// Public, FROZEN interface of the Orbital Studio chart engine. Tabs import
// only from 'webview/src/charts' (index.ts re-exports this file plus the
// implementation). Changing a type here needs the orchestrator's approval —
// every tab depends on it.
//
// Model: a Figure is a grid of Panels; each Panel has an x and y axis (plus
// optional secondary axes) and a list of Series. The same Figure renders
// interactively on screen and exports to SVG / PDF / PNG at a physical size.

// --- styling ----------------------------------------------------------------

/**
 * 'screen': colors from the VS Code theme, sized to the container.
 * 'publication': white background, closed frame, inward major+minor ticks,
 * Helvetica/Arial 7–9 pt, Okabe-Ito colors, physical size (WYSIWYG).
 */
export type Preset = 'screen' | 'publication';

/** Okabe-Ito, colorblind-safe (same order as uv-vis scripts/spectra.py PALETTE). */
export const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#F0E442', '#000000'] as const;
/** Neutral ink for a reference curve, and for experiment (drawn dashed). */
export const REF_COLOR = '#3d3d3a';
export const EXP_COLOR = '#8a8a85';

export type Dash = 'solid' | 'dashed' | 'dotted' | 'dashdot';
export type Colormap = 'viridis' | 'magma' | 'cividis' | 'diverging';

/** Physical figure size in inches (1 in = 72 pt). */
export interface FigureSize {
  widthIn: number;
  heightIn: number;
}

/** Common journal widths; heights are a sensible default aspect. */
export const JOURNAL_SIZES: Record<string, FigureSize & { label: string }> = {
  'acs-1col': { label: 'ACS single column (3.25 in)', widthIn: 3.25, heightIn: 2.4 },
  'acs-2col': { label: 'ACS double column (7 in)', widthIn: 7, heightIn: 3.6 },
  'rsc-1col': { label: 'RSC single column (8.3 cm)', widthIn: 8.3 / 2.54, heightIn: 2.4 },
  'rsc-2col': { label: 'RSC double column (17.1 cm)', widthIn: 17.1 / 2.54, heightIn: 3.6 },
  'nature-1col': { label: 'Nature single column (89 mm)', widthIn: 89 / 25.4, heightIn: 2.5 },
  'nature-2col': { label: 'Nature double column (183 mm)', widthIn: 183 / 25.4, heightIn: 3.8 },
  'slide-16x9': { label: 'Slide 16:9 (10 in)', widthIn: 10, heightIn: 5.625 }
};

// --- axes -------------------------------------------------------------------

export interface AxisSpec {
  /** Text with unit, e.g. "λ / nm". Supports ^{…} and _{…} for super/subscripts: "σ / cm^{2} molecule^{−1}". */
  label?: string;
  /** Fixed limits; omitted = auto from data (with a small margin; y starts at 0 when all data ≥ 0 and `zero` is not false). */
  min?: number;
  max?: number;
  log?: boolean;
  /** Draw high values on the left/bottom (e.g. wavenumbers in IR). */
  reverse?: boolean;
  /** Include zero in auto limits (default true for y, false for x). */
  zero?: boolean;
  /** Explicit major tick positions. */
  ticks?: number[];
  /** Tick label formatter; default: shortest clean decimal / ×10ⁿ for large ranges. */
  format?: (v: number) => string;
  /** Light grid lines at major ticks (screen preset default true, publication false). */
  grid?: boolean;
  /** Hide tick labels (shared axes in stacked panels hide inner ones automatically). */
  hideTickLabels?: boolean;
}

/**
 * Secondary axis showing the same data in another unit, e.g. E / eV on top of
 * λ / nm: `toSecondary(1239.84 / λ)`, `fromSecondary(1239.84 / E)`. The
 * functions must be monotonic on the axis range.
 */
export interface SecondaryAxisSpec {
  label: string;
  toSecondary: (v: number) => number;
  fromSecondary: (v: number) => number;
  ticks?: number[];
  format?: (v: number) => string;
}

