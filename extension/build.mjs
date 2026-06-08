import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

if (existsSync(outdir)) {
  await rm(outdir, { recursive: true });
}
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  logLevel: 'info',
  sourcemap: 'linked',
};

const targets = [
  { entryPoints: ['src/background.ts'], outfile: `${outdir}/background.js` },
  { entryPoints: ['src/popup.ts'], outfile: `${outdir}/popup.js` },
];

await cp('manifest.json', `${outdir}/manifest.json`);
await cp('popup.html', `${outdir}/popup.html`);
await cp('popup.css', `${outdir}/popup.css`);
if (existsSync('icons')) {
  await cp('icons', `${outdir}/icons`, { recursive: true });
}

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context({ ...common, ...t });
    await ctx.watch();
  }
  console.log('watching...');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...common, ...t })));
  console.log('build complete:', outdir);
}
