// Pure plot preparation for the spectra tab: curves on the chosen x axis,
// automatic window, scaling, downsampling, band statistics, the consistency
// test against a reference, the difference with its CI, and the CSV of the
// resampled curves. No `vscode`, no Node APIs.

import {
  SAME_THRESHOLD,
  applyOrder,
  argmax,
  bandStatsInterpolated,
  compareSpectra,
  comparisonVerdict,
  convertSpectrumAxis,
  differenceWithCi,
  formatE18,
  interp,
  npLinspace,
  stepGrid
} from '../../../chem/spectrumSets';
import { SIGMA_PREFACTOR_EV_CM2 } from './crossSection';
import type { DifferenceSeries, ItemKind, PlotSeries, StatsRow, XAxis } from './types';

/** One curve on the plot axis (ascending x), full resolution. */
export interface Curve {
  id: string;
  label: string;
  kind: ItemKind;
  x: number[];
  y: number[];
  lo?: number[];
  hi?: number[];
  states: number[][];
  sticks?: { x: number[]; f: number[] };
  h?: number;
  silverman?: number;
  nGeometries?: number;
  scale?: number;
}

export const CONFIDENCE = 0.95;
export const MAX_POINTS = 2000;

/** A curve read in `from` units, put on axis `to` (all columns reordered to ascending x). */
export function toAxis(
  c: { x: number[]; y: number[]; lo?: number[]; hi?: number[]; states?: number[][] },
  from: XAxis,
  to: XAxis
): { x: number[]; y: number[]; lo?: number[]; hi?: number[]; states: number[][] } {
  const { x, order } = convertSpectrumAxis(c.x, from, to);
  return {
    x,
    y: applyOrder(c.y, order),
    lo: c.lo && applyOrder(c.lo, order),
    hi: c.hi && applyOrder(c.hi, order),
    states: (c.states ?? []).map(s => applyOrder(s, order))
  };
}

function scaleCurve(c: Curve, f: number): void {
  const m = (a: number[]) => a.map(v => v * f);
  c.y = m(c.y);
  if (c.lo) c.lo = m(c.lo);
  if (c.hi) c.hi = m(c.hi);
  c.states = c.states.map(m);
}

/** σ → (1/N) Σ f g (eV⁻¹): divide every column by the prefactor. */
export function toRelative(c: Curve): void {
  scaleCurve(c, 1 / SIGMA_PREFACTOR_EV_CM2);
}

/** Divide by the curve's maximum (v_spectra "normalize to maximum", global max). */
export function normalize(c: Curve): void {
  const k = argmax(c.y);
  const m = k >= 0 ? c.y[k] : NaN;
  if (m > 0) scaleCurve(c, 1 / m);
}

export function peakIn(c: { x: number[]; y: number[] }, w: [number, number]): number {
  let m = -Infinity;
  for (let i = 0; i < c.x.length; i++) {
    if (c.x[i] >= w[0] && c.x[i] <= w[1] && c.y[i] > m) m = c.y[i];
  }
  return m;
}

/** Experiments scaled so their peak in the window equals the reference's. */
export function scaleExperiments(curves: Curve[], ref: Curve | undefined, w: [number, number]): void {
  if (!ref) return;
  const target = peakIn(ref, w);
  for (const c of curves) {
    if (c.kind !== 'exp' || c === ref) continue;
    const p = peakIn(c, w);
    if (p > 0 && target > 0) {
      c.scale = target / p;
      scaleCurve(c, c.scale);
    }
  }
}

const NICE: Record<XAxis, number> = { nm: 10, eV: 0.1, 'cm-1': 1000 };

/**
 * Signal region of the curves: x where y >= frac · peak (per curve), joined
 * over curves, padded by 8 % and rounded outward to 10 nm / 0.1 eV / 1000 cm⁻¹.
 * Experiments count only when nothing else is plotted.
 */
