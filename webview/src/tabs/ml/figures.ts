// Figures of the ML tab (parity plot, learning curve, grid search, run
// comparison). Pure: builds chart-engine Figure objects from run results, so
// it is unit-testable without a DOM.

import { REF_COLOR, type AxisSpec, type Figure, type Series } from '../../charts/api';
import type { CompareRow, Predictions, RunResult } from '../../../../src/studio/tabs/ml/types';

const SIZE_SQUARE = { widthIn: 3.25, heightIn: 3.0 };
const SIZE_WIDE = { widthIn: 3.25, heightIn: 2.4 };

/** Short number for labels: 3 significant digits, exponent form for tiny / huge values. */
export function short(v: unknown): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) {
      const [m, e] = v.toExponential(2).split('e');
      return `${m.replace(/\.?0+$/, '')}e${e.replace('+', '')}`;
    }
    return String(Number(v.toPrecision(3)));
  }
  return String(v);
}

function pairs(y: (number | null)[], p: (number | null)[]): { x: number[]; y: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  y.forEach((v, i) => {
    const w = p[i];
    if (typeof v === 'number' && typeof w === 'number' && Number.isFinite(v) && Number.isFinite(w)) {
      xs.push(v);
      ys.push(w);
    }
  });
  return { x: xs, y: ys };
}

/** Parity plot: train and test scatter, y = x, test MAE in the corner. */
export function parityFigure(pred: Predictions, result: RunResult | null, target: string): Figure {
  const tr = pairs(pred.y_train, pred.y_train_pred);
  const te = pairs(pred.y_test, pred.y_test_pred);
  const all = [...tr.x, ...tr.y, ...te.x, ...te.y];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) {
    hi += 0.5;
    lo -= 0.5;
  }
  const pad = 0.04 * (hi - lo);
  lo -= pad;
  hi += pad;
  const series: Series[] = [
    { type: 'line', x: [lo, hi], y: [lo, hi], color: REF_COLOR, width: 0.75, dash: 'dashed' },
    { type: 'scatter', x: tr.x, y: tr.y, label: `train (${tr.x.length})`, size: 2.2, opacity: 0.45 },
    { type: 'scatter', x: te.x, y: te.y, label: `test (${te.x.length})`, size: 2.8, marker: 'diamond', opacity: 0.85 }
  ];
  if (result?.test) {
    series.push({ type: 'text', x: hi - pad, y: lo + 1.2 * pad, anchor: 'end', text: `test MAE = ${short(result.test.mae)}, R^{2} = ${result.test.r2.toFixed(3)}` });
  }
  return {
    panels: [{
      equalAspect: true, legend: 'top-left',
      x: { label: `${target}, reference`, min: lo, max: hi, zero: false },
      y: { label: `${target}, predicted`, min: lo, max: hi, zero: false },
      series
    }],
    size: SIZE_SQUARE
  };
}

/** Learning curve(s): test MAE vs training-set size, log-log. */
export function curveFigure(curves: { label?: string; curve: { n: number; test_mae: number }[] }[]): Figure {
  const series: Series[] = curves.filter(c => c.curve.length).map(c => ({
    type: 'line' as const, x: c.curve.map(p => p.n), y: c.curve.map(p => p.test_mae), markers: true, label: c.label
  }));
  return {
    panels: [{
      x: { label: 'n_{train}', log: true },
      y: { label: 'MAE (test set)', log: true },
      legend: curves.length > 1 ? 'top-right' : 'none',
      series
    }],
    size: SIZE_WIDE
  };
}

// ------------------------------------------------------------------ grid search

export interface GridAxis {
  key: string;
  /** Distinct values in grid order. */
  values: unknown[];
  /** Plot coordinate of each value (log10 for log-spaced positive numbers, index for categories). */
  coords: number[];
  label: string;
  format: (v: number) => string;
  log: boolean;
}

function isLogSpaced(v: number[]): boolean {
  if (v.length < 3 || v.some(x => !(x > 0))) return v.length === 2 && v.every(x => x > 0) && v[1] / v[0] >= 10;
  const s = [...v].sort((a, b) => a - b);
  const r = s.slice(1).map((x, i) => Math.log10(x / s[i]));
  const lin = s.slice(1).map((x, i) => x - s[i]);
  const spread = (a: number[]) => (Math.max(...a) - Math.min(...a)) / Math.max(Math.abs(Math.max(...a)), 1e-300);
  return spread(r) < spread(lin);
}

export function gridAxis(key: string, values: unknown[]): GridAxis {
  const numeric = values.every(v => typeof v === 'number' && Number.isFinite(v));
  if (numeric) {
    const nums = (values as number[]).slice().sort((a, b) => a - b);
    const log = isLogSpaced(nums);
    const coords = nums.map(v => (log ? Math.log10(v) : v));
    const byCoord = new Map(coords.map((c, i) => [c, nums[i]]));
    return { key, values: nums, coords, log, label: log ? `log_{10} ${key}` : key, format: c => short(log ? Math.round(c * 100) / 100 : (byCoord.get(c) ?? c)) };
  }
  const labels = values.map(String);
  return { key, values, coords: values.map((_, i) => i), log: false, label: key, format: c => labels[Math.round(c)] ?? '' };
}

