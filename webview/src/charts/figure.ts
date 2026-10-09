// Builds a Figure into SVG markup plus a geometric model (plot rectangles and
// scales per panel) that the interactive layer uses. String based and
// DOM-free: the screen view, toSvg, toPng and toPdf all run through here, so
// what is on screen is what gets exported.

import type { AxisSpec, Figure, HeatmapSeries, Panel, SecondaryAxisSpec, Series } from './api';
import { colorAt, colormapStops, normalizer } from './colormap';
import { factorMarkup, formatLinearTicks, formatLogTicks, labelWithFactor } from './format';
import { equalAspectBox, gridLayout, maxTickCount, stackLayout, type Box, type Req } from './layout';
import { bestCorner, cornerBox, isOutside, legendEntries, legendMarkup, measureLegend, type LegendHit, type ResolvedSeries } from './legend';
import { bandMark, f, heatmapLimits, heatmapMark, histogramMark, lineMark, ruleMark, scatterMark, sticksMark, textMark, type MarkContext } from './marks';
import { autoDomain, logTicks, minorTicks, nextStep, Scale, secondaryTicks, ticksFor, ticksForStep, type Ticks } from './scales';
import { escapeXml, parseRich, richExtent, richSvg, richWidth, wrapRuns, type Run } from './text';
import type { Theme } from './themes';

export type Range = [number, number];

/** Zoomed limits per panel (data units). */
export interface ZoomState {
  x?: Range;
  y?: Range;
  y2?: Range;
}

export interface BuildOptions {
  theme: Theme;
  /** Figure size in user units (pt for publication, px for screen). */
  width: number;
  height: number;
  /** Device pixels per user unit (decimation resolution). */
  pxPerUnit: number;
  /** Unique id prefix for clip paths / gradients. */
  idPrefix: string;
  zoom?: (ZoomState | undefined)[];
  hidden?: ReadonlySet<string>;
  /** PDF export: font family per code point. */
  fontFor?: (cp: number) => string;
  /** Paint the theme background (exports); false for transparent. */
  background?: boolean;
}

export interface PanelModel {
  index: number;
  spec: Panel;
  rect: Box;
  x: Scale;
  y: Scale;
  y2?: Scale;
  base: { x: Range; y: Range; y2?: Range };
  series: ResolvedSeries[];
}

export interface FigureModel {
  width: number;
  height: number;
  panels: PanelModel[];
  legendHits: LegendHit[];
  /** Inner markup of the <svg> (defs + layers). */
  body: string;
  sharedX: boolean;
}

const LINEAR_KINDS = new Set<Series['type']>(['line', 'band', 'histogram', 'heatmap', 'hline']);

// --- series resolution ---------------------------------------------------------------

export function seriesKey(s: Series, panel: number, index: number): string {
  return s.group ? `g:${s.group}` : s.label ? `l:${s.label}` : `#${panel}.${index}`;
}

export function resolveSeries(figure: Figure, theme: Theme, hidden?: ReadonlySet<string>): ResolvedSeries[][] {
  const palette = theme.palette.length ? theme.palette : ['#000000'];
  const groupColor = new Map<string, string>();
  // explicit colors of any group member win for the whole group
  for (const p of figure.panels) {
    for (const s of p.series) {
      if (s.group && s.color && !groupColor.has(s.group)) {
        groupColor.set(s.group, s.color);
      }
    }
  }
  return figure.panels.map((p, pi) => {
    let next = 0;
    const seen = new Set<string>();
    return p.series.map((s, si) => {
      let color: string;
      if (s.type === 'heatmap') {
        color = theme.fg;
      } else if (s.type === 'hline' || s.type === 'vline' || s.type === 'text') {
        color = s.color ?? (s.group ? groupColor.get(s.group) : undefined) ?? theme.fg;
      } else if (s.color) {
        color = s.color;
      } else if (s.group && groupColor.has(s.group)) {
        color = groupColor.get(s.group)!;
        if (!seen.has(s.group)) {
          next++; // the group still takes its slot in the colour cycle
        }
      } else {
        color = palette[next++ % palette.length];
        if (s.group) {
          groupColor.set(s.group, color);
        }
      }
      if (s.group) {
        seen.add(s.group);
      }
      const key = seriesKey(s, pi, si);
      return { s, color: theme.adjustColor(color), key, hidden: !!hidden?.has(key), panel: pi, index: si };
    });
  });
}

// --- data extents ----------------------------------------------------------------------

class Extent {
  lo = Infinity;
  hi = -Infinity;
  constructor(readonly positive: boolean) {}
  add(v: number): void {
    if (!Number.isFinite(v) || (this.positive && v <= 0)) {
      return;
    }
    if (v < this.lo) { this.lo = v; }
    if (v > this.hi) { this.hi = v; }
  }
  addAll(a: ArrayLike<number> | undefined): void {
    if (!a) {
      return;
    }
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v < this.lo && Number.isFinite(v) && !(this.positive && v <= 0)) { this.lo = v; }
      if (v > this.hi && Number.isFinite(v)) { this.hi = v; }
    }
  }
  get empty(): boolean {
    return !(this.hi >= this.lo);
  }
}

function xExtent(series: Series[], log: boolean): Extent {
  const e = new Extent(log);
  for (const s of series) {
    switch (s.type) {
      case 'line': case 'band': case 'sticks':
        e.addAll(s.x);
        break;
      case 'scatter':
        if (s.xErr) {
          for (let i = 0; i < s.x.length; i++) {
            e.add(s.x[i] - (s.xErr[i] || 0));
            e.add(s.x[i] + (s.xErr[i] || 0));
          }
        } else {
          e.addAll(s.x);
        }
        break;
      case 'histogram':
        e.addAll(s.edges);
        break;
      case 'heatmap':
        e.addAll(s.xEdges);
        break;
      case 'vline':
        e.add(s.value);
        break;
      default:
        break;
    }
  }
  return e;
}

