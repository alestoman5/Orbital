// NEA spectrum sets: reading PyNEAppLES cross-section files and experimental
// two-column spectra, band statistics, and the "same spectrum within the
// bootstrap noise?" test of the uv-vis project (scripts/spectra.py:
// load_spectrum, load_experiment, band_stats, compare, SAME_THRESHOLD;
// webapp/v_spectra.py: draw_diff, data_csv). The ports follow numpy's
// semantics (np.interp, np.linspace, np.trapezoid, np.median, argmax = first
// maximum) so results agree with the Python to rounding; see
// test/fixtures/spectra/make_fixtures.py. Pure logic, no `vscode` import.

import { convertEnergy } from './spectrum';

/** x-axis units a spectrum file can use. */
export type SpectrumXUnit = 'nm' | 'eV' | 'cm-1';

export interface NeaSpectrum {
  /** Ascending. */
  x: number[];
  /** Total cross section (or intensity). */
  y: number[];
  /** Lower / upper confidence bound (PyNEAppLES bootstrap), when the file has them. */
  lo?: number[];
  hi?: number[];
  /** Per-state columns S1..SN (states[k][i] is state k+1 at x[i]). */
  states: number[][];
  unit: SpectrumXUnit;
  /** Non-empty, non-comment lines that could not be read. */
  skipped: number;
}

export interface ExperimentSpectrum {
  x: number[];
  y: number[];
  delimiter: 'whitespace' | 'tab' | ',' | ';';
  /** Non-numeric lines before the first data line (column titles etc.). */
  header: string[];
  /** Malformed lines after the first data line. */
  skipped: number;
  /** Points removed because y <= 0 (only with dropNonPositive). */
  dropped: number;
}

/** Share of the tested grid that must be consistent for "same within noise" (spectra.py). */
export const SAME_THRESHOLD = 0.80;

// ---------------------------------------------------------------- numerics

/**
 * Inverse of the standard normal CDF, Wichura's AS241 (PPND16), the same
 * algorithm and coefficients as Python's statistics.NormalDist.inv_cdf, so
 * z agrees with the Python to the last bits (relative error ~1e-16).
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const q = p - 0.5;
  let num: number;
  let den: number;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    num = (((((((2.5090809287301226727e+3 * r + 3.3430575583588128105e+4) * r + 6.7265770927008700853e+4) * r
      + 4.5921953931549871457e+4) * r + 1.3731693765509461125e+4) * r + 1.9715909503065514427e+3) * r
      + 1.3314166789178437745e+2) * r + 3.3871328727963666080e+0) * q;
    den = ((((((5.2264952788528545610e+3 * r + 2.8729085735721942674e+4) * r + 3.9307895800092710610e+4) * r
      + 2.1213794301586595867e+4) * r + 5.3941960214247511077e+3) * r + 6.8718700749205790830e+2) * r
      + 4.2313330701600911252e+1) * r + 1.0;
    return num / den;
  }
  let r = q <= 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  if (r <= 5) {
    r -= 1.6;
    num = ((((((7.7454501427834140764e-4 * r + 2.2723844989269184583e-2) * r + 2.4178072517745061177e-1) * r
      + 1.2704582524523683826e+0) * r + 3.6478483247632045960e+0) * r + 5.7694972214606914055e+0) * r
      + 4.6303378461565452959e+0) * r + 1.4234371107496835773e+0;
    den = ((((((1.0507500716444168432e-9 * r + 5.4759380849953449460e-4) * r + 1.5198666563616457197e-2) * r
      + 1.4810397642748007459e-1) * r + 6.8976733498510000455e-1) * r + 1.6763848301838038494e+0) * r
      + 2.0531916266377588219e+0) * r + 1.0;
  } else {
    r -= 5;
    num = ((((((2.0103343992922881326e-7 * r + 2.7115555687434875782e-5) * r + 1.2426609473880784386e-3) * r
      + 2.6532189526576123093e-2) * r + 2.9656057182850489123e-1) * r + 1.7848265399172913358e+0) * r
      + 5.4637849111641143699e+0) * r + 6.6579046435011037772e+0;
    den = ((((((2.0442631033899397856e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r
      + 7.8686913114561329059e-4) * r + 1.4875361290850614853e-2) * r + 1.3692988092273580531e-1) * r
      + 5.9983220655588793769e-1) * r + 1.0;
  }
  const x = num / den;
  return q < 0 ? -x : x;
}

/** np.linspace(a, b, n): a + i*step, last point exactly b. */
export function npLinspace(a: number, b: number, n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [a];
  const step = (b - a) / (n - 1);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a + i * step;
  out[n - 1] = b;
  return out;
}

