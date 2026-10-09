// Request / response / event types of the "geom" tab, shared by its host side
// (./host.ts) and its webview side (webview/src/tabs/geom/). Types only — no
// runtime code, no imports of 'vscode', Node or DOM.

// --- library ------------------------------------------------------------------

export interface LibraryFile {
  path: string;
  /** Shortest unique path suffix, e.g. "CMD_PBEPBE/geoms.xyz". */
  label: string;
  /** Path relative to its workspace folder (or the absolute path). */
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface ListResult {
  files: LibraryFile[];
  /** The search stopped at its file limit. */
  capped: boolean;
}

/** Lazily computed per-file facts (frame counts need a full pass over the file). */
export interface XyzInfo {
  path: string;
  frames: number;
  atoms: number;
  /** Element sequence of the first frame. */
  symbols: string[];
  /** The file ends inside a frame (truncated or still being written). */
  incompleteTail: boolean;
  /** A non-integer count line ended the read early (1-based line). */
  stoppedAtLine?: number;
  error?: string;
}

export interface DatInfo {
  path: string;
  /** Numeric column file with ≥ 2 columns and ≥ 2 rows. */
  ok: boolean;
  columns: string[];
  rows: number;
  skipped: number;
  error?: string;
}

// --- molecule (atom picker) -----------------------------------------------------

export interface MoleculeAtom {
  /** 1-based index. */
  index: number;
  symbol: string;
  x: number;
  y: number;
  z: number;
  /** 2D projection onto the two main axes of the molecule (Å). */
  px: number;
  py: number;
  /** Coordinate along the third axis (draw order and shading). */
  depth: number;
  /** Covalent radius in Å. */
  radius: number;
}

export interface MoleculeResult {
  path: string;
  comment: string;
  atoms: MoleculeAtom[];
  /** Pairs of 1-based indices bonded by covalent radii. */
  bonds: [number, number][];
}

// --- coordinates ----------------------------------------------------------------

export type CoordKind = 'bond' | 'angle' | 'dihedral';

export interface CoordInfo {
  /** Spec as entered, "O-O: 2-3". */
  spec: string;
  label: string;
  atoms: number[];
  kind: CoordKind;
  unit: 'Å' | '°';
  /** Short name without unit, e.g. "r(O2–O3)" (elements from the reference file). */
  name: string;
  /** Axis label, e.g. "r(O2–O3) / Å". */
  axis: string;
}

export interface ParseParams {
  specs: string[];
  /** File whose first frame names the atoms (default: none, indices only). */
  file?: string;
}

export interface ParseResult {
  coords: CoordInfo[];
  /** One entry per spec that could not be read. */
  errors: string[];
}

// --- distributions ----------------------------------------------------------------

export type DistMode = 'histogram' | 'trace' | '2d';

export interface DistParams {
  files: string[];
  specs: string[];
  /** Use every stride-th frame (default 1). */
  stride?: number;
  mode: DistMode;
  /** Index into the parsed coordinates (histogram, trace, x of 2d). */
  coord: number;
  /** y coordinate of the 2d mode. */
  coord2?: number;
  /** File of the 2d mode (default: the first file). */
  file2d?: string;
  bins?: number;
  kde?: boolean;
  /** Max points per trace (default 4000). */
  maxPoints?: number;
}

export interface SummaryRow {
  path: string;
  label: string;
  coord: number;
  n: number;
  mean: number;
  /** Population sd (numpy std, as plot_histograms.py). */
  sd: number;
  median: number;
  min: number;
  max: number;
  /** Integrated autocorrelation time in sampled frames. */
  tau: number;
  /** Standard error of the mean corrected for correlation, sd·sqrt(2τ/n). */
  sem: number;
}

export interface FileScanInfo {
  path: string;
  label: string;
  frames: number;
  sampled: number;
  stride: number;
  orderMismatches: number;
  firstMismatchFrame?: number;
  malformedFrames: number;
  incompleteTail: boolean;
  stoppedAtLine?: number;
  /** Some coordinate index exceeds the atom count of this file. */
  outOfRange: boolean;
  symbols: string[];
}

export interface HistogramPlot {
  kind: 'histogram';
  edges: number[];
  series: { path: string; label: string; values: number[]; mean: number }[];
  /** Gaussian KDE (Scott bandwidth) on a regular grid, same order as series. */
  kde?: { grid: number[]; series: number[][] };
}

export interface TracePlot {
  kind: 'trace';
  /** x = file frame index (0-based), min/max decimated. */
  series: { path: string; label: string; x: number[]; y: number[]; mean: number }[];
}

export interface Hist2dPlot {
  kind: '2d';
  path: string;
  label: string;
  xEdges: number[];
  yEdges: number[];
  /** z[iy][ix], density (integrates to 1). */
  z: number[][];
  n: number;
}

export interface DistResult {
  coords: CoordInfo[];
  errors: string[];
  files: FileScanInfo[];
  summary: SummaryRow[];
  plot?: HistogramPlot | TracePlot | Hist2dPlot;
  /** Stride the host suggests when a file has more than 2·10⁵ frames at stride 1. */
  suggestedStride?: number;
  ms: number;
}

/** Event 'progress' while scanning files. */
export interface ProgressEvent {
  path: string;
  label: string;
  /** 0..1 of the current file. */
  fraction: number;
  /** File index (0-based) of count. */
  index: number;
  count: number;
}

// --- trajectory (.dat) ------------------------------------------------------------

export interface DatViewParams {
  path: string;
  /** Column indices (≥ 1) to return; default all. */
  columns?: number[];
  xMin?: number;
  xMax?: number;
  /** Max points per column (default 4000, min/max decimation). */
  maxPoints?: number;
}

export interface DatStats {
  n: number;
  /** Least-squares slope, per ps when the x column is in fs, else per x unit. */
  slope: number;
  slopeUnit: string;
  /** Fit line y = slopeX·x + intercept in x units (for drawing). */
  slopeX: number;
  intercept: number;
  /** y(last) − y(first) of the visible range. */
  delta: number;
  mean: number;
  /** Sample sd (ddof 1). */
  sd: number;
  min: number;
  max: number;
  /** Integrated autocorrelation time in rows. */
  tau: number;
  sem: number;
}

export interface DatColumnView {
  index: number;
  name: string;
  /** y axis label, e.g. "T / K" for "Temperature". */
  axis: string;
  /** Decimated points of the visible range. */
  x: number[];
  y: number[];
  /** Exact statistics of all rows in the visible range. */
  stats: DatStats;
}

export interface DatViewResult {
  path: string;
  label: string;
  /** All column names; [0] is x. */
  columns: string[];
  /** Axis label of x, e.g. "t / fs". */
  xLabel: string;
  xFull: [number, number];
  xRange: [number, number];
  /** Rows in the visible range / in the file. */
  rows: number;
  totalRows: number;
  skipped: number;
  /** Median x step. */
  dx: number;
  /** x column is in fs (slopes are per ps). */
  fs: boolean;
  /** Every point of the range was sent (no decimation). */
  full: boolean;
  series: DatColumnView[];
}

// --- navigation -------------------------------------------------------------------

/** onNavigate args: { xyz: [...] } opens Distributions with these files; { dat } opens Trajectory. */
export interface GeomNavigateArgs {
  xyz?: string[];
  dat?: string;
}
