// Accelerated UV/Vis (uv-vis scripts/accelerated.py): the form of the studio tab, its
// translation to the driver's accel.json and back, and the command lines that run the stages.
// Pure (no vscode, no fs): shared by the tab host, the webview and the tests.
//
// accel.json mirrors DEFAULTS in uv-vis scripts/accel/common.py; keys this module does not
// know are kept by the driver's merge, so Orbital-only keys (experiment) are harmless.

export const STAGES = ['optfreq', 'minimum', 'sampling', 'select', 'excite', 'train', 'spectrum'] as const;
export type Stage = typeof STAGES[number];

export const STAGE_INFO: Record<Stage, { title: string; dir: string; text: string }> = {
  optfreq: { title: 'Optimisation + frequencies', dir: '01-optfreq', text: 'Ground-state minimum and harmonic frequencies' },
  minimum: { title: 'Excited states at the minimum', dir: '02-minimum', text: 'First N states, their character and the dominant state' },
  sampling: { title: 'Sampling', dir: '03-sampling', text: 'Wigner distribution or GLE / PI+GLE molecular dynamics' },
  select: { title: 'Training selection', dir: '04-excite', text: 'Geometries evenly spread over the ensemble' },
  excite: { title: 'Excitations', dir: '04-excite', text: 'Roots up to the dominant state on the training geometries' },
  train: { title: 'MBTR + KRR', dir: '05-ml', text: 'Descriptor grid from histograms, grid search, prediction for the ensemble' },
  spectrum: { title: 'NEA spectrum', dir: '06-spectrum', text: 'PyNEAppLES on the predicted ensemble' }
};

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting';
export type SamplingKind = 'wigner' | 'gle' | 'pigle';
export type GroundProgram = 'orca' | 'pyscf';
export type ExcitedMethod = 'adc(2)' | 'adc(2)-x' | 'adc(3)' | 'tddft' | 'tda';
export const EXCITED_METHODS: ExcitedMethod[] = ['adc(2)', 'adc(2)-x', 'adc(3)', 'tddft', 'tda'];
export const SAMPLING_KINDS: SamplingKind[] = ['wigner', 'gle', 'pigle'];
export const SAMPLING_LABELS: Record<SamplingKind, string> = { wigner: 'Wigner', gle: 'GLE', pigle: 'PI+GLE' };

/** log10 range of a grid: [min, max, number of points]. */
export type LogGrid = [number, number, number];

export interface AccelForm {
  /** Work directory (absolute, or relative to the first workspace folder). */
  workdir: string;
  /** Spectrum label; empty = work directory name. */
  name: string;
  geometry: string;
  charge: number;
  ground: { program: GroundProgram; method: string; basis: string; keywords: string; nprocs: number };
  sampling: {
    kind: SamplingKind;
    temperature: number;
    nsamples: number;
    seed: number;
    nsteps: number;
    /** a.u. */
    dt: number;
    nwritex: number;
    equilPs: number;
    beads: number;
    /** 'auto', a library name, or 'custom' (glePathA / glePathC). */
    gle: string;
    glePathA: string;
    glePathC: string;
    launch: boolean;
  };
  excited: { method: ExcitedMethod; basis: string; xc: string; frozenCore: boolean; memory: number };
  minimum: { nstates: number; /** 0 = the brightest state */ targetState: number; cubes: boolean };
  train: { n: number; jobs: number };
  mbtr: { n: number; sigma: number; autoRange: boolean; min: number; max: number; maxFrames: number };
  krr: { alpha: LogGrid; gamma: LogGrid; cv: number; nested: boolean; nJobs: number };
  spectrum: { bandwidth: 'silverman' | 'cv' | 'dev'; confidence: number; ealg: 'auto' | 'bootstrap' | 'cbb'; ncores: number; direct: boolean; experiment: string };
}

export function defaultForm(): AccelForm {
  return {
    workdir: '', name: '', geometry: '', charge: 0,
    ground: { program: 'orca', method: 'PBE', basis: 'aug-cc-pVDZ', keywords: 'TightSCF', nprocs: 1 },
    sampling: {
      kind: 'wigner', temperature: 300, nsamples: 10000, seed: 16661, nsteps: 104000, dt: 20, nwritex: 10, equilPs: 2,
      beads: 4, gle: 'auto', glePathA: '', glePathC: '', launch: true
    },
    excited: { method: 'adc(3)', basis: 'aug-cc-pVDZ', xc: 'PBE0', frozenCore: true, memory: 3000 },
    minimum: { nstates: 7, targetState: 0, cubes: true },
    train: { n: 1000, jobs: 30 },
    mbtr: { n: 200, sigma: 0.2, autoRange: true, min: 0.2, max: 1.3, maxFrames: 5000 },
    krr: { alpha: [-11, -2, 10], gamma: [-2, 1, 7], cv: 5, nested: true, nJobs: 16 },
    spectrum: { bandwidth: 'silverman', confidence: 0.95, ealg: 'auto', ncores: 16, direct: true, experiment: '' }
  };
}

