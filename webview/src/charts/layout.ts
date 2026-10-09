// Layout math: where the plot rectangles go, given the space every panel
// needs around its plot area (measured tick labels, axis labels, legends,
// colour bars). Panels of a stack share their left/right margins so the axes
// line up. DOM-free.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Space a panel needs outside its plot rectangle. */
export interface Req {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const MIN_PLOT = 12;

/**
 * One column of panels. `ratios` are the relative plot heights (heightRatio),
 * `gap` the extra space between neighbouring panels.
 */
export function stackLayout(width: number, height: number, pad: number, reqs: Req[], ratios: number[], gap: number): Box[] {
  const n = reqs.length;
  if (!n) {
    return [];
  }
  const left = Math.max(...reqs.map(r => r.left));
  const right = Math.max(...reqs.map(r => r.right));
  const w = Math.max(MIN_PLOT, width - 2 * pad - left - right);
  const outer = reqs.reduce((a, r) => a + r.top + r.bottom, 0) + gap * (n - 1);
  const avail = Math.max(MIN_PLOT * n, height - 2 * pad - outer);
  const total = ratios.reduce((a, r) => a + (r > 0 ? r : 1), 0) || 1;
  const boxes: Box[] = [];
  let y = pad;
  for (let i = 0; i < n; i++) {
    y += reqs[i].top;
    const h = (avail * (ratios[i] > 0 ? ratios[i] : 1)) / total;
    boxes.push({ x: pad + left, y, w, h });
    y += h + reqs[i].bottom + gap;
  }
  return boxes;
}

/** rows × cols grid; columns share left/right margins, rows share top/bottom. */
export function gridLayout(width: number, height: number, pad: number, reqs: Req[], cols: number, gapX: number, gapY: number): Box[] {
  const n = reqs.length;
  const c = Math.max(1, Math.min(cols, n));
  const rows = Math.ceil(n / c);
  const lefts = Array.from({ length: c }, (_, j) => Math.max(0, ...reqs.filter((_, i) => i % c === j).map(r => r.left)));
  const rights = Array.from({ length: c }, (_, j) => Math.max(0, ...reqs.filter((_, i) => i % c === j).map(r => r.right)));
  const tops = Array.from({ length: rows }, (_, k) => Math.max(0, ...reqs.filter((_, i) => Math.floor(i / c) === k).map(r => r.top)));
  const bottoms = Array.from({ length: rows }, (_, k) => Math.max(0, ...reqs.filter((_, i) => Math.floor(i / c) === k).map(r => r.bottom)));
  const cw = Math.max(MIN_PLOT, (width - 2 * pad - lefts.reduce((a, b) => a + b, 0) - rights.reduce((a, b) => a + b, 0) - gapX * (c - 1)) / c);
  const ch = Math.max(MIN_PLOT, (height - 2 * pad - tops.reduce((a, b) => a + b, 0) - bottoms.reduce((a, b) => a + b, 0) - gapY * (rows - 1)) / rows);
  const boxes: Box[] = [];
  for (let i = 0; i < n; i++) {
    const j = i % c;
    const k = Math.floor(i / c);
    let x = pad;
    for (let q = 0; q < j; q++) {
      x += lefts[q] + cw + rights[q] + gapX;
    }
    let y = pad;
    for (let q = 0; q < k; q++) {
      y += tops[q] + ch + bottoms[q] + gapY;
    }
    boxes.push({ x: x + lefts[j], y: y + tops[k], w: cw, h: ch });
  }
  return boxes;
}

/**
 * Shrinks a plot box so one data unit has the same length on x and y
 * (parity plots), keeping it centred in the available box.
 */
export function equalAspectBox(box: Box, xSpan: number, ySpan: number): Box {
  if (!(xSpan > 0) || !(ySpan > 0)) {
    return box;
  }
  const kx = box.w / xSpan;
  const ky = box.h / ySpan;
  const k = Math.min(kx, ky);
  const w = xSpan * k;
  const h = ySpan * k;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Screen height: the container's height if it has one, else width × 0.56 clamped to 260–620 px. */
export function screenHeight(width: number, containerHeight?: number): number {
  if (containerHeight && containerHeight > 40) {
    return containerHeight;
  }
  return Math.round(Math.max(260, Math.min(620, width * 0.56)));
}

/** Scale that fits a w × h figure into the available area (no upscaling beyond maxScale). */
export function fitScale(w: number, h: number, availW: number, availH: number, maxScale = 3): number {
  const s = Math.min(availW / w, availH / h, maxScale);
  return s > 0 && Number.isFinite(s) ? s : 1;
}

/** Number of major ticks that fit on an axis of `length` with ticks at least `spacing` apart. */
export function maxTickCount(length: number, spacing: number): number {
  return Math.max(3, Math.floor(length / Math.max(1, spacing)) + 1);
}
