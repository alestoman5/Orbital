// Perceptual colormaps (viridis, magma, cividis) and a blue–white–red
// diverging map, as 33-stop LUTs from matplotlib with linear interpolation.
// DOM-free.

import type { Colormap } from './api';
import { LUT_CIVIDIS, LUT_DIVERGING, LUT_MAGMA, LUT_VIRIDIS } from './colormapData';

const LUTS: Record<Colormap, string[]> = { viridis: LUT_VIRIDIS, magma: LUT_MAGMA, cividis: LUT_CIVIDIS, diverging: LUT_DIVERGING };

export function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h.split('').map(c => c + c).join('');
  }
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function colormapStops(name: Colormap): readonly string[] {
  return LUTS[name] ?? LUT_VIRIDIS;
}

/** Color at t ∈ [0, 1] (clamped; NaN -> transparent-gray marker). */
export function colorAt(name: Colormap, t: number): string {
  if (Number.isNaN(t)) {
    return '#bfbfbf';
  }
  const lut = colormapStops(name);
  const x = Math.max(0, Math.min(1, t)) * (lut.length - 1);
  const i = Math.min(lut.length - 2, Math.floor(x));
  const f = x - i;
  const a = parseHex(lut[i]);
  const b = parseHex(lut[i + 1]);
  return toHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

/** Relative luminance (WCAG) of a hex color. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Linear mix of two hex colors: t = 0 -> a, 1 -> b. */
export function mix(a: string, b: string, t: number): string {
  const p = parseHex(a);
  const q = parseHex(b);
  return toHex(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t);
}

/** Color normalization of z for a heatmap: returns t ∈ [0, 1]. */
export function normalizer(zMin: number, zMax: number, log = false): (z: number) => number {
  if (log) {
    const a = Math.log10(zMin > 0 ? zMin : 1e-300);
    const b = Math.log10(zMax > 0 ? zMax : 1);
    return z => (z > 0 ? (Math.log10(z) - a) / (b - a || 1) : NaN);
  }
  return z => (z - zMin) / (zMax - zMin || 1);
}

/** Default color limits: data min/max (symmetric around 0 for 'diverging'). */
export function colorLimits(z: ArrayLike<number>[], map: Colormap, log = false, zMin?: number, zMax?: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of z) {
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (!Number.isFinite(v) || (log && v <= 0)) {
        continue;
      }
      if (v < lo) { lo = v; }
      if (v > hi) { hi = v; }
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (map === 'diverging' && !log && zMin === undefined && zMax === undefined) {
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    return [-m, m];
  }
  return [zMin ?? lo, zMax ?? hi];
}
