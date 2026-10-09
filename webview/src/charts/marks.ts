// SVG markup of the series marks: lines (dash, step, markers, decimation),
// bands, sticks, histograms, scatter with error bars, heatmaps, reference
// lines and text. Works on strings (no DOM) so the same code renders on
// screen and in every export.

import type { BandSeries, Dash, HeatmapSeries, HistogramSeries, LineSeries, RuleSeries, ScatterSeries, StickSeries, TextSeries } from './api';
import { colorAt, colorLimits, luminance, normalizer } from './colormap';
import { prepareLine } from './decimate';
import { formatShort } from './format';
import type { Box } from './layout';
import type { Scale } from './scales';
import { escapeXml, parseRich, richSvg, richWidth } from './text';
import type { Theme } from './themes';

/** Coordinates rounded to 0.01 user units. */
export const f = (v: number): string => String(Math.round(v * 100) / 100);

export interface MarkContext {
  x: Scale;
  y: Scale;
  rect: Box;
  theme: Theme;
  color: string;
  /** Pixel columns available for decimation. */
  columns: number;
  /** For text runs in PDF export. */
  fontFor?: (cp: number) => string;
}

export function dashArray(dash: Dash | undefined, width: number): string | undefined {
  switch (dash) {
    case 'dashed':
      return `${f(3.7 * width)} ${f(1.6 * width)}`;
    case 'dotted':
      return `${f(1 * width)} ${f(1.65 * width)}`;
    case 'dashdot':
      return `${f(6.4 * width)} ${f(1.6 * width)} ${f(1 * width)} ${f(1.6 * width)}`;
    default:
      return undefined;
  }
}

function strokeAttrs(color: string, width: number, dash?: Dash): string {
  const da = dashArray(dash, width);
  return `fill="none" stroke="${color}" stroke-width="${f(width)}" stroke-linejoin="round" stroke-linecap="${da ? 'butt' : 'round'}"${da ? ` stroke-dasharray="${da}"` : ''}`;
}

const ok = (v: number) => Number.isFinite(v);

/** Path data for a polyline with NaN gaps and optional step interpolation. */
export function linePath(xs: ArrayLike<number>, ys: ArrayLike<number>, i0: number, i1: number, sx: Scale, sy: Scale, step?: 'pre' | 'mid' | 'post'): string {
  const parts: string[] = [];
  let pen = false;
  let px = 0, py = 0;
  const logY = sy.log;
  const logX = sx.log;
  for (let i = i0; i < i1; i++) {
    const xv = xs[i];
    const yv = ys[i];
    if (!ok(xv) || !ok(yv) || (logY && yv <= 0) || (logX && xv <= 0)) {
      pen = false;
      continue;
    }
    const X = sx.map(xv);
    const Y = sy.map(yv);
    if (!pen) {
      parts.push(`M${f(X)} ${f(Y)}`);
      pen = true;
    } else if (!step) {
      parts.push(`L${f(X)} ${f(Y)}`);
    } else if (step === 'post') {
      parts.push(`H${f(X)}V${f(Y)}`);
    } else if (step === 'pre') {
      parts.push(`V${f(Y)}H${f(X)}`);
    } else {
      const m = (px + X) / 2;
      parts.push(`H${f(m)}V${f(Y)}H${f(X)}`);
    }
    px = X;
    py = Y;
  }
  void py;
  return parts.join('');
}

export function lineMark(s: LineSeries, c: MarkContext): string {
  const w = s.width ?? c.theme.lineWidth;
  const d = prepareLine(s.x, s.y, c.x.lo, c.x.hi, c.columns, s.decimate !== false);
  const path = linePath(d.x, d.y, d.i0, d.i1, c.x, c.y, s.step);
  let out = path ? `<path d="${path}" ${strokeAttrs(c.color, w, s.dash)}/>` : '';
  if (s.markers && d.i1 - d.i0 <= 3000) {
    const r = Math.max(1.2, w * 1.5);
    out += `<path d="${markerPath('circle', d.x, d.y, d.i0, d.i1, c.x, c.y, r)}" fill="${c.color}" stroke="none"/>`;
  }
  return out;
}

