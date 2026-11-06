// Host side of the "accel" studio tab (Accelerated UV/Vis): writes accel.json for the uv-vis
// driver scripts/accelerated.py, starts it (detached, or typed into a terminal and executed),
// stops it, and reads its state.json and stage outputs for the webview. Never imports 'vscode'.
//
// Work directories must lie inside a workspace folder or be chosen in a dialog; every file read
// for a project is resolved strictly inside its work directory.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Disposable, HostContext, TabHost } from '../../context';
import { allowUserPaths, isInside } from '../../paths';
import { rememberPicked, resolveUserPath } from '../ml/paths';
import { commandLineOf, isAlive, killTree } from '../../../ml/proc';
import { parseNeaSpectrum, parseTwoColumn } from '../../../chem/spectrumSets';
import {
  STAGES, STAGE_INFO, SAMPLING_LABELS, configToForm, formToConfig, runArgs, runCommand, validateForm,
  type AccelConfig, type AccelForm, type FieldError, type Stage, type StageStatus
} from '../../../accel/spec';
import type {
  AccelInit, ExciteProgress, GleEntry, PickParams, ProjectDetail, ProjectSummary, RunParams, RunResult, SaveParams,
  SaveResult, SpectrumCurve, StageState
} from './types';

const SCRIPT = 'accelerated.py';
const MAX_SPECTRUM_POINTS = 2000;

// ------------------------------------------------------------------ settings, scripts

export function pythonOf(ctx: HostContext): string {
  const own = String(ctx.config<string>('studio.accel.pythonPath', '') ?? '').trim();
  return own || String(ctx.config<string>('studio.pythonPath', 'python') || 'python');
}

export async function findScripts(ctx: HostContext): Promise<{ scriptsDir: string | null; source: AccelInit['source'] }> {
  const configured = String(ctx.config<string>('nea.scriptsDir', '') ?? '').trim();
  if (configured) {
    const dir = path.isAbsolute(configured) ? configured : path.resolve(ctx.workspaceFolders()[0] ?? '.', configured);
    return { scriptsDir: fs.existsSync(path.join(dir, SCRIPT)) ? dir : null, source: 'setting' };
  }
  const hits = await ctx.findFiles(`**/scripts/${SCRIPT}`, { max: 1, exclude: '**/{node_modules,.git}/**' });
  return hits.length ? { scriptsDir: path.dirname(hits[0]), source: 'search' } : { scriptsDir: null, source: 'none' };
}

async function scriptPath(ctx: HostContext): Promise<string> {
  const s = await findScripts(ctx);
  if (!s.scriptsDir) {
    throw new Error(`uv-vis scripts/${SCRIPT} not found: open the uv-vis repository in the workspace or set orcaInp.nea.scriptsDir`);
  }
  return path.join(s.scriptsDir, SCRIPT);
}

// ------------------------------------------------------------------ files

const jsonCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

/** Parsed JSON or null (missing / half-written); cached by (path, mtime, size). */
export function readJson<T>(file: string): T | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = jsonCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Absolute path of `rel` inside the work directory (throws when it would leave it). */
export function inWorkdir(workdir: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel) throw new Error('missing file');
  const abs = path.resolve(workdir, rel);
  if (!isInside(abs, workdir)) throw new Error(`not inside the work directory: ${rel}`);
  return abs;
}

function tail(file: string, maxLines: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8').split(/\r?\n/).slice(-maxLines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function resolveWorkdir(ctx: HostContext, p: unknown): string {
  return resolveUserPath(ctx, p);
}

function requireProject(ctx: HostContext, p: unknown): string {
  const wd = resolveWorkdir(ctx, p);
  if (!fs.existsSync(path.join(wd, 'accel.json'))) throw new Error(`no accel.json in ${wd}`);
  return wd;
}

// ------------------------------------------------------------------ state

interface StateFile { stages?: Partial<Record<Stage, StageState>>; updated?: string; pid?: number }