/** np.arange(lo, hi + 1e-9, step), the 1 nm grid of v_spectra.data_csv. */
export function stepGrid(lo: number, hi: number, step = 1): number[] {
  const n = Math.max(0, Math.ceil((hi + 1e-9 - lo) / step));
  return Array.from({ length: n }, (_, i) => lo + i * step);
}

/**
 * np.interp(xNew, x, y): piecewise-linear interpolation on ascending `x`,
 * clamped to y[0] / y[n-1] outside the data range. Same branch structure as
 * numpy (exact hits return the tabulated value).
 */
export function interp(xNew: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>): number[] {
  const n = x.length;
  const out = new Array<number>(xNew.length);
  if (n === 0) {
    return out.fill(NaN);
  }
  let j = 0;
  for (let k = 0; k < xNew.length; k++) {
    const v = xNew[k];
    if (Number.isNaN(v)) {
      out[k] = NaN;
      continue;
    }
    if (v >= x[n - 1]) {
      out[k] = y[n - 1];
      continue;
    }
    if (v < x[0]) {
      out[k] = y[0];
      continue;
    }
    // x[j] <= v < x[j+1]; start from the previous j (grids are usually ascending)
    if (!(x[j] <= v && v < x[j + 1])) {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (x[mid] <= v) lo = mid; else hi = mid;
      }
      j = lo;
    }
    if (x[j] === v) {
      out[k] = y[j];
      continue;
    }
    const slope = (y[j + 1] - y[j]) / (x[j + 1] - x[j]);
    let r = slope * (v - x[j]) + y[j];
    if (Number.isNaN(r)) {
      r = slope * (v - x[j + 1]) + y[j + 1];
      if (Number.isNaN(r) && y[j] === y[j + 1]) r = y[j];
    }
    out[k] = r;
  }
  return out;
}

/** np.trapezoid(y, x). */
export function trapezoid(y: ArrayLike<number>, x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 1; i < x.length; i++) {
    s += ((x[i] - x[i - 1]) * (y[i] + y[i - 1])) / 2;
  }
  return s;
}

/** Index of the first maximum (np.argmax), -1 for an empty array. */
export function argmax(y: ArrayLike<number>): number {
  let k = y.length ? 0 : -1;
  for (let i = 1; i < y.length; i++) {
    if (y[i] > y[k]) k = i;
  }
  return k;
}

/** np.median (mean of the two middle values for even n). */
export function median(values: ArrayLike<number>): number {
  const s = Array.from(values).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// ---------------------------------------------------------------- reading

/**
 * Guesses the x unit from the data range: maximum <= 50 is eV, median >=
 * 4000 is cm⁻¹, anything else nm (UV-vis-NIR wavelengths are 100–3000 nm,
 * wavenumbers of the same range 3000–100 000 cm⁻¹).
 */
export function detectXUnit(x: ArrayLike<number>): SpectrumXUnit {
  if (x.length === 0) return 'nm';
  let max = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] > max) max = x[i];
  if (max <= 50) return 'eV';
  return median(x) >= 4000 ? 'cm-1' : 'nm';
}

/** Unit tag in a PyNEAppLES file name (absspec.<name>.nm.cross.dat, ….ev.…, ….cm.…), if any. */
export function unitFromFileName(name: string): SpectrumXUnit | undefined {
  const m = /\.(nm|ev|cm|cm-1)\.(cross|int)?/i.exec(name);
  if (!m) return undefined;
  const t = m[1].toLowerCase();
  return t === 'nm' ? 'nm' : t === 'ev' ? 'eV' : 'cm-1';
}

