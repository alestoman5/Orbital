// Number formatting of the geom tab (significant digits, value ± error, sizes).

import { superscript } from '../../ui/dom';

/** n significant digits; ×10ⁿ form for tiny / huge magnitudes. */
export function sig(v: number | undefined, n = 4): string {
  if (v === undefined || !Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 1e-3 || a >= 1e6) {
    const [m, e] = v.toExponential(n - 1).split('e');
    return `${m.replace('-', '−')}×10${superscript(e.replace('+', ''))}`;
  }
  const d = Math.max(0, n - 1 - Math.floor(Math.log10(a)));
  return v.toFixed(Math.min(d, 10)).replace('-', '−');
}

/** Decimals that show `err` with two significant digits (at least `min`). */
export function decimalsFor(err: number, min = 0, max = 8): number {
  if (!Number.isFinite(err) || err <= 0) return Math.max(min, 4);
  return Math.max(min, Math.min(max, 1 - Math.floor(Math.log10(err))));
}

/** Fixed decimals with a real minus sign. */
export function fixed(v: number | undefined, d: number): string {
  if (v === undefined || !Number.isFinite(v)) return '–';
  return v.toFixed(d).replace('-', '−');
}

/** "1.3472 ± 0.0314" with decimals from the error. */
export function pm(v: number, err: number, d = decimalsFor(err)): string {
  return `${fixed(v, d)} ± ${fixed(err, d)}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function count(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

/**
 * Legend labels: drops the path segments all labels share at the start and at
 * the end ("CMD/geoms.xyz", "GLE/geoms.xyz" → "CMD", "GLE"), keeping at
 * least one segment; a single label keeps only its file name.
 */
export function legendLabels(labels: string[]): string[] {
  const parts = labels.map(l => l.split('/'));
  if (parts.length < 2) return labels;
  const minLen = Math.min(...parts.map(p => p.length));
  let tail = 0;
  while (tail < minLen - 1 && parts.every(p => p[p.length - 1 - tail] === parts[0][parts[0].length - 1 - tail])) tail++;
  let head = 0;
  while (head < minLen - 1 - tail && parts.every(p => p[head] === parts[0][head])) head++;
  const out = parts.map(p => p.slice(head, p.length - tail).join('/'));
  return new Set(out).size === out.length ? out : labels;
}
