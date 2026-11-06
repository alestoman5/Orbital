// Request / response types of the "accel" (Accelerated UV/Vis) studio tab. Types only: the
// webview imports this file. The JSON shapes mirror the files of uv-vis scripts/accel/*.py.

import type { AccelForm, FieldError, RunOptions, Stage, StageStatus } from '../../../accel/spec';

export interface StageState {
  status: StageStatus;
  started?: string;
  finished?: string;
  message?: string | null;
  error?: string;
  progress?: number;
  summary?: Record<string, unknown>;
}

export interface AccelInit {
  scriptsDir: string | null;
  /** How scriptsDir was found: the orcaInp.nea.scriptsDir setting, a workspace search, or not at all. */
  source: 'setting' | 'search' | 'none';
  python: string;
  workspaceFolders: string[];
  projects: ProjectSummary[];
}

export interface ProjectSummary {
  workdir: string;
  name: string;
  sampling: string;
  method: string;
  updated: string | null;
  stages: Record<Stage, StageStatus>;
  running: boolean;
}

export interface Freqs {
  program: string;
  method: string;
  basis: string;
  freqs_cm: number[];
  n_imag: number;
  omega_min_cm: number;
  omega_max_cm: number;
  energy_eh: number | null;
}

export interface Transition { from: number; to: number; weight: number; label: string }

export interface ExcitedState {
  state: number;
  e_ev: number;
  nm: number | null;
  f: number;
  character: string;
  character_weight: number;
  singles: number | null;
  transitions: Transition[];
}

export interface MoInfo {
  name: string;
  label: string;
  pi_frac: number;
  main_atom: string;
  main_atom_frac: number;
  energy_ev: number;
  occ: number;
  /** Cube file relative to the work directory, or null. */
  cube: string | null;
}

export interface MinimumStates {
  method: string;
  basis: string;
  xc: string | null;
  nstates: number;
  converged: boolean;
  states: ExcitedState[];
  orbitals: Record<string, MoInfo>;
  dominant: number;
  target_state: number;
  planar_rms: number;
  planar: boolean;
  homo: number;
}

export interface SamplingInfo {
  kind: string;
  n_frames: number;
  beads: number;
  temperature: number;
  correlated: boolean;
  seed?: number;
  equil_entries?: number;
  gle?: { name: string; omega_max_cm: number | null; highest_mode_cm: number; scale: number; description?: string; warnings: string[] };
}

export interface ExciteProgress {
  total: number;
  done: number;
  converged: number;
  failed: number;
  nstates: number | null;
}

export interface MbtrGrid {
  min: number;
  max: number;
  n: number;
  sigma: number;
  species: string[];
  data_min: number;
  data_max: number;
  outside_fraction: number;
  frames_used: number;
  auto: boolean;
  hist_edges: number[];
  /** "C-O" -> counts per bin of hist_edges. */
  hist: Record<string, number[]>;
}

export interface Metrics { mae: number; rmse: number; r2: number | null }

export interface TargetModel {
  nested?: Metrics;
  parity?: { y: number[]; y_cv: number[] };
  best_params: { alpha: number; gamma: number };
  cv_mae: number;
  grid: { alpha: number[]; gamma: number[]; mae: number[][] };
  edge: string[];
  train: Metrics;
  time_fit_s: number;
  time_predict_s: number;
}

export interface KrrSummary {
  n_all: number;
  n_train: number;
  dropped: number;
  target_state: number;
  features: { backend: string; n_features: number; time_s: number };
  E: TargetModel;
  f: TargetModel;
  hist: { E_edges: number[]; E_all: number[]; E_train: number[]; f_edges: number[]; f_all: number[]; f_train: number[] };
  f_negative: number;
}

export interface SpectrumCurve {
  kind: 'ml' | 'direct' | 'experiment';
  label: string;
  file: string;
  n: number | null;
  x: number[];
  y: number[];
  lo?: number[];
  hi?: number[];
}

export interface ProjectDetail {
  workdir: string;
  form: AccelForm;
  stages: Record<Stage, StageState>;
  updated: string | null;
  running: boolean;
  /** A stage says running but its process is gone. */
  interrupted: boolean;
  pid: number | null;
  freqs: Freqs | null;
  minimum: MinimumStates | null;
  sampling: SamplingInfo | null;
  selection: { n_all: number; n_train: number; step: number } | null;
  excite: ExciteProgress | null;
  mbtr: MbtrGrid | null;
  krr: KrrSummary | null;
  spectrum: SpectrumCurve[];
  /** Last lines of accel.log. */
  log: string;
}

export interface GleEntry {
  name: string;
  kind: string;
  description: string;
  beads: number;
  hwKT: number | null;
  /** omega_max at the requested temperature, cm^-1 (null when the matrix parameters are unknown). */
  omegaMax: number | null;
}

export interface SaveParams { form: AccelForm }
export interface SaveResult { ok: boolean; errors: FieldError[]; workdir?: string; created?: boolean }
export interface RunParams extends RunOptions { workdir: string; terminal?: boolean }
export interface RunResult { command: string; pid?: number; terminal: boolean }
export interface PickParams { kind: 'geometry' | 'workdir' | 'experiment' | 'gle' }
