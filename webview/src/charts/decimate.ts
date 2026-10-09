// Visible-window cropping and min/max-per-pixel-column decimation of line
// data. Keeps the first, minimum, maximum and last point of every column in
// their original order, so spikes and the curve's envelope survive while
// 10⁵-point traces draw in a few milliseconds. DOM-free.

export const DECIMATE_THRESHOLD = 5000;

export interface XY {
  x: Float64Array;
  y: Float64Array;
}

/** 1 when x increases, −1 when it decreases, 0 when it is not monotonic (NaN ignored). */
export function monotonic(x: ArrayLike<number>): 1 | -1 | 0 {
  let dir = 0;
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (Number.isNaN(v)) {
      continue;
    }
    if (!Number.isNaN(prev) && v !== prev) {
      const d = v > prev ? 1 : -1;
      if (dir === 0) {
        dir = d;
      } else if (d !== dir) {
        return 0;
      }
    }
    prev = v;
  }
  return (dir || 1) as 1 | -1;
}

/** Index range [i0, i1) of monotonic x covering [lo, hi] plus one point on each side. */
export function visibleRange(x: ArrayLike<number>, lo: number, hi: number, dir: 1 | -1): [number, number] {
  const n = x.length;
  if (n === 0) {
    return [0, 0];
  }
  // binary search on the first index whose x reaches the window (in x's own order)
  const before = (v: number, bound: number) => (dir === 1 ? v < bound : v > bound);
  const startBound = dir === 1 ? lo : hi;
  const endBound = dir === 1 ? hi : lo;
  let a = 0;
  let b = n;
  while (a < b) {
    const m = (a + b) >> 1;
    if (before(x[m], startBound)) {
      a = m + 1;
    } else {
      b = m;
    }
  }
  const i0 = Math.max(0, a - 1);
  a = i0;
  b = n;
  while (a < b) {
    const m = (a + b) >> 1;
    if (before(endBound, x[m]) ) {
      b = m;
    } else {
      a = m + 1;
    }
  }
  const i1 = Math.min(n, a + 1);
  return [i0, i1];
}

/**
 * Min/max decimation of points i0..i1 into `columns` buckets over [x0, x1].
 * NaN in y is kept as a gap marker. The result has at most 4 points per column.
 */
export function decimateMinMax(x: ArrayLike<number>, y: ArrayLike<number>, x0: number, x1: number, columns: number, i0 = 0, i1 = Math.min(x.length, y.length)): XY {
  const n = i1 - i0;
  const cols = Math.max(1, Math.floor(columns));
  const span = x1 - x0 || 1;
  const outX: number[] = [];
  const outY: number[] = [];
  let col = NaN;
  let iFirst = -1, iMin = -1, iMax = -1, iLast = -1;
  const flush = () => {
    if (iFirst < 0) {
      return;
    }
    const idx = [iFirst, iMin, iMax, iLast].sort((p, q) => p - q);
    let prev = -1;
    for (const i of idx) {
      if (i !== prev) {
        outX.push(x[i]);
        outY.push(y[i]);
        prev = i;
      }
    }
    iFirst = iMin = iMax = iLast = -1;
  };
  for (let k = 0; k < n; k++) {
    const i = i0 + k;
    const yi = y[i];
    const xi = x[i];
    if (Number.isNaN(yi) || Number.isNaN(xi)) {
      flush();
      outX.push(NaN);
      outY.push(NaN);
      col = NaN;
      continue;
    }
    const c = Math.floor(((xi - x0) / span) * cols);
    if (c !== col) {
      flush();
      col = c;
      iFirst = iMin = iMax = iLast = i;
      continue;
    }
    iLast = i;
    if (yi < y[iMin]) {
      iMin = i;
    }
    if (yi > y[iMax]) {
      iMax = i;
    }
  }
  flush();
  return { x: Float64Array.from(outX), y: Float64Array.from(outY) };
}

/**
 * The points of a line that need drawing for the visible x window: cropped to
 * the window when x is monotonic, and decimated to `columns` when long.
 */
export function prepareLine(x: ArrayLike<number>, y: ArrayLike<number>, lo: number, hi: number, columns: number, decimate = true): { x: ArrayLike<number>; y: ArrayLike<number>; i0: number; i1: number } {
  const n = Math.min(x.length, y.length);
  const dir = n > 64 ? monotonic(x) : 0;
  let i0 = 0;
  let i1 = n;
  if (dir !== 0) {
    [i0, i1] = visibleRange(x, lo, hi, dir);
  }
  if (decimate && dir !== 0 && n >= DECIMATE_THRESHOLD && i1 - i0 > columns * 4) {
    const d = decimateMinMax(x, y, lo, hi, columns, i0, i1);
    return { x: d.x, y: d.y, i0: 0, i1: d.x.length };
  }
  return { x, y, i0, i1 };
}
