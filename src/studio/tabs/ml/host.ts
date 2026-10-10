// Host side of the "ml" studio tab: builds worker configs from the form
// (src/ml/spec.ts), creates / starts / stops / deletes runs and reads their
// results (src/ml/runs.ts). Runs live in <storageDir>/ml_runs, the feature
// cache in <storageDir>/ml_cache. Never imports 'vscode'.

import * as fs from 'fs';
import * as path from 'path';
import type { HostContext, TabHost } from '../../context';
import { buildConfig, MAX_JOBS, type MlConfig, type MlForm } from '../../../ml/spec';
import * as runs from '../../../ml/runs';
import { rememberPicked, resolveUserPath } from './paths';
import type {
  CompareRow, CsvHeader, CsvHeaderParams, EnvCheck, MlInit, PickParams, Predictions, ReadRunParams, RunDetail,
  RunSummary, StartParams, StartResult
} from './types';

// Compile-time check: the webview mirrors in ./types stay compatible with src/ml/runs.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const typesInSync: [Same<RunSummary, runs.RunSummary>, Same<RunDetail, runs.RunDetail>, Same<EnvCheck, runs.EnvCheck>] = [true, true, true];
void typesInSync;

export function pythonPath(ctx: HostContext): string {
  return String(ctx.config('studio.pythonPath', 'python') || 'python');
}

export function maxJobs(ctx: HostContext): number {
  const v = Number(ctx.config('studio.ml.maxJobs', MAX_JOBS));
  return Number.isFinite(v) && v >= 1 ? Math.trunc(v) : MAX_JOBS;
}

export function workerPath(ctx: HostContext): string {
  return path.join(ctx.extensionPath, 'python', 'ml_worker.py');
}

function storage(ctx: HostContext): string {
  const s = ctx.storageDir();
  if (!s) throw new Error('open a workspace folder first: ML runs are stored in <workspace>/.orbital');
  return s;
}

export function runsDir(ctx: HostContext): string {
  return path.join(storage(ctx), 'ml_runs');
}

// ------------------------------------------------------------------ environment check (cached per interpreter)

const envCache = new Map<string, Promise<EnvCheck>>();

function checkEnv(ctx: HostContext, refresh: boolean): Promise<EnvCheck> {
  const py = pythonPath(ctx);
  const key = `${py}\n${workerPath(ctx)}`;
  if (refresh || !envCache.has(key)) {
    envCache.set(key, runs.checkEnvironment(py, workerPath(ctx)));
  }
  return envCache.get(key)!;
}

// ------------------------------------------------------------------ CSV header

/** Split one CSV line (comma separated, double-quoted fields with "" escapes). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const headerCache = new Map<string, { mtimeMs: number; header: boolean; result: CsvHeader }>();

export function readCsvHeader(file: string, header: boolean): CsvHeader {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`not a file: ${file}`);
  const hit = headerCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.header === header) return hit.result;
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error(`empty CSV: ${file}`);
  const first = splitCsvLine(lines[0]);
  const columns = header ? first.map((c, i) => c || `column ${i}`) : first.map((_, i) => `column ${i}`);
  const data = header ? lines.slice(1) : lines;
  const row = data.length ? splitCsvLine(data[0]) : [];
  const numeric = columns.map((_, i) => row[i] !== undefined && row[i] !== '' && Number.isFinite(Number(row[i])));
  const result: CsvHeader = { path: file, columns, rows: data.length, numeric };
  headerCache.set(file, { mtimeMs: st.mtimeMs, header, result });
  return result;
}

// ------------------------------------------------------------------ form <-> config

/** Paths of the form resolved (inside the workspace or picked) — relative paths are workspace-relative. */
function resolveForm(ctx: HostContext, form: MlForm): MlForm {
  const f: MlForm = JSON.parse(JSON.stringify(form));
  const res = (p: unknown) => (typeof p === 'string' && p.trim() ? resolveUserPath(ctx, p) : p);
  f.data.xyz = res(f.data.xyz) as string;
  f.data.csv = res(f.data.csv) as string;
  if (f.rep?.params && typeof f.rep.params.path === 'string' && f.rep.params.path.trim()) {
    f.rep.params.path = res(f.rep.params.path) as string;
  }
  return f;
}