const COMMENT_RE = /^\s*(#|$)/;

function sortedOrder(x: number[]): number[] {
  return x.map((_, i) => i).sort((a, b) => x[a] - x[b] || a - b);
}

/**
 * Parses a PyNEAppLES spectrum (absspec.*.cross.dat): columns x, total,
 * CI low, CI high, S1..SN — or just x, total. A three-column file is
 * rejected: PyNEAppLES writes no "x, y, sd" format, and guessing whether
 * the third column is an sd, a half-width or a state would be silent
 * nonsense. `#` comments and blank lines are skipped; lines with a
 * different column count than the first data line, or non-numeric fields,
 * are counted in `skipped`. Rows are sorted by x (load_spectrum).
 */
export function parseNeaSpectrum(text: string, options: { unit?: SpectrumXUnit } = {}): NeaSpectrum {
  const rows: number[][] = [];
  let ncols = 0;
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (COMMENT_RE.test(line)) continue;
    const f = line.trim().split(/\s+/).map(Number);
    if (f.some(v => Number.isNaN(v))) {
      skipped++;
      continue;
    }
    if (ncols === 0) {
      ncols = f.length;
      if (ncols === 3) {
        throw new Error('3-column spectrum (x, y, ?) is not a PyNEAppLES format: expected x, total[, CI low, CI high, S1..SN].');
      }
      if (ncols < 2) {
        throw new Error('Spectrum needs at least 2 columns (x, total).');
      }
    }
    if (f.length !== ncols) {
      skipped++;
      continue;
    }
    rows.push(f);
  }
  const order = sortedOrder(rows.map(r => r[0]));
  const col = (c: number) => order.map(i => rows[i][c]);
  const x = col(0);
  const hasCi = ncols >= 4;
  const states: number[][] = [];
  for (let c = 4; c < ncols; c++) states.push(col(c));
  return {
    x,
    y: col(1),
    lo: hasCi ? col(2) : undefined,
    hi: hasCi ? col(3) : undefined,
    states,
    unit: options.unit ?? detectXUnit(x),
    skipped
  };
}

function splitFields(line: string, delimiter: ExperimentSpectrum['delimiter']): number[] {
  const t = line.trim();
  const parts = delimiter === 'whitespace' ? t.split(/\s+/)
    : t.split(delimiter === 'tab' ? '\t' : delimiter).map(s => s.trim());
  return parts.map(s => {
    const v = delimiter === ';' ? s.replace(',', '.') : s;
    return v === '' ? NaN : Number(v);
  });
}

function detectDelimiter(line: string): ExperimentSpectrum['delimiter'] {
  if (line.includes(';')) return ';';
  if (line.includes('\t')) return 'tab';
  if (line.includes(',')) return ',';
  return 'whitespace';
}

/**
 * Reads an experimental two-column spectrum (x, y; further columns are
 * ignored). The delimiter is detected from the first data line: `;`
 * (fields may use decimal commas), tab, `,` or whitespace. Lines starting
 * with `#`, `%` or `//` are comments; non-numeric lines before the data are
 * returned as `header`, malformed lines after it counted in `skipped`.
 * Points are sorted by x and, with dropNonPositive, points with y <= 0 are
 * removed (load_experiment: digitisation noise must not look like negative
 * absorption).
 */