// --- series -----------------------------------------------------------------

interface SeriesBase {
  /** Legend entry; omit to keep the series out of the legend. */
  label?: string;
  /** CSS color; default: next palette color (series sharing `group` share a color). */
  color?: string;
  /** Series with the same group share color, legend entry and visibility toggle (curve + its CI band). */
  group?: string;
  /** Plot against the right-hand y axis of the panel. */
  yAxis?: 'left' | 'right';
}

export interface LineSeries extends SeriesBase {
  type: 'line';
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Line width in pt (default 1.25 publication / 1.75 screen). */
  width?: number;
  dash?: Dash;
  /** Draw markers at points. */
  markers?: boolean;
  /** Step plot (histogram look) instead of straight segments. */
  step?: 'pre' | 'mid' | 'post';
  /** For ≥ 5000 points the engine decimates (min/max per pixel) unless false. */
  decimate?: boolean;
}

/** Filled region between lo and hi (CI band, ± sd). */
export interface BandSeries extends SeriesBase {
  type: 'band';
  x: ArrayLike<number>;
  lo: ArrayLike<number>;
  hi: ArrayLike<number>;
  /** Fill opacity 0–1 (default 0.22). */
  opacity?: number;
}

/** Vertical sticks from 0 to y (excitations: energy vs oscillator strength). */
export interface StickSeries extends SeriesBase {
  type: 'sticks';
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  width?: number;
  /** Draw sticks against the right y axis scaled so the tallest reaches this fraction of the panel (default: plot in data units). */
  relativeHeight?: number;
}

export interface HistogramSeries extends SeriesBase {
  type: 'histogram';
  /** n+1 bin edges. */
  edges: ArrayLike<number>;
  /** n values (counts or densities — the caller decides). */
  values: ArrayLike<number>;
  /** 'step' outline (default), 'filled' bars with outline, 'bars'. */
  style?: 'step' | 'filled' | 'bars';
  opacity?: number;
}

export interface ScatterSeries extends SeriesBase {
  type: 'scatter';
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Marker diameter in pt (default 3). */
  size?: number;
  marker?: 'circle' | 'square' | 'triangle' | 'diamond' | 'cross';
  opacity?: number;
  /** Optional per-point error bars (symmetric). */
  yErr?: ArrayLike<number>;
  xErr?: ArrayLike<number>;
}

/** Regular grid: z[iy][ix] at cell edges xEdges (nx+1) × yEdges (ny+1). */
export interface HeatmapSeries extends SeriesBase {
  type: 'heatmap';
  xEdges: ArrayLike<number>;
  yEdges: ArrayLike<number>;
  z: ArrayLike<number>[];
  colormap?: Colormap;
  /** Color limits; default min/max of z (symmetric around 0 for 'diverging'). */
  zMin?: number;
  zMax?: number;
  /** Log color scale. */
  logZ?: boolean;
  /** Color bar title, e.g. "CV MAE / eV". */
  colorbarLabel?: string;
  /** Print the value in each cell (small grids, e.g. grid-search results). */
  annotate?: boolean | ((v: number) => string);
}

/** Horizontal or vertical reference line spanning the panel. */
export interface RuleSeries extends SeriesBase {
  type: 'hline' | 'vline';
  value: number;
  dash?: Dash;
  width?: number;
}

/** Text placed at data coordinates. */
export interface TextSeries extends SeriesBase {
  type: 'text';
  x: number;
  y: number;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
  /** Offset in pt from the anchor point. */
  dx?: number;
  dy?: number;
}

export type Series = LineSeries | BandSeries | StickSeries | HistogramSeries | ScatterSeries | HeatmapSeries | RuleSeries | TextSeries;

// --- figure -----------------------------------------------------------------

export type LegendPosition = 'auto' | 'none' | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'outside-right' | 'outside-top';

