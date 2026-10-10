// Host side of the "calcs" studio tab: status of every calculation in the
// workspace (PySCF geom_NNNN/result.json sets, ORCA .out files, other JSON
// with a `converged` key), generalizing uv-vis webapp/v_status.py.
//
// State lives in the host for the lifetime of the panel: one CalcCache per
// group directory (parsed files are re-used while (mtime, size) is
// unchanged), the file list of every scanned root (kept current from
// watcher events, so a refresh does not list 3·10⁴ files again), and the
// latest groups for the detail requests. Must not import 'vscode'.

import * as fs from 'fs';
import * as path from 'path';
import type { Disposable, HostContext, TabHost } from '../../context';
import { CALC_STATUSES, CalcCache, CalcGroup, CalcStatus, readCalcGroups, summarizeGroup } from '../../../chem/calcStatus';
import { matchesAny } from '../runs/glob';
import { isAllowedPath, isInside, isUserChosen } from '../../paths';
import type {
  CalcStatusName, CalcTotals, FailedListParams, GroupDetail, GroupRow, ProblemsParams, ProblemsResult, ScanParams, ScanResult, TimeStats
} from './types';

export const DEFAULT_CALC_GLOBS = ['**/result.json', '**/*.out'];
const DEFAULT_EXCLUDE = '**/{node_modules,.git}/**';
const CHANGE_DEBOUNCE_MS = 1000;
const YIELD_EVERY_MS = 40;

const caseless = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => (caseless ? path.resolve(p).toLowerCase() : path.resolve(p));

export { isInside };

function emptyCounts(): Record<CalcStatusName, number> {
  return Object.fromEntries(CALC_STATUSES.map(s => [s, 0])) as Record<CalcStatusName, number>;
}

/** Key of the group a file belongs to: the set directory for geom_NNNN/result.json, else its directory. */
function groupKey(file: string): string {
  const dir = path.dirname(file);
  if (path.basename(file).toLowerCase() === 'result.json' && /^geom_\d+$/.test(path.basename(dir))) {
    return path.dirname(dir);
  }
  return dir;
}

const isCalcFile = (f: string) => /\.(out|json)$/i.test(f);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Stats and a histogram of ascending times (seconds). */
export function timeStats(sorted: number[]): TimeStats | undefined {
  const n = sorted.length;
  if (n === 0) return undefined;
  const min = sorted[0];
  const max = sorted[n - 1];
  const p10 = quantile(sorted, 0.1);
  const p90 = quantile(sorted, 0.9);
  // Freedman–Diaconis bin width, clamped to 8..60 bins.
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  let bins = iqr > 0 ? Math.ceil((max - min) / (2 * iqr * Math.cbrt(n))) : Math.ceil(Math.sqrt(n));
  bins = Math.max(Math.min(15, Math.max(5, 2 * n)), Math.min(80, bins || 1));
  const span = max - min || Math.max(1, Math.abs(max) * 0.1);
  const lo = max === min ? min - span / 2 : min;
  const width = span / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * width);
  const values = new Array<number>(bins).fill(0);
  for (const t of sorted) values[Math.min(bins - 1, Math.max(0, Math.floor((t - lo) / width)))]++;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  return { n, min, p10, median: sorted[n >> 1], p90, max, mean, edges, values };
}

const groupId = (g: CalcGroup) => `${g.kind}:${g.dir}`;
/** Normalized map key of a group id (kind prefix, then the directory). */
const idKey = (id: string) => {
  const i = id.indexOf(':');
  return `${id.slice(0, i)}:${norm(id.slice(i + 1))}`;
};

function configString(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function toRow(g: CalcGroup, label: string): GroupRow {
  const s = summarizeGroup(g);
  const row: GroupRow = { id: groupId(g), dir: g.dir, label, kind: g.kind, counts: { ...g.counts }, total: s.total };
  if (s.medianTimeS !== undefined) row.medianTimeS = s.medianTimeS;
  if (s.maxTimeS !== undefined) row.maxTimeS = s.maxTimeS;
  const method = configString(g.config?.method);
  const basis = configString(g.config?.basis);
  if (method) row.method = method;
  if (basis) row.basis = basis;
  return row;
}

/** Merge ascending arrays. */
function mergeSorted(arrays: number[][]): number[] {
  return arrays.flat().sort((a, b) => a - b);
}

/** run_config.json for display: long arrays and objects are shortened. */
function displayConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (Array.isArray(v) && v.length > 12) out[k] = `[${v.length} items]`;
    else if (v && typeof v === 'object') {
      const s = JSON.stringify(v);
      out[k] = s.length > 400 ? `${s.slice(0, 400)}…` : v;
    } else if (typeof v === 'string' && v.length > 4000) out[k] = `${v.slice(0, 4000)}…`;
    else out[k] = v;
  }
  return out;
}

