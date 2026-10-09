// HostContext for the dev harness: the real tab hosts run in plain Node
// against a workspace folder on disk (see server.mjs). Mirrors
// src/studio/vscodeContext.ts without the VS Code API.

import * as fs from 'fs';
import * as path from 'path';
import type { Disposable, FindFilesOptions, HostContext } from '../../src/studio/context';
import type { TabId } from '../../src/studio/protocol';

export interface DevOptions {
  workspace: string;
  extensionPath: string;
  /** Settings without the "orcaInp." prefix. */
  settings: Record<string, unknown>;
  broadcast(channel: TabId | 'studio', name: string, payload?: unknown): void;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const matches = (p: string, glob: string) => (path as any).matchesGlob(p.replace(/\\/g, '/'), glob) as boolean;

/** Defaults of every orcaInp.* setting from package.json and contrib/*.json, overridden by `overrides`. */
export function loadSettings(extensionPath: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const take = (props: Record<string, { default?: unknown }> | undefined) => {
    for (const [k, v] of Object.entries(props ?? {})) {
      out[k.replace(/^orcaInp\./, '')] = v.default;
    }
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
  take(pkg.contributes?.configuration?.properties);
  const contrib = path.join(extensionPath, 'contrib');
  if (fs.existsSync(contrib)) {
    for (const f of fs.readdirSync(contrib).filter(f => f.endsWith('.json'))) {
      try {
        take(JSON.parse(fs.readFileSync(path.join(contrib, f), 'utf8')).configuration);
      } catch (e) {
        console.error(`contrib/${f}: ${e}`);
      }
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    out[k.replace(/^orcaInp\./, '')] = v;
  }
  return out;
}

export function createNodeContext(tab: TabId, o: DevOptions): HostContext {
  const log = (m: string) => process.stderr.write(`[${tab}] ${m}\n`);
  const config = <T>(key: string, fallback: T): T => (key in o.settings && o.settings[key] !== undefined ? (o.settings[key] as T) : fallback);
  return {
    tab,
    extensionPath: o.extensionPath,
    workspaceFolders: () => [o.workspace],
    storageDir() {
      const d = path.join(o.workspace, '.orbital');
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    config,
    async findFiles(include: string, options: FindFilesOptions = {}) {
      const base = options.base ?? o.workspace;
      const exclude = options.exclude ?? config('runs.exclude', '**/{node_modules,.git}/**');
      const found: string[] = [];
      const files = (fs as any).globSync(include, {
        cwd: base,
        exclude: (p: string) => matches(typeof p === 'string' ? p : String(p), exclude) || matches(`${p}/`, exclude)
      }) as string[];
      for (const rel of files) {
        const abs = path.join(base, rel);
        if (!matches(rel, exclude) && fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) {
          found.push(abs);
          if (options.max && found.length >= options.max) {
            break;
          }
        }
      }
      return found.sort(natural);
    },
    watch(include: string, onChange: (p: string) => void, base?: string): Disposable {
      const root = base ?? o.workspace;
      let w: fs.FSWatcher | undefined;
      try {
        w = fs.watch(root, { recursive: true }, (_e, name) => {
          if (name && matches(String(name), include)) {
            onChange(path.join(root, String(name)));
          }
        });
      } catch (e) {
        log(`watch ${root} failed: ${e}`);
      }
      return { dispose: () => w?.close() };
    },
    post: (name, payload) => o.broadcast(tab, name, payload),
    navigate: (t, args) => o.broadcast('studio', 'navigate', { tab: t, args }),
    async saveFile(p) {
      const target = p.path ?? path.join(o.workspace, '.orbital', 'dev-exports', p.defaultName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, p.encoding === 'base64' ? Buffer.from(p.data, 'base64') : p.data);
      log(`saved ${target}`);
      return target;
    },
    async openFile(p) {
      log(`openFile ${p.path}${p.line !== undefined ? `:${p.line + 1}` : ''} (dev harness: not opened)`);
    },
    async pickFiles(p) {
      log(`pickFiles "${p.title ?? ''}" (dev harness: returns [] — pass files via ?args= instead)`);
      return [];
    },
    async confirm(p) {
      log(`confirm "${p.message}" -> yes (dev harness)`);
      return true;
    },
    notify(p) {
      log(`${p.level}: ${p.message}`);
      o.broadcast('studio', 'devNotify', p);
    },
    log
  };
}
