// Request / response / event types of the "calcs" tab, shared by its host side
// (./host.ts) and its webview side (webview/src/tabs/calcs/). Types only — no
// runtime code, no imports of 'vscode', Node or DOM.

/** Same values as CALC_STATUSES in src/chem/calcStatus.ts. */
export type CalcStatusName = 'ok' | 'not converged' | 'error' | 'running' | 'unreadable' | 'not started';
export type CalcKind = 'pyscf-result' | 'orca-out' | 'json';

/** 'all' = every workspace folder plus the added folders; otherwise an absolute folder. */
export type CalcScope = string;

export interface ScanParams {
  scope?: CalcScope;
  /** Folders added with "Add folder…" (scanned with scope 'all'). */
  extraFolders?: string[];
  /** Re-list and re-check every file even if no change was reported. */
  refresh?: boolean;
}

export interface GroupRow {
  /** `${kind}:${dir}` — the id used by group() / problems() / failedList(). */
  id: string;
  /** Absolute directory. */
  dir: string;
  /** Relative to the scan root ('.' for the root), prefixed with the root's name when several roots are scanned. */
  label: string;
  kind: CalcKind;
  counts: Record<CalcStatusName, number>;
  total: number;
  medianTimeS?: number;
  maxTimeS?: number;
  method?: string;
  basis?: string;
}

export interface CalcTotals {
  total: number;
  counts: Record<CalcStatusName, number>;
  medianTimeS?: number;
  maxTimeS?: number;
}

export interface ScanResult {
  scope: CalcScope;
  /** Folders that were scanned. */
  roots: string[];
  groups: GroupRow[];
  totals: CalcTotals;
  /** Files matched by the globs. */
  fileCount: number;
  /** Files parsed vs re-used from the cache in this scan. */
  parsed: number;
  reused: number;
  /** Wall time of this scan, listing included. */
  durationMs: number;
  /** Time spent listing files (0 when the file list was cached). */
  listMs: number;
  /** True when nothing changed and the previous result was returned. */
  cached: boolean;
  scannedAt: number;
  /** Folders that were skipped (outside the workspace and not picked). */
  skipped: string[];
  globs: string[];
}

export interface ProblemsParams {
  /** GroupRow.id */
  id: string;
  /** Only this status ('all' or omitted: every non-ok status). */
  status?: CalcStatusName | 'all';
  /** Max rows (default 2000, at most 5000). */
  limit?: number;
}

export interface ProblemItem {
  name: string;
  status: CalcStatusName;
  path: string;
  detail?: string;
  timeS?: number;
}

export interface ProblemsResult {
  items: ProblemItem[];
  /** Matching items before the limit. */
  total: number;
}

export interface TimeStats {
  n: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
  /** Histogram of the ok times: n+1 edges (seconds) and n counts. */
  edges: number[];
  values: number[];
}

export interface GroupDetail {
  row: GroupRow;
  /** run_config.json of the group. */
  config?: Record<string, unknown>;
  times?: TimeStats;
  problems: ProblemsResult;
}

export interface FailedListParams {
  /** GroupRow.id */
  id: string;
  status?: CalcStatusName | 'all';
}

/** Event 'progress': scan progress. */
export interface ProgressEvent {
  phase: 'listing' | 'reading';
  done: number;
  total: number;
}

/** Event 'changed': files matching the globs changed since the last scan. */
export interface ChangedEvent {
  files: number;
}