export function bandMark(s: BandSeries, c: MarkContext): string {
  const n = Math.min(s.x.length, s.lo.length, s.hi.length);
  const d = prepareLine(s.x, s.lo, c.x.lo, c.x.hi, 1e9, false);
  const i0 = d.i0;
  const i1 = Math.min(d.i1, n);
  // contiguous segments where both bounds are finite
  const polys: string[] = [];
  let start = -1;
  const emit = (a: number, b: number) => {
    if (b - a < 1) {
      return;
    }
    // decimate long bands by striding (bands are smooth)
    const stride = Math.max(1, Math.floor((b - a) / Math.max(200, c.columns * 2)));
    const idx: number[] = [];
    for (let i = a; i < b; i += stride) {
      idx.push(i);
    }
    if (idx[idx.length - 1] !== b - 1) {
      idx.push(b - 1);
    }
    const fw = idx.map((i, k) => `${k ? 'L' : 'M'}${f(c.x.map(s.x[i]))} ${f(c.y.map(s.hi[i]))}`).join('');
    const bw = idx.slice().reverse().map(i => `L${f(c.x.map(s.x[i]))} ${f(c.y.map(s.lo[i]))}`).join('');
    polys.push(`${fw}${bw}Z`);
  };
  for (let i = i0; i < i1; i++) {
    const good = ok(s.x[i]) && ok(s.lo[i]) && ok(s.hi[i]) && (!c.y.log || (s.lo[i] > 0 && s.hi[i] > 0));
    if (good && start < 0) {
      start = i;
    } else if (!good && start >= 0) {
      emit(start, i);
      start = -1;
    }
  }
  if (start >= 0) {
    emit(start, i1);
  }
  if (!polys.length) {
    return '';
  }
  return `<path d="${polys.join('')}" fill="${c.color}" fill-opacity="${s.opacity ?? c.theme.bandOpacity}" stroke="none"/>`;
}

function baseline(c: MarkContext): number {
  if (c.y.log) {
    return c.rect.y + c.rect.h;
  }
  const b = c.y.map(0);
  return Math.max(c.rect.y - 1, Math.min(c.rect.y + c.rect.h + 1, b));
}

export function sticksMark(s: StickSeries, c: MarkContext): string {
  const n = Math.min(s.x.length, s.y.length);
  const w = s.width ?? c.theme.lineWidth * 0.8;
  const parts: string[] = [];
  let maxY = 0;
  if (s.relativeHeight) {
    for (let i = 0; i < n; i++) {
      if (ok(s.y[i])) {
        maxY = Math.max(maxY, Math.abs(s.y[i]));
      }
    }
  }
  const bottom = c.rect.y + c.rect.h;
  const b = s.relativeHeight ? bottom : baseline(c);
  for (let i = 0; i < n; i++) {
    const xv = s.x[i];
    const yv = s.y[i];
    if (!ok(xv) || !ok(yv) || !c.x.contains(xv)) {
      continue;
    }
    const X = c.x.map(xv);
    const Y = s.relativeHeight ? bottom - (maxY ? (yv / maxY) * s.relativeHeight * c.rect.h : 0) : c.y.log && yv <= 0 ? b : c.y.map(yv);
    parts.push(`M${f(X)} ${f(b)}V${f(Y)}`);
  }
  return parts.length ? `<path d="${parts.join('')}" fill="none" stroke="${c.color}" stroke-width="${f(w)}" stroke-linecap="butt"/>` : '';
}

export function histogramMark(s: HistogramSeries, c: MarkContext): string {
  const n = Math.min(s.values.length, s.edges.length - 1);
  if (n <= 0) {
    return '';
  }
  const style = s.style ?? 'step';
  const b = baseline(c);
  const yOf = (v: number) => (c.y.log && v <= 0 ? b : c.y.map(v));
  if (style === 'bars') {
    const rects: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (!ok(v)) {
        continue;
      }
      const x0 = c.x.map(s.edges[i]);
      const x1 = c.x.map(s.edges[i + 1]);
      const Y = yOf(v);
      rects.push(`<rect x="${f(Math.min(x0, x1))}" y="${f(Math.min(Y, b))}" width="${f(Math.abs(x1 - x0))}" height="${f(Math.abs(b - Y))}"/>`);
    }
    return `<g fill="${c.color}" fill-opacity="${s.opacity ?? 0.85}" stroke="${c.theme.paper}" stroke-width="${f(c.theme.spineWidth * 0.6)}">${rects.join('')}</g>`;
  }
  let d = `M${f(c.x.map(s.edges[0]))} ${f(b)}`;
  for (let i = 0; i < n; i++) {
    const v = ok(s.values[i]) ? s.values[i] : 0;
    d += `V${f(yOf(v))}H${f(c.x.map(s.edges[i + 1]))}`;
  }
  d += `V${f(b)}`;
  const w = c.theme.lineWidth;
  if (style === 'filled') {
    return `<path d="${d}Z" fill="${c.color}" fill-opacity="${s.opacity ?? 0.3}" stroke="none"/><path d="${d}" ${strokeAttrs(c.color, w * 0.8)}/>`;
  }
  return `<path d="${d}" ${strokeAttrs(c.color, w)}/>`;
}