export function autoRange(curves: Curve[], axis: XAxis, frac = 0.01): [number, number] {
  const use = curves.some(c => c.kind !== 'exp') ? curves.filter(c => c.kind !== 'exp') : curves;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of use) {
    const k = argmax(c.y);
    if (k < 0) continue;
    const t = c.y[k] * frac;
    for (let i = 0; i < c.x.length; i++) {
      if (c.y[i] >= t) {
        lo = Math.min(lo, c.x[i]);
        hi = Math.max(hi, c.x[i]);
      }
    }
  }
  if (!Number.isFinite(lo)) {
    return axis === 'nm' ? [200, 600] : axis === 'eV' ? [2, 8] : [15000, 50000];
  }
  if (hi - lo < 1e-9) {
    lo -= NICE[axis];
    hi += NICE[axis];
  }
  const pad = (hi - lo) * 0.08;
  const step = NICE[axis];
  let a = Math.floor((lo - pad) / step) * step;
  const b = Math.ceil((hi + pad) / step) * step;
  if (a < 0) a = 0;
  return [round(a), round(b)];
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Window ∩ x range (one point margin), at most MAX_POINTS points (uniform resampling). */
export function cropForPlot(c: Curve, w: [number, number], max = MAX_POINTS): PlotSeries {
  let a = 0;
  while (a < c.x.length - 1 && c.x[a + 1] < w[0]) a++;
  let b = c.x.length - 1;
  while (b > 0 && c.x[b - 1] > w[1]) b--;
  const sl = (v: number[]) => v.slice(a, b + 1);
  let x = sl(c.x);
  let y = sl(c.y);
  let lo = c.lo && sl(c.lo);
  let hi = c.hi && sl(c.hi);
  let states = c.states.map(sl);
  if (x.length > max) {
    const g = npLinspace(x[0], x[x.length - 1], max);
    y = interp(g, x, y);
    lo = lo && interp(g, x, lo);
    hi = hi && interp(g, x, hi);
    states = states.map(s => interp(g, x, s));
    x = g;
  }
  const out: PlotSeries = { id: c.id, label: c.label, kind: c.kind, x, y };
  if (lo && hi) {
    out.lo = lo;
    out.hi = hi;
  }
  if (states.length) out.states = states;
  if (c.h !== undefined) out.h = c.h;
  if (c.silverman !== undefined) out.silverman = c.silverman;
  if (c.nGeometries !== undefined) out.nGeometries = c.nGeometries;
  if (c.scale !== undefined) out.scale = c.scale;
  return out;
}

/** Sticks inside the window, at most `max` (the strongest are kept). */
export function cropSticks(s: { x: number[]; f: number[] }, w: [number, number], max = 3000): { x: number[]; f: number[]; total: number } {
  const idx: number[] = [];
  for (let i = 0; i < s.x.length; i++) if (s.x[i] >= w[0] && s.x[i] <= w[1]) idx.push(i);
  const keep = idx.length > max ? idx.sort((i, j) => s.f[j] - s.f[i]).slice(0, max).sort((i, j) => s.x[i] - s.x[j]) : idx;
  return { x: keep.map(i => s.x[i]), f: keep.map(i => s.f[i]), total: idx.length };
}

/** Other − reference on a 1000-point grid over the window (with the CI of the difference when both have CIs). */
export function differences(ref: Curve, others: Curve[], w: [number, number]): DifferenceSeries[] {
  const grid = npLinspace(w[0], w[1], 1000);
  return others.filter(c => c !== ref && c.kind !== 'exp').map(c => {
    if (ref.lo && ref.hi && c.lo && c.hi) {
      const d = differenceWithCi(ref, c, grid, CONFIDENCE);
      return { id: c.id, label: c.label, x: grid, diff: d.diff, lo: d.lo, hi: d.hi };
    }
    const a = interp(grid, ref.x, ref.y);
    const b = interp(grid, c.x, c.y);
    return { id: c.id, label: c.label, x: grid, diff: b.map((v, i) => v - a[i]) };
  });
}

