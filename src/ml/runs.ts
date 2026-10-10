// ML runs on disk: <runsDir>/<id>/{config.json, status.json, spawn.json, result.json, pred.json,
// pred.npz, log.txt}. Creates, starts (detached python/ml_worker.py), stops, lists and reads runs.
// Node fs + child_process only (no vscode), so the dev harness and the tests use it directly.
//
// Who writes what:
//   config.json  createRun                  (schema: header of src/ml/spec.ts)
//   status.json  createRun ('created'), startRun ('starting'), the worker ('running' -> 'done' |
//                'failed', with step, pid, progress), stopRun ('stopped')
//   spawn.json   startRun: { pid, started, python, worker } of the spawned process (on Windows a
//                venv python.exe is a launcher whose child is the real worker, so both pids count)
//   log.txt      the worker's stdout + stderr
//   result.json, pred.json, pred.npz  the worker (see python/ml_worker.py)
//
// Run ids come from the webview: every function that takes an id validates it with RUN_ID
// (/^[\w-]{1,100}$/) and resolves the folder strictly inside runsDir.

import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandLineOf, isAlive, killTree } from './proc';
import type { MlConfig } from './spec';
import { targetLabel } from './spec';

export type RunState = 'created' | 'starting' | 'running' | 'done' | 'failed' | 'stopped';

export interface RunStatus {
  state: RunState;
  step: string;
  /** Worker process id (written by the worker). */
  pid?: number;
  /** 0..1 */
  progress?: number;
  created?: string;
  started?: string;
  updated?: string;
  finished?: string;
  error?: string;
}

export interface Metrics { mae: number; rmse: number; r2: number }

export interface RunResult {
  n_features: number;
  time_features_s: number;
  n_train: number;
  n_test: number;
  best_params: Record<string, unknown>;
  grid?: Array<Record<string, unknown> & { cv_mae: number }>;
  cv_mae?: number;
  time_search_s?: number;
  time_fit_s: number;
  fitted_kernel?: string;
  train: Metrics;
  test: Metrics;
  time_predict_s: number;
  curve?: { n: number; test_mae: number }[];
  warnings?: string[];
}

export interface Predictions {
  y_train: (number | null)[];
  y_train_pred: (number | null)[];
  y_test: (number | null)[];
  y_test_pred: (number | null)[];
  /** Molecule indices (0-based, after the n_mol cap) of the train/test sets. */
  idx_train?: number[];
  idx_test?: number[];
}

export interface RunSummary {
  id: string;
  name: string;
  state: RunState;
  step: string;
  progress: number | null;
  created: string | null;
  rep: string;
  model: string;
  grid: boolean;
  /** 'targets.csv:E' */
  target: string;
  n_train: number | null;
  n_test: number | null;
  n_features: number | null;
  train: Metrics | null;
  test: Metrics | null;
  cv_mae: number | null;
  hasCurve: boolean;
  error: string | null;
}

export interface RunDetail {
  id: string;
  dir: string;
  config: MlConfig;
  status: RunStatus;
  result: RunResult | null;
  pred: Predictions | null;
  /** Last lines of log.txt. */
  log: string;
}

export interface EnvCheck {
  ok: boolean;
  python: string | null;
  executable?: string;
  /** Version or null per package: numpy, scipy, pandas, sklearn, joblib, threadpoolctl, dscribe, ase, xgboost. */
  packages: Record<string, string | null>;
  missing_required: string[];
  /** Set when the interpreter could not be run or its output was not understood. */
  error?: string;
}

export const RUN_ID = /^[\w-]{1,100}$/;

export function isValidRunId(id: unknown): id is string {
  return typeof id === 'string' && RUN_ID.test(id);
}

/** Folder of run `id`; throws on an invalid id (never resolves outside runsDir). */
export function runDirOf(runsDir: string, id: unknown): string {
  if (!isValidRunId(id)) throw new Error(`invalid run id: ${JSON.stringify(id)}`);
  const root = path.resolve(runsDir);
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root) throw new Error(`invalid run id: ${JSON.stringify(id)}`);
  return dir;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** 'YYYYMMDD-HHMMSS' in local time, as the original web app. */
