// Request / response / event types of the "runs" tab, shared by its host side
// (./host.ts) and its webview side (webview/src/tabs/runs/). Types only — no
// runtime code, no imports of 'vscode', Node or DOM.

export interface ProcRow {
  pid: number;
  ppid?: number;
  /** Empty on Windows (owner lookup is too slow). */
  user?: string;
  /** Percent of one core (ps convention: may exceed 100 for parallel jobs). */
  cpu: number;
  /** Percent of physical memory. */
  mem: number;
  rssBytes?: number;
  threads?: number;
  elapsedS?: number;
  /** Executable name (Windows), or the first word of the command. */
  name: string;
  command: string;
}

export interface ProcessesResult {
  rows: ProcRow[];
  /** All processes seen before filtering. */
  scanned: number;
  pattern: string;
  /** Set when the pattern setting is not a valid regular expression (the default was used). */
  patternError?: string;
  platform: string;
  /** How %CPU was measured. */
  cpuNote: string;
  durationMs: number;
  error?: string;
}

export interface MachineInfo {
  hostname: string;
  platform: string;
  release: string;
  cores: number;
  cpuModel: string;
  /** 1, 5, 15 min (not on Windows). */
  loadavg?: [number, number, number];
  /** Utilization of all cores since the previous call (0–100). */
  cpuPercent: number;
  memTotal: number;
  /** Used memory (total − available). */
  memUsed: number;
  uptimeS: number;
  user: string;
}

export interface QueueJob {
  jobid: string;
  name: string;
  state: string;
  time: string;
  timeLimit: string;
  nodes: string;
  reason: string;
}

export interface QueueResult {
  /** False when squeue is not on PATH (the card is hidden). */
  available: boolean;
  user: string;
  jobs: QueueJob[];
  error?: string;
}

export interface KillParams {
  pid: number;
  /** TERM (default): graceful; KILL: forced (taskkill /F on Windows). */
  signal?: 'TERM' | 'KILL';
}

export interface KillResult {
  ok: boolean;
  message: string;
}

export interface LogFile {
  path: string;
  /** Relative to its workspace folder ('/'-separated). */
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface LogsResult {
  files: LogFile[];
  /** Matching files before the cap. */
  total: number;
  limit: number;
  globs: string[];
  exclude: string[];
  durationMs: number;
}

export interface TailParams {
  path: string;
  /** Number of last lines (default 200, at most 50 000). */
  lines?: number;
  /** Return { unchanged: true } when the file still has this size and mtime. */
  since?: { size: number; mtimeMs: number };
}

export interface TailResult {
  path: string;
  unchanged?: boolean;
  text: string;
  /** Lines in `text`. */
  lines: number;
  /** The file has more lines before `text`. */
  more: boolean;
  size: number;
  mtimeMs: number;
}
