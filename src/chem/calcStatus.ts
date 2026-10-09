// "Calculation status" across ensembles and single runs, generalizing the
// uv-vis web app's status tab (webapp/v_status.py, which only knew
// geom_*/result.json): PySCF result.json sets (geom_NNNN directories, the
// layout of neaRun.ts), ORCA .out files (parseOrcaOutput + summarizeRun),
// and any other JSON with a boolean `converged` key. Files are parsed once
// and re-used while their (mtimeMs, size) is unchanged (CalcCache), so a
// workspace with 3·10⁴ result.json files refreshes with one stat per file.
// Pure Node (fs), no `vscode` import.

import * as fs from 'fs';
import * as path from 'path';
import { parseOrcaOutput } from '../outparser/parse';
import { summarizeRun } from '../features/runSummary';

export type CalcStatus = 'ok' | 'not converged' | 'error' | 'running' | 'unreadable' | 'not started';
export const CALC_STATUSES: CalcStatus[] = ['ok', 'not converged', 'error', 'running', 'unreadable', 'not started'];

export interface CalcItem {
  /** geom_NNNN for PySCF sets, the file name otherwise. */
  name: string;
  status: CalcStatus;
  /** File to open: geom_NNNN/run.log (if present) or result.json; the .out; the .json. For a not-started geometry without run.log, its directory. */
  path: string;
  /** Wall time in seconds (time_adc_s / other time_*_s; ORCA TOTAL RUN TIME). */
  timeS?: number;
  /** `failure` of a result.json, or the ORCA verdict and problems. */
  detail?: string;
}

export type CalcGroupKind = 'pyscf-result' | 'orca-out' | 'json';

export interface CalcGroup {
  dir: string;
  /** dir relative to the scan root, '/'-separated ('.' for the root itself). */
  label: string;
  kind: CalcGroupKind;
  items: CalcItem[];
  counts: Record<CalcStatus, number>;
  /** timeS of the ok items, ascending. */
  times: number[];
  /** run_config.json of dir or its parent (as neaRuns.ts neaOverview reads it). */
  config?: Record<string, unknown>;
}

const isGeomDir = (name: string) => /^geom_\d+$/.test(name);

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function statOf(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/** Seconds from a result JSON: time_adc_s, else time_total_s, else the first numeric time_*_s. */
function timeOf(r: Record<string, unknown>): number | undefined {
  for (const k of ['time_adc_s', 'time_total_s']) {
    if (typeof r[k] === 'number') return r[k] as number;
  }
  for (const [k, v] of Object.entries(r)) {
    if (/^time_.*_s$/.test(k) && typeof v === 'number') return v;
  }
  return undefined;
}

interface JsonInfo {
  /** undefined: unparseable or not an object. */
  converged?: boolean;
  hasConvergedKey: boolean;
  parsed: boolean;
  timeS?: number;
  failure?: string;
}

interface OrcaInfo {
  status: CalcStatus;
  timeS?: number;
  detail?: string;
}

interface Entry<T> {
  mtimeMs: number;
  size: number;
  value: T;
  gen: number;
}

function readJsonInfo(file: string): JsonInfo {
  let r: unknown;
  try {
    r = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { parsed: false, hasConvergedKey: false };
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    return { parsed: false, hasConvergedKey: false };
  }
  const o = r as Record<string, unknown>;
  return {
    parsed: true,
    hasConvergedKey: typeof o.converged === 'boolean',
    converged: Boolean(o.converged),
    timeS: timeOf(o),
    failure: typeof o.failure === 'string' ? o.failure : undefined
  };
}

const ORCA_SIGNATURE = /\*\s*O\s+R\s+C\s+A\s*\*|Program Version\s+\d|ORCA TERMINATED|INPUT FILE|aborting the run/i;

/**
 * Status of one ORCA output. Order of the checks: empty or not ORCA →
 * unreadable; no termination banner → running (or killed); SCF or
 * optimization not converged → not converged (even when ORCA then
 * aborted, which it usually does for the SCF); "aborting the run" → error;
 * otherwise ok (saddle points or high T1 keep ok, with the verdict in detail).
 */
export function orcaCalcStatus(text: string): OrcaInfo {
  if (text.trim() === '' || !ORCA_SIGNATURE.test(text)) {
    return { status: 'unreadable', detail: text.trim() === '' ? 'empty file' : 'not an ORCA output' };
  }
  const parsed = parseOrcaOutput(text);
  const s = summarizeRun(parsed);
  let status: CalcStatus;
  if (parsed.status === 'unknown') status = 'unreadable';
  else if (parsed.status === 'running') status = 'running';
  else if (s.scfConverged === false || s.optConverged === false) status = 'not converged';
  else if (parsed.status === 'error') status = 'error';
  else status = 'ok';
  const detail = s.problems.length ? `${s.verdict}: ${s.problems.join('; ')}` : s.verdict;
  return { status, timeS: parsed.totalRunTimeSeconds, detail };
}

/**
 * Parsed-file cache keyed by path and validated by (mtimeMs, size). Entries
 * not seen in the latest readCalcGroups call are dropped. `stats` counts
 * how many files the last call parsed vs. reused.
 */
export class CalcCache {
  readonly json = new Map<string, Entry<JsonInfo & { runLog: boolean }>>();
  readonly orca = new Map<string, Entry<OrcaInfo>>();
  readonly configs = new Map<string, Entry<Record<string, unknown> | undefined>>();
  gen = 0;
  stats = { parsed: 0, reused: 0 };

  lookup<T>(map: Map<string, Entry<T>>, file: string, st: fs.Stats, load: () => T): T {
    const e = map.get(file);
    if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) {
      e.gen = this.gen;
      this.stats.reused++;
      return e.value;
    }
    const value = load();
    map.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, gen: this.gen });
    this.stats.parsed++;
    return value;
  }

  begin(): void {
    this.gen++;
    this.stats = { parsed: 0, reused: 0 };
  }

  prune(): void {
    for (const map of [this.json, this.orca, this.configs] as Map<string, Entry<unknown>>[]) {
      for (const [k, e] of map) if (e.gen !== this.gen) map.delete(k);
    }
  }
}