export function readStages(workdir: string): { stages: Record<Stage, StageState>; updated: string | null; pid: number | null } {
  const st = readJson<StateFile>(path.join(workdir, 'state.json')) ?? {};
  const stages = {} as Record<Stage, StageState>;
  for (const s of STAGES) stages[s] = { status: 'pending', ...(st.stages?.[s] ?? {}) } as StageState;
  return { stages, updated: st.updated ?? null, pid: typeof st.pid === 'number' ? st.pid : null };
}

/** Is the driver of this work directory alive? (pid from state.json, checked by command line.) */
async function driverAlive(pid: number | null): Promise<boolean> {
  if (!pid || !isAlive(pid)) return false;
  const cmd = await commandLineOf(pid, 3000);
  return cmd === undefined ? true : cmd.includes(SCRIPT);
}

async function runningOf(workdir: string): Promise<{ running: boolean; interrupted: boolean; pid: number | null }> {
  const { stages, pid } = readStages(workdir);
  const anyRunning = STAGES.some(s => stages[s].status === 'running');
  const alive = anyRunning && await driverAlive(pid);
  return { running: alive, interrupted: anyRunning && !alive, pid };
}

// ------------------------------------------------------------------ project data

function exciteProgress(workdir: string): ExciteProgress | null {
  const root = path.join(workdir, '04-excite', 'geoms');
  const sel = readJson<{ n_train: number }>(path.join(workdir, '04-excite', 'train_indices.json'));
  if (!sel) return null;
  let done = 0;
  let converged = 0;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root).filter(d => /^geom_\d+$/.test(d));
  } catch { /* not split yet */ }
  for (const d of dirs) {
    const r = readJson<{ converged?: boolean }>(path.join(root, d, 'result.json'));
    if (r) {
      done++;
      if (r.converged) converged++;
    }
  }
  const ex = readJson<{ nstates?: number }>(path.join(workdir, '04-excite', 'excite.json'));
  return { total: sel.n_train, done, converged, failed: done - converged, nstates: ex?.nstates ?? null };
}

function thin<T>(a: T[] | undefined, step: number): T[] | undefined {
  return a && step > 1 ? a.filter((_, i) => i % step === 0) : a;
}

function readSpectrum(file: string, kind: SpectrumCurve['kind'], label: string, n: number | null): SpectrumCurve | null {
  try {
    const s = parseNeaSpectrum(fs.readFileSync(file, 'utf8'), { unit: 'nm' });
    const step = Math.max(1, Math.ceil(s.x.length / MAX_SPECTRUM_POINTS));
    return { kind, label, file, n, x: thin(s.x, step)!, y: thin(s.y, step)!, lo: thin(s.lo, step), hi: thin(s.hi, step) };
  } catch {
    return null;
  }
}

function spectra(workdir: string, form: AccelForm): SpectrumCurve[] {
  const dir = path.join(workdir, '06-spectrum');
  const info = readJson<{ series: { kind: 'ml' | 'direct'; file: string; n: number }[] }>(path.join(dir, 'spectrum.json'));
  const out: SpectrumCurve[] = [];
  for (const s of info?.series ?? []) {
    const label = s.kind === 'ml' ? `ML-NEA (KRR, ${s.n} geometries)` : `direct NEA (${s.n} training geometries)`;
    const c = readSpectrum(inWorkdir(dir, s.file), s.kind, label, s.n);
    if (c) out.push(c);
  }
  if (form.spectrum.experiment) {
    try {
      const file = path.resolve(workdir, form.spectrum.experiment);
      const e = parseTwoColumn(fs.readFileSync(file, 'utf8'), { dropNonPositive: true });
      out.push({ kind: 'experiment', label: 'experiment', file, n: null, x: e.x, y: e.y });
    } catch { /* missing experiment file: no curve */ }
  }
  return out;
}

/** The webview shows and sends absolute paths; accel.json keeps them relative to the work directory. */
function absolutePaths(f: AccelForm, workdir: string): AccelForm {
  const abs = (p: string) => (p ? path.resolve(workdir, p) : p);
  return {
    ...f, geometry: abs(f.geometry),
    sampling: { ...f.sampling, glePathA: abs(f.sampling.glePathA), glePathC: abs(f.sampling.glePathC) },
    spectrum: { ...f.spectrum, experiment: abs(f.spectrum.experiment) }
  };
}