export function newRunId(now: Date = new Date()): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// ------------------------------------------------------------------ JSON files

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename, retried while Windows has the target open). */
export function writeJsonAtomic(file: string, obj: unknown, indent?: number): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      const until = Date.now() + 25;
      while (Date.now() < until) { /* short busy wait: the reader closes the file within ms */ }
    }
  }
}

function mergeStatus(dir: string, patch: Partial<RunStatus>): RunStatus {
  const file = path.join(dir, 'status.json');
  const s = { ...(readJson<RunStatus>(file) ?? { state: 'created', step: '' }), ...patch };
  writeJsonAtomic(file, s);
  return s;
}

function nowIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface SpawnInfo { pid?: number; started?: string; python?: string; worker?: string }

/**
 * status.json corrected for dead processes: 'running' whose worker pid is gone -> 'failed'
 * ('process died'); 'starting' whose spawned process is gone -> 'failed' (see the log).
 */
export function readStatus(dir: string): RunStatus {
  const s = readJson<RunStatus>(path.join(dir, 'status.json')) ?? { state: 'created', step: '' };
  if (s.state === 'running' && !isAlive(s.pid)) {
    return { ...s, state: 'failed', step: 'process died' };
  }
  if (s.state === 'starting') {
    const sp = readJson<SpawnInfo>(path.join(dir, 'spawn.json'));
    if (sp && !isAlive(sp.pid)) {
      // the worker may have finished between the two reads: read once more
      const again = readJson<RunStatus>(path.join(dir, 'status.json'));
      if (again && again.state !== 'starting') return again.state === 'running' && !isAlive(again.pid)
        ? { ...again, state: 'failed', step: 'process died' } : again;
      return { ...s, state: 'failed', step: 'worker exited before it started (see the log)' };
    }
  }
  return s;
}

// ------------------------------------------------------------------ create / list / read

/** New run folder with config.json and status 'created'. Id collisions get a -2, -3, ... suffix. */
export function createRun(runsDir: string, config: MlConfig, now: Date = new Date()): { id: string; dir: string } {
  fs.mkdirSync(runsDir, { recursive: true });
  const base = newRunId(now);
  for (let k = 1; k < 1000; k++) {
    const id = k === 1 ? base : `${base}-${k}`;
    const dir = runDirOf(runsDir, id);
    try {
      fs.mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    writeJsonAtomic(path.join(dir, 'config.json'), config, 1);
    writeJsonAtomic(path.join(dir, 'status.json'), { state: 'created', step: '', created: nowIso() });
    return { id, dir };
  }
  throw new Error('could not find a free run id');
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function summarize(id: string, dir: string): RunSummary | null {
  const cfg = readJson<MlConfig>(path.join(dir, 'config.json'));
  if (!cfg || typeof cfg !== 'object' || !cfg.data || !cfg.rep || !cfg.model) return null;
  const st = readStatus(dir);
  const res = readJson<Partial<RunResult>>(path.join(dir, 'result.json')) ?? {};
  let created = st.created ?? null;
  if (!created) {
    try { created = fs.statSync(path.join(dir, 'config.json')).mtime.toISOString().slice(0, 19); } catch { /* none */ }
  }
  return {
    id,
    name: typeof cfg.name === 'string' ? cfg.name : '',
    state: st.state,
    step: st.step ?? '',
    progress: isNum(st.progress) ? st.progress : null,
    created,
    rep: String(cfg.rep.name),
    model: String(cfg.model.name),
    grid: Boolean(cfg.model.grid),
    target: typeof cfg.data.csv === 'string' ? targetLabel(cfg) : '',
    n_train: isNum(res.n_train) ? res.n_train : null,
    n_test: isNum(res.n_test) ? res.n_test : null,
    n_features: isNum(res.n_features) ? res.n_features : null,
    train: res.train ?? null,
    test: res.test ?? null,
    cv_mae: isNum(res.cv_mae) ? res.cv_mae : null,
    hasCurve: Array.isArray(res.curve) && res.curve.length > 0,
    error: st.state === 'failed' ? (st.error ?? st.step ?? null) : null
  };
}

/** All runs (folders with a readable config.json), newest first. Missing runsDir -> []. */
export function listRuns(runsDir: string): RunSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const id of names) {
    if (!isValidRunId(id)) continue;
    const dir = path.join(runsDir, id);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const s = summarize(id, dir);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '') || b.id.localeCompare(a.id));
}