function emptyCounts(): Record<CalcStatus, number> {
  return Object.fromEntries(CALC_STATUSES.map(s => [s, 0])) as Record<CalcStatus, number>;
}

function finishGroup(dir: string, root: string, kind: CalcGroupKind, items: CalcItem[], config?: Record<string, unknown>): CalcGroup {
  items.sort((a, b) => naturalCompare(a.name, b.name));
  const counts = emptyCounts();
  const times: number[] = [];
  for (const it of items) {
    counts[it.status]++;
    if (it.status === 'ok' && it.timeS !== undefined) times.push(it.timeS);
  }
  times.sort((a, b) => a - b);
  const rel = path.relative(root, dir).split(path.sep).join('/');
  const group: CalcGroup = { dir, label: rel === '' ? '.' : rel, kind, items, counts, times };
  if (config) group.config = config;
  return group;
}

function readConfig(dir: string, cache: CalcCache): Record<string, unknown> | undefined {
  for (const d of [dir, path.dirname(dir)]) {
    const file = path.join(d, 'run_config.json');
    const st = statOf(file);
    if (!st) continue;
    const cfg = cache.lookup(cache.configs, file, st, () => {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    });
    if (cfg) return cfg;
  }
  return undefined;
}

/**
 * One PySCF set: every geom_NNNN directory of `dir`, classified with the
 * rules of readGeomSet (neaRun.ts) and scripts/nea/batch.py status():
 * no result.json → not started, unparseable → unreadable, converged falsy
 * → not converged, else ok. (readGeomSet itself is not called because it
 * re-parses every file and keeps no per-geometry time or failure.)
 */
function pyscfGroup(dir: string, root: string, cache: CalcCache): CalcGroup {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && isGeomDir(e.name)).map(e => e.name);
  } catch {
    names = [];
  }
  const items: CalcItem[] = [];
  for (const name of names) {
    const gdir = path.join(dir, name);
    const result = path.join(gdir, 'result.json');
    const runLog = path.join(gdir, 'run.log');
    const st = statOf(result);
    if (!st) {
      items.push({ name, status: 'not started', path: statOf(runLog) ? runLog : gdir });
      continue;
    }
    const info = cache.lookup(cache.json, result, st, () => ({ ...readJsonInfo(result), runLog: fs.existsSync(runLog) }));
    const item: CalcItem = {
      name,
      status: !info.parsed ? 'unreadable' : info.converged ? 'ok' : 'not converged',
      path: info.runLog ? runLog : result
    };
    if (info.parsed && info.timeS !== undefined) item.timeS = info.timeS;
    if (info.failure) item.detail = info.failure;
    items.push(item);
  }
  return finishGroup(dir, root, 'pyscf-result', items, readConfig(dir, cache));
}

