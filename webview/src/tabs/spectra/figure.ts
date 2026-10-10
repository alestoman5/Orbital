// Builds the chart-engine Figure of the spectra tab from the host's
// plot-ready series: overlay, overlay + difference (stack) or small
// multiples (grid). Colors: Okabe-Ito per series, the reference in
// REF_COLOR when it is compared against, experiments dashed in EXP_COLOR.

import { EXP_COLOR, JOURNAL_SIZES, PALETTE, REF_COLOR, type Figure, type FigureSize, type Panel, type Preset, type SecondaryAxisSpec, type Series } from '../../charts';
import type { LoadResult, PlotSeries, XAxis } from '../../../../src/studio/tabs/spectra/types';

export type Mode = 'overlay' | 'diff' | 'multiples';

export interface FigureOptions {
  mode: Mode;
  refId?: string;
  ci: boolean;
  states: boolean;
  sticks: boolean;
  secondary: boolean;
  preset: Preset;
  /** Size picked in the toolbar; undefined = a default for the mode. */
  size?: FigureSize;
  labels: Map<string, string>;
}

export const X_LABEL: Record<XAxis, string> = { nm: 'λ / nm', eV: 'E / eV', 'cm-1': 'ν̃ / cm^{−1}' };
export const X_UNIT: Record<XAxis, string> = { nm: 'nm', eV: 'eV', 'cm-1': 'cm⁻¹' };
const HC_EV_NM = 1239.84198;

export function yLabel(res: Pick<LoadResult, 'yScale' | 'normalized'>, diff = false): string {
  const d = diff ? 'Δ' : '';
  if (res.normalized) return diff ? 'Δ(σ / σ_{max})' : 'σ / σ_{max}';
  return res.yScale === 'relative' ? `${d}f density / eV^{−1}` : `${d}σ / cm^{2} molecule^{−1}`;
}

function secondaryFor(axis: XAxis, range: [number, number]): SecondaryAxisSpec | undefined {
  if (!(range[0] > 0)) return undefined;
  if (axis === 'nm') return { label: 'E / eV', toSecondary: v => HC_EV_NM / v, fromSecondary: v => HC_EV_NM / v };
  if (axis === 'eV') return { label: 'λ / nm', toSecondary: v => HC_EV_NM / v, fromSecondary: v => HC_EV_NM / v };
  return { label: 'λ / nm', toSecondary: v => 1e7 / v, fromSecondary: v => 1e7 / v };
}

/**
 * Series colors in plot order: computed/NEA series take palette slots in
 * order (the reference REF_COLOR in difference / multiples mode),
 * experiments EXP_COLOR.
 */
export function seriesColors(res: LoadResult, mode: Mode, refId?: string): Map<string, string> {
  const out = new Map<string, string>();
  let k = 0;
  const neutralRef = mode !== 'overlay' && refId !== undefined;
  for (const s of res.series) {
    if (s.kind === 'exp') out.set(s.id, EXP_COLOR);
    else if (neutralRef && s.id === refId) out.set(s.id, REF_COLOR);
    else out.set(s.id, PALETTE[k++ % PALETTE.length]);
  }
  return out;
}

function label(s: PlotSeries, o: FigureOptions): string {
  const base = o.labels.get(s.id) ?? s.label;
  return s.kind === 'exp' && s.scale !== undefined ? `${base} (×${s.scale.toFixed(2)})` : base;
}

function curveSeries(s: PlotSeries, color: string, o: FigureOptions, opts: { width?: number; bandOpacity?: number } = {}): Series[] {
  const name = label(s, o);
  const group = s.id;
  const out: Series[] = [];
  if (s.kind === 'exp') {
    out.push({ type: 'line', x: s.x, y: s.y, label: name, group, color, dash: 'dashed', width: 1.1 });
    return out;
  }
  if (o.ci && s.lo && s.hi) {
    out.push({ type: 'band', x: s.x, lo: s.lo, hi: s.hi, group, color, opacity: opts.bandOpacity });
  }
  if (o.states && s.states) {
    for (const st of s.states) out.push({ type: 'line', x: s.x, y: st, group, color, width: 0.6, dash: 'dotted' });
  }
  out.push({ type: 'line', x: s.x, y: s.y, label: name, group, color, width: opts.width });
  if (o.sticks && s.sticks && s.sticks.x.length) {
    // ensembles: thousands of sticks, kept low under the band so the curve stays readable
    const many = s.sticks.x.length > 200;
    out.push({ type: 'sticks', x: s.sticks.x, y: s.sticks.f, yAxis: many ? 'left' : 'right', group, color, width: many ? 0.35 : 1, relativeHeight: many ? 0.3 : undefined });
  }
  return out;
}