/** Atomic time unit in fs (accel/sampling.py FS_PER_AU). */
export const FS_PER_AU = 0.02418884326;
/** k_B / (h c) in cm^-1 K^-1. */
export const CM_PER_KELVIN = 0.6950348;

export function mdLengthPs(f: AccelForm['sampling']): number {
  return f.nsteps * f.dt * FS_PER_AU / 1000;
}

/** Ensemble entries after equilibration (beads count separately for PI+GLE). */
export function mdEntries(f: AccelForm['sampling']): number {
  const beads = f.kind === 'pigle' ? f.beads : 1;
  const written = Math.floor(f.nsteps / Math.max(1, f.nwritex));
  const skip = Math.ceil(f.equilPs * 1000 / (f.dt * FS_PER_AU * Math.max(1, f.nwritex)));
  return Math.max(0, written - skip) * beads;
}

export interface FieldError { field: string; message: string }

export type AccelConfig = Record<string, any>;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateForm(f: AccelForm): FieldError[] {
  const e: FieldError[] = [];
  const need = (ok: boolean, field: string, message: string) => { if (!ok) e.push({ field, message }); };
  need(Boolean(f.workdir.trim()), 'workdir', 'choose a work directory');
  need(Boolean(f.geometry.trim()), 'geometry', 'choose a start geometry (.xyz)');
  need(/^[\w.+-]*$/.test(f.name), 'name', 'letters, digits, _ . + - only (it becomes part of file names)');
  need(isInt(f.charge) && Math.abs(f.charge) <= 10, 'charge', 'integer');
  need(Boolean(f.ground.method.trim()) && Boolean(f.ground.basis.trim()), 'ground', 'method and basis');
  need(isInt(f.ground.nprocs) && f.ground.nprocs >= 1, 'ground.nprocs', '≥ 1');
  const s = f.sampling;
  need(isNum(s.temperature) && s.temperature > 0, 'sampling.temperature', '> 0 K');
  if (s.kind === 'wigner') {
    need(isInt(s.nsamples) && s.nsamples >= 10, 'sampling.nsamples', 'at least 10');
    need(isInt(s.seed) && s.seed >= 0, 'sampling.seed', 'integer ≥ 0');
  } else {
    need(f.ground.program === 'orca', 'ground.program', 'MD runs ABIN with ORCA forces');
    need(isInt(s.nsteps) && s.nsteps > 0, 'sampling.nsteps', '> 0');
    need(isNum(s.dt) && s.dt > 0 && s.dt <= 100, 'sampling.dt', '0–100 a.u.');
    need(isInt(s.nwritex) && s.nwritex >= 1, 'sampling.nwritex', '≥ 1');
    need(isNum(s.equilPs) && s.equilPs >= 0 && s.equilPs < mdLengthPs(s), 'sampling.equilPs', 'shorter than the trajectory');
    if (s.kind === 'pigle') need(isInt(s.beads) && s.beads >= 2, 'sampling.beads', '≥ 2');
    if (s.gle === 'custom') need(Boolean(s.glePathA.trim() && s.glePathC.trim()), 'sampling.gle', 'pick both GLE-A and GLE-C');
  }
  const x = f.excited;
  need(EXCITED_METHODS.includes(x.method), 'excited.method', 'unknown method');
  need(Boolean(x.basis.trim()), 'excited.basis', 'basis');
  if (x.method === 'tddft' || x.method === 'tda') need(Boolean(x.xc.trim()), 'excited.xc', 'functional');
  need(isInt(x.memory) && x.memory >= 100, 'excited.memory', '≥ 100 MB');
  need(isInt(f.minimum.nstates) && f.minimum.nstates >= 1 && f.minimum.nstates <= 30, 'minimum.nstates', '1–30');
  need(isInt(f.minimum.targetState) && f.minimum.targetState >= 0 && f.minimum.targetState <= f.minimum.nstates,
    'minimum.targetState', `0 (brightest) or 1–${f.minimum.nstates}`);
  need(isInt(f.train.n) && f.train.n >= 10, 'train.n', 'at least 10');
  if (s.kind === 'wigner') need(f.train.n <= s.nsamples, 'train.n', 'not more than the Wigner samples');
  else need(f.train.n <= mdEntries(s), 'train.n', `not more than the ${mdEntries(s)} MD entries after equilibration`);
  need(isInt(f.train.jobs) && f.train.jobs >= 1, 'train.jobs', '≥ 1');
  const m = f.mbtr;
  need(isInt(m.n) && m.n >= 10 && m.n <= 2000, 'mbtr.n', '10–2000');
  need(isNum(m.sigma) && m.sigma > 0, 'mbtr.sigma', '> 0');
  if (!m.autoRange) need(isNum(m.min) && isNum(m.max) && m.min >= 0 && m.min < m.max, 'mbtr.range', '0 ≤ min < max');
  need(isInt(m.maxFrames) && m.maxFrames >= 100, 'mbtr.maxFrames', '≥ 100');
  for (const [key, g] of [['krr.alpha', f.krr.alpha], ['krr.gamma', f.krr.gamma]] as const) {
    need(g.length === 3 && isNum(g[0]) && isNum(g[1]) && g[0] <= g[1] && isInt(g[2]) && g[2] >= 1 && g[2] <= 40, key,
      'log10 min ≤ max, 1–40 points');
  }
  need(isInt(f.krr.cv) && f.krr.cv >= 2 && f.krr.cv <= 20, 'krr.cv', '2–20 folds');
  need(isInt(f.krr.nJobs) && f.krr.nJobs >= 1, 'krr.nJobs', '≥ 1');
  need(isNum(f.spectrum.confidence) && f.spectrum.confidence > 0 && f.spectrum.confidence < 1, 'spectrum.confidence', '0–1');
  need(isInt(f.spectrum.ncores) && f.spectrum.ncores >= 1, 'spectrum.ncores', '≥ 1');
  return e;
}

