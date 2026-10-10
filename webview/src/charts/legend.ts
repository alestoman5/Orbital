// Legend: entries (series sharing a group give one entry), size, placement
// ('auto' = the corner overlapping the least data, inside or outside the
// frame) and markup with hit boxes for click-to-toggle. DOM-free.

import type { Dash, LegendPosition, Series } from './api';
import type { Box } from './layout';
import { dashArray, f } from './marks';
import { parseRich, richExtent, richSvg, richWidth } from './text';
import type { Theme } from './themes';

export interface ResolvedSeries {
  s: Series;
  /** Display color. */
  color: string;
  /** Legend / visibility key (group, else label, else index). */
  key: string;
  hidden: boolean;
  panel: number;
  index: number;
}

export interface LegendEntry {
  key: string;
  label: string;
  color: string;
  hidden: boolean;
  line?: { width: number; dash?: Dash; markers?: boolean };
  band?: number;
  patch?: number;
  marker?: string;
  sticks?: boolean;
}

/** One entry per key, in order of first appearance; the label comes from the first labelled member. */
export function legendEntries(series: ResolvedSeries[], theme: Theme): LegendEntry[] {
  const byKey = new Map<string, LegendEntry>();
  const order: string[] = [];
  const labelled = new Set(series.filter(r => r.s.label).map(r => r.key));
  for (const r of series) {
    if (!labelled.has(r.key) || r.s.type === 'heatmap' || r.s.type === 'text') {
      continue;
    }
    let e = byKey.get(r.key);
    if (!e) {
      e = { key: r.key, label: '', color: r.color, hidden: r.hidden };
      byKey.set(r.key, e);
      order.push(r.key);
    }
    if (!e.label && r.s.label) {
      e.label = r.s.label;
    }
    const s = r.s;
    switch (s.type) {
      case 'line':
        e.line = { width: s.width ?? theme.lineWidth, dash: s.dash, markers: s.markers };
        e.color = r.color;
        break;
      case 'hline':
      case 'vline':
        e.line ??= { width: s.width ?? theme.spineWidth, dash: s.dash };
        break;
      case 'band':
        e.band = s.opacity ?? theme.bandOpacity;
        break;
      case 'histogram':
        if (s.style === 'step' || !s.style) {
          e.line ??= { width: theme.lineWidth };
        } else {
          e.patch = s.opacity ?? (s.style === 'bars' ? 0.85 : 0.3);
        }
        break;
      case 'scatter':
        e.marker = s.marker ?? 'circle';
        break;
      case 'sticks':
        e.sticks = true;
        break;
      default:
        break;
    }
  }
  return order.map(k => byKey.get(k)!);
}

export interface LegendLayout {
  w: number;
  h: number;
  rowH: number;
  swatch: number;
  gap: number;
  padX: number;
  padY: number;
  titleH: number;
  horizontal: boolean;
  /** Item positions relative to the legend origin (top-left). */
  items: { x: number; y: number; w: number }[];
}

export function measureLegend(entries: LegendEntry[], title: string | undefined, theme: Theme, horizontal = false, maxWidth = Infinity): LegendLayout {
  const fs = theme.legendSize;
  const rowH = fs * 1.32;
  const swatch = fs * (theme.preset === 'publication' ? 2.1 : 1.9);
  const gap = fs * 0.5;
  const framed = !!theme.legendBorder || !!theme.legendBg;
  const padX = framed ? fs * 0.75 : fs * 0.3;
  const padY = framed ? fs * 0.5 : fs * 0.25;
  const titleH = title ? rowH : 0;
  const items: { x: number; y: number; w: number }[] = [];
  let w = 0;
  if (horizontal) {
    let x = 0;
    let y = titleH;
    const colGap = fs * 1.2;
    for (const e of entries) {
      const iw = swatch + gap + richWidth(parseRich(e.label), fs, theme.measure);
      if (x > 0 && x + iw > maxWidth - 2 * padX) {
        x = 0;
        y += rowH;
      }
      items.push({ x, y, w: iw });
      x += iw + colGap;
      w = Math.max(w, x - colGap);
    }
    const rows = entries.length ? (items[items.length - 1].y - titleH) / rowH + 1 : 0;
    const tw = title ? richWidth(parseRich(title), fs, theme.measure) : 0;
    return { w: Math.max(w, tw) + 2 * padX, h: titleH + rows * rowH + 2 * padY, rowH, swatch, gap, padX, padY, titleH, horizontal, items };
  }
  entries.forEach((e, i) => {
    const iw = swatch + gap + richWidth(parseRich(e.label), fs, theme.measure);
    items.push({ x: 0, y: titleH + i * rowH, w: iw });
    w = Math.max(w, iw);
  });
  if (title) {
    w = Math.max(w, richWidth(parseRich(title), fs, theme.measure));
  }
  return { w: w + 2 * padX, h: titleH + entries.length * rowH + 2 * padY, rowH, swatch, gap, padX, padY, titleH, horizontal, items };
}

export type Corner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
const CORNERS: Corner[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];

export function cornerBox(corner: Corner, rect: Box, w: number, h: number, inset: number): Box {
  const x = corner.endsWith('left') ? rect.x + inset : rect.x + rect.w - inset - w;
  const y = corner.startsWith('top') ? rect.y + inset : rect.y + rect.h - inset - h;
  return { x, y, w, h };
}

/**
 * The corner whose legend box covers the fewest data points (`points` are
 * interleaved x, y in user units). Ties keep the order TR, TL, BR, BL.
 */