export async function projectDetail(workdir: string): Promise<ProjectDetail> {
  const cfg = readJson<AccelConfig>(path.join(workdir, 'accel.json'));
  if (!cfg) throw new Error(`accel.json in ${workdir} is not valid JSON`);
  const form = absolutePaths(configToForm(cfg, workdir), workdir);
  const { stages, updated } = readStages(workdir);
  const run = await runningOf(workdir);
  const j = <T>(...p: string[]) => readJson<T>(path.join(workdir, ...p));
  const sel = j<{ n_all: number; n_train: number; step: number }>('04-excite', 'train_indices.json');
  const log = tail(path.join(workdir, 'accel.log'), 200) || tail(path.join(workdir, 'accel.out'), 200);
  return {
    workdir, form, stages, updated, running: run.running, interrupted: run.interrupted, pid: run.pid,
    freqs: j('01-optfreq', 'freqs.json') ?? j('01-optfreq', 'freqs_imaginary.json'),
    minimum: j('02-minimum', 'states.json'),
    sampling: j('03-sampling', 'sampling.json') ?? (j('03-sampling', 'md', 'gle.json')
      ? { kind: form.sampling.kind, n_frames: 0, beads: form.sampling.beads, temperature: form.sampling.temperature, correlated: true, gle: j('03-sampling', 'md', 'gle.json')! }
      : null),
    selection: sel ? { n_all: sel.n_all, n_train: sel.n_train, step: sel.step } : null,
    excite: exciteProgress(workdir),
    mbtr: j('05-ml', 'mbtr.json'),
    krr: j('05-ml', 'krr.json'),
    spectrum: spectra(workdir, form),
    log
  };
}

export async function projectSummary(workdir: string): Promise<ProjectSummary | null> {
  const cfg = readJson<AccelConfig>(path.join(workdir, 'accel.json'));
  if (!cfg) return null;
  const { stages, updated } = readStages(workdir);
  const statuses = {} as Record<Stage, StageStatus>;
  for (const s of STAGES) statuses[s] = stages[s].status;
  const kind = String(cfg.sampling?.kind ?? 'wigner') as keyof typeof SAMPLING_LABELS;
  return {
    workdir, name: String(cfg.name || path.basename(workdir)), sampling: SAMPLING_LABELS[kind] ?? kind,
    method: `${cfg.excited?.method ?? '?'}/${cfg.excited?.basis ?? '?'}`, updated,
    stages: statuses, running: (await runningOf(workdir)).running
  };
}

async function listProjects(ctx: HostContext): Promise<ProjectSummary[]> {
  const files = await ctx.findFiles('**/accel.json', { max: 200, exclude: '**/{node_modules,.git,.orbital}/**' });
  const out: ProjectSummary[] = [];
  for (const f of files) {
    const s = await projectSummary(path.dirname(f));
    if (s) out.push(s);
  }
  return out.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
}

// ------------------------------------------------------------------ save