function yExtent(series: Series[], log: boolean, side: 'left' | 'right'): Extent {
  const e = new Extent(log);
  for (const s of series) {
    if ((s.yAxis ?? 'left') !== side) {
      continue;
    }
    switch (s.type) {
      case 'line':
        e.addAll(s.y);
        break;
      case 'band':
        e.addAll(s.lo);
        e.addAll(s.hi);
        break;
      case 'sticks':
        if (!s.relativeHeight) {
          e.addAll(s.y);
          e.add(0);
        }
        break;
      case 'scatter':
        if (s.yErr) {
          for (let i = 0; i < s.y.length; i++) {
            e.add(s.y[i] - (s.yErr[i] || 0));
            e.add(s.y[i] + (s.yErr[i] || 0));
          }
        } else {
          e.addAll(s.y);
        }
        break;
      case 'histogram':
        e.addAll(s.values);
        e.add(0);
        break;
      case 'heatmap':
        e.addAll(s.yEdges);
        break;
      case 'hline':
        e.add(s.value);
        break;
      default:
        break;
    }
  }
  return e;
}

function withExplicit(d: Range, spec: AxisSpec): Range {
  return [spec.min ?? d[0], spec.max ?? d[1]];
}

function xAuto(series: Series[], spec: AxisSpec): Range {
  const e = xExtent(series, !!spec.log);
  const continuous = series.every(s => LINEAR_KINDS.has(s.type) || s.type === 'vline');
  const margin = continuous ? 0 : 0.04;
  const d = e.empty ? (spec.log ? [1, 10] as Range : [0, 1] as Range) : autoDomain(e.lo, e.hi, { log: spec.log, margin, zero: spec.zero === true });
  return withExplicit(d, spec);
}

function yAuto(series: Series[], spec: AxisSpec, side: 'left' | 'right', panel: Panel): Range {
  const e = yExtent(series, !!spec.log, side);
  const onlyGrid = series.filter(s => (s.yAxis ?? 'left') === side).every(s => s.type === 'heatmap');
  const parity = panel.equalAspect && series.every(s => s.type === 'scatter' || s.type === 'line' || s.type === 'text');
  const zero = spec.zero ?? !(onlyGrid || parity);
  const margin = onlyGrid ? 0 : 0.05;
  const d = e.empty ? (spec.log ? [1, 10] as Range : [0, 1] as Range) : autoDomain(e.lo, e.hi, { log: spec.log, margin, zero });
  return withExplicit(d, spec);
}

// --- axis ticks ---------------------------------------------------------------------

interface AxisTicks {
  major: number[];
  minor: number[];
  labels: Run[][];
  /** Widest / tallest label in user units. */
  maxW: number;
  ascent: number;
  descent: number;
  exponent: number;
  /** Label text including the factor. */
  label?: Run[];
  /** The label broken into lines that fit the axis length (rotated labels). */
  lines: Run[][];
  /** Factor text drawn separately when the label has no " / ". */
  factor?: Run[];
}

function evenStep(t: number[]): number | undefined {
  if (t.length < 2) {
    return undefined;
  }
  const s = t[1] - t[0];
  return t.every((v, i) => i === 0 || Math.abs(v - t[i - 1] - s) < Math.abs(s) * 1e-6) ? Math.abs(s) : undefined;
}

function axisTicks(spec: AxisSpec, d: Range, length: number, horizontal: boolean, theme: Theme, size: number): AxisTicks {
  const lo = Math.min(d[0], d[1]);
  const hi = Math.max(d[0], d[1]);
  const spacing = horizontal ? (theme.preset === 'publication' ? size * 3.2 : 84) : (theme.preset === 'publication' ? size * 2.1 : 44);
  const maxN = maxTickCount(length, spacing);
  let t: Ticks;
  const make = (): Ticks => {
    if (spec.ticks) {
      const major = spec.ticks.filter(v => v >= lo - 1e-9 * (hi - lo) && v <= hi + 1e-9 * (hi - lo));
      const st = evenStep(major);
      return { major, minor: st && !spec.log ? minorTicks(lo, hi, st) : [], step: st ?? 1 };
    }
    return ticksFor(lo, hi, !!spec.log, maxN);
  };
  t = make();
  let fmt = format(spec, t);
  if (horizontal && !spec.ticks && !spec.log) {
    // widen the step until the labels do not collide
    for (let guard = 0; guard < 6 && t.major.length > 2; guard++) {
      const widths = fmt.labels.map(r => richWidth(r, size, theme.measure));
      const maxW = Math.max(...widths);
      const px = (length * t.step) / (hi - lo || 1);
      if (maxW + size * 1.0 <= px) {
        break;
      }
      const step = nextStep(t.step);
      t = { major: ticksForStep(lo, hi, step), minor: minorTicks(lo, hi, step), step };
      fmt = format(spec, t);
    }
  }
  if (spec.log && !spec.ticks && t.major.length > maxN) {
    t = logTicks(lo, hi, Math.max(2, maxN - 1));
    fmt = format(spec, t);
  }
  const hidden = !!spec.hideTickLabels;
  let maxW = 0;
  let ascent = 0.72 * size;
  let descent = 0.21 * size;
  if (!hidden) {
    for (const r of fmt.labels) {
      maxW = Math.max(maxW, richWidth(r, size, theme.measure));
      const e = richExtent(r, size);
      ascent = Math.max(ascent, e.ascent);
      descent = Math.max(descent, e.descent);
    }
  }
  let label: Run[] | undefined;
  let factor: Run[] | undefined;
  const text = spec.label?.trim() ? spec.label : undefined;
  if (fmt.exponent !== 0 && hidden && !text) {
    // shared axis without labels: the visible neighbour carries the factor
  } else if (fmt.exponent !== 0) {
    const merged = text ? labelWithFactor(text, fmt.exponent) : undefined;
    if (merged) {
      label = parseRich(merged);
    } else {
      label = text ? parseRich(text) : undefined;
      factor = parseRich(`×${factorMarkup(fmt.exponent)}`);
    }
  } else if (text) {
    label = parseRich(text);
  }
  const lines = label ? (horizontal ? [label] : wrapRuns(label, theme.labelSize, theme.measure, length * 1.04)) : [];
  return { major: t.major, minor: theme.minorTicks ? t.minor : [], labels: hidden ? t.major.map(() => []) : fmt.labels, maxW, ascent, descent, exponent: fmt.exponent, label, factor, lines };
}