export function bestCorner(points: ArrayLike<number>, rect: Box, w: number, h: number, inset: number): Corner {
  return bestCornerScored(points, rect, w, h, inset).corner;
}

/** bestCorner plus the number of points the legend still covers there. */
export function bestCornerScored(points: ArrayLike<number>, rect: Box, w: number, h: number, inset: number): { corner: Corner; covered: number } {
  let best: Corner = 'top-right';
  let bestScore = Infinity;
  const margin = Math.min(w, h) * 0.15;
  for (const c of CORNERS) {
    const b = cornerBox(c, rect, w, h, inset);
    const x0 = b.x - margin, x1 = b.x + b.w + margin, y0 = b.y - margin, y1 = b.y + b.h + margin;
    let score = 0;
    for (let i = 0; i + 1 < points.length; i += 2) {
      const px = points[i];
      const py = points[i + 1];
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
        score++;
      }
    }
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = c;
    }
  }
  return { corner: best, covered: bestScore };
}

export function isOutside(pos: LegendPosition | undefined): boolean {
  return pos === 'outside-right' || pos === 'outside-top';
}

export interface LegendHit {
  key: string;
  box: Box;
}

/** Legend markup at (x, y) (top-left); returns hit boxes per entry. */
export function legendMarkup(entries: LegendEntry[], title: string | undefined, layout: LegendLayout, x: number, y: number, theme: Theme, fontFor?: (cp: number) => string): { markup: string; hits: LegendHit[] } {
  const fs = theme.legendSize;
  const out: string[] = [];
  const hits: LegendHit[] = [];
  if (theme.legendBg || theme.legendBorder) {
    out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(layout.w)}" height="${f(layout.h)}" rx="${f(theme.legendRadius)}" fill="${theme.legendBg ?? 'none'}" stroke="${theme.legendBorder ?? 'none'}" stroke-width="1"/>`);
  }
  const ox = x + layout.padX;
  const oy = y + layout.padY;
  const textOpts = { size: fs, explicitMarks: theme.arimo, fontFor };
  if (title) {
    const runs = parseRich(title);
    const ext = richExtent(runs, fs);
    out.push(`<text x="${f(ox)}" y="${f(oy + (layout.rowH + ext.ascent - ext.descent) / 2)}" font-size="${f(fs)}" fill="${theme.fg}">${richSvg(runs, textOpts)}</text>`);
  }
  entries.forEach((e, i) => {
    const it = layout.items[i];
    const ix = ox + it.x;
    const iy = oy + it.y;
    const cy = iy + layout.rowH / 2;
    const sw = layout.swatch;
    const parts: string[] = [];
    const op = e.hidden ? ' opacity="0.3"' : '';
    if (e.band !== undefined) {
      parts.push(`<rect x="${f(ix)}" y="${f(cy - fs * 0.38)}" width="${f(sw)}" height="${f(fs * 0.76)}" fill="${e.color}" fill-opacity="${e.band}"/>`);
    }
    if (e.patch !== undefined) {
      parts.push(`<rect x="${f(ix + sw * 0.1)}" y="${f(cy - fs * 0.38)}" width="${f(sw * 0.8)}" height="${f(fs * 0.76)}" fill="${e.color}" fill-opacity="${e.patch}" stroke="${e.color}" stroke-width="${f(theme.spineWidth)}"/>`);
    }
    if (e.line) {
      const w = Math.min(e.line.width, fs * 0.35);
      const da = dashArray(e.line.dash, w);
      parts.push(`<path d="M${f(ix)} ${f(cy)}H${f(ix + sw)}" fill="none" stroke="${e.color}" stroke-width="${f(w)}"${da ? ` stroke-dasharray="${da}"` : ''} stroke-linecap="butt"/>`);
      if (e.line.markers) {
        parts.push(`<circle cx="${f(ix + sw / 2)}" cy="${f(cy)}" r="${f(Math.max(1.2, w * 1.5))}" fill="${e.color}"/>`);
      }
    }
    if (e.sticks && !e.line) {
      const sx = [0.25, 0.5, 0.75];
      parts.push(`<path d="${sx.map((t, k) => `M${f(ix + sw * t)} ${f(cy + fs * 0.4)}V${f(cy - fs * (0.15 + 0.22 * ((k + 1) % 3)))}`).join('')}" stroke="${e.color}" stroke-width="${f(Math.max(0.6, theme.lineWidth * 0.7))}" fill="none"/>`);
    }
    if (e.marker && !e.line) {
      const r = fs * 0.3;
      parts.push(`<circle cx="${f(ix + sw / 2)}" cy="${f(cy)}" r="${f(r)}" fill="${e.color}" fill-opacity="0.85"/>`);
    }
    const runs = parseRich(e.label);
    const ext = richExtent(runs, fs);
    parts.push(`<text x="${f(ix + sw + layout.gap)}" y="${f(cy + (ext.ascent - ext.descent) / 2)}" font-size="${f(fs)}" fill="${theme.fg}">${richSvg(runs, textOpts)}</text>`);
    out.push(`<g class="chart-legend-item" data-key="${encodeURIComponent(e.key)}"${op}>${parts.join('')}</g>`);
    hits.push({ key: e.key, box: { x: ix - 2, y: iy, w: it.w + 4, h: layout.rowH } });
  });
  return { markup: `<g class="chart-legend">${out.join('')}</g>`, hits };
}