/**
 * Builds calculation groups from files found by a workspace glob
 * (`**\/result.json`, `**\/*.out`, other `*.json`), using and refreshing
 * `cache`:
 * - result.json in a geom_NNNN directory: one 'pyscf-result' group per set
 *   (the directory holding the geom_NNNN dirs), including geometries
 *   without result.json ('not started'). A set whose geometries all lack
 *   result.json is not found from the file list.
 * - *.out: one 'orca-out' group per directory (orcaCalcStatus).
 * - other *.json with a boolean `converged`: one 'json' group per
 *   directory; a result.json outside geom_NNNN that cannot be parsed is
 *   listed as unreadable, other unparseable JSON is ignored, and
 *   run_config.json is never an item.
 * Groups are sorted by label, items by name (natural order).
 */
export function readCalcGroups(root: string, files: string[], cache: CalcCache = new CalcCache()): CalcGroup[] {
  cache.begin();
  const sets = new Set<string>();
  const outs = new Map<string, string[]>();
  const jsons = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const a = m.get(k);
    if (a) a.push(v); else m.set(k, [v]);
  };
  for (const f of files) {
    const base = path.basename(f);
    const dir = path.dirname(f);
    const lower = base.toLowerCase();
    if (lower === 'result.json' && isGeomDir(path.basename(dir))) {
      sets.add(path.dirname(dir));
    } else if (lower.endsWith('.out')) {
      push(outs, dir, f);
    } else if (lower.endsWith('.json') && lower !== 'run_config.json') {
      push(jsons, dir, f);
    }
  }
  const groups: CalcGroup[] = [];
  for (const dir of sets) groups.push(pyscfGroup(dir, root, cache));
  for (const [dir, list] of outs) {
    const items: CalcItem[] = [];
    for (const f of list) {
      const st = statOf(f);
      if (!st) continue;
      const info = cache.lookup(cache.orca, f, st, () => {
        try {
          return orcaCalcStatus(fs.readFileSync(f, 'utf8'));
        } catch {
          return { status: 'unreadable', detail: 'cannot read file' } as OrcaInfo;
        }
      });
      const item: CalcItem = { name: path.basename(f), status: info.status, path: f };
      if (info.timeS !== undefined) item.timeS = info.timeS;
      if (info.detail) item.detail = info.detail;
      items.push(item);
    }
    if (items.length) groups.push(finishGroup(dir, root, 'orca-out', items, readConfig(dir, cache)));
  }
  for (const [dir, list] of jsons) {
    const items: CalcItem[] = [];
    for (const f of list) {
      const st = statOf(f);
      if (!st) continue;
      const info = cache.lookup(cache.json, f, st, () => ({ ...readJsonInfo(f), runLog: false }));
      const name = path.basename(f);
      if (!info.parsed) {
        if (name.toLowerCase() === 'result.json') items.push({ name, status: 'unreadable', path: f });
        continue;
      }
      if (!info.hasConvergedKey) continue;
      const item: CalcItem = { name, status: info.converged ? 'ok' : 'not converged', path: f };
      if (info.timeS !== undefined) item.timeS = info.timeS;
      if (info.failure) item.detail = info.failure;
      items.push(item);
    }
    if (items.length) groups.push(finishGroup(dir, root, 'json', items, readConfig(dir, cache)));
  }
  cache.prune();
  return groups.sort((a, b) => naturalCompare(a.label, b.label) || a.kind.localeCompare(b.kind));
}

/** readCalcGroups with the argument order of the spec; a fresh cache unless one is given. */
export function groupsFromFiles(files: string[], root: string, cache?: CalcCache): CalcGroup[] {
  return readCalcGroups(root, files, cache);
}

export interface GroupSummary {
  total: number;
  /** ok / total (NaN for an empty group). */
  okFrac: number;
  /** times[floor(n/2)] of the ok items, as webapp/v_status.py shows it (upper median for even n). */
  medianTimeS?: number;
  maxTimeS?: number;
  /** Every item that is not ok, in item order. */
  problems: CalcItem[];
}

export function summarizeGroup(group: CalcGroup): GroupSummary {
  const total = group.items.length;
  const t = group.times;
  return {
    total,
    okFrac: total ? group.counts.ok / total : NaN,
    medianTimeS: t.length ? t[t.length >> 1] : undefined,
    maxTimeS: t.length ? t[t.length - 1] : undefined,
    problems: group.items.filter(i => i.status !== 'ok')
  };
}
