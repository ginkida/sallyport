// Optional real-Chromium smoke test. Node >=22; CHROME_BIN must point to a
// Chromium / Chrome for Testing binary that permits --load-extension.
// Uses a temporary profile and a localhost-only fixture. No normal profile,
// pairing secret or external website is involved. --mcp adds an isolated daemon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { startMcp } from './mcp-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromeBin =
  process.env.CHROME_BIN || process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const testMcp = process.argv.includes('--mcp');
if (!chromeBin || typeof WebSocket === 'undefined') {
  throw new Error('Use Node >=22 and set CHROME_BIN to Chromium / Chrome for Testing.');
}
const temp = await mkdtemp(join(tmpdir(), 'sallyport-browser-test-'));
const extensionDir = join(temp, 'extension');
const profileDir = join(temp, 'profile');
let browser;
let socket;
let mcp;
let diagnostics = '';
let fixtureRequests = 0;
const server = createServer((req, res) => {
  fixtureRequests++;
  if (req.url?.startsWith('/data')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ value: 42 }));
  } else if (req.url?.startsWith('/xhtml')) {
    // An XHTML page: tagName comes back lower case ("iframe"), which a
    // case-sensitive focus walk failed to descend.
    res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' });
    res.end(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XHTML</title></head>' +
        '<body><iframe id="login" src="/pwframe"></iframe></body></html>',
    );
  } else if (req.url?.startsWith('/htmlframe')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><iframe id="login" src="/pwframe"></iframe>');
  } else if (req.url?.startsWith('/shadow')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><x-text id="xt"></x-text><x-pw id="xp"></x-pw>' +
        '<input id="jump" onfocus="setTimeout(() => document.getElementById(\'jumppw\').focus(), 0)">' +
        '<input id="jumppw" type="password">' +
        '<div aria-hidden="true"><input id="axhidden"></div>' +
        // Two fields that trade focus every few ms once the first is focused —
        // in the light DOM, and inside ONE closed shadow root (where a window-
        // level listener sees the same host for both). Whatever the timing, the
        // password field must stay empty; its length is mirrored for the test.
        '<input id="flip" aria-label="flip"><input id="flippw" type="password">' +
        '<x-login id="xl"></x-login><span id="pwlen">0</span><span id="spwlen">0</span>' +
        // Focus moved BY THE PAGE'S OWN beforeinput handler — after the event's
        // target is fixed, before Chrome inserts — in the light DOM, and in an
        // open shadow root behind a document-level capture listener that also
        // stops propagation (so no listener inside the root ever runs).
        '<input id="bi" aria-label="bi"><input id="bipw" type="password"><span id="bilen">0</span>' +
        '<x-sp id="xsp"></x-sp><span id="splen">0</span>' +
        '<script>' +
        "const bipw = document.getElementById('bipw');" +
        "document.getElementById('bi').addEventListener('beforeinput', (e) => { if (e.inputType === 'insertText') bipw.focus(); });" +
        "bipw.addEventListener('input', () => { document.getElementById('bilen').textContent = String(bipw.value.length); });" +
        "customElements.define('x-sp', class extends HTMLElement { constructor() { super();" +
        " const r = this.attachShadow({ mode: 'open', delegatesFocus: true });" +
        " r.innerHTML = '<input aria-label=sp-user><input type=password aria-label=sp-pass>';" +
        " const [, p] = r.querySelectorAll('input'); const host = this;" +
        " p.addEventListener('input', () => { document.getElementById('splen').textContent = String(p.value.length); });" +
        " document.addEventListener('beforeinput', (e) => { if (e.target === host && e.inputType === 'insertText') { p.focus(); e.stopPropagation(); } }, true); } });" +
        "const flip = document.getElementById('flip'), flippw = document.getElementById('flippw');" +
        "flippw.addEventListener('input', () => { document.getElementById('pwlen').textContent = String(flippw.value.length); });" +
        "flip.addEventListener('focus', () => { if (flip.dataset.on) return; flip.dataset.on = '1';" +
        ' setInterval(() => (document.activeElement === flip ? flippw : flip).focus(), 1); });' +
        "customElements.define('x-login', class extends HTMLElement { constructor() { super();" +
        " const r = this.attachShadow({ mode: 'closed', delegatesFocus: true });" +
        " r.innerHTML = '<input aria-label=shadow-user><input type=password aria-label=shadow-pass>';" +
        " const [u, p] = r.querySelectorAll('input'); let on = false;" +
        " p.addEventListener('input', () => { document.getElementById('spwlen').textContent = String(p.value.length); });" +
        " u.addEventListener('focus', () => { if (on) return; on = true;" +
        ' setInterval(() => (r.activeElement === u ? p : u).focus(), 1); }); } });' +
        "customElements.define('x-text', class extends HTMLElement { constructor() { super();" +
        " this.attachShadow({ mode: 'closed', delegatesFocus: true }).innerHTML = '<input type=text aria-label=inner-text>'; } });" +
        "customElements.define('x-pw', class extends HTMLElement { constructor() { super();" +
        " this.attachShadow({ mode: 'closed', delegatesFocus: true }).innerHTML = '<input type=password>'; } });" +
        '</script>',
    );
  } else if (req.url?.startsWith('/designframe')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><iframe id="dm" src="/designdoc"></iframe>');
  } else if (req.url?.startsWith('/designdoc')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end("<!doctype html><body><p>x</p><script>document.designMode = 'on';</script></body>");
  } else if (req.url?.startsWith('/xoframe')) {
    // Same port, other host name: a different SITE, so an out-of-process frame.
    const port = server.address().port;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><iframe id="xo" src="http://localhost:${port}/editor"></iframe>`);
  } else if (req.url?.startsWith('/editorframe')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><iframe id="ed" src="/editor"></iframe>');
  } else if (req.url?.startsWith('/editor')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body contenteditable="true"></body>');
  } else if (req.url?.startsWith('/card')) {
    // Auto-advance: a full card number moves focus to the CVV (a password
    // field). The write was correct; nothing must be flagged or cleared.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><input id="card" oninput="if (this.value.length >= 16) document.getElementById(\'cvv\').focus()">' +
        '<input id="cvv" type="password" value="123">',
    );
  } else if (req.url?.startsWith('/xsite-a')) {
    // Invariant #7 across a navigation the PAGE starts: a link from this site
    // (127.0.0.1) to another (localhost) swaps the renderer process, and the
    // new process numbers its nodes from 1 again — so without the loader-id
    // stamp, a ref from here resolves to a live node of /xsite-b.
    const port = server.address().port;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Site A</title>' +
        Array.from({ length: 20 }, (_, i) => `<button>A button ${i}</button>`).join('') +
        `<a id="tob" href="http://localhost:${port}/xsite-b">Go to B</a>`,
    );
  } else if (req.url?.startsWith('/xsite-b')) {
    // Big enough that the new process's node ids cover whatever range the
    // 127.0.0.1 process had reached by the time /xsite-a was walked, and every
    // click ANYWHERE on it is counted.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Site B</title><p>B page</p><span id="clicks">0</span>' +
        Array.from({ length: 3000 }, (_, i) => `<button>B button ${i}</button>`).join('') +
        '<script>let n = 0; document.addEventListener("click", () => {' +
        ' document.getElementById("clicks").textContent = String(++n); }, true);</script>',
    );
  } else if (req.url?.startsWith('/beforeunload')) {
    // A page that asks before it is left — once it has had a user gesture,
    // which an agent's click or typing is.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Unsaved</title>' +
        '<input id="draft" style="position:absolute;left:10px;top:10px;width:200px;height:30px">' +
        '<script>const guard = (e) => { e.preventDefault(); e.returnValue = ""; };' +
        'addEventListener("beforeunload", guard);' +
        // A handleEvent OBJECT: removeEventListener must be handed the object.
        'addEventListener("beforeunload", { handleEvent(e) { e.preventDefault(); } }, true);' +
        'onbeforeunload = () => "unsaved";' +
        // What an SPA router does when the editor route unmounts.
        'window.dropGuard = () => removeEventListener("beforeunload", guard);' +
        // Back/forward-cache restores are told apart from fresh loads.
        'window.__shows = []; addEventListener("pageshow", (e) => __shows.push(e.persisted));</script>',
    );
  } else if (req.url?.startsWith('/pwframe')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><input id="pw" type="password" autofocus>');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Sallyport test</title><p>Local capture fixture</p>' +
        '<label>Name <input id="name"></label><label>Password <input id="password" type="password"></label>' +
        "<button id=\"submit\" onclick=\"document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value\">Submit</button>" +
        '<p id="result"></p><p id="changing">AAAA</p>' +
        '<button id="churn-text" onclick="startChurn(0)">Update text</button>' +
        '<button id="churn-attribute" onclick="startChurn(1)">Update attributes</button>' +
        '<button id="churn-revert" onclick="startChurn(2)">Revert changes</button>' +
        '<button id="navigate-soon" onclick="setTimeout(() => location.assign(`/?next`), 300)">Navigate</button>' +
        '<button id="start-clock" onclick="startClock()">Start clock</button><span id="clock">0</span>' +
        '<span class="dup" style="display:none">hidden copy</span><span class="dup">visible copy</span>' +
        '<fieldset disabled><button id="fs-btn">In a disabled fieldset</button></fieldset>' +
        '<svg id="svg-btn" role="button" width="24" height="24" onclick="document.querySelector(\'#result\').textContent = \'svg clicked\'"><rect width="24" height="24"></rect></svg>' +
        '<input id="ro" readonly value="2026-10-01">' +
        '<x-pass id="xpass" type="password"></x-pass>' +
        '<textarea id="msg"></textarea>' +
        '<select id="multi" multiple><option value="UA">UA</option><option value="PL">PL</option><option value="DE">DE</option></select>' +
        '<select id="dupe"><option value="">— choose —</option><option value="">Other</option></select>' +
        '<div id="list" style="height:150px;overflow:auto;position:relative;scroll-behavior:smooth" onscroll="renderRows()">' +
        '<div style="height:900px;position:relative"></div></div>' +
        '<script>function startChurn(mode) {' +
        ' const node = document.querySelector("#changing").firstChild;' +
        ' node.data = "AAAA";' +
        ' const timer = setInterval(() => {' +
        ' if (mode === 0) node.data = node.data === "AAAA" ? "BBBB" : "AAAA";' +
        ' if (mode === 1) document.documentElement.dataset.state = document.documentElement.dataset.state === "A" ? "B" : "A";' +
        ' if (mode === 2) { const el = document.createElement("span"); document.body.append(el); el.remove(); }' +
        ' }, 25);' +
        ' setTimeout(() => { clearInterval(timer); node.data = "DONE"; }, 2000);' +
        '}' +
        // A minimal virtualised list: only the rows in view exist, so reveal
        // really has to scroll for "Row 25", and each scroll re-renders rows.
        'function renderRows() {' +
        ' const list = document.querySelector("#list");' +
        ' const first = Math.floor(list.scrollTop / 30);' +
        ' const rows = [];' +
        ' for (let i = first; i < Math.min(30, first + 6); i++) {' +
        '  const row = document.createElement("button");' +
        '  row.textContent = "Row " + i;' +
        '  row.style.cssText = "position:absolute;top:" + i * 30 + "px;height:30px";' +
        '  rows.push(row);' +
        ' }' +
        ' list.firstChild.replaceChildren(...rows);' +
        '}' +
        'function startClock() {' +
        ' const clock = document.querySelector("#clock");' +
        ' const timer = setInterval(() => { clock.textContent = String(performance.now()); }, 50);' +
        ' setTimeout(() => clearInterval(timer), 20000);' +
        '}' +
        'renderRows();' +
        // A design-system password field: the real input sits in a CLOSED
        // shadow root that takes focus — fill can only see the host.
        "customElements.define('x-pass', class extends HTMLElement { constructor() { super();" +
        " const root = this.attachShadow({ mode: 'closed', delegatesFocus: true });" +
        " root.innerHTML = '<input type=password>'; } });" +
        '</script>',
    );
  }
});

async function until(probe, description, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await probe();
    if (value) return value;
    if (browser && browser.exitCode !== null) throw new Error(`Browser exited: ${diagnostics}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${description}\n${diagnostics}`);
}

try {
  await cp(join(root, 'dist'), extensionDir, { recursive: true });
  await mkdir(profileDir);
  // Test-only seeding shares the production worker's ownership module. The
  // published dist never contains this hook; only this temporary copy does.
  await build({
    stdin: {
      resolveDir: root,
      contents: `
        import './src/background.ts';
        import { mintEpoch, markHumanTab, markOrphanedTab } from './src/tools/ownership.ts';
        import { attach } from './src/tools/cdp.ts';
        import { closeAgentTab, disarmBeforeUnload, rearmIfSameDocument } from './src/tools/quiet-leave.ts';
        // Focus theft: a beforeunload prompt makes Chrome ACTIVATE the tab and
        // FOCUS its window. The agent's own tab must leave without raising one.
        globalThis.quietLeaveTest = async (base) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const bounded = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what + ' hung'); })]);
          const settled = (p, ms) => Promise.race([p.then(() => 'done', () => 'done'), sleep(ms).then(() => 'pending')]);
          const exists = (id) => chrome.tabs.get(id).then(() => true, () => false);
          const events = [];
          const onActivated = (info) => events.push('activated:' + info.tabId);
          const onFocus = (windowId) => { if (windowId !== chrome.windows.WINDOW_ID_NONE) events.push('focus:' + windowId); };
          chrome.tabs.onActivated.addListener(onActivated);
          chrome.windows.onFocusChanged.addListener(onFocus);
          const win = await chrome.windows.create({ url: base + '/?agent-window', focused: false });
          // An agent tab in the BACKGROUND of its window, with a gesture on it.
          const dirtyTab = async () => {
            const tab = await chrome.tabs.create({ windowId: win.id, url: base + '/beforeunload', active: false });
            for (let i = 0; i < 100 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++) await sleep(50);
            await attach(tab.id);
            // The capture test turned keep-awake off; a hidden tab takes no input without it.
            await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
              await bounded(chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type, x: 50, y: 25, button: 'left', clickCount: 1 }), 5000, 'click');
            await bounded(chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.insertText', { text: 'draft' }), 5000, 'type');
            mintEpoch(tab.id, 'smoke');
            return tab.id;
          };
          const out = {};
          try {
            // Control: the plain removal DOES prompt here, so the cases below mean something.
            const control = await dirtyTab();
            events.length = 0;
            out.controlRemove = await settled(chrome.tabs.remove(control), 1500);
            out.controlEvents = [...events];
            // The prompt ACTIVATED the tab in a focused window, which reads as the
            // human engaging with it — one more thing the old behaviour got wrong
            // — so it is no longer quietly closable; close its target directly.
            const controlTarget = (await chrome.debugger.getTargets()).find(
              (t) => t.tabId === control && t.type === 'page',
            );
            await chrome.debugger
              .sendCommand({ tabId: control }, 'Target.closeTarget', { targetId: controlTarget.id })
              .catch(() => {});
            await sleep(200);
            out.controlGone = !(await exists(control));
            const closing = await dirtyTab();
            events.length = 0;
            out.close = await bounded(closeAgentTab(closing), 5000, 'quiet close');
            out.closeGone = !(await exists(closing));
            out.closeEvents = [...events];
            const leaving = await dirtyTab();
            const send = (method, params) => chrome.debugger.sendCommand({ tabId: leaving }, method, params);
            const count = async () => {
              const { result } = await send('Runtime.evaluate', { expression: 'window', objectGroup: 'smoke' });
              const { listeners } = await send('DOMDebugger.getEventListeners', { objectId: result.objectId });
              await send('Runtime.releaseObjectGroup', { objectGroup: 'smoke' });
              return listeners.filter((l) => l.type === 'beforeunload').length;
            };
            // A same-document navigate (#hash) must hand the page its guard back.
            out.listenersBefore = await count();
            const hashDisarm = await disarmBeforeUnload(leaving);
            out.listenersDisarmed = await count();
            await chrome.tabs.update(leaving, { url: base + '/beforeunload#later' });
            for (let i = 0; i < 60 && !(await chrome.tabs.get(leaving)).url.endsWith('#later'); i++) await sleep(50);
            out.rearmed = await rearmIfSameDocument(leaving, hashDisarm);
            out.listenersRearmed = await count();
            const value = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
            out.idlBack = await value('typeof onbeforeunload');
            // The watch is down again: no shadow left on the page's window.
            out.shadowLeft = await value('Object.prototype.hasOwnProperty.call(window, "removeEventListener")');
            // The page drops a guard itself while it is down (an SPA route
            // change): the restore must not bring that one back.
            const spaDisarm = await disarmBeforeUnload(leaving);
            await value('history.pushState(null, "", location.pathname + "?list"); dropGuard(); 1');
            out.spaRearmed = await rearmIfSameDocument(leaving, spaDisarm);
            out.listenersAfterSpa = await count();
            await value('addEventListener("beforeunload", guard); history.replaceState(null, "", location.pathname + "#later"); 1');
            events.length = 0;
            out.disarmed = (await disarmBeforeUnload(leaving))?.count ?? 0;
            await chrome.tabs.update(leaving, { url: base + '/?left' });
            for (let i = 0; i < 60 && !(await chrome.tabs.get(leaving)).url.endsWith('/?left'); i++) await sleep(50);
            out.leftUrl = (await chrome.tabs.get(leaving)).url;
            out.quietEvents = [...events];
            // Back to the disarmed document: from the back/forward cache it is
            // the SAME document, and it must come back with its guard.
            await chrome.tabs.goBack(leaving);
            for (let i = 0; i < 60 && !(await chrome.tabs.get(leaving)).url.endsWith('#later'); i++) await sleep(50);
            for (let i = 0; i < 40 && (await chrome.tabs.get(leaving)).status !== 'complete'; i++) await sleep(50);
            out.backShows = await value('JSON.stringify(__shows)');
            out.listenersAfterBack = await count();
            out.idlAfterBack = await value('typeof onbeforeunload');
            await closeAgentTab(leaving);
          } finally {
            chrome.tabs.onActivated.removeListener(onActivated);
            chrome.windows.onFocusChanged.removeListener(onFocus);
            await chrome.windows.remove(win.id).catch(() => {});
          }
          return out;
        };
        globalThis.seedAgentTabs = async (url) => {
          const ids = [];
          for (let i = 0; i < 3; i++) {
            const tab = await chrome.tabs.create({url, active: false});
            mintEpoch(tab.id, i < 2 ? 'Finished research ' + 'LongSessionName'.repeat(12) : 'Active writer');
            if (i < 2) markOrphanedTab(tab.id);
            if (i === 1) markHumanTab(tab.id);
            ids.push(tab.id);
          }
          return ids;
        };
      `,
    },
    outfile: join(extensionDir, 'background.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    logLevel: 'silent',
  });
  await writeFile(
    join(extensionDir, 'capture-test.html'),
    '<!doctype html><script src="capture-test.js"></script>',
  );
  await build({
    stdin: {
      resolveDir: root,
      contents: `
        import { attach, detach } from './src/tools/cdp.ts';
        import { readNetwork, ensureNetworkCapture } from './src/tools/network-capture.ts';
        import { readConsole, ensureConsoleCapture } from './src/tools/console-capture.ts';
        import { installCaptureSettingsListener } from './src/tools/capture-settings.ts';
        import { setSettings } from './src/storage.ts';
        installCaptureSettingsListener();
        async function waitFor(probe) {
          const deadline = performance.now() + 10000;
          while (performance.now() < deadline) {
            if (await probe()) return;
            await new Promise(r => setTimeout(r, 50));
          }
          throw new Error('Capture event did not arrive');
        }
        globalThis.captureTest = {
          async setup(url) {
            await setSettings({ captureConsole: true, captureNetwork: true, keepAwake: false });
            const tab = await chrome.tabs.create({ url, active: true });
            try {
              await waitFor(async () => (await chrome.tabs.get(tab.id)).status === 'complete');
            } catch (error) {
              throw new Error('Fixture did not load: ' + JSON.stringify(await chrome.tabs.get(tab.id)), { cause: error });
            }
            await attach(tab.id);
            return tab.id;
          },
          async generate(tabId) {
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
              expression: 'console.error("capture fixture"); fetch("/data").then(r => r.json())',
              awaitPromise: true,
              returnByValue: true,
            });
          },
          async captured(tabId) {
            await waitFor(() => readNetwork(tabId).some(e => e.body) && readConsole(tabId).length);
            return { network: readNetwork(tabId), console: readConsole(tabId) };
          },
          read(tabId) { return { network: readNetwork(tabId), console: readConsole(tabId) }; },
          async off(tabId) {
            await setSettings({ captureConsole: false, captureNetwork: false });
            await waitFor(() => !readNetwork(tabId).length && !readConsole(tabId).length);
            // Simulate an attach that had read old settings before the change.
            await ensureNetworkCapture(tabId);
            await ensureConsoleCapture(tabId);
          },
          async on(tabId) {
            await setSettings({ captureConsole: true, captureNetwork: true });
            await attach(tabId);
          },
          async reattach(tabId) {
            await detach(tabId);
            await waitFor(() => !readNetwork(tabId).length && !readConsole(tabId).length);
            await attach(tabId);
          },
        };
      `,
    },
    outfile: join(extensionDir, 'capture-test.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    logLevel: 'silent',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let launchError;
  browser.on('error', (error) => {
    launchError = error;
  });
  browser.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4000);
  });
  const port = await until(async () => {
    if (launchError) throw launchError;
    try {
      return (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    } catch {
      return null;
    }
  }, 'Chromium debugging port');
  const api = `http://127.0.0.1:${port}`;
  const json = async (path) =>
    (await fetch(api + path, { signal: AbortSignal.timeout(5000) })).json();
  const version = await json('/json/version');
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await Promise.race([
    once(socket, 'open'),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP socket did not open')), 10000);
      timer.unref();
    }),
  ]);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
      diagnostics = (diagnostics + '\n' + JSON.stringify(message.params)).slice(-8000);
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  // Chromium also starts built-in extension workers (some named background.js).
  // Identify our worker by its manifest rather than the first matching URL.
  const { worker, workerSession } = await until(async () => {
    for (const candidate of await json('/json/list')) {
      if (candidate.type !== 'service_worker' || !candidate.url.startsWith('chrome-extension://'))
        continue;
      const { sessionId: candidateSession } = await call('Target.attachToTarget', {
        targetId: candidate.id,
        flatten: true,
      });
      await call('Runtime.enable', {}, candidateSession);
      const info = await call(
        'Runtime.evaluate',
        {
          expression: 'chrome.runtime?.getManifest?.().name',
          returnByValue: true,
        },
        candidateSession,
      );
      if (info.result?.value === 'Sallyport')
        return { worker: candidate, workerSession: candidateSession };
      await call('Target.detachFromTarget', { sessionId: candidateSession });
    }
    return null;
  }, 'Sallyport service worker');
  const extensionUrl = `chrome-extension://${new URL(worker.url).host}`;
  const opened = await call(
    'Runtime.evaluate',
    {
      expression: 'chrome.tabs.create({url: chrome.runtime.getURL("capture-test.html")})',
      awaitPromise: true,
      returnByValue: true,
    },
    workerSession,
  );
  if (opened.exceptionDetails) throw new Error(JSON.stringify(opened.exceptionDetails));
  const harnessTarget = await until(
    async () =>
      (await json('/json/list')).find(
        (target) => target.url === `${extensionUrl}/capture-test.html`,
      ),
    'extension test page',
  );
  const targetId = harnessTarget.id;
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, sessionId);
  await call('Log.enable', {}, sessionId);
  const evaluate = async (expression) => {
    const result = await call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        JSON.stringify(result.exceptionDetails) +
          '\nFixture requests: ' +
          fixtureRequests +
          '\n' +
          diagnostics,
      );
    }
    return result.result.value;
  };
  try {
    await until(() => evaluate('typeof captureTest !== "undefined"'), 'capture harness');
  } catch (error) {
    const page = await evaluate(
      '({url: location.href, ready: document.readyState, html: document.documentElement.outerHTML.slice(0, 2000)})',
    );
    throw new Error(`${error.message}\nWorker: ${worker.url}\nPage: ${JSON.stringify(page)}`);
  }
  const tabId = await evaluate(`captureTest.setup(${JSON.stringify(fixtureUrl)})`);
  await evaluate(`captureTest.generate(${tabId})`);
  const captured = await evaluate(`captureTest.captured(${tabId})`);
  assert.ok(captured.network.some((entry) => JSON.parse(entry.body || '{}').value === 42));
  assert.ok(captured.console.some((entry) => entry.text.includes('capture fixture')));
  console.log('PASS: real CDP console events and response bodies');
  await evaluate(`captureTest.off(${tabId})`);
  await evaluate(`captureTest.generate(${tabId})`);
  assert.deepEqual(await evaluate(`captureTest.read(${tabId})`), { network: [], console: [] });
  console.log('PASS: opt-out clears data and rejects stale enable calls');
  await evaluate(`captureTest.on(${tabId})`);
  await evaluate(`captureTest.generate(${tabId})`);
  await evaluate(`captureTest.captured(${tabId})`);
  await evaluate(`captureTest.reattach(${tabId})`);
  await evaluate(`captureTest.generate(${tabId})`);
  await evaluate(`captureTest.captured(${tabId})`);
  console.log('PASS: re-enable and real debugger detach/re-attach');
  const seeded = await call(
    'Runtime.evaluate',
    {
      expression: `seedAgentTabs(${JSON.stringify(fixtureUrl)})`,
      awaitPromise: true,
      returnByValue: true,
    },
    workerSession,
  );
  if (seeded.exceptionDetails) throw new Error(JSON.stringify(seeded.exceptionDetails));
  const agentIds = seeded.result.value;
  await call(
    'Runtime.evaluate',
    {
      expression: 'chrome.action.openPopup()',
      awaitPromise: true,
    },
    workerSession,
  );
  const popup = await until(
    async () =>
      (await json('/json/list')).find((target) => target.url === `${extensionUrl}/popup.html`),
    'popup',
  );
  const { sessionId: popupSession } = await call('Target.attachToTarget', {
    targetId: popup.id,
    flatten: true,
  });
  const popupEval = async (expression) => {
    const out = await call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      popupSession,
    );
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  await until(() => popupEval('document.readyState === "complete"'), 'popup document');
  // Pair with a synthetic test key while paused, so the actual main UI is
  // visible without connecting to any daemon or altering the normal profile.
  assert.ok(
    (
      await popupEval(
        'new Promise(resolve => chrome.runtime.sendMessage({type: "PAUSE"}, resolve))',
      )
    ).ok,
  );
  assert.ok(
    (
      await popupEval(
        `new Promise(resolve => chrome.runtime.sendMessage({type: "PAIR", secret: btoa("x".repeat(32)), serverUrl: ${JSON.stringify(fixtureUrl.replace('http:', 'ws:'))}}, resolve))`,
      )
    ).ok,
  );
  await until(
    () => popupEval('!document.querySelector("#main").classList.contains("hidden")'),
    'paired main UI',
  );
  await popupEval('document.querySelector("#nav-status").focus()');
  for (const [key, expected] of [
    ['ArrowRight', 'allowlist'],
    ['End', 'audit'],
    ['ArrowRight', 'status'],
    ['ArrowLeft', 'audit'],
    ['Home', 'status'],
  ]) {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key }, popupSession);
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }, popupSession);
    const selected = await popupEval(`({
      active: document.activeElement.dataset.tab,
      selected: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(t => t.dataset.tab),
      focusable: [...document.querySelectorAll('[role="tab"]')].filter(t => t.tabIndex === 0).map(t => t.dataset.tab),
      panels: [...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.hidden).map(p => p.id),
    })`);
    assert.deepEqual(selected, {
      active: expected,
      selected: [expected],
      focusable: [expected],
      panels: ['tab-' + expected],
    });
  }
  console.log('PASS: keyboard navigation, focus and accessible tab/panel state');
  await popupEval('document.querySelector("#status-agents").open = true');
  await until(
    () => popupEval('document.querySelectorAll(".agent-session").length === 2'),
    'session groups',
  );
  assert.equal(await popupEval('document.querySelectorAll(".agent-tab-row").length'), 3);
  assert.ok(
    await popupEval('document.documentElement.scrollWidth <= innerWidth'),
    'Long session names must not cause horizontal overflow',
  );
  if (process.env.BROWSER_SCREENSHOT) {
    const shot = await call(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      popupSession,
    );
    await writeFile(process.env.BROWSER_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await popupEval('document.querySelector("#agent-tabs-finished").click()');
  await until(
    () =>
      popupEval(
        'document.querySelector("#agent-tabs-feedback").textContent.includes("Closed 1 tab")',
      ),
    'finished cleanup',
  );
  await until(
    () => popupEval('document.querySelectorAll(".agent-tab-row").length === 2'),
    'remaining agent tabs',
  );
  const surviving = await call(
    'Runtime.evaluate',
    {
      expression: 'chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))',
      awaitPromise: true,
      returnByValue: true,
    },
    workerSession,
  );
  assert.ok(!surviving.result.value.includes(agentIds[0]));
  assert.ok(surviving.result.value.includes(agentIds[1]));
  assert.ok(surviving.result.value.includes(agentIds[2]));
  assert.ok(surviving.result.value.includes(tabId));
  console.log(
    'PASS: popup session groups and finished cleanup preserve viewed, active and non-agent tabs',
  );
  const quiet = await call(
    'Runtime.evaluate',
    {
      expression: `quietLeaveTest(${JSON.stringify(fixtureUrl)})`,
      awaitPromise: true,
      returnByValue: true,
    },
    workerSession,
  );
  if (quiet.exceptionDetails) throw new Error(JSON.stringify(quiet.exceptionDetails));
  const q = quiet.result.value;
  // The fixture really prompts: a plain removal hangs on it and raises the tab.
  assert.equal(q.controlRemove, 'pending', JSON.stringify(q));
  assert.ok(
    q.controlEvents.some((e) => e.startsWith('activated:')),
    JSON.stringify(q),
  );
  assert.ok(q.controlGone, JSON.stringify(q));
  // The agent's own tab closes and navigates away with no prompt, nothing
  // activated, no window focused.
  assert.equal(q.close, 'quiet', JSON.stringify(q));
  assert.ok(q.closeGone, JSON.stringify(q));
  assert.deepEqual(q.closeEvents, [], JSON.stringify(q));
  assert.ok(q.disarmed >= 3, JSON.stringify(q));
  // The IDL handler is reported too (3 = listener + handleEvent object + IDL),
  // every one of them goes — the object only by its originalHandler — and a
  // same-document navigate puts back exactly what was there, no duplicate.
  assert.equal(q.listenersBefore, 3, JSON.stringify(q));
  assert.equal(q.listenersDisarmed, 0, JSON.stringify(q));
  assert.equal(q.rearmed, true, JSON.stringify(q));
  assert.equal(q.listenersRearmed, 3, JSON.stringify(q));
  assert.equal(q.idlBack, 'function', JSON.stringify(q));
  assert.equal(q.shadowLeft, false, JSON.stringify(q));
  // A guard the page dropped itself while it was down stays dropped.
  assert.equal(q.spaRearmed, true, JSON.stringify(q));
  assert.equal(q.listenersAfterSpa, 2, JSON.stringify(q));
  // A disarmed document restored from the back/forward cache has its guard.
  assert.equal(q.backShows, '[false,true]', JSON.stringify(q));
  assert.equal(q.listenersAfterBack, 3, JSON.stringify(q));
  assert.equal(q.idlAfterBack, 'function', JSON.stringify(q));
  assert.ok(q.leftUrl.endsWith('/?left'), JSON.stringify(q));
  assert.deepEqual(q.quietEvents, [], JSON.stringify(q));
  console.log(
    'PASS: an agent tab with a beforeunload handler closes and navigates without a prompt',
  );
  if (testMcp) {
    // Hand the fixture back before the production worker drives it. The
    // earlier capture test owns a debugger session from its separate page.
    await evaluate(`captureTest.off(${tabId})`);
    await evaluate(`chrome.debugger.detach({tabId:${tabId}})`);
    const reservation = createTcpServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const secret = randomBytes(32).toString('base64');
    const secretFile = join(temp, 'secret');
    await writeFile(secretFile, secret, { mode: 0o600 });
    const daemonRoot = resolve(root, '../daemon');
    const python =
      process.env.SALLYPORT_TEST_PYTHON ||
      join(daemonRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    mcp = startMcp(
      python,
      ['--no-broker', '--port', String(port), '--secret-file', secretFile],
      join(daemonRoot, 'src'),
    );
    const initialized = await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sallyport-browser-test', version: '1' },
    });
    assert.ok(initialized.serverInfo);
    mcp.notify('notifications/initialized');
    const callTool = (name, args = {}) => mcp.request('tools/call', { name, arguments: args });
    const value = (result) => {
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content.find((item) => item.type === 'text').text);
    };
    assert.ok((await mcp.request('tools/list')).tools.some((tool) => tool.name === 'fill'));
    const pair = await popupEval(
      `new Promise(resolve => chrome.runtime.sendMessage({type:'PAIR', secret:${JSON.stringify(secret)}, serverUrl:${JSON.stringify(`ws://127.0.0.1:${port}/ws`)}}, resolve))`,
    );
    assert.ok(pair.ok);
    assert.ok(
      (
        await popupEval(
          'new Promise(resolve => chrome.runtime.sendMessage({type:"RESUME"}, resolve))',
        )
      ).ok,
    );
    await until(
      async () => value(await callTool('status')).connected,
      'authenticated daemon connection',
    );
    const refused = await callTool('navigate', { url: fixtureUrl, tabId });
    assert.match(refused.content[0].text, /domain_not_allowed/);
    assert.equal(refused.isError, true, 'MCP must flag tool failures as errors');
    await popupEval(
      `chrome.storage.local.set({sallyport_allowlist:[{pattern:${JSON.stringify(fixtureUrl + '/*')},allowEvaluate:false,addedAt:Date.now()}]})`,
    );
    value(await callTool('navigate', { url: fixtureUrl, tabId }));
    // fill by @eN straight after an a11y snapshot: nothing has fetched the DOM
    // document yet, which is the state a ref-based password gate must handle.
    const snap = value(await callTool('snapshot', { compact: true, tabId }));
    const nameRef = snap.elements.find((e) => e.role === 'textbox' && /Name/.test(e.name))?.ref;
    assert.ok(nameRef, JSON.stringify(snap.elements));
    value(await callTool('fill', { selector: nameRef, value: 'Sallyport', tabId }));
    // ...and the same path still refuses the real password field (invariant #5).
    const pwRef = snap.elements.find((e) => e.role === 'textbox' && /Password/.test(e.name))?.ref;
    assert.ok(pwRef, JSON.stringify(snap.elements));
    const pwByRef = await callTool('fill', { selector: pwRef, value: 'do-not-record', tabId });
    assert.equal(pwByRef.isError, true, JSON.stringify(pwByRef));
    assert.match(pwByRef.content[0].text, /password_field/);
    const pwHost = await callTool('fill', { selector: '#xpass', value: 'do-not-record', tabId });
    assert.equal(pwHost.isError, true, JSON.stringify(pwHost));
    assert.match(pwHost.content[0].text, /password_field/);
    value(await callTool('click', { selector: '#submit', tabId }));
    const text = await callTool('read_text', { tabId });
    assert.ok(!text.isError);
    assert.match(JSON.stringify(text.content), /Hello Sallyport/);
    // Clicks that the browser would not (or could not) deliver must not read
    // as ok:true.
    const fieldset = await callTool('click', { selector: '#fs-btn', tabId });
    assert.equal(fieldset.isError, true, JSON.stringify(fieldset));
    assert.match(fieldset.content[0].text, /element_disabled/);
    value(await callTool('click', { selector: '#svg-btn', tabId }));
    assert.match(JSON.stringify((await callTool('read_text', { tabId })).content), /svg clicked/);
    value(await callTool('mouse_click', { selector: '#ro', tabId }));
    const readonly = await callTool('key_type', { text: 'abc', tabId });
    assert.equal(readonly.isError, true, JSON.stringify(readonly));
    assert.match(readonly.content[0].text, /no_editable_focus/);
    console.log('PASS: MCP click/key_type refuse what the browser would not deliver');
    // select_option: values out of document order, and a label whose value
    // another option shares, must both land AND read back as landed.
    const multi = value(
      await callTool('select_option', { selector: '#multi', value: ['DE', 'UA'], tabId }),
    );
    assert.equal(multi.applied, 'yes', JSON.stringify(multi));
    const dupe = value(
      await callTool('select_option', { selector: '#dupe', label: 'Other', tabId }),
    );
    assert.equal(dupe.applied, 'yes', JSON.stringify(dupe));
    assert.equal(dupe.selected[0].label, 'Other');
    console.log('PASS: MCP select_option lands the planned option and reads it back');
    // method:value on a <textarea> must land by value, not fall back to typing
    // with an empty tag as if a framework had reverted it.
    const area = value(
      await callTool('fill', { selector: '#msg', value: 'multi\nline', method: 'value', tabId }),
    );
    assert.equal(area.mode, 'value', JSON.stringify(area));
    assert.equal(area.tag, 'TEXTAREA');
    assert.equal(area.fallbackFrom, undefined);
    console.log('PASS: MCP fill method:value lands on a textarea');
    for (const mode of ['text', 'attribute', 'revert']) {
      value(await callTool('click', { selector: `#churn-${mode}`, tabId }));
      const busy = value(await callTool('settle', { stableMs: 500, timeoutMs: 1000, tabId }));
      assert.equal(busy.settled, false, `${mode} mutations must keep the page unsettled`);
      const quiet = value(await callTool('settle', { stableMs: 500, timeoutMs: 5000, tabId }));
      assert.equal(quiet.settled, true, 'the page should settle once updates stop');
      assert.match(JSON.stringify((await callTool('read_text', { tabId })).content), /DONE/);
    }
    console.log('PASS: MCP settle detects text/attribute/reverted changes and waits for DOM quiet');
    // The observer lives in one document: a navigation mid-wait must hand the
    // wait to the NEW page, not fail it. stableMs outlasts the 300 ms delay, so
    // the old page cannot settle before it is replaced.
    value(await callTool('click', { selector: '#navigate-soon', tabId }));
    const moved = value(await callTool('settle', { stableMs: 1000, timeoutMs: 8000, tabId }));
    assert.equal(moved.settled, true, 'settle must follow a navigation to the new page');
    assert.match(JSON.stringify((await callTool('list_tabs', {})).content), /\?next/);
    console.log('PASS: MCP settle survives a navigation during the wait');
    // A selector's FIRST match is hidden and its second visible: the selector
    // is present, and it is not gone.
    const present = value(await callTool('wait_for', { selector: '.dup', timeoutMs: 1000, tabId }));
    assert.equal(present.found, true, 'a visible later match makes the selector present');
    const gone = value(
      await callTool('wait_for', { selector: '.dup', absent: true, timeoutMs: 600, tabId }),
    );
    assert.equal(gone.found, false, 'a visible later match means the selector is not gone');
    // Chrome's own DOMException must surface as the caller's mistake: a
    // standalone wait fails bad_args, an embedded one names it.
    const bad = await callTool('wait_for', { selector: 'div[', timeoutMs: 1000, tabId });
    assert.equal(bad.isError, true, JSON.stringify(bad));
    assert.match(bad.content[0].text, /bad_args/);
    const malformed = value(
      await callTool('scroll', { to: 'top', waitFor: { selector: 'div[', timeoutMs: 300 }, tabId }),
    );
    assert.equal(malformed.wait.reason, 'invalid_selector', JSON.stringify(malformed.wait));
    console.log('PASS: MCP wait_for weighs every match of a selector');
    // reveal waits between scroll steps on its CONTAINER: a clock ticking
    // elsewhere on the page must not cost every step the full 1.5 s budget.
    value(await callTool('click', { selector: '#start-clock', tabId }));
    const revealStart = performance.now();
    const revealed = value(
      await callTool('reveal', {
        container: '#list',
        role: 'button',
        name: 'Row 25',
        timeoutMs: 30000,
        tabId,
      }),
    );
    const revealMs = performance.now() - revealStart;
    assert.equal(revealed.found, true, JSON.stringify(revealed));
    assert.ok(revealed.steps >= 3, `the target must need scrolling: ${revealed.steps} steps`);
    assert.ok(
      revealMs / revealed.steps < 1100,
      `${Math.round(revealMs)} ms over ${revealed.steps} steps — page churn is stalling each step`,
    );
    console.log(
      `PASS: MCP reveal steps are not stalled by DOM churn outside the container (${Math.round(revealMs)} ms, ${revealed.steps} steps)`,
    );
    // The list has `scroll-behavior: smooth` (so reveal above also proves a
    // smooth container is not misread as a stall); scroll must report where it
    // actually landed, not where an animation started from.
    value(await callTool('scroll', { selector: '#list', to: 'top', tabId }));
    const landed = value(await callTool('scroll', { selector: '#list', dy: 300, tabId }));
    assert.equal(landed.y, 300, JSON.stringify(landed));
    console.log('PASS: MCP scroll and reveal land at once under scroll-behavior: smooth');
    const password = await callTool('fill', {
      selector: '#password',
      value: 'do-not-record',
      tabId,
    });
    assert.match(password.content[0].text, /password_field/);
    assert.equal(password.isError, true);
    // Invariant #5 through a frame: fill on a same-origin <iframe> whose own
    // document autofocuses a password field. The DOM walk sees the frame's
    // <body> until Chrome applies that pending focus AT the insert, so the text
    // used to land in the password field. It must be refused — on an HTML page
    // and on an XHTML one (whose lower-case "iframe" the walk also missed).
    for (const page of ['/htmlframe', '/xhtml']) {
      value(await callTool('navigate', { url: fixtureUrl + page, tabId }));
      await until(
        async () =>
          value(await callTool('wait_for', { selector: '#login', timeoutMs: 1000, tabId })).found,
        `${page} frame`,
      );
      await new Promise((r) => setTimeout(r, 500)); // the frame's own document
      const intoFrame = await callTool('fill', {
        selector: '#login',
        value: 'do-not-record',
        tabId,
      });
      assert.equal(intoFrame.isError, true, `${page}: ${JSON.stringify(intoFrame)}`);
      // A frame is not a field: refused before anything is focused or typed.
      assert.match(intoFrame.content[0].text, /wrong_element/);
    }
    // Closed-shadow components: a text one fills, a password one is refused —
    // the browser's AX focus sees through the closed root to the real field.
    value(await callTool('navigate', { url: fixtureUrl + '/shadow', tabId }));
    await until(
      async () =>
        value(await callTool('wait_for', { selector: '#xt', timeoutMs: 1000, tabId })).found,
      'shadow page',
    );
    const shadowText = value(
      await callTool('fill', { selector: '#xt', value: 'via host', method: 'insertText', tabId }),
    );
    assert.equal(shadowText.applied, 'yes', JSON.stringify(shadowText));
    // ...and by a ref straight to the INNER field, which is what snapshot/find
    // hand out (the AX tree pierces even closed roots). The guard compares at
    // the shadow root too, so the window only ever seeing the host is fine.
    const inner = value(await callTool('find', { name: 'inner-text', tabId }));
    assert.equal(inner.matches.length, 1, JSON.stringify(inner));
    const innerFill = value(
      await callTool('fill', {
        selector: inner.matches[0].ref,
        value: 'via ref',
        method: 'insertText',
        tabId,
      }),
    );
    assert.equal(innerFill.applied, 'yes', JSON.stringify(innerFill));
    // A field the AX tree ignores (aria-hidden) still takes a fill.
    const axh = value(
      await callTool('fill', {
        selector: '#axhidden',
        value: 'hidden ax',
        method: 'insertText',
        tabId,
      }),
    );
    assert.equal(axh.applied, 'yes', JSON.stringify(axh));
    const shadowPw = await callTool('fill', {
      selector: '#xp',
      value: 'do-not-record',
      method: 'insertText',
      tabId,
    });
    assert.equal(shadowPw.isError, true, JSON.stringify(shadowPw));
    assert.match(shadowPw.content[0].text, /password_field/);
    // A page that moves focus onto a password field as the target takes it:
    // the insert is stopped, nothing lands in the password field.
    const jump = await callTool('fill', {
      selector: '#jump',
      value: 'do-not-record',
      method: 'insertText',
      tabId,
    });
    assert.equal(jump.isError, true, JSON.stringify(jump));
    assert.match(jump.content[0].text, /focus_moved|not_focusable|password_field/);
    // Focus that keeps trading places with a password field — the race the
    // guard exists for. Any outcome but text in the password field is fine.
    const outcomes = {};
    for (const [label, selector, mirror] of [
      ['light', '#flip', '#pwlen'],
      ['shadow', '#xl', '#spwlen'],
    ]) {
      for (let i = 0; i < 12; i++) {
        // Not 'do-not-record': a write that DID land in the ordinary field is
        // audited verbatim, as it should be.
        const r = await callTool('fill', {
          selector,
          value: 'race-text',
          method: 'insertText',
          tabId,
        });
        const code = r.isError ? /\[(\w+)\]/.exec(r.content[0].text)?.[1] : 'ok';
        assert.match(
          String(code),
          /^(ok|focus_moved|not_focusable|password_field|no_editable_focus)$/,
        );
        outcomes[`${label}:${code}`] = (outcomes[`${label}:${code}`] ?? 0) + 1;
        const len = value(await callTool('get_state', { selector: mirror, tabId }));
        assert.equal(
          len.text,
          '0',
          `${label} password field received text (${JSON.stringify(outcomes)})`,
        );
      }
    }
    console.log('  focus-race outcomes:', JSON.stringify(outcomes));
    // A fresh page: the race fixtures keep trading focus forever once started.
    value(await callTool('navigate', { url: fixtureUrl + '/shadow', tabId }));
    await until(
      async () =>
        value(await callTool('wait_for', { selector: '#xsp', timeoutMs: 1000, tabId })).found,
      'shadow page again',
    );
    for (const [selector, mirror] of [
      ['#bi', '#bilen'],
      ['#xsp', '#splen'],
    ]) {
      const r = await callTool('fill', {
        selector,
        value: 'race-text',
        method: 'insertText',
        tabId,
      });
      assert.equal(r.isError, true, `${selector}: ${JSON.stringify(r)}`);
      assert.match(r.content[0].text, /focus_moved/);
      const len = value(await callTool('get_state', { selector: mirror, tabId }));
      assert.equal(len.text, '0', `${selector}: the password field received text`);
    }
    // A cross-origin frame cannot be verified, so it is not typed into.
    value(await callTool('navigate', { url: fixtureUrl + '/xoframe', tabId }));
    await new Promise((r) => setTimeout(r, 800));
    const xo = await callTool('fill', { selector: '#xo', value: 'do-not-record', tabId });
    assert.equal(xo.isError, true, JSON.stringify(xo));
    assert.match(xo.content[0].text, /wrong_element/);
    // A designMode frame is an editor too.
    value(await callTool('navigate', { url: fixtureUrl + '/designframe', tabId }));
    await new Promise((r) => setTimeout(r, 800));
    const dm = value(await callTool('fill', { selector: '#dm', value: 'designed', tabId }));
    assert.equal(dm.applied, 'yes', JSON.stringify(dm));
    // ...while a framed rich editor (a contenteditable body) still fills.
    value(await callTool('navigate', { url: fixtureUrl + '/editorframe', tabId }));
    await until(
      async () =>
        value(await callTool('wait_for', { selector: '#ed', timeoutMs: 1000, tabId })).found,
      'editor frame',
    );
    await new Promise((r) => setTimeout(r, 500));
    value(await callTool('fill', { selector: '#ed', value: 'hello editor', tabId }));
    // ...and a form that advances focus to a password field after a CORRECT
    // write is not mistaken for text landing in it.
    value(await callTool('navigate', { url: fixtureUrl + '/card', tabId }));
    const card = value(
      await callTool('fill', {
        selector: '#card',
        value: '4111111111111111',
        method: 'insertText',
        tabId,
      }),
    );
    assert.equal(card.applied, 'yes', JSON.stringify(card));
    console.log('PASS: MCP fill refuses to type through a frame into its password field');
    // A ref must not cross a navigation the page started itself (#7).
    const bUrl = fixtureUrl.replace('127.0.0.1', 'localhost');
    await popupEval(
      `chrome.storage.local.set({sallyport_allowlist:[` +
        `{pattern:${JSON.stringify(fixtureUrl + '/*')},allowEvaluate:false,addedAt:Date.now()},` +
        `{pattern:${JSON.stringify(bUrl + '/*')},allowEvaluate:false,addedAt:Date.now()}]})`,
    );
    value(await callTool('navigate', { url: fixtureUrl + '/xsite-a', tabId }));
    const siteA = value(await callTool('snapshot', { compact: true, tabId }));
    const aRefs = siteA.elements.filter((e) => /^A button/.test(e.name)).map((e) => e.ref);
    const link = siteA.elements.find((e) => e.name === 'Go to B')?.ref;
    assert.ok(aRefs.length >= 10 && link, JSON.stringify(siteA.elements));
    // The PAGE navigates (the link's own default action), not a tool.
    value(await callTool('click', { selector: link, tabId }));
    assert.ok(
      value(await callTool('wait_for', { text: 'B page', timeoutMs: 10000, tabId })).found,
      'the link did not reach site B',
    );
    // Give the new document node ids without touching the ref map, as any
    // later call would: key_type's focus walk reads the whole AX tree (nothing
    // is focused, so it refuses — the ids are assigned all the same).
    const noFocus = await callTool('key_type', { text: 'x', tabId });
    assert.equal(noFocus.isError, true, JSON.stringify(noFocus));
    const stale = [];
    for (const ref of aRefs) stale.push(await callTool('click', { selector: ref, tabId }));
    for (const r of stale) {
      assert.equal(r.isError, true, JSON.stringify(r));
      assert.match(r.content[0].text, /bad_ref/);
    }
    // Not vacuous: the old ids DID resolve on the new page — only the document
    // check stood between them and a click on site B.
    assert.ok(
      stale.some((r) => /issued for a different page/.test(r.content[0].text)),
      JSON.stringify(stale.map((r) => r.content[0].text)),
    );
    const clicks = value(await callTool('get_state', { selector: '#clicks', tabId }));
    assert.equal(clicks.text, '0', 'a stale ref clicked something on site B');
    // …and a fresh snapshot keeps counting, so the old numbers never come back.
    const siteB = value(await callTool('snapshot', { compact: true, tabId }));
    const maxA = Math.max(...siteA.elements.map((e) => Number(e.ref.slice(2))));
    for (const e of siteB.elements) assert.ok(Number(e.ref.slice(2)) > maxA, e.ref);
    console.log('PASS: MCP refs from a page that navigated itself cross-site are refused');
    const audit = await popupEval(
      'chrome.storage.local.get("sallyport_audit").then(value => value.sallyport_audit)',
    );
    assert.ok(audit.some((row) => row.tool === 'click' && row.ok));
    assert.ok(!JSON.stringify(audit).includes('do-not-record'));
    console.log(
      'PASS: MCP stdio → HMAC WebSocket → real Chrome actions, allowlist/password gates and audit redaction',
    );
  }
  console.log(`Browser smoke test passed (${version.Browser}).`);
} finally {
  await mcp?.close();
  socket?.close();
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    const exited = once(browser, 'exit');
    browser.kill('SIGTERM');
    const force = setTimeout(() => browser.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(force);
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((done) => server.close(done));
  await rm(temp, { recursive: true, force: true });
}