const text = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : String(v));

/** Form values that reproduce a config ("duplicate as new run"). */
export function configToForm(cfg: MlConfig): MlForm {
  const params = (p: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, typeof v === 'boolean' ? v : text(v)]));
  return {
    name: cfg.name ? `${cfg.name} (copy)`.slice(0, 60) : '',
    data: {
      xyz: cfg.data.xyz ?? '', csv: cfg.data.csv, column: cfg.data.column, header: cfg.data.header,
      n_mol: cfg.data.n_mol === null ? '' : String(cfg.data.n_mol)
    },
    rep: { name: cfg.rep.name, params: params(cfg.rep.params), variance: cfg.rep.variance, scale: cfg.rep.scale },
    model: { name: cfg.model.name, params: params(cfg.model.params), grid: cfg.model.grid },
    split: { test_size: text(cfg.split.test_size), seed: text(cfg.split.seed), cv: text(cfg.split.cv), curve: text(cfg.split.curve) },
    n_jobs: text(cfg.n_jobs)
  };
}

function stride<T>(a: T[] | undefined, step: number): T[] {
  return (a ?? []).filter((_, i) => i % step === 0);
}

/** Predictions with every series thinned to at most maxPoints (same stride for y and y_pred). */
export function thinPredictions(p: Predictions | null, maxPoints: number): Predictions | null {
  if (!p) return p;
  const s1 = Math.max(1, Math.ceil((p.y_train?.length ?? 0) / maxPoints));
  const s2 = Math.max(1, Math.ceil((p.y_test?.length ?? 0) / maxPoints));
  return {
    y_train: stride(p.y_train, s1), y_train_pred: stride(p.y_train_pred, s1),
    y_test: stride(p.y_test, s2), y_test_pred: stride(p.y_test_pred, s2)
  };
}

function requireId(id: unknown): string {
  if (!runs.isValidRunId(id)) throw new Error(`invalid run id: ${JSON.stringify(id)}`);
  return id;
}

// ------------------------------------------------------------------ methods

