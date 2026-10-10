// Bundles the Orbital Studio webview (webview/src/main.ts -> out/webview/).
// The extension itself is still compiled by tsc (npm run compile runs both).
//
//   node esbuild.mjs            one production build
//   node esbuild.mjs --watch    rebuild on change
//   node esbuild.mjs --dev      unminified, with source maps

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const outdir = 'out/webview';

/** @type {esbuild.BuildOptions} */
export const webviewOptions = {
  entryPoints: { studio: 'webview/src/main.ts' },
  bundle: true,
  outdir,
  format: 'iife',
  platform: 'browser',
  target: ['chrome114'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.otf': 'file', '.svg': 'text' },
  assetNames: 'assets/[name]-[hash]',
  logLevel: 'info'
};

/** Static files the webview loads by URL rather than through the bundle. */
export function copyStatic() {
  mkdirSync(outdir, { recursive: true });
  const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
  copyFileSync(join(pdfjs, 'build', 'pdf.worker.min.mjs'), join(outdir, 'pdf.worker.min.mjs'));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  copyStatic();
  if (watch) {
    const ctx = await esbuild.context(webviewOptions);
    await ctx.watch();
  } else {
    await esbuild.build(webviewOptions);
  }
}