type MarkerShape = NonNullable<ScatterSeries['marker']>;

/** One path with a marker of radius r at every finite point. */
export function markerPath(shape: MarkerShape, xs: ArrayLike<number>, ys: ArrayLike<number>, i0: number, i1: number, sx: Scale, sy: Scale, r: number): string {
  const parts: string[] = [];
  const rs = r * 0.886; // equal area to the circle
  const rt = r * 1.25;
  for (let i = i0; i < i1; i++) {
    const xv = xs[i];
    const yv = ys[i];
    if (!ok(xv) || !ok(yv) || (sy.log && yv <= 0) || (sx.log && xv <= 0)) {
      continue;
    }
    const X = sx.map(xv);
    const Y = sy.map(yv);
    switch (shape) {
      case 'square':
        parts.push(`M${f(X - rs)} ${f(Y - rs)}h${f(2 * rs)}v${f(2 * rs)}h${f(-2 * rs)}Z`);
        break;
      case 'diamond':
        parts.push(`M${f(X)} ${f(Y - rt)}L${f(X + rs)} ${f(Y)}L${f(X)} ${f(Y + rt)}L${f(X - rs)} ${f(Y)}Z`);
        break;
      case 'triangle':
        parts.push(`M${f(X)} ${f(Y - rt)}L${f(X + rt * 0.866)} ${f(Y + rt * 0.5)}L${f(X - rt * 0.866)} ${f(Y + rt * 0.5)}Z`);
        break;
      case 'cross':
        parts.push(`M${f(X - rs)} ${f(Y - rs)}L${f(X + rs)} ${f(Y + rs)}M${f(X + rs)} ${f(Y - rs)}L${f(X - rs)} ${f(Y + rs)}`);
        break;
      default:
        parts.push(`M${f(X - r)} ${f(Y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`);
    }
  }
  return parts.join('');
}

export function scatterMark(s: ScatterSeries, c: MarkContext): string {
  const n = Math.min(s.x.length, s.y.length);
  const r = (s.size ?? (c.theme.preset === 'publication' ? 3 : 5)) / 2;
  let out = '';
  if (s.yErr || s.xErr) {
    const parts: string[] = [];
    const cap = r * 0.9;
    for (let i = 0; i < n; i++) {
      const xv = s.x[i];
      const yv = s.y[i];
      if (!ok(xv) || !ok(yv)) {
        continue;
      }
      const X = c.x.map(xv);
      const Y = c.y.map(yv);
      const ey = s.yErr?.[i];
      if (ey !== undefined && ok(ey) && ey > 0) {
        const y0 = c.y.map(yv - ey);
        const y1 = c.y.map(yv + ey);
        parts.push(`M${f(X)} ${f(y0)}V${f(y1)}M${f(X - cap)} ${f(y0)}H${f(X + cap)}M${f(X - cap)} ${f(y1)}H${f(X + cap)}`);
      }
      const ex = s.xErr?.[i];
      if (ex !== undefined && ok(ex) && ex > 0) {
        const x0 = c.x.map(xv - ex);
        const x1 = c.x.map(xv + ex);
        parts.push(`M${f(x0)} ${f(Y)}H${f(x1)}M${f(x0)} ${f(Y - cap)}V${f(Y + cap)}M${f(x1)} ${f(Y - cap)}V${f(Y + cap)}`);
      }
    }
    if (parts.length) {
      out += `<path d="${parts.join('')}" fill="none" stroke="${c.color}" stroke-width="${f(c.theme.spineWidth)}" stroke-opacity="0.8"/>`;
    }
  }
  const shape = s.marker ?? 'circle';
  const d = markerPath(shape, s.x, s.y, 0, n, c.x, c.y, r);
  if (d) {
    out += shape === 'cross'
      ? `<path d="${d}" fill="none" stroke="${c.color}" stroke-width="${f(Math.max(0.6, r * 0.45))}" stroke-opacity="${s.opacity ?? 0.9}"/>`
      : `<path d="${d}" fill="${c.color}" fill-opacity="${s.opacity ?? 0.8}" stroke="${c.color}" stroke-width="${f(c.theme.preset === 'publication' ? 0.3 : 0.6)}" stroke-opacity="${Math.min(1, (s.opacity ?? 0.8) + 0.15)}"/>`;
  }
  return out;
}