/** Path for accel.json: relative to the work directory when it is below it, else absolute. */
function relTo(workdir: string, abs: string): string {
  const rel = path.relative(workdir, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

export function saveProject(ctx: HostContext, form: AccelForm): SaveResult {
  const errors: FieldError[] = validateForm(form);
  if (errors.length) return { ok: false, errors };
  let workdir: string;
  try {
    workdir = resolveWorkdir(ctx, form.workdir);
  } catch (e) {
    return { ok: false, errors: [{ field: 'workdir', message: (e as Error).message }] };
  }
  const file = (field: string, p: string, required: boolean): string | null => {
    if (!p.trim()) return required ? (errors.push({ field, message: 'missing' }), null) : '';
    try {
      const abs = resolveUserPath(ctx, path.isAbsolute(p) ? p : path.resolve(workdir, p));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        errors.push({ field, message: `not found: ${abs}` });
        return null;
      }
      return relTo(workdir, abs);
    } catch (e) {
      errors.push({ field, message: (e as Error).message });
      return null;
    }
  };
  const geometry = file('geometry', form.geometry, true);
  const experiment = file('spectrum.experiment', form.spectrum.experiment, false);
  const gleA = form.sampling.gle === 'custom' && form.sampling.kind !== 'wigner' ? file('sampling.gle', form.sampling.glePathA, true) : '';
  const gleC = form.sampling.gle === 'custom' && form.sampling.kind !== 'wigner' ? file('sampling.gle', form.sampling.glePathC, true) : '';
  if (errors.length) return { ok: false, errors };
  const fixed: AccelForm = {
    ...form, workdir, geometry: geometry!,
    sampling: { ...form.sampling, glePathA: gleA ?? '', glePathC: gleC ?? '' },
    spectrum: { ...form.spectrum, experiment: experiment ?? '' }
  };
  const created = !fs.existsSync(workdir);
  fs.mkdirSync(workdir, { recursive: true });
  const target = path.join(workdir, 'accel.json');
  const old = readJson<AccelConfig>(target) ?? {};
  writeJsonAtomic(target, { ...old, ...formToConfig(fixed) });
  ctx.log(`accel: wrote ${target}`);
  return { ok: true, errors: [], workdir, created };
}

// ------------------------------------------------------------------ run / stop

export async function startRun(ctx: HostContext, p: RunParams): Promise<RunResult> {
  const workdir = requireProject(ctx, p?.workdir);
  const opts = {
    until: STAGES.includes(p?.until as Stage) ? p.until : undefined,
    only: STAGES.includes(p?.only as Stage) ? p.only : undefined,
    redo: STAGES.includes(p?.redo as Stage) ? p.redo : undefined
  };
  if ((await runningOf(workdir)).running) throw new Error('the pipeline of this work directory is already running');
  const script = await scriptPath(ctx);
  const python = pythonOf(ctx);
  const command = runCommand(python, script, workdir, opts);
  if (p?.terminal) {
    ctx.runInTerminal({ command, cwd: workdir, name: 'Accelerated UV/Vis', execute: true });
    return { command, terminal: true };
  }
  const out = fs.openSync(path.join(workdir, 'accel.out'), 'a');
  const pid = await new Promise<number>((resolve, reject) => {
    const child = spawn(python, runArgs(script, workdir, opts), {
      cwd: workdir, detached: true, stdio: ['ignore', out, out], windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    child.once('error', e => reject(new Error(`could not start ${python}: ${e.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid ?? 0);
    });
  }).finally(() => fs.closeSync(out));
  ctx.log(`accel: started ${command} (pid ${pid})`);
  return { command, pid, terminal: false };
}

export async function stopRun(ctx: HostContext, workdir: string): Promise<boolean> {
  const { pid } = readStages(workdir);
  if (!(await driverAlive(pid))) return false;
  const ok = await ctx.confirm({ message: 'Stop the accelerated UV/Vis pipeline?', action: 'Stop', detail: `pid ${pid} in ${workdir}; finished geometries are kept` });
  if (!ok) return false;
  await killTree(pid!);
  // the driver cannot record its own end: mark the running stage
  const file = path.join(workdir, 'state.json');
  const st = readJson<StateFile>(file) ?? {};
  for (const s of STAGES) {
    const e = st.stages?.[s];
    if (e?.status === 'running') {
      st.stages![s] = { ...e, status: 'failed', error: 'stopped from Orbital', finished: new Date().toISOString() };
    }
  }
  writeJsonAtomic(file, st);
  return true;
}

// ------------------------------------------------------------------ GLE library

export async function gleLibrary(ctx: HostContext, temperature: number): Promise<GleEntry[]> {
  const s = await findScripts(ctx);
  if (!s.scriptsDir) return [];
  const lib = readJson<{ matrices?: Record<string, any> }>(path.join(s.scriptsDir, 'gle', 'library.json'));
  const T = Number.isFinite(temperature) && temperature > 0 ? temperature : 300;
  return Object.entries(lib?.matrices ?? {}).map(([name, e]) => ({
    name, kind: String(e.kind ?? ''), description: String(e.description ?? ''), beads: Number(e.beads ?? 1),
    hwKT: typeof e.hw_kT === 'number' ? e.hw_kT : null,
    omegaMax: typeof e.hw_kT === 'number' ? e.hw_kT * 0.6950348 * T : null
  }));
}

// ------------------------------------------------------------------ methods

const PICK: Record<PickParams['kind'], { title: string; folders?: boolean; filters?: Record<string, string[]> }> = {
  geometry: { title: 'Start geometry', filters: { XYZ: ['xyz'], 'All files': ['*'] } },
  workdir: { title: 'Work directory of the pipeline', folders: true },
  experiment: { title: 'Experimental spectrum (nm, cross section)', filters: { Spectrum: ['dat', 'txt', 'csv'], 'All files': ['*'] } },
  gle: { title: 'GLE matrix (ABIN format)', filters: { 'All files': ['*'] } }
};

export const host: TabHost = {
  id: 'accel',
  methods: {
    async init(_p: unknown, ctx: HostContext): Promise<AccelInit> {
      const s = await findScripts(ctx);
      return { ...s, python: pythonOf(ctx), workspaceFolders: ctx.workspaceFolders(), projects: await listProjects(ctx) };
    },

    projects(_p: unknown, ctx: HostContext): Promise<ProjectSummary[]> {
      return listProjects(ctx);
    },

    load(p: { workdir: string }, ctx: HostContext): Promise<ProjectDetail> {
      return projectDetail(requireProject(ctx, p?.workdir));
    },

    validate(p: SaveParams): FieldError[] {
      return validateForm(p.form);
    },

    save(p: SaveParams, ctx: HostContext): SaveResult {
      return saveProject(ctx, p.form);
    },

    async command(p: RunParams, ctx: HostContext): Promise<string> {
      const workdir = resolveWorkdir(ctx, p?.workdir);
      return runCommand(pythonOf(ctx), await scriptPath(ctx), workdir, { until: p?.until, only: p?.only, redo: p?.redo });
    },

    run(p: RunParams, ctx: HostContext): Promise<RunResult> {
      return startRun(ctx, p);
    },

    stop(p: { workdir: string }, ctx: HostContext): Promise<boolean> {
      return stopRun(ctx, requireProject(ctx, p?.workdir));
    },

    async pick(p: PickParams, ctx: HostContext): Promise<string | null> {
      const o = PICK[p?.kind] ?? PICK.geometry;
      const got = await ctx.pickFiles({ title: o.title, canSelectFiles: !o.folders, canSelectFolders: Boolean(o.folders), canSelectMany: false, filters: o.filters });
      if (!got.length) return null;
      rememberPicked(got);
      allowUserPaths(got);
      return got[0];
    },

    gle(p: { temperature: number }, ctx: HostContext): Promise<GleEntry[]> {
      return gleLibrary(ctx, Number(p?.temperature));
    },

    async openFile(p: { workdir: string; file: string }, ctx: HostContext): Promise<void> {
      const wd = requireProject(ctx, p?.workdir);
      const abs = inWorkdir(wd, p?.file);
      if (!fs.existsSync(abs)) throw new Error(`${p.file} does not exist (yet)`);
      await ctx.openFile({ path: abs, beside: true });
    },

    /** Open a structure / cube / ensemble of the project in the Viewer or Geometries tab. */
    show(p: { workdir: string; file: string; tab?: 'viewer' | 'geom' | 'spectra' }, ctx: HostContext): void {
      const wd = requireProject(ctx, p?.workdir);
      const abs = inWorkdir(wd, p?.file);
      if (!fs.existsSync(abs)) throw new Error(`${p.file} does not exist (yet)`);
      if (p.tab === 'geom') ctx.navigate('geom', { xyz: [abs] });
      else if (p.tab === 'spectra') ctx.navigate('spectra', { files: [abs] });
      else ctx.navigate('viewer', { file: abs });
    },

    stageInfo(): typeof STAGE_INFO {
      return STAGE_INFO;
    }
  },

  activate(ctx: HostContext): Disposable {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<string>();
    const fire = (p: string) => {
      changed.add(path.dirname(p));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        ctx.post('changed', { workdirs: [...changed] });
        changed.clear();
      }, 500);
    };
    const watchers = ['**/state.json', '**/accel.json'].map(g => ctx.watch(g, fire));
    return {
      dispose() {
        if (timer) clearTimeout(timer);
        watchers.forEach(w => w.dispose());
      }
    };
  }
};