function format(spec: { format?: (v: number) => string; log?: boolean }, t: Ticks): { labels: Run[][]; exponent: number } {
  if (spec.format) {
    return { labels: t.major.map(v => parseRich(spec.format!(v))), exponent: 0 };
  }
  const r = spec.log ? formatLogTicks(t.major) : formatLinearTicks(t.major, t.step);
  return { labels: r.labels.map(parseRich), exponent: r.exponent };
}

interface SecondaryTicks {
  major: { at: number; label: Run[] }[];
  minor: number[];
  maxW: number;
  ascent: number;
  descent: number;
  label: Run[];
}

function secondaryAxisTicks(spec: SecondaryAxisSpec, d: Range, length: number, theme: Theme, size: number): SecondaryTicks {
  const spacing = theme.preset === 'publication' ? size * 3.2 : 84;
  let maxN = maxTickCount(length, spacing);
  let res = secondaryTicks(d[0], d[1], spec.toSecondary, spec.fromSecondary, maxN, spec.ticks);
  const fmtLabels = (vals: number[], step: number) => spec.format ? vals.map(v => parseRich(spec.format!(v))) : formatLinearTicks(vals, step).labels.map(parseRich);
  let labels = fmtLabels(res.major.map(m => m.value), res.step);
  // avoid collisions where the non-linear mapping crowds the ticks
  for (let guard = 0; guard < 5 && !spec.ticks && res.major.length > 2; guard++) {
    const span = Math.abs(d[1] - d[0]) || 1;
    const pos = res.major.map(m => (m.at / span) * length).sort((a, b) => a - b);
    const minGap = Math.min(...pos.slice(1).map((p, i) => p - pos[i]));
    const maxW = Math.max(...labels.map(r => richWidth(r, size, theme.measure)));
    if (minGap >= maxW + size * 0.9) {
      break;
    }
    maxN = Math.max(2, res.major.length - 1);
    res = secondaryTicks(d[0], d[1], spec.toSecondary, spec.fromSecondary, maxN, spec.ticks);
    labels = fmtLabels(res.major.map(m => m.value), res.step);
  }
  let maxW = 0;
  let ascent = 0.72 * size;
  let descent = 0.21 * size;
  for (const r of labels) {
    maxW = Math.max(maxW, richWidth(r, size, theme.measure));
    const e = richExtent(r, size);
    ascent = Math.max(ascent, e.ascent);
    descent = Math.max(descent, e.descent);
  }
  return { major: res.major.map((m, i) => ({ at: m.at, label: labels[i] })), minor: theme.minorTicks ? res.minor : [], maxW, ascent, descent, label: parseRich(spec.label) };
}

// --- per-panel geometry -----------------------------------------------------------------

interface PanelPlan {
  spec: Panel;
  series: ResolvedSeries[];
  xd: Range;
  yd: Range;
  y2d?: Range;
  base: { x: Range; y: Range; y2?: Range };
  hasY2: boolean;
  heat?: HeatmapSeries;
  hideX: boolean;
  hideY: boolean;
  hideXLabel: boolean;
  hideYLabel: boolean;
  // computed per pass
  xt?: AxisTicks;
  yt?: AxisTicks;
  y2t?: AxisTicks;
  st?: SecondaryTicks;
  ct?: AxisTicks;
  legend?: ReturnType<typeof measureLegend>;
  legendEntries: ReturnType<typeof legendEntries>;
  legendPos: NonNullable<Panel['legend']>;
  req: Req;
}

const LINE = 1.15;

/** Height of a (possibly wrapped) label. */
function linesHeight(lines: Run[][], size: number): number {
  if (!lines.length) {
    return 0;
  }
  return labelHeight(lines[0], size) + (lines.length - 1) * LINE * size;
}

/** Rotated (bottom-to-top) label; line i has its baseline at base + i × line height. */
function rotatedLabel(lines: Run[][], base: number, cy: number, size: number, ink: string, theme: Theme, o: BuildOptions): string {
  return lines.map((ln, i) => `<g transform="translate(${f(base + i * LINE * size)} ${f(cy)}) rotate(-90)">${textEl(0, 0, ln, size, ink, theme, o, ' text-anchor="middle"')}</g>`).join('');
}

function labelHeight(runs: Run[] | undefined, size: number): number {
  if (!runs || !runs.length) {
    return 0;
  }
  const e = richExtent(runs, size);
  return e.ascent + e.descent;
}

