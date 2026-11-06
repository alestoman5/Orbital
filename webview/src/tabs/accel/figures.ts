// Figures of the Accelerated UV/Vis tab. Pure: chart-engine Figure objects from the pipeline
// outputs (src/studio/tabs/accel/types.ts), unit-testable without a DOM.

import { EXP_COLOR, PALETTE, REF_COLOR, type Figure, type Series } from '../../charts/api';
import type { KrrSummary, MbtrGrid, MinimumStates, SpectrumCurve, TargetModel } from '../../../../src/studio/tabs/accel/types';

const NM_EV = 1239.841984;
const WIDE = { widthIn: 3.25, heightIn: 2.4 };
const SQUARE = { widthIn: 3.25, heightIn: 3.0 };

/** eV on top of a nm axis. */
const EV_AXIS = { label: 'E / eV', toSecondary: (nm: number) => NM_EV / nm, fromSecondary: (ev: number) => NM_EV / ev };

/** Pretty MO / transition labels: "pi -> pi*" -> "π → π*". */
export function greek(s: string): string {
  return s.replace(/sigma/g, 'σ').replace(/pi/g, 'π').replace(/->/g, '→');
}

export function short(v: number | null | undefined, digits = 3): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2).replace('e+', 'e');
  return String(Number(v.toPrecision(digits)));
}

/** ML-NEA and direct NEA with their CI bands, experiment dashed; λ / nm with E / eV on top. */
export function spectrumFigure(curves: SpectrumCurve[], window?: [number, number]): Figure {
  const series: Series[] = [];
  const colorOf = (c: SpectrumCurve) => (c.kind === 'ml' ? PALETTE[0] : c.kind === 'direct' ? REF_COLOR : EXP_COLOR);
  for (const c of curves) {
    if (c.kind !== 'experiment' && c.lo && c.hi) {
      series.push({ type: 'band', x: c.x, lo: c.lo, hi: c.hi, group: c.label, color: colorOf(c), opacity: c.kind === 'ml' ? 0.25 : 0.15 });
    }
  }
  for (const c of curves) {
    series.push({
      type: 'line', x: c.x, y: c.y, label: c.label, group: c.label, color: colorOf(c),
      dash: c.kind === 'experiment' ? 'dashed' : c.kind === 'direct' ? 'dotted' : 'solid'
    });
  }
  // Experiment usually spans a different range: scale the axis to the computed curves.
  const comp = curves.filter(c => c.kind !== 'experiment');
  let xmin = window?.[0];
  let xmax = window?.[1];
  if (xmin === undefined && comp.length) {
    const peakish = comp.flatMap(c => c.x.filter((_, i) => c.y[i] > 0.01 * Math.max(...c.y)));
    if (peakish.length) {
      const lo = Math.min(...peakish);
      const hi = Math.max(...peakish);
      const pad = 0.08 * (hi - lo || 50);
      xmin = Math.max(0, lo - pad);
      xmax = hi + pad;
    }
  }
  return {
    panels: [{
      x: { label: 'λ / nm', min: xmin, max: xmax }, y: { label: 'σ / cm^{2} molecule^{−1}' },
      xSecondary: EV_AXIS, series, legend: 'top-right'
    }],
    size: WIDE
  };
}

/** States at the minimum as sticks (E vs f); the dominant one highlighted and labelled. */
export function statesFigure(m: MinimumStates): Figure {
  const dom = m.states.filter(s => s.state === m.target_state);
  const rest = m.states.filter(s => s.state !== m.target_state);
  const series: Series[] = [
    { type: 'sticks', x: rest.map(s => s.e_ev), y: rest.map(s => s.f), label: 'states', color: REF_COLOR, width: 1.5 },
    { type: 'sticks', x: dom.map(s => s.e_ev), y: dom.map(s => s.f), label: `S${m.target_state} (followed)`, color: PALETTE[1], width: 2.2 }
  ];
  for (const s of m.states) {
    series.push({ type: 'text', x: s.e_ev, y: s.f, text: `S${s.state}`, anchor: 'middle', dy: -4 });
  }
  const es = m.states.map(s => s.e_ev);
  const pad = 0.3 + 0.05 * (Math.max(...es) - Math.min(...es));
  return {
    panels: [{
      x: { label: 'E / eV', min: Math.max(0, Math.min(...es) - pad), max: Math.max(...es) + pad },
      y: { label: 'f', min: 0, max: Math.max(0.01, ...m.states.map(s => s.f)) * 1.25 }, series, legend: 'top-left'
    }],
    size: WIDE
  };
}

