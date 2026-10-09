// Request / response / event types of the "spectra" tab, shared by its host side
// (./host.ts) and its webview side (webview/src/tabs/spectra/). Types only — no
// runtime code, no imports of 'vscode', Node or DOM.

/** What a library entry is plotted as. */
export type ItemKind = 'nea' | 'exp' | 'sticks';

/**
 * Where an entry comes from: a spectrum file, one ORCA .out, a folder of .out
 * files (NEA average) or a geom_NNNN/result.json set.
 */
export type ItemSource = 'file' | 'out' | 'outdir' | 'geom';

/** x axis of the plot. */
export type XAxis = 'nm' | 'eV' | 'cm-1';

/**
 * Ordinate: absolute cross section σ in cm² molecule⁻¹, or σ divided by the
 * prefactor πe²ħ/(2 m_e c ε₀), i.e. the oscillator-strength density
 * (1/N) Σ f g(E − E_i) in eV⁻¹ ("relative").
 */
export type YScale = 'sigma' | 'relative';

export type ExperimentScaling = 'none' | 'ref';

export interface LibraryItem {
  /** `<source>:<absolute path>`; stable across reloads. */
  id: string;
  path: string;
  source: ItemSource;
  /** Default kind (spectrum files: 'exp' when matched by studio.experimentGlobs). */
  kind: ItemKind;
  /** File stem / folder name. */
  name: string;
  /** Named groups of studio.spectrumNamePattern, plus `name`. */
  fields: Record<string, string>;
  /** x unit of the file (sticks: eV). */
  xUnit: XAxis;
  /** Bytes (files) or number of outputs / geometries (folders). */
  size: number;
  mtimeMs: number;
  /** Has CI low / high columns (needed for the consistency test). */
  hasCi: boolean;
  /** Number of S1..SN columns / excited states. */
  nStates: number;
  /** Sticks: geometries used, Silverman h (eV) and the default h for this entry. */
  nGeometries?: number;
  silverman?: number;
  defaultH?: number;
  /** Geometries skipped (unfinished, unreadable, not converged). */
  skipped?: number;
  /** Added by the user / a command rather than found by a glob. */
  added?: boolean;
  /** Why the entry cannot be plotted. */
  error?: string;
}

export interface LibraryParams {
  /** Paths added earlier (Add files…, commands); re-validated on every call. */
  extra?: string[];
}

export interface LibraryResult {
  items: LibraryItem[];
  /** Group names of studio.spectrumNamePattern, in pattern order. */
  fieldNames: string[];
  spectraGlobs: string[];
  experimentGlobs: string[];
  /** Problems with settings or added paths. */
  warnings: string[];
}

export interface AddFilesParams {
  paths: string[];
}

export interface AddFilesResult {
  /** Ids of the entries the paths produced (a folder can give several). */
  ids: string[];
  /** Accepted paths, to keep in the webview state and pass as LibraryParams.extra. */
  accepted: string[];
  errors: string[];
}

/** Common plot / statistics parameters. */
export interface PlotParams {
  ids: string[];
  /** Ids plotted as experiment (2-column, dashed). */
  experiment?: string[];
  refId?: string;
  axis: XAxis;
  /** Window in axis units; omitted = automatic (signal region of the selection). */
  range?: [number, number];
  /** Gaussian width in eV for every stick entry; omitted = each entry's default. */
  h?: number;
  normalize?: boolean;
  yScale?: YScale;
  expScale?: ExperimentScaling;
}

export interface LoadParams extends PlotParams {
  /** Also compute other − reference with the CI of the difference. */
  difference?: boolean;
  /** Send the S1..SN columns. */
  states?: boolean;
  /** Send the sticks (sticks entries). */
  sticks?: boolean;
}

export interface PlotSeries {
  id: string;
  label: string;
  kind: ItemKind;
  x: number[];
  y: number[];
  lo?: number[];
  hi?: number[];
  states?: number[][];
  /** Sticks in axis units: x and oscillator strength f (subsampled to `shown` of `total`). */
  sticks?: { x: number[]; f: number[]; total: number };
  /** Gaussian width used (eV) and the Silverman value. */
  h?: number;
  silverman?: number;
  nGeometries?: number;
  /** Factor applied to an experiment (scale to the reference peak). */
  scale?: number;
}

export interface DifferenceSeries {
  id: string;
  label: string;
  x: number[];
  diff: number[];
  lo?: number[];
  hi?: number[];
}

export interface LoadResult {
  axis: XAxis;
  /** Window actually used (the automatic one when params.range was omitted). */
  range: [number, number];
  yScale: YScale;
  normalized: boolean;
  series: PlotSeries[];
  difference?: DifferenceSeries[];
  errors: { id: string; message: string }[];
}

export interface StatsRow {
  id: string;
  label: string;
  kind: ItemKind;
  isRef: boolean;
  /** Position of the maximum (axis units). */
  xmax: number;
  peak: number;
  centroid: number;
  fwhm: number;
  integral: number;
  /** peak / experiment peak in the window. */
  maxOverExp?: number;
  /** xmax(other) − xmax(ref) on the common grid (axis units). */
  shift?: number;
  /** % of the signal grid where the CI of the difference contains 0. */
  consistentPct?: number;
  verdict?: 'same within noise' | 'different';
  /** Why there is no consistency number (e.g. no CI columns). */
  note?: string;
}

export interface StatsResult {
  axis: XAxis;
  window: [number, number];
  rows: StatsRow[];
  refId?: string;
  experimentLabel?: string;
  /** SAME_THRESHOLD as a percentage. */
  thresholdPct: number;
  confidence: number;
  errors: { id: string; message: string }[];
}

export interface CsvParams extends PlotParams {
  /** Grid step in axis units; default 1 nm / 0.01 eV / 10 cm⁻¹. */
  step?: number;
}

export interface CsvResult {
  /** Written file, undefined when the save dialog was cancelled. */
  path?: string;
  rows: number;
  columns: number;
}

/** Event 'changed': a file matched by the globs changed on disk. */
export interface ChangedEvent {
  path: string;
}

/** Arguments of openStudio('spectra', args) / TabInstance.onNavigate. */
export interface SpectraNavigateArgs {
  files?: string[];
  folder?: string;
}