/** Parameters that vary in the grid, with their distinct values (first-seen order). */
export function variedParams(grid: NonNullable<RunResult['grid']>): { key: string; values: unknown[] }[] {
  if (!grid.length) return [];
  const keys = Object.keys(grid[0]).filter(k => k !== 'cv_mae');
  const out: { key: string; values: unknown[] }[] = [];
  for (const k of keys) {
    const seen: unknown[] = [];
    for (const g of grid) if (!seen.some(s => s === g[k])) seen.push(g[k]);
    if (seen.length > 1) out.push({ key: k, values: seen });
  }
  return out;
}

function edgesOf(c: number[]): number[] {
  if (c.length === 1) return [c[0] - 0.5, c[0] + 0.5];
  const e = [c[0] - (c[1] - c[0]) / 2];
  for (let i = 1; i < c.length; i++) e.push((c[i - 1] + c[i]) / 2);
  e.push(c[c.length - 1] + (c[c.length - 1] - c[c.length - 2]) / 2);
  return e;
}

function tickAxis(a: GridAxis): AxisSpec {
  const step = Math.ceil(a.coords.length / 9);
  return { label: a.label, ticks: a.coords.filter((_, i) => i % step === 0), format: a.format, zero: false, grid: false };
}

/**
 * Grid-search figure: a heatmap of CV MAE over two varied parameters (the best over any further
 * ones), or CV MAE vs the single varied parameter. Null when nothing varies.
 */
export function gridFigure(result: RunResult): { figure: Figure; note: string } | null {
  const grid = result.grid ?? [];
  const varied = variedParams(grid);
  if (!varied.length) return null;
  const best = result.best_params ?? {};
  if (varied.length === 1) {
    const ax = gridAxis(varied[0].key, varied[0].values);
    const y = ax.values.map(v => Math.min(...grid.filter(g => g[ax.key] === v).map(g => g.cv_mae)));
    const series: Series[] = [{ type: 'line', x: ax.coords, y, markers: true, label: 'CV MAE' }];
    const bi = ax.values.findIndex(v => v === best[ax.key]);
    if (bi >= 0) series.push({ type: 'scatter', x: [ax.coords[bi]], y: [y[bi]], marker: 'diamond', size: 6, label: 'best' });
    return {
      figure: { panels: [{ x: { ...tickAxis(ax), grid: true }, y: { label: 'CV MAE', zero: false }, series, legend: 'none' }], size: SIZE_WIDE },
      note: `${grid.length} combinations`
    };
  }
  // the two parameters with the most values go on the axes
  const [px, py] = [...varied].sort((a, b) => b.values.length - a.values.length).slice(0, 2);
  const ax = gridAxis(px.key, px.values);
  const ay = gridAxis(py.key, py.values);
  const z = ay.values.map(vy => ax.values.map(vx => {
    const cells = grid.filter(g => g[px.key] === vx && g[py.key] === vy).map(g => g.cv_mae).filter(Number.isFinite);
    return cells.length ? Math.min(...cells) : NaN;
  }));
  const others = varied.filter(v => v !== px && v !== py).map(v => v.key);
  const n = ax.values.length * ay.values.length;
  const series: Series[] = [{
    type: 'heatmap', xEdges: edgesOf(ax.coords), yEdges: edgesOf(ay.coords), z, colormap: 'viridis',
    colorbarLabel: 'CV MAE', annotate: n <= 120 ? (v: number) => short(v) : false
  }];
  return {
    figure: { panels: [{ x: tickAxis(ax), y: tickAxis(ay), legend: 'none', series }], size: { widthIn: 3.6, heightIn: 2.8 } },
    note: others.length ? `best CV MAE over ${others.join(', ')}` : `${grid.length} combinations`
  };
}

/** Bars of test MAE per run (comparison). */
export function compareBarsFigure(rows: CompareRow[]): Figure {
  const ok = rows.filter(r => r.test);
  const names = ok.map(r => (r.name.length > 18 ? r.name.slice(0, 17) + '…' : r.name));
  return {
    panels: [{
      x: { label: 'run', ticks: ok.map((_, i) => i + 0.5), format: v => names[Math.floor(v)] ?? '', grid: false, min: 0, max: Math.max(ok.length, 1) },
      y: { label: 'MAE (test set)' },
      legend: 'none',
      // separated bars: [i + 0.2, i + 0.8] carries the value, the gaps between are empty bins
      series: [{
        type: 'histogram', edges: ok.flatMap((_, i) => [i + 0.2, i + 0.8]), values: ok.flatMap((r, i) => (i < ok.length - 1 ? [r.test!.mae, 0] : [r.test!.mae])),
        style: 'filled', opacity: 0.75, label: 'test MAE'
      }]
    }],
    size: SIZE_WIDE
  };
}
