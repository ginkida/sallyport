import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

/** Tiny JSON-RPC stdio client for the optional full-browser integration test. */
export function startMcp(python, args, sourceDir) {
  const child = spawn(python, ['-m', 'sallyport_daemon', ...args], {
    env: { ...process.env, PYTHONPATH: sourceDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0;
  let stderr = '';
  let failure;
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const fail = (error) => {
    failure = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code) => fail(new Error(`MCP daemon exited (${code}): ${stderr}`)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error('Daemon emitted non-JSON data on MCP stdout'));
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  return {
    request(method, params = {}) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP timeout: ${method} ${params.name ?? ''}\n${stderr}`));
        }, 45000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    async close() {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.stdin.end();
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(force);
      }
      lines.close();
    },
  };
}