function computeReq(p: PanelPlan, box: Box, theme: Theme): Req {
  const out = theme.tickDir === 'out' ? theme.tickLen : 0;
  const ts = theme.tickLabelSize;
  const ls = theme.labelSize;
  p.xt = axisTicks({ ...p.spec.x, hideTickLabels: p.spec.x.hideTickLabels || p.hideX, label: p.hideXLabel ? undefined : p.spec.x.label }, p.xd, box.w, true, theme, ts);
  p.yt = axisTicks({ ...p.spec.y, hideTickLabels: p.spec.y.hideTickLabels || p.hideY, label: p.hideYLabel ? undefined : p.spec.y.label }, p.yd, box.h, false, theme, ts);
  p.y2t = p.hasY2 && p.y2d ? axisTicks(p.spec.y2 ?? {}, p.y2d, box.h, false, theme, ts) : undefined;
  p.st = p.spec.xSecondary ? secondaryAxisTicks(p.spec.xSecondary, p.xd, box.w, theme, ts) : undefined;
  const req: Req = { left: 0, right: 0, top: 0, bottom: 0 };
  // left: y tick labels + y label
  req.left = out + (p.yt.maxW > 0 ? theme.tickPad + p.yt.maxW : 0) + (p.yt.label ? theme.labelPad + linesHeight(p.yt.lines, ls) : 0);
  // bottom: x tick labels + x label (+ factor)
  const xLabelsH = p.xt.maxW > 0 ? theme.tickPad + p.xt.ascent + p.xt.descent : 0;
  req.bottom = out + xLabelsH + (p.xt.label || p.xt.factor ? theme.labelPad + Math.max(labelHeight(p.xt.label, ls), labelHeight(p.xt.factor, ts)) : 0);
  if (p.hideX && !p.xt.label) {
    req.bottom = out;
  }
  // top
  let top = 0;
  if (p.st) {
    top = out + theme.tickPad + p.st.ascent + p.st.descent + (p.st.label.length ? theme.labelPad + labelHeight(p.st.label, ls) : 0);
  } else if (p.yt.maxW > 0 || (p.y2t && p.y2t.maxW > 0)) {
    top = ts * 0.45; // half a tick label above the top tick
  }
  if (p.yt.factor || p.y2t?.factor) {
    top = Math.max(top, ts * 1.35) + (p.st ? ts * 1.2 : 0);
  }
  if (p.spec.title) {
    top += theme.titleSize * 1.5;
  }
  // right
  let right = 0;
  if (p.y2t) {
    right = out + (p.y2t.maxW > 0 ? theme.tickPad + p.y2t.maxW : 0) + (p.y2t.label ? theme.labelPad + linesHeight(p.y2t.lines, ls) : 0);
  }
  if (p.xt.maxW > 0 && p.xt.major.length && !p.y2t) {
    // the last x tick label may stick out on the right
    const sx = new Scale(p.xd[0], p.xd[1], p.spec.x.reverse ? box.w : 0, p.spec.x.reverse ? 0 : box.w, !!p.spec.x.log);
    let over = 0;
    p.xt.major.forEach((v, i) => {
      const w = richWidth(p.xt!.labels[i], ts, theme.measure);
      over = Math.max(over, sx.map(v) + w / 2 - box.w);
      req.left = Math.max(req.left, w / 2 - sx.map(v));
    });
    right = Math.max(right, over);
  }
  if (p.heat) {
    const ht = heatmapLimits(p.heat);
    const barH = box.h;
    p.ct = axisTicks({ log: p.heat.logZ, label: p.heat.colorbarLabel }, [ht.zMin, ht.zMax], barH, false, { ...theme, minorTicks: false }, ts);
    right += colorbarGap(theme) + colorbarWidth(theme) + theme.tickLen * (theme.tickDir === 'out' ? 1 : 0.6) + theme.tickPad + p.ct.maxW + (p.ct.label ? theme.labelPad + linesHeight(p.ct.lines, ls) : 0);
    if (p.ct.factor) {
      top = Math.max(top, ts * 1.35);
    }
  }
  if (p.legendEntries.length && p.legendPos === 'outside-right') {
    p.legend = measureLegend(p.legendEntries, p.spec.legendTitle, theme);
    right += theme.fontSize * 0.8 + p.legend.w;
  } else if (p.legendEntries.length && p.legendPos === 'outside-top') {
    p.legend = measureLegend(p.legendEntries, p.spec.legendTitle, theme, true, box.w);
    top += p.legend.h + theme.fontSize * 0.3;
  } else if (p.legendEntries.length && p.legendPos !== 'none') {
    p.legend = measureLegend(p.legendEntries, p.spec.legendTitle, theme);
  }
  req.top = top;
  req.right = right;
  return req;
}

/** Heatmaps get outward ticks: inward ticks over coloured cells read like minus signs. */
function panelTheme(p: PanelPlan, theme: Theme): Theme {
  return p.heat && theme.tickDir === 'in' ? { ...theme, tickDir: 'out', minorTicks: false } : theme;
}

function colorbarGap(theme: Theme): number {
  return theme.preset === 'publication' ? theme.fontSize * 0.9 : 14;
}
function colorbarWidth(theme: Theme): number {
  return theme.preset === 'publication' ? theme.fontSize * 1.1 : 12;
}

// --- build -------------------------------------------------------------------------