/** Last `lines` lines of a text file ('' when missing); reads at most the last 256 KiB. */
export function tailFile(file: string, lines = 200): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const all = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Everything about one run. Throws when the id is invalid or the run has no config. */
export function readRun(runsDir: string, id: string, opts: { logLines?: number } = {}): RunDetail {
  const dir = runDirOf(runsDir, id);
  const config = readJson<MlConfig>(path.join(dir, 'config.json'));
  if (!config) throw new Error(`run not found: ${id}`);
  return {
    id,
    dir,
    config,
    status: readStatus(dir),
    result: readJson<RunResult>(path.join(dir, 'result.json')),
    pred: readJson<Predictions>(path.join(dir, 'pred.json')),
    log: tailFile(path.join(dir, 'log.txt'), opts.logLines ?? 200)
  };
}

// ------------------------------------------------------------------ start / stop / delete

export interface StartOptions {
  /** Extra environment variables for the worker. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Start `python worker <runDir>/config.json` detached (it survives the extension host), with
 * stdout + stderr appended to log.txt. Writes status 'starting' and spawn.json. Resolves with the
 * pid of the spawned process; rejects (and marks the run failed) when it cannot be spawned.
 */
export function startRun(pythonPath: string, workerPath: string, runDir: string, opts: StartOptions = {}): Promise<number> {
  const config = path.join(runDir, 'config.json');
  if (!fs.existsSync(config)) return Promise.reject(new Error(`no config.json in ${runDir}`));
  const st = readStatus(runDir);
  if (st.state === 'running' || st.state === 'starting') {
    return Promise.reject(new Error(`run is already ${st.state}`));
  }
  mergeStatus(runDir, { state: 'starting', step: 'starting python', progress: 0, error: undefined, finished: undefined });
  const log = fs.openSync(path.join(runDir, 'log.txt'), 'a');
  return new Promise<number>((resolve, reject) => {
    let child;
    const fail = (e: Error) => {
      try {
        fs.writeSync(log, `could not start ${pythonPath}: ${e.message}\n`);
        fs.closeSync(log);
      } catch { /* already closed */ }
      mergeStatus(runDir, { state: 'failed', step: `could not start python: ${e.message}`, error: e.message });
      reject(e);
    };
    try {
      child = spawn(pythonPath, [workerPath, config], {
        cwd: os.tmpdir(),   // neutral: Windows cannot delete a folder that is a live process's cwd
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...opts.env }
      });
    } catch (e) {
      fail(e as Error);
      return;
    }
    child.once('error', fail);
    child.once('spawn', () => {
      fs.closeSync(log);
      const pid = child.pid as number;
      writeJsonAtomic(path.join(runDir, 'spawn.json'), { pid, started: nowIso(), python: pythonPath, worker: workerPath });
      child.unref();
      resolve(pid);
    });
  });
}

/**
 * Kill the worker (and its joblib children, and the launcher) when it runs; marks the run
 * 'stopped'. Resolves with stopped = false when it was not running.
 */
export async function stopRun(runDir: string): Promise<{ stopped: boolean; state: RunState }> {
  const raw = readJson<RunStatus>(path.join(runDir, 'status.json'));
  const sp = readJson<SpawnInfo>(path.join(runDir, 'spawn.json'));
  if (!raw || (raw.state !== 'running' && raw.state !== 'starting')) {
    return { stopped: false, state: readStatus(runDir).state };
  }
  // status.json and spawn.json are plain files (a crashed worker leaves a stale pid that the OS
  // may reuse; a cloned repo can ship any pid): only kill processes that run this run's config.
  const pids: number[] = [];
  for (const pid of new Set([raw.pid, sp?.pid])) {
    if (typeof pid === 'number' && isAlive(pid) && await runsConfig(pid, runDir)) pids.push(pid);
  }
  for (const pid of pids) await killTree(pid);
  const after = readJson<RunStatus>(path.join(runDir, 'status.json'));
  if (after && (after.state === 'done' || after.state === 'failed') && pids.length === 0) {
    return { stopped: false, state: after.state };   // finished on its own meanwhile
  }
  mergeStatus(runDir, { state: 'stopped', step: 'stopped by user', finished: nowIso() });
  return { stopped: true, state: 'stopped' };
}

