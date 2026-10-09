// Orbital Studio dev harness: serves the webview in a normal browser and runs
// the REAL tab hosts (src/studio/tabs/*/host.ts) in Node against a folder on
// disk, so UI work and screenshots need no Extension Development Host.
//
//   npm run dev:webview -- [--workspace ../../uv-vis] [--port 5173] [--settings dev-settings.json]
//
// Open http://localhost:5173/?tab=spectra&theme=dark   (theme: dark | light | hc)
//      ...&args=<url-encoded JSON>  is passed to the tab like a 'navigate' from a command.
// Both bundles rebuild on change; reload the page to pick them up.

import * as esbuild from 'esbuild';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyStatic, webviewOptions } from '../../esbuild.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const defaultWs = [resolve(root, '..', 'uv-vis'), process.cwd()].find(existsSync);
const workspace = resolve(arg('workspace', defaultWs));
const port = Number(arg('port', '5173'));
const settingsFile = arg('settings', undefined);
const hostOut = join(root, 'out', 'webview-dev', 'host.cjs');
const require = createRequire(import.meta.url);

// --- bundles -------------------------------------------------------------------

copyStatic();
const web = await esbuild.context({ ...webviewOptions, minify: false, sourcemap: 'inline', logLevel: 'warning' });
await web.watch();

let host;
const loadHost = () => {
  delete require.cache[hostOut];
  host = require(hostOut);
};
const hostCtx = await esbuild.context({
  entryPoints: [join(root, 'webview', 'dev', 'hostEntry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: hostOut,
  sourcemap: 'inline',
  logLevel: 'warning',
  // Tab hosts must not use 'vscode'; the test mock keeps an accidental import from crashing the harness.
  alias: { vscode: join(root, 'test', 'mocks', 'vscode.ts') },
  plugins: [{
    name: 'reload-host',
    setup(b) {
      b.onEnd(r => {
        if (r.errors.length === 0) {
          try {
            loadHost();
            contexts.clear();
            activateAll();
            console.log('[dev] host reloaded');
          } catch (e) {
            console.error('[dev] host load failed', e);
          }
        }
      });
    }
  }]
});

// --- host contexts -------------------------------------------------------------

const clients = new Set();
const broadcast = (channel, name, payload) => {
  const data = `data: ${JSON.stringify({ kind: 'event', channel, name, payload })}\n\n`;
  clients.forEach(res => res.write(data));
};
const contexts = new Map();
let activations = [];
const settings = () => host.loadSettings(root, settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {});
const contextFor = tab => {
  if (!contexts.has(tab)) {
    contexts.set(tab, host.createNodeContext(tab, { workspace, extensionPath: root, settings: settings(), broadcast }));
  }
  return contexts.get(tab);
};
function activateAll() {
  activations.forEach(d => d?.dispose?.());
  activations = Object.values(host.TAB_HOSTS).map(t => {
    try {
      return t.activate?.(contextFor(t.id));
    } catch (e) {
      console.error(`[dev] activate ${t.id}`, e);
    }
  });
}
await hostCtx.watch();

const info = () => ({ workspaceFolders: [workspace], colorTheme: 'dark', platform: process.platform, extensionVersion: 'dev' });

// --- HTTP ----------------------------------------------------------------------

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.pdf': 'application/pdf' };

function serveFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, join(root, 'webview', 'dev', 'index.html'));
  }
  if (url.pathname === '/dev-client.js') {
    return serveFile(res, join(root, 'webview', 'dev', 'dev-client.js'));
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/rpc' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const msg = JSON.parse(body);
    const out = msg.channel === 'studio'
      ? await host.dispatchStudioRequest(msg, contextFor, info)
      : await host.dispatchTabRequest(msg, contextFor);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }
  // Static: /out/webview/*, /media/*, and /fs/<abs path> for files of the workspace (images, PDFs).
  if (url.pathname.startsWith('/out/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/webview/dev/')) {
    return serveFile(res, join(root, decodeURIComponent(url.pathname)));
  }
  if (url.pathname.startsWith('/fs/')) {
    const p = resolve(decodeURIComponent(url.pathname.slice(4)));
    return p.startsWith(workspace) ? serveFile(res, p) : res.writeHead(403).end('outside workspace');
  }
  res.writeHead(404).end('not found');
}).listen(port, '127.0.0.1', () => {
  console.log(`[dev] Orbital Studio on http://localhost:${port}/?tab=spectra   workspace: ${workspace}`);
});