export interface Panel {
  x: AxisSpec;
  y: AxisSpec;
  /** Right-hand y axis for series with yAxis: 'right'. */
  y2?: AxisSpec;
  /** Top axis in another unit (e.g. eV above nm). */
  xSecondary?: SecondaryAxisSpec;
  series: Series[];
  legend?: LegendPosition;
  /** Legend title, e.g. "minus <ref>". */
  legendTitle?: string;
  /** Panel tag drawn in the corner, e.g. "(a)" — set automatically when Figure.panelLabels is true. */
  tag?: string;
  /** Small title above the panel (screen use; journals prefer captions). */
  title?: string;
  /** Relative height in a 'stack' layout (default 1), e.g. [2, 1] for overlay + difference. */
  heightRatio?: number;
  /** Keep aspect ratio 1 (parity plots). */
  equalAspect?: boolean;
}

export interface Figure {
  panels: Panel[];
  /**
   * 'stack' (default): panels in one column; with sharedX the x axis is shared
   * and only the bottom panel shows tick labels. 'grid': rows × cols.
   */
  layout?: { kind: 'stack'; sharedX?: boolean } | { kind: 'grid'; cols: number; sharedX?: boolean; sharedY?: boolean };
  preset?: Preset;
  /** Physical size — used by 'publication' preview and all exports. */
  size?: FigureSize;
  /** Base font size in pt (default 8 publication, 12 screen). */
  fontSize?: number;
  /** CSS font stack (default "Helvetica, Arial, sans-serif" publication, theme font on screen). */
  fontFamily?: string;
  /** Series colors in order (default PALETTE). */
  palette?: readonly string[];
  /** Label panels (a), (b), … automatically. */
  panelLabels?: boolean;
}

// --- rendering & export -----------------------------------------------------

export interface RenderOptions {
  /** Zoom by dragging, double-click resets, crosshair readout, click legend to hide (default true). */
  interactive?: boolean;
  /** Called with the visible x range after zoom / reset (per panel index). */
  onZoom?: (panel: number, xMin: number, xMax: number) => void;
  /** Formats the crosshair readout; default "x, y" with 4 significant digits. */
  readout?: (panel: number, x: number, y: number) => string;
}

export interface ChartHandle {
  /** Re-render with new data/options, keeping zoom when the axes are compatible. */
  update(figure: Figure): void;
  /** Reset zoom to the auto/explicit limits. */
  resetZoom(): void;
  /** The live SVG element. */
  element(): SVGSVGElement;
  dispose(): void;
}

export interface ExportOptions {
  /** Default: figure.size, else 'acs-1col'. */
  size?: FigureSize;
  /** PNG resolution (default 600). */
  dpi?: number;
  /** Export always uses 'publication' unless 'screen' is asked for explicitly. */
  preset?: Preset;
  /** Transparent instead of white background (PNG/SVG). */
  transparent?: boolean;
}

// --- figure toolbar (shared export UI) ---------------------------------------

/** Minimal slice of the tab's ViewContext the toolbar needs (see webview/src/view.ts). */
export interface ToolbarHost {
  studio(method: 'saveFile', params: { defaultName: string; data: string; encoding?: 'utf8' | 'base64'; filters?: Record<string, string[]> }): Promise<string | undefined>;
  studio(method: 'sendToReport', params: { name: string; caption?: string; pdf?: string; png?: string }): Promise<void>;
  toast(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void;
}

export interface FigureToolbarOptions {
  /** The figure to export, read at click time. */
  figure: () => Figure;
  /** Base file name without extension, e.g. "spectra-overlay". */
  name: string;
  host: ToolbarHost;
  /** Preset + size the user picked in the toolbar; the tab re-renders with them. */
  onLayoutChange?: (preset: Preset, size: FigureSize) => void;
  initialPreset?: Preset;
  initialSize?: FigureSize;
  /** Show "Send to report" (default true). */
  sendToReport?: boolean;
  /** Default caption offered when sending to the report. */
  caption?: () => string;
}