/** accel.json content for a valid form; `geometry` and the GLE paths are given as passed in. */
export function formToConfig(f: AccelForm): AccelConfig {
  const s = f.sampling;
  const td = f.excited.method === 'tddft' || f.excited.method === 'tda';
  return {
    version: 1,
    name: f.name.trim() || null,
    geometry: f.geometry.trim(),
    charge: f.charge,
    multiplicity: 1,
    ground: { program: f.ground.program, method: f.ground.method.trim(), basis: f.ground.basis.trim(), keywords: f.ground.keywords.trim(), nprocs: f.ground.nprocs },
    sampling: {
      kind: s.kind, temperature: s.temperature,
      wigner: { nsamples: s.nsamples, seed: s.seed },
      md: {
        nsteps: s.nsteps, dt: s.dt, nwritex: s.nwritex, equil_ps: s.equilPs, beads: s.beads, launch: s.launch,
        gle: s.gle === 'custom' ? { A: s.glePathA.trim(), C: s.glePathC.trim() } : s.gle || 'auto'
      }
    },
    excited: { method: f.excited.method, basis: f.excited.basis.trim(), xc: td ? f.excited.xc.trim() : (f.excited.xc.trim() || 'PBE0'), frozen_core: f.excited.frozenCore, memory: f.excited.memory },
    minimum: { nstates: f.minimum.nstates, target_state: f.minimum.targetState || null, cubes: f.minimum.cubes },
    train: { n: f.train.n, jobs: f.train.jobs },
    mbtr: { n: f.mbtr.n, sigma: f.mbtr.sigma, range: f.mbtr.autoRange ? 'auto' : [f.mbtr.min, f.mbtr.max], max_frames: f.mbtr.maxFrames },
    krr: { alpha: [...f.krr.alpha], gamma_factor: [...f.krr.gamma], cv: f.krr.cv, nested: f.krr.nested, n_jobs: f.krr.nJobs, seed: 42 },
    spectrum: { bandwidth: f.spectrum.bandwidth, confidence: f.spectrum.confidence, ealg: f.spectrum.ealg, ncores: f.spectrum.ncores, direct: f.spectrum.direct },
    experiment: f.spectrum.experiment.trim() || null
  };
}

const pick = <T>(v: unknown, ok: (v: unknown) => boolean, fallback: T): T => (ok(v) ? v as T : fallback);
const numOr = (v: unknown, d: number) => pick(v, isNum, d);
const intOr = (v: unknown, d: number) => pick(v, isInt, d);
const strOr = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const boolOr = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const gridOr = (v: unknown, d: LogGrid): LogGrid =>
  Array.isArray(v) && v.length === 3 && v.every(isNum) ? [v[0], v[1], v[2]] : [...d] as LogGrid;