export function buildFigure(figure: Figure, o: BuildOptions): FigureModel {
  const theme = o.theme;
  const panels = figure.panels;
  const resolved = resolveSeries(figure, theme, o.hidden);
  const layoutSpec = figure.layout ?? { kind: 'stack' as const };
  const n = panels.length;
  const cols = layoutSpec.kind === 'grid' ? Math.max(1, Math.min(layoutSpec.cols, n)) : 1;
  const sharedX = !!layoutSpec.sharedX && n > 1;
  const sharedY = layoutSpec.kind === 'grid' && !!layoutSpec.sharedY && n > 1;

  // domains
  const plans: PanelPlan[] = panels.map((spec0, i) => {
    const spec: Panel = spec0.tag === undefined && figure.panelLabels && n > 1 ? { ...spec0, tag: `(${String.fromCharCode(97 + i)})` } : spec0;
    const series = resolved[i];
    const raw = spec.series;
    const hasY2 = !!spec.y2 || raw.some(s => s.yAxis === 'right');
    const xd = xAuto(raw, spec.x);
    let yd = yAuto(raw, spec.y, 'left', spec);
    const y2d = hasY2 ? yAuto(raw, spec.y2 ?? {}, 'right', spec) : undefined;
    let x = xd;
    if (spec.equalAspect && spec.x.min === undefined && spec.x.max === undefined && spec.y.min === undefined && spec.y.max === undefined && !spec.x.log && !spec.y.log) {
      const lo = Math.min(x[0], yd[0]);
      const hi = Math.max(x[1], yd[1]);
      x = [lo, hi];
      yd = [lo, hi];
    }
    const row = Math.floor(i / cols);
    const lastRow = Math.floor((n - 1) / cols);
    const hideX = sharedX && (layoutSpec.kind === 'stack' ? i < n - 1 : row < lastRow && i + cols < n);
    const hideY = sharedY && i % cols > 0;
    const legendPos = spec.legend ?? 'auto';
    const entries = legendPos === 'none' ? [] : legendEntries(series, theme);
    return {
      spec, series, xd: x, yd, y2d, base: { x, y: yd, y2: y2d }, hasY2,
      heat: raw.find((s): s is HeatmapSeries => s.type === 'heatmap'),
      hideX, hideY, hideXLabel: hideX, hideYLabel: hideY,
      legendEntries: entries, legendPos, req: { left: 0, right: 0, top: 0, bottom: 0 }
    };
  });
  if (sharedX) {
    const lo = Math.min(...plans.map(p => Math.min(p.xd[0], p.xd[1])));
    const hi = Math.max(...plans.map(p => Math.max(p.xd[0], p.xd[1])));
    plans.forEach(p => {
      if (p.spec.x.min === undefined && p.spec.x.max === undefined) {
        p.xd = [lo, hi];
        p.base.x = [lo, hi];
      }
    });
  }
  if (sharedY) {
    const lo = Math.min(...plans.map(p => p.yd[0]));
    const hi = Math.max(...plans.map(p => p.yd[1]));
    plans.forEach(p => {
      p.yd = [lo, hi];
      p.base.y = [lo, hi];
    });
  }
  // zoom
  plans.forEach((p, i) => {
    const z = o.zoom?.[i];
    if (z?.x) { p.xd = z.x; }
    if (z?.y) { p.yd = z.y; }
    if (z?.y2 && p.y2d) { p.y2d = z.y2; }
  });

  // layout passes
  const W = o.width;
  const H = o.height;
  const pad = theme.pad;
  const gapStack = sharedX ? theme.fontSize * (theme.preset === 'publication' ? 0.5 : 0.9) : theme.fontSize * 0.9;
  const ratios = plans.map(p => p.spec.heightRatio ?? 1);
  let boxes: Box[] = plans.map(() => ({ x: pad + 40, y: pad + 10, w: Math.max(20, W / cols - 60), h: Math.max(20, (H - 40) / Math.ceil(n / cols) - 30) }));
  for (let pass = 0; pass < 3; pass++) {
    plans.forEach((p, i) => { p.req = computeReq(p, boxes[i], panelTheme(p, theme)); });
    const reqs = plans.map(p => p.req);
    boxes = layoutSpec.kind === 'grid'
      ? gridLayout(W, H, pad, reqs, cols, theme.fontSize * 1.2, theme.fontSize * 1.0)
      : stackLayout(W, H, pad, reqs, ratios, gapStack);
  }
  // final ticks at the final sizes (margins from the last pass)
  plans.forEach((p, i) => {
    if (p.spec.equalAspect) {
      const sx = p.spec.x.log ? Math.log10(p.xd[1] / p.xd[0]) : p.xd[1] - p.xd[0];
      const sy = p.spec.y.log ? Math.log10(p.yd[1] / p.yd[0]) : p.yd[1] - p.yd[0];
      boxes[i] = equalAspectBox(boxes[i], Math.abs(sx), Math.abs(sy));
    }
    computeReq(p, boxes[i], panelTheme(p, theme));
  });

  // markup
  const defs: string[] = [];
  const layers: string[] = [];
  const hits: LegendHit[] = [];
  const models: PanelModel[] = [];
  if (o.background && theme.bg) {
    layers.push(`<rect width="${f(W)}" height="${f(H)}" fill="${theme.bg}"/>`);
  }
  // shared y-label column for a stack: align labels across panels
  const yLabelX = layoutSpec.kind === 'stack' ? Math.min(...plans.map((p, i) => boxes[i].x - (panelTheme(p, theme).tickDir === 'out' ? theme.tickLen : 0) - (p.yt!.maxW > 0 ? theme.tickPad + p.yt!.maxW : 0))) : undefined;
  plans.forEach((p, i) => {
    const r = boxes[i];
    const spec = p.spec;
    const xs = new Scale(p.xd[0], p.xd[1], spec.x.reverse ? r.x + r.w : r.x, spec.x.reverse ? r.x : r.x + r.w, !!spec.x.log);
    const ys = new Scale(p.yd[0], p.yd[1], spec.y.reverse ? r.y : r.y + r.h, spec.y.reverse ? r.y + r.h : r.y, !!spec.y.log);
    const y2s = p.y2d ? new Scale(p.y2d[0], p.y2d[1], spec.y2?.reverse ? r.y : r.y + r.h, spec.y2?.reverse ? r.y + r.h : r.y, !!spec.y2?.log) : undefined;
    models.push({ index: i, spec, rect: r, x: xs, y: ys, y2: y2s, base: p.base, series: p.series });
    const clip = `${o.idPrefix}clip${i}`;
    defs.push(`<clipPath id="${clip}"><rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}"/></clipPath>`);
    const g: string[] = [];
    // grid
    const gridX = spec.x.grid ?? theme.gridDefault;
    const gridY = spec.y.grid ?? theme.gridDefault;
    const snap = (v: number) => (theme.crisp ? Math.round(v - 0.5) + 0.5 : v);
    if (gridX || gridY) {
      const d: string[] = [];
      if (gridX) {
        p.xt!.major.forEach(v => { const X = snap(xs.map(v)); if (X > r.x + 0.5 && X < r.x + r.w - 0.5) { d.push(`M${f(X)} ${f(r.y)}V${f(r.y + r.h)}`); } });
      }
      if (gridY) {
        p.yt!.major.forEach(v => { const Y = snap(ys.map(v)); if (Y > r.y + 0.5 && Y < r.y + r.h - 0.5) { d.push(`M${f(r.x)} ${f(Y)}H${f(r.x + r.w)}`); } });
      }
      if (d.length) {
        g.push(`<path class="chart-grid" d="${d.join('')}" stroke="${theme.grid}" stroke-width="${f(theme.gridWidth)}" fill="none"/>`);
      }
    }
    // data
    const columns = Math.max(50, Math.round(r.w * o.pxPerUnit));
    const order: Series['type'][] = ['heatmap', 'band', 'histogram', 'hline', 'vline', 'sticks', 'line', 'scatter', 'text'];
    const data: string[] = [];
    for (const type of order) {
      for (const rs of p.series) {
        if (rs.s.type !== type || rs.hidden) {
          continue;
        }
        const right = rs.s.yAxis === 'right' && y2s;
        const ctx: MarkContext = { x: xs, y: right ? y2s! : ys, rect: r, theme, color: rs.color, columns, fontFor: o.fontFor };
        const s = rs.s;
        let m = '';
        switch (s.type) {
          case 'line': m = lineMark(s, ctx); break;
          case 'band': m = bandMark(s, ctx); break;
          case 'sticks': m = sticksMark(s, ctx); break;
          case 'histogram': m = histogramMark(s, ctx); break;
          case 'scatter': m = scatterMark(s, ctx); break;
          case 'heatmap': m = heatmapMark(s, ctx); break;
          case 'hline': case 'vline': m = ruleMark(s, ctx); break;
          case 'text': m = textMark(s, ctx); break;
        }
        if (m) {
          data.push(`<g class="chart-series" data-key="${encodeURIComponent(rs.key)}">${m}</g>`);
        }
      }
    }
    g.push(`<g clip-path="url(#${clip})">${data.join('')}</g>`);
    // axes
    g.push(drawAxes(p, r, xs, ys, y2s, panelTheme(p, theme), o, yLabelX));
    // colorbar
    if (p.heat && p.ct) {
      g.push(drawColorbar(p.heat, p.ct, r, theme, o, defs, `${o.idPrefix}cb${i}`));
    }
    // tag and title
    if (spec.tag) {
      const inset = Math.max(theme.fontSize * 0.5, (theme.tickDir === 'in' ? theme.tickLen : 0) + theme.fontSize * 0.3);
      const runs = parseRich(spec.tag);
      g.push(`<text x="${f(r.x + inset)}" y="${f(r.y + inset + 0.72 * theme.tagSize)}" font-size="${f(theme.tagSize)}" font-weight="bold" fill="${theme.fg}">${richSvg(runs, { size: theme.tagSize, bold: true, explicitMarks: theme.arimo, fontFor: o.fontFor })}</text>`);
    }
    if (spec.title) {
      const runs = parseRich(spec.title);
      const top = r.y - p.req.top + theme.titleSize * 0.95;
      g.push(`<text x="${f(r.x)}" y="${f(top)}" font-size="${f(theme.titleSize)}" font-weight="600" fill="${theme.fg}">${richSvg(runs, { size: theme.titleSize, bold: true, explicitMarks: theme.arimo, fontFor: o.fontFor })}</text>`);
    }
    // legend
    if (p.legend && p.legendEntries.length) {
      const lg = p.legend;
      let lx: number;
      let ly: number;
      const inset = (theme.tickDir === 'in' ? theme.tickLen : 0) + theme.fontSize * 0.35;
      if (p.legendPos === 'outside-right') {
        let right = r.x + r.w + p.req.right - lg.w;
        if (p.y2t || p.heat) {
          right = r.x + r.w + p.req.right - lg.w;
        }
        lx = right;
        ly = r.y;
      } else if (p.legendPos === 'outside-top') {
        lx = r.x;
        ly = r.y - p.req.top + (spec.title ? theme.titleSize * 1.5 : 0);
      } else {
        let pos = p.legendPos;
        const fits = lg.h <= r.h * 0.92 && lg.w <= r.w * 0.8;
        if (pos === 'auto' || !fits) {
          const pts = samplePoints(p, xs, ys, y2s, r);
          if (spec.tag) {
            // keep the panel tag corner free
            const tagW = richWidth(parseRich(spec.tag), theme.tagSize, theme.measure, true) + theme.fontSize;
            for (let k = 0; k < 400; k++) {
              pts.push(r.x + ((k % 20) / 20) * tagW, r.y + (Math.floor(k / 20) / 20) * theme.tagSize * 1.8);
            }
          }
          pos = bestCorner(pts, r, lg.w, lg.h, inset);
        }
        const b = cornerBox(pos as 'top-right', r, lg.w, lg.h, inset);
        lx = b.x;
        ly = b.y;
      }
      const lm = legendMarkup(p.legendEntries, spec.legendTitle, lg, lx, ly, theme, o.fontFor);
      g.push(lm.markup);
      hits.push(...lm.hits);
    }
    layers.push(`<g class="chart-panel" data-panel="${i}">${g.join('')}</g>`);
  });
  const body = `<defs>${defs.join('')}</defs>${layers.join('')}`;
  return { width: W, height: H, panels: models, legendHits: hits, body, sharedX };
}