export function parseTwoColumn(text: string, options: { dropNonPositive?: boolean } = {}): ExperimentSpectrum {
  const header: string[] = [];
  let delimiter: ExperimentSpectrum['delimiter'] | undefined;
  let skipped = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (/^\s*(#|%|\/\/|$)/.test(line)) continue;
    const d = delimiter ?? detectDelimiter(line);
    const f = splitFields(line, d);
    if (f.length < 2 || !Number.isFinite(f[0]) || !Number.isFinite(f[1])) {
      if (delimiter === undefined) header.push(line.trim()); else skipped++;
      continue;
    }
    delimiter = d;
    xs.push(f[0]);
    ys.push(f[1]);
  }
  const order = sortedOrder(xs);
  let x = order.map(i => xs[i]);
  let y = order.map(i => ys[i]);
  let dropped = 0;
  if (options.dropNonPositive) {
    const keep = y.map(v => v > 0);
    dropped = keep.filter(k => !k).length;
    x = x.filter((_, i) => keep[i]);
    y = y.filter((_, i) => keep[i]);
  }
  return { x, y, delimiter: delimiter ?? 'whitespace', header, skipped, dropped };
}

/**
 * Splits a file stem into named fields with a user regex (named groups),
 * e.g. `(?<sampling>.+?)-(?<geometry>.+?)_adc3-(?<basis>.+?)_n(?<n>\d+)$`.
 * Always contains `name` (the stem). Without a pattern, or when it does not
 * match, that is the only field. An invalid pattern string throws.
 */
export function parseSpectrumName(stem: string, pattern?: string | RegExp): Record<string, string> {
  const out: Record<string, string> = { name: stem };
  if (!pattern) return out;
  const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  const m = re.exec(stem);
  if (!m?.groups) return out;
  for (const [k, v] of Object.entries(m.groups)) {
    if (v !== undefined && k !== 'name') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- transforms

/** Copy with y, lo, hi and states divided by max(y) (v_spectra.load with norm). */
export function normalizeToMax<T extends { y: number[]; lo?: number[]; hi?: number[]; states?: number[][] }>(s: T): T {
  const m = s.y.length ? s.y[argmax(s.y)] : NaN;
  const f = (a: number[]) => a.map(v => v / m);
  return {
    ...s,
    y: f(s.y),
    lo: s.lo ? f(s.lo) : s.lo,
    hi: s.hi ? f(s.hi) : s.hi,
    states: s.states ? s.states.map(f) : s.states
  };
}

/**
 * Converts x values between nm, eV and cm⁻¹ (convertEnergy) and returns the
 * permutation that keeps the result ascending: out.x[i] = converted x[order[i]].
 * Apply `order` to every y column with applyOrder. Ordinates are not
 * Jacobian-transformed: a cross section is not a density in x.
 */
export function convertSpectrumAxis(x: number[], from: SpectrumXUnit, to: SpectrumXUnit): { x: number[]; order: number[] } {
  const c = from === to ? x.slice() : x.map(v => convertEnergy(v, from, to));
  const order = sortedOrder(c);
  return { x: order.map(i => c[i]), order };
}

export function applyOrder(values: number[], order: number[]): number[] {
  return order.map(i => values[i]);
}

/** A NeaSpectrum with its x axis in `to` (all columns reordered). */
export function convertSpectrum(s: NeaSpectrum, to: SpectrumXUnit): NeaSpectrum {
  const { x, order } = convertSpectrumAxis(s.x, s.unit, to);
  return {
    ...s,
    x,
    unit: to,
    y: applyOrder(s.y, order),
    lo: s.lo && applyOrder(s.lo, order),
    hi: s.hi && applyOrder(s.hi, order),
    states: s.states.map(c => applyOrder(c, order))
  };
}

// ---------------------------------------------------------------- statistics

export interface BandStats {
  /** x at the maximum (λmax for nm). */
  lmax: number;
  peak: number;
  /** ∫x y dx / ∫y dx on the window. */
  centroid: number;
  fwhm: number;
  /** ∫y dx (trapezoid). */
  integral: number;
}

function windowed(x: number[], y: number[], window: [number, number]): { x: number[]; y: number[] } {
  const wx: number[] = [];
  const wy: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] >= window[0] && x[i] <= window[1]) {
      wx.push(x[i]);
      wy.push(y[i]);
    }
  }
  return { x: wx, y: wy };
}

/**
 * Port of band_stats(d, window): on the points with window[0] <= x <=
 * window[1] (x ascending), λmax and peak at the first maximum, centroid and
 * integral by trapezoid, FWHM = max - min of the grid points with y >=
 * peak/2. The FWHM is therefore grid-limited (a multiple-ish of the
 * spacing, and it includes any secondary band above half maximum). Use the
 * same window for every compared curve: the centroid depends on the cut.
 */