/** Does process `pid` run `<runDir>/config.json` (our worker, or the venv launcher in front of it)? */
async function runsConfig(pid: number, runDir: string): Promise<boolean> {
  const cmd = await commandLineOf(pid);
  if (!cmd) return false;
  const fold = (s: string) => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s).replace(/\\/g, '/');
  return fold(cmd).includes(fold(path.join(path.resolve(runDir), 'config.json')));
}

/** Delete a run folder. A running run is stopped first when force, else this throws. */
export async function deleteRun(runsDir: string, id: string, opts: { force?: boolean } = {}): Promise<void> {
  const dir = runDirOf(runsDir, id);
  if (!fs.existsSync(dir)) return;
  const st = readStatus(dir).state;
  if (st === 'running' || st === 'starting') {
    if (!opts.force) throw new Error(`run ${id} is ${st}; stop it first`);
    await stopRun(dir);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ------------------------------------------------------------------ environment check

/** Run `python worker --check` and parse its JSON. Never rejects: problems go to `error`. */
export function checkEnvironment(pythonPath: string, workerPath: string, timeoutMs = 30000): Promise<EnvCheck> {
  return new Promise(resolve => {
    const bad = (error: string): EnvCheck => ({ ok: false, python: null, packages: {}, missing_required: [], error });
    execFile(pythonPath, [workerPath, '--check'], {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return resolve(bad(`python not found: ${pythonPath}`));
      }
      if (err && err.killed) return resolve(bad(`no answer from ${pythonPath} within ${Math.round(timeoutMs / 1000)} s`));
      const line = String(stdout).split(/\r?\n/).reverse().find(l => l.trim().startsWith('{'));
      if (!line) {
        const msg = (String(stderr).trim().split(/\r?\n/).pop() || (err ? err.message : 'no output')).slice(0, 500);
        return resolve(bad(`${pythonPath} --check failed: ${msg}`));
      }
      try {
        const j = JSON.parse(line);
        const packages: Record<string, string | null> = j.packages && typeof j.packages === 'object' ? j.packages : {};
        const missing: string[] = Array.isArray(j.missing_required) ? j.missing_required : [];
        resolve({ ok: Boolean(j.ok) && missing.length === 0, python: j.python ?? null, executable: j.executable, packages, missing_required: missing });
      } catch (e) {
        resolve(bad(`could not parse the --check output: ${(e as Error).message}`));
      }
    });
  });
}

// ------------------------------------------------------------------ CSV exports

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** All finished runs as CSV (columns of the original runs.csv export). */
export function runsCsv(runsDir: string): string {
  const head = ['run', 'name', 'target', 'representation', 'model', 'n_train', 'n_test', 'n_features', 'test_mae',
    'test_rmse', 'test_r2', 'train_mae', 'cv_mae', 'time_features_s', 'time_fit_s', 'params'];
  const rows = [head.join(',')];
  for (const s of listRuns(runsDir).reverse()) {
    const dir = runDirOf(runsDir, s.id);
    const cfg = readJson<MlConfig>(path.join(dir, 'config.json'))!;
    const res = readJson<RunResult>(path.join(dir, 'result.json'));
    if (!res || !res.test) continue;
    const params = JSON.stringify({ rep: cfg.rep.params, model: res.best_params });
    rows.push([s.id, s.name, s.target, s.rep, s.model, res.n_train, res.n_test, res.n_features, res.test.mae,
      res.test.rmse, res.test.r2, res.train?.mae, res.cv_mae, res.time_features_s, res.time_fit_s, params].map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

/** Test-set predictions as CSV: reference,predicted. */
export function predictionsCsv(pred: Predictions, set: 'test' | 'train' = 'test'): string {
  const y = set === 'test' ? pred.y_test : pred.y_train;
  const p = set === 'test' ? pred.y_test_pred : pred.y_train_pred;
  return ['reference,predicted', ...y.map((v, k) => `${v ?? ''},${p[k] ?? ''}`)].join('\n') + '\n';
}
