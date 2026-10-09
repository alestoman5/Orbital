// Visual presets. A Theme holds concrete colors (hex, so exports need no CSS)
// and sizes in the figure's user units: pt for 'publication', CSS px for
// 'screen'. publicationTheme() is DOM-free; screenTheme() reads the VS Code
// theme through the tokens.css variables of the chart's container.

import { PALETTE, type Figure, type Preset } from './api';
import { contrast, mix, toHex } from './colormap';
import { arimoMeasure, type Measure } from './text';

export interface Theme {
  preset: Preset;
  /** Chart background; null = transparent (screen sits on the card). */
  bg: string | null;
  /** Background used for contrast decisions (legend box, heatmap labels). */
  paper: string;
  fg: string;
  muted: string;
  frame: string;
  grid: string;
  legendBg: string | null;
  legendBorder: string | null;
  legendRadius: number;
  /** Font stack written into the SVG. */
  fontFamily: string;
  /** Whether text is set in Arimo/Arial metrics (explicit accent placement). */
  arimo: boolean;
  fontSize: number;
  tickLabelSize: number;
  labelSize: number;
  legendSize: number;
  tagSize: number;
  titleSize: number;
  lineWidth: number;
  spineWidth: number;
  tickWidth: number;
  minorWidth: number;
  gridWidth: number;
  tickLen: number;
  minorLen: number;
  tickDir: 'in' | 'out';
  /** Draw all four spines and mirror ticks on top/right. */
  closedFrame: boolean;
  minorTicks: boolean;
  gridDefault: boolean;
  /** Gap between tick and its label. */
  tickPad: number;
  /** Gap between tick labels and the axis label. */
  labelPad: number;
  /** Outer padding of the figure. */
  pad: number;
  palette: readonly string[];
  bandOpacity: number;
  measure: Measure;
  /** Snap 1-unit lines to the pixel grid (screen). */
  crisp: boolean;
  /** Maps a series color for display (contrast against the background on screen). */
  adjustColor: (c: string) => string;
}

export const PUBLICATION_FONT = 'Arial, Helvetica, Arimo, sans-serif';

export function publicationTheme(figure: Figure): Theme {
  const fs = figure.fontSize ?? 8;
  return {
    preset: 'publication',
    bg: '#ffffff',
    paper: '#ffffff',
    fg: '#000000',
    muted: '#000000',
    frame: '#000000',
    grid: '#d9d9d9',
    legendBg: null,
    legendBorder: null,
    legendRadius: 0,
    fontFamily: figure.fontFamily ?? PUBLICATION_FONT,
    arimo: !figure.fontFamily || /arial|helvetica|arimo|liberation sans/i.test(figure.fontFamily),
    fontSize: fs,
    tickLabelSize: fs,
    labelSize: fs + 1,
    legendSize: fs - 0.5,
    tagSize: fs + 1,
    titleSize: fs + 1,
    lineWidth: 1.25,
    spineWidth: 0.75,
    tickWidth: 0.75,
    minorWidth: 0.6,
    gridWidth: 0.5,
    tickLen: 3.5,
    minorLen: 2,
    tickDir: 'in',
    closedFrame: true,
    minorTicks: true,
    gridDefault: false,
    tickPad: 3,
    labelPad: 3.5,
    pad: 2.5,
    palette: figure.palette ?? PALETTE,
    bandOpacity: 0.22,
    measure: arimoMeasure,
    crisp: false,
    adjustColor: c => c
  };
}

// --- screen ---------------------------------------------------------------------

let probeCanvas: CanvasRenderingContext2D | null | undefined;

/** Parses rgb()/rgba()/color(srgb …)/#hex; falls back to a canvas readback. */
export function cssColorToRgba(value: string): [number, number, number, number] | undefined {
  const v = value.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) {
      h = h.split('').map(c => c + c).join('');
    }
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1] * 255, +m[2] * 255, +m[3] * 255, a];
  }
  if (typeof document === 'undefined') {
    return undefined;
  }
  if (probeCanvas === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probeCanvas = c.getContext('2d', { willReadFrequently: true });
  }
  if (!probeCanvas) {
    return undefined;
  }
  probeCanvas.clearRect(0, 0, 1, 1);
  probeCanvas.fillStyle = '#000';
  probeCanvas.fillStyle = v;
  probeCanvas.fillRect(0, 0, 1, 1);
  const d = probeCanvas.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
}

function composite(rgba: [number, number, number, number] | undefined, over: string, fallback: string): string {
  if (!rgba) {
    return fallback;
  }
  const [r, g, b, a] = rgba;
  const base = over.replace('#', '');
  const n = parseInt(base, 16);
  const br = (n >> 16) & 255, bg = (n >> 8) & 255, bb = n & 255;
  return toHex(r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a));
}