/** Screen positions of the data (interleaved x, y) for legend placement. */
function samplePoints(p: PanelPlan, xs: Scale, ys: Scale, y2s: Scale | undefined, r: Box): number[] {
  const pts: number[] = [];
  const push = (X: number, Y: number) => {
    if (Number.isFinite(X) && Number.isFinite(Y) && X >= r.x && X <= r.x + r.w && Y >= r.y && Y <= r.y + r.h) {
      pts.push(X, Y);
    }
  };
  for (const rs of p.series) {
    if (rs.hidden) {
      continue;
    }
    const s = rs.s;
    const sy = s.yAxis === 'right' && y2s ? y2s : ys;
    const each = (x: ArrayLike<number>, y: ArrayLike<number>, fill = false) => {
      const nn = Math.min(x.length, y.length);
      const stride = Math.max(1, Math.floor(nn / 600));
      for (let i = 0; i < nn; i += stride) {
        const X = xs.map(x[i]);
        const Y = sy.map(y[i]);
        push(X, Y);
        if (fill) {
          // the area under sticks / histograms counts too
          const b = sy.map(sy.lo > 0 ? sy.lo : 0);
          for (let k = 1; k < 4; k++) {
            push(X, Y + ((b - Y) * k) / 4);
          }
        }
      }
    };
    switch (s.type) {
      case 'line': case 'scatter': each(s.x, s.y); break;
      case 'sticks': each(s.x, s.y, true); break;
      case 'band': each(s.x, s.lo); each(s.x, s.hi); break;
      case 'histogram': {
        const c = Float64Array.from({ length: s.values.length }, (_, i) => (s.edges[i] + s.edges[i + 1]) / 2);
        each(c, s.values, true);
        break;
      }
      case 'heatmap':
        for (let iy = 0; iy < s.z.length; iy++) {
          for (let ix = 0; ix < s.z[iy].length; ix++) {
            push(xs.map((s.xEdges[ix] + s.xEdges[ix + 1]) / 2), sy.map((s.yEdges[iy] + s.yEdges[iy + 1]) / 2));
          }
        }
        break;
      case 'text': push(xs.map(s.x), sy.map(s.y)); break;
      default: break;
    }
  }
  return pts;
}