/** Form values of an existing accel.json (unknown or missing keys fall back to the defaults). */
export function configToForm(cfg: AccelConfig, workdir: string): AccelForm {
  const d = defaultForm();
  const c = cfg ?? {};
  const g = c.ground ?? {};
  const s = c.sampling ?? {};
  const w = s.wigner ?? {};
  const md = s.md ?? {};
  const x = c.excited ?? {};
  const mn = c.minimum ?? {};
  const mb = c.mbtr ?? {};
  const k = c.krr ?? {};
  const sp = c.spectrum ?? {};
  const gle = md.gle;
  return {
    workdir,
    name: strOr(c.name, ''),
    geometry: strOr(c.geometry, ''),
    charge: intOr(c.charge, d.charge),
    ground: {
      program: g.program === 'pyscf' ? 'pyscf' : 'orca', method: strOr(g.method, d.ground.method), basis: strOr(g.basis, d.ground.basis),
      keywords: strOr(g.keywords, d.ground.keywords), nprocs: intOr(g.nprocs, d.ground.nprocs)
    },
    sampling: {
      kind: SAMPLING_KINDS.includes(s.kind) ? s.kind : d.sampling.kind,
      temperature: numOr(s.temperature, d.sampling.temperature),
      nsamples: intOr(w.nsamples, d.sampling.nsamples), seed: intOr(w.seed, d.sampling.seed),
      nsteps: intOr(md.nsteps, d.sampling.nsteps), dt: numOr(md.dt, d.sampling.dt), nwritex: intOr(md.nwritex, d.sampling.nwritex),
      equilPs: numOr(md.equil_ps, d.sampling.equilPs), beads: intOr(md.beads, d.sampling.beads),
      gle: gle && typeof gle === 'object' ? 'custom' : strOr(gle, 'auto') || 'auto',
      glePathA: gle && typeof gle === 'object' ? strOr(gle.A, '') : '',
      glePathC: gle && typeof gle === 'object' ? strOr(gle.C, '') : '',
      launch: boolOr(md.launch, d.sampling.launch)
    },
    excited: {
      method: EXCITED_METHODS.includes(x.method) ? x.method : d.excited.method, basis: strOr(x.basis, d.excited.basis),
      xc: strOr(x.xc, d.excited.xc), frozenCore: boolOr(x.frozen_core, d.excited.frozenCore), memory: intOr(x.memory, d.excited.memory)
    },
    minimum: { nstates: intOr(mn.nstates, d.minimum.nstates), targetState: intOr(mn.target_state, 0), cubes: boolOr(mn.cubes, true) },
    train: { n: intOr(c.train?.n, d.train.n), jobs: intOr(c.train?.jobs, d.train.jobs) },
    mbtr: {
      n: intOr(mb.n, d.mbtr.n), sigma: numOr(mb.sigma, d.mbtr.sigma), autoRange: !Array.isArray(mb.range),
      min: Array.isArray(mb.range) ? numOr(mb.range[0], d.mbtr.min) : d.mbtr.min,
      max: Array.isArray(mb.range) ? numOr(mb.range[1], d.mbtr.max) : d.mbtr.max,
      maxFrames: intOr(mb.max_frames, d.mbtr.maxFrames)
    },
    krr: {
      alpha: gridOr(k.alpha, d.krr.alpha), gamma: gridOr(k.gamma_factor, d.krr.gamma), cv: intOr(k.cv, d.krr.cv),
      nested: boolOr(k.nested, true), nJobs: intOr(k.n_jobs, d.krr.nJobs)
    },
    spectrum: {
      bandwidth: ['silverman', 'cv', 'dev'].includes(sp.bandwidth) ? sp.bandwidth : 'silverman',
      confidence: numOr(sp.confidence, d.spectrum.confidence),
      ealg: ['auto', 'bootstrap', 'cbb'].includes(sp.ealg) ? sp.ealg : 'auto',
      ncores: intOr(sp.ncores, d.spectrum.ncores), direct: boolOr(sp.direct, true),
      experiment: strOr(c.experiment, '')
    }
  };
}

/** POSIX-shell quoting (bare when safe). */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export interface RunOptions { until?: Stage; only?: Stage; redo?: Stage }

/** Arguments of `python accelerated.py ...` for a run. */
export function runArgs(script: string, workdir: string, o: RunOptions = {}): string[] {
  const args = [script, 'run', workdir];
  if (o.only) args.push('--only', o.only);
  else if (o.until) args.push('--until', o.until);
  if (o.redo) args.push('--redo', o.redo);
  return args;
}

export function runCommand(python: string, script: string, workdir: string, o: RunOptions = {}): string {
  return [python, ...runArgs(script, workdir, o)].map(shellQuote).join(' ');
}