export const host: TabHost = {
  id: 'ml',
  methods: {
    init(_p: unknown, ctx: HostContext): MlInit {
      const s = ctx.storageDir();
      return {
        maxJobs: maxJobs(ctx), pythonPath: pythonPath(ctx), hasStorage: Boolean(s),
        runsDir: s ? path.join(s, 'ml_runs') : null, workspaceFolders: ctx.workspaceFolders()
      };
    },

    checkEnv(p: { refresh?: boolean } | undefined, ctx: HostContext): Promise<EnvCheck> {
      return checkEnv(ctx, Boolean(p?.refresh));
    },

    async pick(p: PickParams, ctx: HostContext): Promise<string | null> {
      const filters: Record<PickParams['kind'], Record<string, string[]>> = {
        xyz: { 'Multi-XYZ': ['xyz'], 'All files': ['*'] },
        csv: { CSV: ['csv', 'txt'], 'All files': ['*'] },
        features: { 'Feature matrix': ['npy', 'npz', 'csv', 'txt', 'dat'], 'All files': ['*'] }
      };
      const kind = p?.kind in filters ? p.kind : 'csv';
      const titles = { xyz: 'Molecules (multi-XYZ)', csv: 'Targets (CSV)', features: 'Feature matrix' };
      const got = await ctx.pickFiles({ title: titles[kind], canSelectFiles: true, canSelectMany: false, filters: filters[kind] });
      if (!got.length) return null;
      rememberPicked(got);
      return got[0];
    },

    csvHeader(p: CsvHeaderParams, ctx: HostContext): CsvHeader {
      const file = resolveUserPath(ctx, p?.path);
      return readCsvHeader(file, p?.header !== false);
    },

    /** Validate without starting (also checks that the files exist). */
    validate(p: StartParams, ctx: HostContext) {
      const form = resolveForm(ctx, p.form);
      const r = buildConfig(form, { maxJobs: maxJobs(ctx), fileExists: f => fs.existsSync(f) });
      return { errors: r.errors };
    },

    async start(p: StartParams, ctx: HostContext): Promise<StartResult> {
      let form: MlForm;
      try {
        form = resolveForm(ctx, p?.form);
      } catch (e) {
        return { ok: false, errors: [{ field: '', message: (e as Error).message }] };
      }
      const cacheDir = path.join(storage(ctx), 'ml_cache');
      const r = buildConfig(form, { cacheDir, maxJobs: maxJobs(ctx), fileExists: f => fs.existsSync(f) });
      if (!r.config) return { ok: false, errors: r.errors };
      const dir = runsDir(ctx);
      const { id, dir: runDir } = runs.createRun(dir, r.config);
      ctx.log(`ml: run ${id} created (${r.config.rep.name} + ${r.config.model.name})`);
      const pid = await runs.startRun(pythonPath(ctx), workerPath(ctx), runDir);
      return { ok: true, id, pid };
    },

    list(_p: unknown, ctx: HostContext): RunSummary[] {
      const s = ctx.storageDir();
      return s ? runs.listRuns(path.join(s, 'ml_runs')) : [];
    },

    read(p: ReadRunParams, ctx: HostContext): RunDetail {
      const d = runs.readRun(runsDir(ctx), requireId(p?.id), { logLines: Math.min(Math.max(Number(p?.logLines) || 120, 1), 2000) });
      return { ...d, pred: thinPredictions(d.pred, Math.max(100, Number(p?.maxPoints) || 4000)) };
    },

    formOf(p: { id: string }, ctx: HostContext): MlForm {
      return configToForm(runs.readRun(runsDir(ctx), requireId(p?.id), { logLines: 1 }).config);
    },

    async stop(p: { id: string }, ctx: HostContext) {
      return runs.stopRun(runs.runDirOf(runsDir(ctx), requireId(p?.id)));
    },

    async remove(p: { id: string }, ctx: HostContext): Promise<void> {
      await runs.deleteRun(runsDir(ctx), requireId(p?.id), { force: true });
    },

    compare(p: { ids: string[] }, ctx: HostContext): CompareRow[] {
      const ids = Array.isArray(p?.ids) ? p.ids.slice(0, 40) : [];
      return ids.map(id => {
        const d = runs.readRun(runsDir(ctx), requireId(id), { logLines: 1 });
        return {
          id, name: d.config.name || id, rep: String(d.config.rep.name), model: String(d.config.model.name),
          test: d.result?.test ?? null, cv_mae: d.result?.cv_mae ?? null, curve: d.result?.curve ?? []
        };
      });
    },

    async exportCsv(_p: unknown, ctx: HostContext): Promise<string | undefined> {
      return ctx.saveFile({ defaultName: 'ml_runs.csv', data: runs.runsCsv(runsDir(ctx)), filters: { CSV: ['csv'] } });
    },

    async exportPredictions(p: { id: string; set?: 'test' | 'train' }, ctx: HostContext): Promise<string | undefined> {
      const id = requireId(p?.id);
      const d = runs.readRun(runsDir(ctx), id, { logLines: 1 });
      if (!d.pred) throw new Error(`run ${id} has no predictions yet`);
      const set = p.set === 'train' ? 'train' : 'test';
      return ctx.saveFile({ defaultName: `${id}_${set}_predictions.csv`, data: runs.predictionsCsv(d.pred, set), filters: { CSV: ['csv'] } });
    },

    async openLog(p: { id: string }, ctx: HostContext): Promise<void> {
      const dir = runs.runDirOf(runsDir(ctx), requireId(p?.id));
      await ctx.openFile({ path: path.join(dir, 'log.txt'), beside: true });
    }
  }
};