function textEl(x: number, y: number, runs: Run[], size: number, fill: string, theme: Theme, o: BuildOptions, attrs = ''): string {
  return `<text x="${f(x)}" y="${f(y)}" font-size="${f(size)}" fill="${fill}"${attrs}>${richSvg(runs, { size, explicitMarks: theme.arimo, fontFor: o.fontFor })}</text>`;
}

function drawAxes(p: PanelPlan, r: Box, xs: Scale, ys: Scale, y2s: Scale | undefined, theme: Theme, o: BuildOptions, yLabelX?: number): string {
  const out: string[] = [];
  const inward = theme.tickDir === 'in';
  const tl = theme.tickLen;
  const ml = theme.minorLen;
  const dirIn = inward ? 1 : -1;
  const ts = theme.tickLabelSize;
  const ls = theme.labelSize;
  const outLen = inward ? 0 : tl;
  const snap = (v: number) => (theme.crisp ? Math.round(v - 0.5) + 0.5 : v);
  const xt = p.xt!;
  const yt = p.yt!;
  const left = r.x, right = r.x + r.w, top = r.y, bottom = r.y + r.h;
  const inX = (v: number) => xs.contains(v);
  const inY = (s: Scale, v: number) => s.contains(v);
  const major: string[] = [];
  const minor: string[] = [];
  // bottom
  xt.major.filter(inX).forEach(v => major.push(`M${f(snap(xs.map(v)))} ${f(bottom)}v${f(-dirIn * tl)}`));
  xt.minor.filter(inX).forEach(v => minor.push(`M${f(snap(xs.map(v)))} ${f(bottom)}v${f(-dirIn * ml)}`));
  // left
  yt.major.filter(v => inY(ys, v)).forEach(v => major.push(`M${f(left)} ${f(snap(ys.map(v)))}h${f(dirIn * tl)}`));
  yt.minor.filter(v => inY(ys, v)).forEach(v => minor.push(`M${f(left)} ${f(snap(ys.map(v)))}h${f(dirIn * ml)}`));
  // top
  if (p.st) {
    p.st.major.forEach(m => major.push(`M${f(snap(xs.map(m.at)))} ${f(top)}v${f(dirIn * tl)}`));
    p.st.minor.forEach(v => minor.push(`M${f(snap(xs.map(v)))} ${f(top)}v${f(dirIn * ml)}`));
  } else if (theme.closedFrame && inward) {
    xt.major.filter(inX).forEach(v => major.push(`M${f(xs.map(v))} ${f(top)}v${f(dirIn * tl)}`));
    xt.minor.filter(inX).forEach(v => minor.push(`M${f(xs.map(v))} ${f(top)}v${f(dirIn * ml)}`));
  }
  // right
  const y2t = p.y2t;
  if (y2s && y2t) {
    y2t.major.filter(v => inY(y2s, v)).forEach(v => major.push(`M${f(right)} ${f(snap(y2s.map(v)))}h${f(-dirIn * tl)}`));
    y2t.minor.filter(v => inY(y2s, v)).forEach(v => minor.push(`M${f(right)} ${f(snap(y2s.map(v)))}h${f(-dirIn * ml)}`));
  } else if (theme.closedFrame && inward) {
    yt.major.filter(v => inY(ys, v)).forEach(v => major.push(`M${f(right)} ${f(ys.map(v))}h${f(-dirIn * tl)}`));
    yt.minor.filter(v => inY(ys, v)).forEach(v => minor.push(`M${f(right)} ${f(ys.map(v))}h${f(-dirIn * ml)}`));
  }
  // spines
  if (theme.closedFrame) {
    out.push(`<rect class="chart-frame" x="${f(left)}" y="${f(top)}" width="${f(r.w)}" height="${f(r.h)}" fill="none" stroke="${theme.frame}" stroke-width="${f(theme.spineWidth)}"/>`);
  } else {
    const d = [`M${f(left)} ${f(snap(bottom))}H${f(right)}`];
    d.push(`M${f(snap(left))} ${f(top)}V${f(bottom)}`);
    if (p.st) { d.push(`M${f(left)} ${f(snap(top))}H${f(right)}`); }
    if (y2s) { d.push(`M${f(snap(right))} ${f(top)}V${f(bottom)}`); }
    out.push(`<path class="chart-frame" d="${d.join('')}" fill="none" stroke="${theme.frame}" stroke-width="${f(theme.spineWidth)}"/>`);
  }
  if (major.length) {
    out.push(`<path d="${major.join('')}" fill="none" stroke="${theme.frame}" stroke-width="${f(theme.tickWidth)}"/>`);
  }
  if (minor.length) {
    out.push(`<path d="${minor.join('')}" fill="none" stroke="${theme.frame}" stroke-width="${f(theme.minorWidth)}"/>`);
  }
  const tickInk = theme.muted;
  const labelInk = theme.fg;
  // x tick labels
  const xBase = bottom + outLen + theme.tickPad + xt.ascent;
  if (xt.maxW > 0) {
    xt.major.forEach((v, i) => {
      if (!inX(v)) { return; }
      out.push(textEl(xs.map(v), xBase, xt.labels[i], ts, tickInk, theme, o, ' text-anchor="middle"'));
    });
  }
  // x label (+ factor)
  const xLabelBase = (xt.maxW > 0 ? xBase + xt.descent : bottom + outLen) + theme.labelPad + (xt.label ? richExtent(xt.label, ls).ascent : 0.72 * ts);
  if (xt.label) {
    out.push(textEl(left + r.w / 2, xLabelBase, xt.label, ls, labelInk, theme, o, ' text-anchor="middle"'));
  }
  if (xt.factor) {
    out.push(textEl(right, xLabelBase, xt.factor, ts, tickInk, theme, o, ' text-anchor="end"'));
  }
  // y tick labels
  const yLab = (s: Scale, t: AxisTicks, x: number, anchor: 'start' | 'end') => {
    if (t.maxW <= 0) {
      return;
    }
    t.major.forEach((v, i) => {
      if (!inY(s, v)) { return; }
      out.push(textEl(x, s.map(v) + ts * 0.36, t.labels[i], ts, tickInk, theme, o, ` text-anchor="${anchor}"`));
    });
  };
  yLab(ys, yt, left - outLen - theme.tickPad, 'end');
  if (yt.label) {
    const ext = richExtent(yt.lines[yt.lines.length - 1], ls);
    const x0 = (yLabelX ?? left - outLen - (yt.maxW > 0 ? theme.tickPad + yt.maxW : 0)) - theme.labelPad - ext.descent;
    out.push(rotatedLabel(yt.lines, x0 - (yt.lines.length - 1) * LINE * ls, top + r.h / 2, ls, labelInk, theme, o));
  }
  if (yt.factor) {
    out.push(textEl(left, top - ts * 0.45, yt.factor, ts, tickInk, theme, o));
  }
  if (y2s && y2t) {
    yLab(y2s, y2t, right + outLen + theme.tickPad, 'start');
    if (y2t.label) {
      const ext = richExtent(y2t.lines[0], ls);
      const x0 = right + outLen + (y2t.maxW > 0 ? theme.tickPad + y2t.maxW : 0) + theme.labelPad + ext.ascent;
      out.push(rotatedLabel(y2t.lines, x0, top + r.h / 2, ls, labelInk, theme, o));
    }
    if (y2t.factor) {
      out.push(textEl(right, top - ts * 0.45, y2t.factor, ts, tickInk, theme, o, ' text-anchor="end"'));
    }
  }
  // secondary x (top)
  if (p.st) {
    const base = top - outLen - theme.tickPad - p.st.descent;
    p.st.major.forEach(m => out.push(textEl(xs.map(m.at), base, m.label, ts, tickInk, theme, o, ' text-anchor="middle"')));
    if (p.st.label.length) {
      const lb = base - p.st.ascent - theme.labelPad - richExtent(p.st.label, ls).descent;
      out.push(textEl(left + r.w / 2, lb, p.st.label, ls, labelInk, theme, o, ' text-anchor="middle"'));
    }
  }
  return `<g class="chart-axes">${out.join('')}</g>`;
}