export function bandStats(x: number[], y: number[], window: [number, number]): BandStats {
  const w = windowed(x, y, window);
  if (w.x.length === 0) {
    return { lmax: NaN, peak: NaN, centroid: NaN, fwhm: NaN, integral: NaN };
  }
  const k = argmax(w.y);
  const peak = w.y[k];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < w.x.length; i++) {
    if (w.y[i] >= peak / 2) {
      lo = Math.min(lo, w.x[i]);
      hi = Math.max(hi, w.x[i]);
    }
  }
  const area = trapezoid(w.y, w.x);
  const moment = trapezoid(w.y.map((v, i) => v * w.x[i]), w.x);
  return { lmax: w.x[k], peak, centroid: moment / area, fwhm: hi - lo, integral: area };
}

/**
 * bandStats with the FWHM taken between linearly interpolated half-maximum
 * crossings: the outermost points at or above half maximum (as in
 * bandStats) are each extended to the crossing with their outer neighbour.
 * When the band is still above half maximum at a window edge, that edge is
 * used. Everything else is identical to bandStats. The result no longer
 * depends on the grid spacing, so it is the better number for spectra on
 * different grids; bandStats stays the Python-parity value.
 */
export function bandStatsInterpolated(x: number[], y: number[], window: [number, number]): BandStats {
  const base = bandStats(x, y, window);
  const w = windowed(x, y, window);
  if (w.x.length === 0) return base;
  const half = base.peak / 2;
  let first = -1;
  let last = -1;
  for (let i = 0; i < w.y.length; i++) {
    if (w.y[i] >= half) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const cross = (i: number, j: number) => w.x[i] + ((half - w.y[i]) * (w.x[j] - w.x[i])) / (w.y[j] - w.y[i]);
  const left = first > 0 ? cross(first - 1, first) : w.x[first];
  const right = last < w.x.length - 1 ? cross(last, last + 1) : w.x[last];
  return { ...base, fwhm: right - left };
}

export interface SpectrumWithCi {
  x: number[];
  y: number[];
  lo?: number[];
  hi?: number[];
}

export interface Comparison {
  /** x of other's maximum minus x of ref's maximum on the common grid. */
  shift_nm: number;
  /** max |A - B| / peak. */
  max_diff_rel: number;
  /** median over the grid of max(CI half-widths) / peak. */
  median_ci_half_rel: number;
  /** Share of the signal points where the CI of the difference contains 0. */
  consistent_frac: number;
}

function requireCi(s: SpectrumWithCi, what: string): { lo: number[]; hi: number[] } {
  if (!s.lo || !s.hi) {
    throw new Error(`${what} has no confidence interval columns; the comparison needs x, total, CI low, CI high.`);
  }
  return { lo: s.lo, hi: s.hi };
}

/**
 * Port of compare(ref, other, xlim, confidence, signal_frac): both spectra
 * go on a 2000-point grid over the overlap of xlim and both x ranges; the
 * pointwise sd is recovered from each CI as (hi - lo) / (2z), and a point is
 * consistent when |A - B| <= z·hypot(sdA, sdB). Only points where either
 * curve exceeds signalFrac·peak are tested. (`shift_nm` is in x units.)
 */
export function compareSpectra(
  ref: SpectrumWithCi,
  other: SpectrumWithCi,
  xlim: [number, number],
  confidence = 0.95,
  signalFrac = 0.02
): Comparison {
  const a = requireCi(ref, 'reference');
  const b = requireCi(other, 'compared spectrum');
  const grid = npLinspace(
    Math.max(xlim[0], ref.x[0], other.x[0]),
    Math.min(xlim[1], ref.x[ref.x.length - 1], other.x[other.x.length - 1]),
    2000
  );
  const ta = interp(grid, ref.x, ref.y);
  const loa = interp(grid, ref.x, a.lo);
  const hia = interp(grid, ref.x, a.hi);
  const tb = interp(grid, other.x, other.y);
  const lob = interp(grid, other.x, b.lo);
  const hib = interp(grid, other.x, b.hi);
  const peak = Math.max(ta[argmax(ta)], tb[argmax(tb)]);
  const z = normalQuantile(0.5 + confidence / 2);
  let maxDiff = 0;
  let nSignal = 0;
  let nConsistent = 0;
  const halfCi = new Array<number>(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const d = Math.abs(ta[i] - tb[i]);
    if (d > maxDiff || Number.isNaN(d)) maxDiff = d;
    halfCi[i] = Math.max(hia[i] - loa[i], hib[i] - lob[i]) / 2;
    if (Math.max(ta[i], tb[i]) > signalFrac * peak) {
      nSignal++;
      const sd = Math.hypot((hia[i] - loa[i]) / (2 * z), (hib[i] - lob[i]) / (2 * z));
      if (d <= z * sd) nConsistent++;
    }
  }
  return {
    shift_nm: grid[argmax(tb)] - grid[argmax(ta)],
    max_diff_rel: maxDiff / peak,
    median_ci_half_rel: median(halfCi) / peak,
    consistent_frac: nSignal ? nConsistent / nSignal : NaN
  };
}

/** "same within noise" when consistent_frac >= threshold (spectra.summary). */
export function comparisonVerdict(c: Comparison, threshold = SAME_THRESHOLD): 'same within noise' | 'different' {
  return c.consistent_frac >= threshold ? 'same within noise' : 'different';
}

/**
 * other - ref on `grid` with the CI of the difference (v_spectra.draw_diff,
 * spectra.difference): diff ± z·hypot(sdA, sdB), sd = (hi - lo) / (2z).
 * The webapp uses grid = npLinspace(xlim[0], xlim[1], 1000).
 */
export function differenceWithCi(
  ref: SpectrumWithCi,
  other: SpectrumWithCi,
  grid: number[],
  confidence = 0.95
): { grid: number[]; diff: number[]; lo: number[]; hi: number[] } {
  const a = requireCi(ref, 'reference');
  const b = requireCi(other, 'compared spectrum');
  const z = normalQuantile(0.5 + confidence / 2);
  const ta = interp(grid, ref.x, ref.y);
  const loa = interp(grid, ref.x, a.lo);
  const hia = interp(grid, ref.x, a.hi);
  const tb = interp(grid, other.x, other.y);
  const lob = interp(grid, other.x, b.lo);
  const hib = interp(grid, other.x, b.hi);
  const diff = grid.map((_, i) => tb[i] - ta[i]);
  const half = grid.map((_, i) => z * Math.hypot((hia[i] - loa[i]) / (2 * z), (hib[i] - lob[i]) / (2 * z)));
  return { grid, diff, lo: diff.map((d, i) => d - half[i]), hi: diff.map((d, i) => d + half[i]) };
}

/** numpy's default savetxt format '%.18e' (two-digit exponent). */
export function formatE18(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  const s = v.toExponential(18);
  return s.replace(/e([+-])(\d)$/, 'e$10$2');
}

/**
 * CSV of v_spectra.data_csv: column `xLabel`, then per series
 * "<name>:total", "<name>:ci_low", "<name>:ci_high" (the CI columns only
 * when the series has them), each interpolated on `grid` (np.interp), in
 * '%.18e' format. Use stepGrid(lo, hi, 1) for the webapp's 1 nm grid.
 */
export function resampleCsv(
  series: { name: string; x: number[]; y: number[]; lo?: number[]; hi?: number[] }[],
  grid: number[],
  xLabel = 'wavelength_nm'
): string {
  const names = [xLabel];
  const cols: number[][] = [grid];
  for (const s of series) {
    const parts: [string, number[] | undefined][] = [['total', s.y], ['ci_low', s.lo], ['ci_high', s.hi]];
    for (const [suffix, ys] of parts) {
      if (ys) {
        names.push(`${s.name}:${suffix}`);
        cols.push(interp(grid, s.x, ys));
      }
    }
  }
  const lines = [names.join(',')];
  for (let i = 0; i < grid.length; i++) {
    lines.push(cols.map(c => formatE18(c[i])).join(','));
  }
  return lines.join('\n') + '\n';
}