interface Scope {
  key: string;
  roots: string[];
  skipped: string[];
}

interface CachedResult {
  version: number;
  result: ScanResult;
}

/** One instance per panel (the module exports one; tests create their own). */
export function createCalcsHost(opts: { debounceMs?: number } = {}): TabHost {
  const debounceMs = opts.debounceMs ?? CHANGE_DEBOUNCE_MS;
  const caches = new Map<string, CalcCache>();
  /** Files matching the globs per listed root (normalized root key → absolute paths). */
  const lists = new Map<string, { root: string; files: Set<string> }>();
  const groups = new Map<string, { group: CalcGroup; label: string }>();
  const results = new Map<string, CachedResult>();
  const inflight = new Map<string, Promise<ScanResult>>();
  /** Folders the user picked with "Add folder…" (may lie outside the workspace). */
  const picked = new Set<string>();
  const extraWatchers = new Map<string, Disposable>();
  let version = 0;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCtx: HostContext | undefined;

  const globs = (ctx: HostContext) => {
    const g = ctx.config<string[]>('studio.calcGlobs', DEFAULT_CALC_GLOBS);
    return Array.isArray(g) && g.length ? g.filter(s => typeof s === 'string' && s.trim()) : DEFAULT_CALC_GLOBS;
  };

  const allowed = (ctx: HostContext, dir: string) =>
    isAllowedPath(ctx, dir) || [...picked].some(p => isInside(dir, p));

  /** Apply queued watcher events to the file lists; returns how many paths changed. */
  const flush = (ctx: HostContext): number => {
    const changed = pending;
    pending = new Set();
    if (changed.size === 0) return 0;
    const exclude = ctx.config<string>('runs.exclude', DEFAULT_EXCLUDE);
    for (const file of changed) {
      const exists = fs.existsSync(file);
      for (const { root, files } of lists.values()) {
        if (!isInside(file, root)) continue;
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (exists && !matchesAny(rel, [exclude])) files.add(file);
        else if (!exists) files.delete(file);
      }
    }
    version++;
    return changed.size;
  };

  const onFsEvent = (ctx: HostContext) => (file: string) => {
    pending.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const n = flush(ctx);
      if (n) ctx.post('changed', { files: n });
    }, debounceMs);
  };

  const watchFolder = (ctx: HostContext, folder: string) => {
    const key = norm(folder);
    if (extraWatchers.has(key) || ctx.workspaceFolders().some(w => isInside(folder, w))) return;
    const subs = globs(ctx).map(g => ctx.watch(g, onFsEvent(ctx), folder));
    extraWatchers.set(key, { dispose: () => subs.forEach(s => s.dispose()) });
  };

  const resolveScope = (ctx: HostContext, p: ScanParams): Scope => {
    const skipped: string[] = [];
    const scope = typeof p.scope === 'string' && p.scope && p.scope !== 'all' ? p.scope : 'all';
    if (scope !== 'all') {
      let dir = path.resolve(scope);
      if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
      if (!allowed(ctx, dir)) throw new Error(`${dir} is outside the workspace; add it with "Add folder…" first`);
      if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist`);
      return { key: norm(dir), roots: [dir], skipped };
    }
    const roots = ctx.workspaceFolders().map(w => path.resolve(w));
    for (const f of Array.isArray(p.extraFolders) ? p.extraFolders : []) {
      if (typeof f !== 'string' || !f) continue;
      const dir = path.resolve(f);
      if (roots.some(r => isInside(dir, r))) continue;
      if ((!picked.has(norm(dir)) && !isUserChosen(dir)) || !fs.existsSync(dir)) {
        skipped.push(dir);
        continue;
      }
      roots.push(dir);
    }
    return { key: `all|${roots.map(norm).join('|')}`, roots, skipped };
  };

  /** Matching files under `root`, from a cached list when one covers it. */
  const listRoot = async (ctx: HostContext, root: string, refresh: boolean): Promise<{ files: string[]; listed: boolean }> => {
    if (!refresh) {
      for (const l of lists.values()) {
        if (isInside(root, l.root)) {
          const files = [...l.files].filter(f => isInside(f, root));
          return { files, listed: false };
        }
      }
    }
    const found = await Promise.all(globs(ctx).map(g => ctx.findFiles(g, { base: root })));
    const set = new Set(found.flat());
    lists.set(norm(root), { root, files: set });
    // A wider list replaces the narrower ones it covers.
    for (const [k, l] of lists) if (k !== norm(root) && isInside(l.root, root)) lists.delete(k);
    return { files: [...set], listed: true };
  };

  const doScan = async (ctx: HostContext, scope: Scope, refresh: boolean): Promise<ScanResult> => {
    const t0 = Date.now();
    if (pending.size) flush(ctx);
    const startVersion = version;
    ctx.post('progress', { phase: 'listing', done: 0, total: scope.roots.length });
    const perRoot: { root: string; files: string[] }[] = [];
    let listMs = 0;
    for (const root of scope.roots) {
      const tl = Date.now();
      const { files, listed } = await listRoot(ctx, root, refresh);
      if (listed) listMs += Date.now() - tl;
      perRoot.push({ root, files });
      ctx.post('progress', { phase: 'listing', done: perRoot.length, total: scope.roots.length });
    }
    const fileCount = perRoot.reduce((n, r) => n + r.files.length, 0);
    const multi = scope.roots.length > 1;
    const rows: GroupRow[] = [];
    const seen = new Set<string>();
    let parsed = 0;
    let reused = 0;
    let done = 0;
    let lastYield = Date.now();
    for (const { root, files } of perRoot) {
      const byGroup = new Map<string, string[]>();
      for (const f of files) {
        if (!isCalcFile(f)) continue;
        const k = groupKey(f);
        const a = byGroup.get(k);
        if (a) a.push(f); else byGroup.set(k, [f]);
      }
      for (const [dir, list] of byGroup) {
        const key = norm(dir);
        if (seen.has(key)) continue;
        seen.add(key);
        let cache = caches.get(key);
        if (!cache) caches.set(key, (cache = new CalcCache()));
        for (const g of readCalcGroups(root, list, cache)) {
          const label = multi ? `${path.basename(root)}/${g.label === '.' ? '' : g.label}`.replace(/\/$/, '') : g.label === '.' ? path.basename(g.dir) : g.label;
          groups.set(idKey(groupId(g)), { group: g, label });
          rows.push(toRow(g, label));
        }
        parsed += cache.stats.parsed;
        reused += cache.stats.reused;
        done += list.length;
        if (Date.now() - lastYield > YIELD_EVERY_MS) {
          ctx.post('progress', { phase: 'reading', done, total: fileCount });
          await new Promise(r => setImmediate(r));
          lastYield = Date.now();
        }
      }
    }
    // Drop caches of groups that vanished from the scanned roots.
    for (const k of [...caches.keys()]) {
      if (!seen.has(k) && scope.roots.some(r => isInside(k, r))) caches.delete(k);
    }
    const produced = new Set(rows.map(r => idKey(r.id)));
    for (const k of [...groups.keys()]) {
      if (!produced.has(k) && scope.roots.some(r => isInside(groups.get(k)!.group.dir, r))) groups.delete(k);
    }
    rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) || a.kind.localeCompare(b.kind));
    const counts = emptyCounts();
    for (const r of rows) for (const s of CALC_STATUSES) counts[s] += r.counts[s];
    const times = mergeSorted(rows.map(r => groups.get(idKey(r.id))?.group.times ?? []));
    const totals: CalcTotals = { total: rows.reduce((n, r) => n + r.total, 0), counts };
    if (times.length) {
      totals.medianTimeS = times[times.length >> 1];
      totals.maxTimeS = times[times.length - 1];
    }
    const result: ScanResult = {
      scope: scope.key.startsWith('all|') ? 'all' : scope.roots[0],
      roots: scope.roots,
      groups: rows,
      totals,
      fileCount,
      parsed,
      reused,
      durationMs: Date.now() - t0,
      listMs,
      cached: false,
      scannedAt: Date.now(),
      skipped: scope.skipped,
      globs: globs(ctx)
    };
    results.set(scope.key, { version: startVersion, result });
    return result;
  };

  const findGroup = (id: unknown) => {
    if (typeof id !== 'string' || !/^(pyscf-result|orca-out|json):./.test(id)) throw new Error('a group id is required');
    const g = groups.get(idKey(id));
    if (!g) throw new Error(`no calculations known for ${id} (scan first)`);
    return g;
  };

  const statusFilter = (status: unknown) => (status === undefined || status === 'all'
    ? (s: CalcStatus) => s !== 'ok'
    : (CALC_STATUSES as string[]).includes(String(status)) ? (s: CalcStatus) => s === status : (() => { throw new Error(`unknown status ${String(status)}`); })());

  const problems = (p: ProblemsParams): ProblemsResult => {
    const { group } = findGroup(p?.id);
    const keep = statusFilter(p?.status);
    const limit = Math.max(1, Math.min(5000, Number.isFinite(p?.limit) ? Number(p.limit) : 2000));
    const all = group.items.filter(i => keep(i.status));
    return {
      total: all.length,
      items: all.slice(0, limit).map(i => {
        const o: ProblemsResult['items'][number] = { name: i.name, status: i.status, path: i.path };
        if (i.detail) o.detail = i.detail.length > 600 ? `${i.detail.slice(0, 600)}…` : i.detail;
        if (i.timeS !== undefined) o.timeS = i.timeS;
        return o;
      })
    };
  };

  return {
    id: 'calcs',
    activate(ctx) {
      activeCtx = ctx;
      const subs = globs(ctx).map(g => ctx.watch(g, onFsEvent(ctx)));
      return {
        dispose() {
          subs.forEach(s => s.dispose());
          extraWatchers.forEach(s => s.dispose());
          extraWatchers.clear();
          if (timer) clearTimeout(timer);
          timer = undefined;
          if (activeCtx === ctx) activeCtx = undefined;
        }
      };
    },
    methods: {
      /** Groups and totals of a scope; returns the previous result when nothing changed. */
      async scan(params: ScanParams, ctx) {
        const p = params ?? {};
        const scope = resolveScope(ctx, p);
        const refresh = p.refresh === true;
        if (pending.size) flush(ctx);
        const prev = results.get(scope.key);
        if (!refresh && prev && prev.version === version) {
          return { ...prev.result, cached: true, durationMs: 0, listMs: 0, skipped: scope.skipped };
        }
        const running = inflight.get(scope.key);
        if (running) return running;
        const job = doScan(ctx, scope, refresh).finally(() => inflight.delete(scope.key));
        inflight.set(scope.key, job);
        return job;
      },

      /** run_config, time histogram and the first problems of one group. */
      group(params: { id: string; status?: CalcStatusName | 'all'; limit?: number }): GroupDetail {
        const { group, label } = findGroup(params?.id);
        const detail: GroupDetail = {
          row: toRow(group, label),
          problems: problems({ id: groupId(group), status: params?.status, limit: params?.limit })
        };
        if (group.config) detail.config = displayConfig(group.config);
        const t = timeStats(group.times);
        if (t) detail.times = t;
        return detail;
      },

      problems: (params: ProblemsParams) => problems(params),

      /** Names of the non-ok (or `status`) items, one per line — to rerun them. */
      failedList(params: FailedListParams): string {
        const { group } = findGroup(params?.id);
        const keep = statusFilter(params?.status);
        return group.items.filter(i => keep(i.status)).map(i => i.name).join('\n');
      },

      /** Folder picker; picked folders may lie outside the workspace. */
      async addFolder(_params: unknown, ctx) {
        const dirs = await ctx.pickFiles({ title: 'Add folders with calculations', canSelectFolders: true, canSelectFiles: false, canSelectMany: true });
        const out: string[] = [];
        for (const d of dirs ?? []) {
          const dir = path.resolve(d);
          picked.add(norm(dir));
          watchFolder(activeCtx ?? ctx, dir);
          out.push(dir);
        }
        return out;
      },

      /** The settings the tab shows (globs). */
      settings(_params: unknown, ctx) {
        return { globs: globs(ctx), exclude: ctx.config<string>('runs.exclude', DEFAULT_EXCLUDE), workspaceFolders: ctx.workspaceFolders() };
      }
    }
  };
}

export const host: TabHost = createCalcsHost();