function drawColorbar(s: HeatmapSeries, ct: AxisTicks, r: Box, theme: Theme, o: BuildOptions, defs: string[], id: string): string {
  const map = s.colormap ?? 'viridis';
  const { zMin, zMax } = heatmapLimits(s);
  const x = r.x + r.w + colorbarGap(theme);
  const w = colorbarWidth(theme);
  const y = r.y;
  const h = r.h;
  const stops = colormapStops(map);
  defs.push(`<linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0">${stops.map((c, i) => `<stop offset="${f((i / (stops.length - 1)) * 100)}%" stop-color="${c}"/>`).join('')}</linearGradient>`);
  const out: string[] = [];
  out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="url(#${id})"/>`);
  out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="none" stroke="${theme.frame}" stroke-width="${f(theme.spineWidth)}"/>`);
  const norm = normalizer(zMin, zMax, s.logZ);
  const ts = theme.tickLabelSize;
  const tl = theme.tickDir === 'out' ? theme.tickLen : theme.tickLen * 0.6;
  const ticks: string[] = [];
  const labels: string[] = [];
  ct.major.forEach((v, i) => {
    const t = norm(v);
    if (!(t >= -1e-9 && t <= 1 + 1e-9)) {
      return;
    }
    const Y = y + h - t * h;
    ticks.push(`M${f(x + w)} ${f(Y)}h${f(tl)}`);
    labels.push(textEl(x + w + tl + theme.tickPad, Y + ts * 0.36, ct.labels[i], ts, theme.muted, theme, o));
  });
  out.push(`<path d="${ticks.join('')}" stroke="${theme.frame}" stroke-width="${f(theme.tickWidth)}" fill="none"/>`);
  out.push(...labels);
  if (ct.label) {
    const ext = richExtent(ct.lines[0], theme.labelSize);
    const lx = x + w + tl + theme.tickPad + ct.maxW + theme.labelPad + ext.ascent;
    out.push(rotatedLabel(ct.lines, lx, y + h / 2, theme.labelSize, theme.fg, theme, o));
  }
  if (ct.factor) {
    out.push(textEl(x, y - ts * 0.45, ct.factor, ts, theme.muted, theme, o));
  }
  void colorAt;
  return `<g class="chart-colorbar">${out.join('')}</g>`;
}

/** A standalone SVG document string around a built figure. */
export function svgDocument(model: FigureModel, attrs: { width: string; height: string; fontFamily: string; extraDefs?: string }): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${attrs.width}" height="${attrs.height}" viewBox="0 0 ${f(model.width)} ${f(model.height)}" font-family="${escapeXml(attrs.fontFamily)}">`;
  const body = attrs.extraDefs ? model.body.replace('<defs>', `<defs>${attrs.extraDefs}`) : model.body;
  return `${head}${body}</svg>`;
}