/** Inverse-distance histograms per element pair with the chosen MBTR grid range. */
export function mbtrFigure(g: MbtrGrid): Figure {
  const series: Series[] = Object.entries(g.hist).map(([pair, counts]) => ({
    type: 'histogram' as const, edges: g.hist_edges, values: counts, label: pair, style: 'filled' as const, opacity: 0.35
  }));
  series.push({ type: 'vline', value: g.min, color: REF_COLOR, dash: 'dashed', label: 'MBTR grid' });
  series.push({ type: 'vline', value: g.max, color: REF_COLOR, dash: 'dashed' });
  return {
    panels: [{ x: { label: 'r^{−1} / Å^{−1}', min: Math.min(g.min, g.hist_edges[0]), max: Math.max(g.max, g.hist_edges[g.hist_edges.length - 1]) }, y: { label: 'count' }, series, legend: 'top-right' }],
    size: WIDE
  };
}

/** Nested-CV parity plot of one target. */
export function parityFigure(t: TargetModel, label: string, unit: string): Figure | null {
  if (!t.parity || !t.parity.y.length) return null;
  const all = [...t.parity.y, ...t.parity.y_cv];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) { hi += 0.5; lo -= 0.5; }
  const pad = 0.04 * (hi - lo);
  lo -= pad;
  hi += pad;
  const ax = unit ? `${label} / ${unit}` : label;
  const series: Series[] = [
    { type: 'line', x: [lo, hi], y: [lo, hi], color: REF_COLOR, width: 0.75, dash: 'dashed' },
    { type: 'scatter', x: t.parity.y, y: t.parity.y_cv, label: `nested CV (${t.parity.y.length})`, size: 2.4, opacity: 0.6 }
  ];
  if (t.nested) {
    series.push({ type: 'text', x: hi - pad, y: lo + 1.2 * pad, anchor: 'end', text: `MAE = ${short(t.nested.mae)}${unit ? ' ' + unit : ''}, R^{2} = ${short(t.nested.r2)}` });
  }
  return {
    panels: [{ equalAspect: true, legend: 'top-left', x: { label: `${ax}, computed`, min: lo, max: hi, zero: false }, y: { label: `${ax}, KRR`, min: lo, max: hi, zero: false }, series }],
    size: SQUARE
  };
}

/** Grid-search CV MAE over log10 alpha × log10 gamma. */
export function gridFigure(t: TargetModel, label: string): Figure | null {
  const { alpha, gamma, mae } = t.grid;
  if (alpha.length < 2 || gamma.length < 2) return null;
  const edges = (v: number[]) => {
    const l = v.map(Math.log10);
    const d = l.length > 1 ? l[1] - l[0] : 1;
    return [...l.map(x => x - d / 2), l[l.length - 1] + d / 2];
  };
  const best = t.best_params;
  return {
    panels: [{
      x: { label: 'log_{10} γ', zero: false }, y: { label: 'log_{10} α', zero: false },
      series: [
        { type: 'heatmap', xEdges: edges(gamma), yEdges: edges(alpha), z: mae, colormap: 'viridis', logZ: true, colorbarLabel: `CV MAE (${label})` },
        { type: 'scatter', x: [Math.log10(best.gamma)], y: [Math.log10(best.alpha)], marker: 'cross', size: 7, color: PALETTE[6], label: 'optimum' }
      ],
      legend: 'none'
    }],
    size: SQUARE
  };
}

/** Distribution of the predicted E (or f) of the whole ensemble vs the training set. */
export function predictionHistFigure(k: KrrSummary, which: 'E' | 'f'): Figure {
  const edges = which === 'E' ? k.hist.E_edges : k.hist.f_edges;
  const all = which === 'E' ? k.hist.E_all : k.hist.f_all;
  const train = which === 'E' ? k.hist.E_train : k.hist.f_train;
  return {
    panels: [{
      x: { label: which === 'E' ? `E(S_{${k.target_state}}) / eV` : `f(S_{${k.target_state}})`, zero: which === 'f' },
      y: { label: 'probability density' },
      series: [
        { type: 'histogram', edges, values: all, label: `ensemble, KRR (${k.n_all})`, style: 'filled', opacity: 0.35, color: PALETTE[0] },
        { type: 'histogram', edges, values: train, label: `training, computed (${k.n_train})`, style: 'step', color: PALETTE[1] }
      ],
      legend: 'top-right'
    }],
    size: WIDE
  };
}

/** Wavelength of the maximum of a curve (nm) and its FWHM, for the KPI row. */
export function bandMaximum(c: SpectrumCurve): { lmax: number; peak: number; fwhm: number } | null {
  if (!c.x.length) return null;
  let i = 0;
  for (let k = 1; k < c.y.length; k++) if (c.y[k] > c.y[i]) i = k;
  const half = c.y[i] / 2;
  let a = i;
  let b = i;
  while (a > 0 && c.y[a] > half) a--;
  while (b < c.y.length - 1 && c.y[b] > half) b++;
  return { lmax: c.x[i], peak: c.y[i], fwhm: Math.abs(c.x[b] - c.x[a]) };
}