/** Resolves CSS color expressions (var(), color-mix()) in the context of `el` to hex over `bg`. */
export function resolveColors(el: Element, exprs: Record<string, string>, bg = '#1f1f1f'): Record<string, string> {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  el.appendChild(probe);
  const out: Record<string, string> = {};
  try {
    for (const [k, expr] of Object.entries(exprs)) {
      probe.style.color = '';
      probe.style.color = expr;
      out[k] = composite(cssColorToRgba(getComputedStyle(probe).color), bg, '#808080');
    }
  } finally {
    probe.remove();
  }
  return out;
}

const canvasCache = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Canvas-based text measurement for the screen font (cached), Arimo metrics as fallback. */
export function canvasMeasure(family: string): Measure {
  return (text, size, bold = false) => {
    if (measureCtx === undefined) {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    }
    if (!measureCtx) {
      return arimoMeasure(text, size, bold) * 1.04;
    }
    const key = `${bold ? 'b' : 'r'}|${family}|${text}`;
    let w = canvasCache.get(key);
    if (w === undefined) {
      measureCtx.font = `${bold ? 600 : 400} 100px ${family}`;
      w = measureCtx.measureText(text).width / 100;
      if (canvasCache.size > 20000) {
        canvasCache.clear();
      }
      canvasCache.set(key, w);
    }
    return w * size;
  };
}

/** Clears cached text widths (call once web fonts finish loading). */
export function clearMeasureCache(): void {
  canvasCache.clear();
}

export type ThemeKind = 'dark' | 'light' | 'high-contrast';

export function themeKind(): ThemeKind {
  const c = typeof document !== 'undefined' ? document.body.classList : undefined;
  if (!c) {
    return 'dark';
  }
  return c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light') ? 'high-contrast'
    : c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark';
}

/** Screen preset from the live VS Code theme (tokens.css variables of `el`). */
export function screenTheme(el: Element, figure: Figure): Theme {
  const kind = themeKind();
  const bgc = resolveColors(el, { bg: 'var(--bg)' }, kind === 'light' ? '#ffffff' : '#1f1f1f').bg;
  const c = resolveColors(el, {
    fg: 'var(--fg)',
    strong: 'var(--fg-strong)',
    muted: 'var(--muted)',
    frame: kind === 'high-contrast' ? 'var(--border-strong)' : 'color-mix(in srgb, var(--fg) 34%, transparent)',
    grid: kind === 'high-contrast' ? 'color-mix(in srgb, var(--fg) 30%, transparent)' : 'color-mix(in srgb, var(--fg) 8%, transparent)',
    legendBg: 'color-mix(in srgb, var(--surface-2) 88%, transparent)',
    legendBorder: 'var(--border)'
  }, bgc);
  const cs = getComputedStyle(el);
  const family = (figure.fontFamily ?? cs.getPropertyValue('--font-ui').trim()) || cs.fontFamily || 'system-ui, sans-serif';
  const fs = figure.fontSize ?? 12;
  const minContrast = kind === 'high-contrast' ? 4.5 : 2.6;
  const adjust = (col: string): string => {
    if (!/^#[0-9a-f]{6}$/i.test(col)) {
      const rgba = cssColorToRgba(col);
      col = rgba ? toHex(rgba[0], rgba[1], rgba[2]) : col;
    }
    if (!/^#[0-9a-f]{6}$/i.test(col)) {
      return col;
    }
    let out = col;
    for (let t = 0.12; t <= 1.0001 && contrast(out, bgc) < minContrast; t += 0.12) {
      out = mix(col, c.strong, t);
    }
    return out;
  };
  return {
    preset: 'screen',
    bg: null,
    paper: bgc,
    fg: c.strong,
    muted: c.muted,
    frame: c.frame,
    grid: c.grid,
    legendBg: c.legendBg,
    legendBorder: c.legendBorder,
    legendRadius: 6,
    fontFamily: family,
    arimo: false,
    fontSize: fs,
    tickLabelSize: fs - 1,
    labelSize: fs,
    legendSize: fs - 1,
    tagSize: fs,
    titleSize: fs,
    lineWidth: 1.75,
    spineWidth: 1,
    tickWidth: 1,
    minorWidth: 1,
    gridWidth: 1,
    tickLen: 4,
    minorLen: 2.5,
    tickDir: 'out',
    closedFrame: false,
    minorTicks: false,
    gridDefault: true,
    tickPad: 4,
    labelPad: 6,
    pad: 6,
    palette: figure.palette ?? PALETTE,
    bandOpacity: kind === 'light' ? 0.2 : 0.26,
    measure: canvasMeasure(family),
    crisp: true,
    adjustColor: adjust
  };
}