/**
 * Band statistics in the window (bandStatsInterpolated: FWHM between
 * interpolated half-maximum crossings), peak / experiment peak, and against
 * the reference: shift of the maximum and the share of the signal grid
 * where the 95 % CI of the difference contains 0 (compareSpectra).
 */
export function statsRows(curves: Curve[], ref: Curve | undefined, w: [number, number]): StatsRow[] {
  const exp = curves.find(c => c.kind === 'exp' && c !== ref);
  const expPeak = exp ? peakIn(exp, w) : NaN;
  const refStats = ref ? bandStatsInterpolated(ref.x, ref.y, w) : undefined;
  return curves.map(c => {
    const b = bandStatsInterpolated(c.x, c.y, w);
    const row: StatsRow = {
      id: c.id, label: c.label, kind: c.kind, isRef: c === ref,
      xmax: b.lmax, peak: b.peak, centroid: b.centroid, fwhm: b.fwhm, integral: b.integral
    };
    if (c.kind !== 'exp' && expPeak > 0) row.maxOverExp = b.peak / expPeak;
    if (ref && c !== ref) {
      if (ref.lo && ref.hi && c.lo && c.hi) {
        const cmp = compareSpectra(ref, c, w, CONFIDENCE);
        row.shift = cmp.shift_nm;
        if (Number.isFinite(cmp.consistent_frac)) {
          row.consistentPct = 100 * cmp.consistent_frac;
          row.verdict = comparisonVerdict(cmp);
        }
      } else {
        row.shift = b.lmax - (refStats?.lmax ?? NaN);
        row.note = c.kind === 'exp' ? 'experiment (no CI)' : !(c.lo && c.hi) ? 'no CI columns' : 'reference has no CI';
      }
    }
    return row;
  });
}

export const THRESHOLD_PCT = 100 * SAME_THRESHOLD;

const CSV_X: Record<XAxis, string> = { nm: 'wavelength_nm', eV: 'energy_eV', 'cm-1': 'wavenumber_cm-1' };
export const DEFAULT_STEP: Record<XAxis, number> = { nm: 1, eV: 0.01, 'cm-1': 10 };

/**
 * CSV of the curves on a regular grid over the window (v_spectra data_csv:
 * x, then "<name>:total", "<name>:ci_low", "<name>:ci_high" per curve,
 * '%.18e'); cells outside a curve's data range are empty instead of the
 * clamped end value np.interp would give.
 */
export function curvesCsv(curves: Curve[], axis: XAxis, w: [number, number], step = DEFAULT_STEP[axis]): { text: string; rows: number; columns: number } {
  const grid = stepGrid(w[0], w[1], step).map(round);
  const names = [CSV_X[axis]];
  const cols: (number | undefined)[][] = [grid];
  const unique = new Map<string, number>();
  for (const c of curves) {
    let name = c.label.replace(/[,\r\n]/g, ' ');
    const k = unique.get(name) ?? 0;
    unique.set(name, k + 1);
    if (k) name = `${name} (${k + 1})`;
    const inRange = (v: number) => v >= c.x[0] && v <= c.x[c.x.length - 1];
    const parts: [string, number[] | undefined][] = [['total', c.y], ['ci_low', c.lo], ['ci_high', c.hi]];
    for (const [suffix, ys] of parts) {
      if (!ys) continue;
      names.push(`${name}:${suffix}`);
      const v = interp(grid, c.x, ys);
      cols.push(grid.map((g, i) => (inRange(g) ? v[i] : undefined)));
    }
  }
  const lines = [names.join(',')];
  for (let i = 0; i < grid.length; i++) {
    lines.push(cols.map(col => (col[i] === undefined ? '' : formatE18(col[i] as number))).join(','));
  }
  return { text: lines.join('\n') + '\n', rows: grid.length, columns: names.length };
}