function hasSticks(series: Series[]): boolean {
  return series.some(s => s.type === 'sticks' && !s.relativeHeight);
}

function basePanel(res: LoadResult, o: FigureOptions, series: Series[]): Panel {
  const p: Panel = {
    x: { label: X_LABEL[res.axis], min: res.range[0], max: res.range[1] },
    y: { label: yLabel(res) },
    series
  };
  if (hasSticks(series)) p.y2 = { label: 'f', min: 0 };
  return p;
}

export function defaultSize(mode: Mode, panels: number): FigureSize {
  if (mode === 'diff') return { widthIn: 3.25, heightIn: 3.4 };
  if (mode === 'multiples' && panels > 1) {
    const s = JOURNAL_SIZES['acs-2col'];
    const rows = Math.ceil(panels / 3);
    return { widthIn: s.widthIn, heightIn: Math.min(9, 2.2 * rows + 0.5) };
  }
  const s = JOURNAL_SIZES['acs-1col'];
  return { widthIn: s.widthIn, heightIn: s.heightIn };
}

export function buildFigure(res: LoadResult, o: FigureOptions): Figure {
  const colors = seriesColors(res, o.mode, o.refId);
  const ref = res.series.find(s => s.id === o.refId);
  const exps = res.series.filter(s => s.kind === 'exp');
  const secondary = o.secondary ? secondaryFor(res.axis, res.range) : undefined;

  if (o.mode === 'multiples' && ref) {
    const others = res.series.filter(s => s !== ref && s.kind !== 'exp');
    if (others.length) {
      const panels: Panel[] = others.map(s => basePanel(res, o, [
        ...curveSeries(ref, REF_COLOR, o, { width: 1, bandOpacity: 0.12 }),
        ...exps.flatMap(e => curveSeries(e, EXP_COLOR, o)),
        ...curveSeries(s, colors.get(s.id)!, o)
      ]));
      return {
        layout: { kind: 'grid', cols: Math.min(3, panels.length), sharedX: true, sharedY: true },
        panelLabels: true,
        panels,
        preset: o.preset,
        size: o.size ?? defaultSize('multiples', panels.length)
      };
    }
  }

  // overlay: experiments last so they draw on top
  const ordered = [...res.series.filter(s => s.kind !== 'exp'), ...exps];
  const top = basePanel(res, o, ordered.flatMap(s => curveSeries(s, colors.get(s.id)!, o)));
  if (secondary) top.xSecondary = secondary;

  if (o.mode === 'diff' && ref && res.difference && res.difference.length) {
    top.heightRatio = 2;
    const bottom: Series[] = [{ type: 'hline', value: 0, color: REF_COLOR, width: 0.8, group: ref.id }];
    for (const d of res.difference) {
      const color = colors.get(d.id) ?? PALETTE[0];
      if (o.ci && d.lo && d.hi) bottom.push({ type: 'band', x: d.x, lo: d.lo, hi: d.hi, group: d.id, color, opacity: 0.2 });
      bottom.push({ type: 'line', x: d.x, y: d.diff, group: d.id, color });
    }
    return {
      layout: { kind: 'stack', sharedX: true },
      panelLabels: true,
      panels: [
        top,
        { x: { label: X_LABEL[res.axis], min: res.range[0], max: res.range[1] }, y: { label: yLabel(res, true), zero: false }, series: bottom, heightRatio: 1, legend: 'none' }
      ],
      preset: o.preset,
      size: o.size ?? defaultSize('diff', 2)
    };
  }
  return { panels: [top], preset: o.preset, size: o.size ?? defaultSize('overlay', 1) };
}
