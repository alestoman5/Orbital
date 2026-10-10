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
const globCache = new Map<string, RegExp>();
/** Glob -> RegExp (**, *, ?, {a,b}, [..]), compiled once: path.matchesGlob per file made listings take seconds. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) {
    return re;
  }
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      depth++;
      out += '(?:';
    } else if (c === '}' && depth > 0) {
      depth--;
      out += ')';
    } else if (c === ',' && depth > 0) {
      out += '|';
    } else if (c === '[' && glob.indexOf(']', i) > i) {
      const end = glob.indexOf(']', i);
      out += glob.slice(i, end + 1);
      i = end;
    } else {
      out += /[.+^$()|\\\]]/.test(c) ? `\\${c}` : c;
    }
  }
  re = new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
  globCache.set(glob, re);
  return re;
}
const matches = (p: string, glob: string) => globToRegExp(glob).test(p.replace(/\\/g, '/'));

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
      const full = (d: fs.Dirent) => path.join((d as any).parentPath ?? (d as any).path, d.name);
      const entries = (fs as any).globSync(include, {
        cwd: base,
        withFileTypes: true,
        exclude: (d: fs.Dirent) => {
          const rel = path.relative(base, full(d));
          return matches(rel, exclude) || matches(`${rel}/`, exclude);
        }
      }) as fs.Dirent[];
      for (const d of entries) {
        if (d.isFile()) {
          found.push(full(d));
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
    runInTerminal(p) {
      log(`runInTerminal (${p.cwd ?? o.workspace}): ${p.command}`);
    },
    activeEditorPath: () => undefined,
    log
  };
}
