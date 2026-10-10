// Request / response / event types of the "ml" tab, shared by its host side
// (./host.ts) and its webview side (webview/src/tabs/ml/). Types only — no
// runtime code, no imports of 'vscode', Node or DOM.

import type { ConfigError, MlConfig, MlForm } from '../../../ml/spec';

export type { ConfigError, MlConfig, MlForm };

// Mirrors of the types in src/ml/runs.ts (that module uses Node, so the webview cannot import it).
// host.ts checks at compile time that both stay assignable.

export type RunState = 'created' | 'starting' | 'running' | 'done' | 'failed' | 'stopped';

export interface RunStatus {
  state: RunState;
  step: string;
  pid?: number;
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
  log: string;
}

export interface EnvCheck {
  ok: boolean;
  python: string | null;
  executable?: string;
  packages: Record<string, string | null>;
  missing_required: string[];
  error?: string;
}

/** ml.init */
export interface MlInit {
  maxJobs: number;
  pythonPath: string;
  /** False without a workspace folder (runs cannot be stored). */
  hasStorage: boolean;
  runsDir: string | null;
  workspaceFolders: string[];
}

/** ml.pick params: which file the dialog is for. Result: the path, or null when cancelled. */
export interface PickParams {
  kind: 'xyz' | 'csv' | 'features';
}

/** ml.csvHeader params / result. */
export interface CsvHeaderParams {
  path: string;
  header?: boolean;
}
export interface CsvHeader {
  path: string;
  /** Header names (header = true) or 'column 0', 'column 1', ... */
  columns: string[];
  /** Data rows (non-blank lines after the header). */
  rows: number;
  /** Per column: the first data row parses as a number. */
  numeric: boolean[];
}

/** ml.start params / result. */
export interface StartParams {
  form: MlForm;
}
export type StartResult =
  | { ok: true; id: string; pid: number }
  | { ok: false; errors: ConfigError[] };

/** ml.readRun params; `maxPoints` caps each parity series (default 4000). */
export interface ReadRunParams {
  id: string;
  logLines?: number;
  maxPoints?: number;
}

/** ml.compare result row. */
export interface CompareRow {
  id: string;
  name: string;
  rep: string;
  model: string;
  test: Metrics | null;
  cv_mae: number | null;
  curve: { n: number; test_mae: number }[];
}