export interface HeatmapInfo {
  zMin: number;
  zMax: number;
}

export function heatmapLimits(s: HeatmapSeries): HeatmapInfo {
  const [zMin, zMax] = colorLimits(s.z, s.colormap ?? 'viridis', s.logZ, s.zMin, s.zMax);
  return { zMin, zMax };
}

export function heatmapMark(s: HeatmapSeries, c: MarkContext): string {
  const map = s.colormap ?? 'viridis';
  const { zMin, zMax } = heatmapLimits(s);
  const norm = normalizer(zMin, zMax, s.logZ);
  const ny = Math.min(s.z.length, s.yEdges.length - 1);
  const rects: string[] = [];
  const labels: string[] = [];
  const fmt = typeof s.annotate === 'function' ? s.annotate : formatShort;
  const theme = c.theme;
  for (let iy = 0; iy < ny; iy++) {
    const row = s.z[iy];
    const nx = Math.min(row.length, s.xEdges.length - 1);
    const ya = c.y.map(s.yEdges[iy]);
    const yb = c.y.map(s.yEdges[iy + 1]);
    for (let ix = 0; ix < nx; ix++) {
      const v = row[ix];
      if (!ok(v)) {
        continue;
      }
      const xa = c.x.map(s.xEdges[ix]);
      const xb = c.x.map(s.xEdges[ix + 1]);
      const fill = colorAt(map, norm(v));
      const x = Math.min(xa, xb);
      const y = Math.min(ya, yb);
      const w = Math.abs(xb - xa);
      const h = Math.abs(yb - ya);
      // a hair of overlap hides anti-aliasing seams between cells
      rects.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w + 0.2)}" height="${f(h + 0.2)}" fill="${fill}"/>`);
      if (s.annotate) {
        const text = fmt(v);
        const runs = parseRich(text);
        let size = theme.fontSize * 0.85;
        const tw = richWidth(runs, size, theme.measure);
        if (tw > w * 0.9) {
          size *= (w * 0.9) / tw;
        }
        size = Math.min(size, h * 0.6);
        if (size >= 3) {
          const ink = luminance(fill) > 0.36 ? '#000000' : '#ffffff';
          labels.push(`<text x="${f(x + w / 2)}" y="${f(y + h / 2 + size * 0.36)}" text-anchor="middle" font-size="${f(size)}" fill="${ink}">${richSvg(runs, { size, explicitMarks: theme.arimo, fontFor: c.fontFor })}</text>`);
        }
      }
    }
  }
  return `<g stroke="none">${rects.join('')}</g>${labels.length ? `<g>${labels.join('')}</g>` : ''}`;
}

export function ruleMark(s: RuleSeries, c: MarkContext): string {
  const w = s.width ?? c.theme.spineWidth;
  if (s.type === 'hline') {
    if (!c.y.contains(s.value)) {
      return '';
    }
    let Y = c.y.map(s.value);
    if (c.theme.crisp && Math.abs(w - 1) < 1e-6) {
      Y = Math.round(Y - 0.5) + 0.5;
    }
    return `<path d="M${f(c.rect.x)} ${f(Y)}H${f(c.rect.x + c.rect.w)}" ${strokeAttrs(c.color, w, s.dash)}/>`;
  }
  if (!c.x.contains(s.value)) {
    return '';
  }
  let X = c.x.map(s.value);
  if (c.theme.crisp && Math.abs(w - 1) < 1e-6) {
    X = Math.round(X - 0.5) + 0.5;
  }
  return `<path d="M${f(X)} ${f(c.rect.y)}V${f(c.rect.y + c.rect.h)}" ${strokeAttrs(c.color, w, s.dash)}/>`;
}

export function textMark(s: TextSeries, c: MarkContext): string {
  if (!ok(s.x) || !ok(s.y)) {
    return '';
  }
  const size = c.theme.fontSize;
  const X = c.x.map(s.x) + (s.dx ?? 0);
  const Y = c.y.map(s.y) - (s.dy ?? 0) + size * 0.36;
  const runs = parseRich(s.text);
  return `<text x="${f(X)}" y="${f(Y)}" text-anchor="${s.anchor ?? 'start'}" font-size="${f(size)}" fill="${c.color}">${richSvg(runs, { size, explicitMarks: c.theme.arimo, fontFor: c.fontFor })}</text>`;
}

export { escapeXml };
