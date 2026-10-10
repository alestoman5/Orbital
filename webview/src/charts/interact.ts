// Pointer and keyboard interaction on a rendered chart: drag to zoom x (shift:
// rectangle), double-click / Escape to reset, crosshair with a readout
// tooltip, click a legend entry to hide/show its group.

import type { RenderOptions } from './api';
import { monotonic } from './decimate';
import type { FigureModel, PanelModel, ZoomState } from './figure';
import { formatValue } from './format';
import type { Box } from './layout';
import { plainText } from './text';

const SVGNS = 'http://www.w3.org/2000/svg';

export interface InteractionHost {
  root: HTMLElement;
  svg: SVGSVGElement;
  model(): FigureModel | undefined;
  /** User units per CSS pixel (publication preview is scaled). */
  unitsPerPx(): number;
  zoomTo(panel: number, z: ZoomState): void;
  reset(): void;
  toggle(key: string): void;
  options: RenderOptions;
}

interface Drag {
  panel: PanelModel;
  x0: number;
  y0: number;
  rect: boolean;
  el: SVGRectElement;
  pointer: number;
}

const monoCache = new WeakMap<object, 1 | -1 | 0>();
function mono(x: ArrayLike<number>): 1 | -1 | 0 {
  let m = monoCache.get(x as object);
  if (m === undefined) {
    m = monotonic(x);
    monoCache.set(x as object, m);
  }
  return m;
}

/** y of a monotonic-x polyline at x (linear interpolation), NaN outside. */
export function interpolateAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = Math.min(xs.length, ys.length);
  const dir = mono(xs);
  if (n < 2 || dir === 0) {
    return NaN;
  }
  let a = 0;
  let b = n - 1;
  const before = (v: number) => (dir === 1 ? v <= x : v >= x);
  if (!(dir === 1 ? x >= xs[0] && x <= xs[n - 1] : x <= xs[0] && x >= xs[n - 1])) {
    return NaN;
  }
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (before(xs[m])) {
      a = m;
    } else {
      b = m;
    }
  }
  const x0 = xs[a], x1 = xs[b];
  const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  return ys[a] + (ys[b] - ys[a]) * t;
}

function inside(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v));
  }
  return e;
}

export class Interaction {
  private overlay: SVGGElement | undefined;
  private crossV: SVGLineElement | undefined;
  private crossH: SVGLineElement | undefined;
  private dots: SVGGElement | undefined;
  private tip: HTMLDivElement;
  private drag: Drag | undefined;
  private readonly off: (() => void)[] = [];

  constructor(private readonly host: InteractionHost) {
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    host.root.appendChild(this.tip);
    const on = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K | string, fn: (e: any) => void) => {
      target.addEventListener(type, fn);
      this.off.push(() => target.removeEventListener(type, fn));
    };
    on(host.svg, 'pointerdown', e => this.onDown(e));
    on(host.svg, 'pointermove', e => this.onMove(e));
    on(host.svg, 'pointerup', e => this.onUp(e));
    on(host.svg, 'pointercancel', () => this.cancelDrag());
    on(host.svg, 'pointerleave', () => { if (!this.drag) { this.hideCross(); } });
    on(host.svg, 'dblclick', e => {
      if (this.hitPanel(e)) {
        e.preventDefault();
        host.reset();
      }
    });
    on(host.svg, 'click', e => {
      const item = (e.target as Element).closest?.('.chart-legend-item');
      if (item) {
        const key = decodeURIComponent(item.getAttribute('data-key') ?? '');
        if (key) {
          host.toggle(key);
        }
      }
    });
    on(host.root, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.cancelDrag();
        host.reset();
      }
    });
  }

  /** Re-creates the overlay layer after a re-render. */
  attach(): void {
    const g = el('g', { class: 'chart-overlay', 'pointer-events': 'none' });
    this.crossV = el('line', { class: 'chart-cross', 'vector-effect': 'non-scaling-stroke' });
    this.crossH = el('line', { class: 'chart-cross', 'vector-effect': 'non-scaling-stroke' });
    this.dots = el('g', { class: 'chart-dots' });
    g.append(this.crossV, this.crossH, this.dots);
    this.crossV.style.display = this.crossH.style.display = 'none';
    this.host.svg.appendChild(g);
    this.overlay = g;
    this.tip.hidden = true;
  }

  private point(e: PointerEvent | MouseEvent): { x: number; y: number } | undefined {
    const ctm = this.host.svg.getScreenCTM();
    if (!ctm) {
      return undefined;
    }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  private hitPanel(e: PointerEvent | MouseEvent): { panel: PanelModel; x: number; y: number } | undefined {
    const m = this.host.model();
    const p = this.point(e);
    if (!m || !p) {
      return undefined;
    }
    const panel = m.panels.find(q => inside(q.rect, p.x, p.y));
    return panel ? { panel, x: p.x, y: p.y } : undefined;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || this.host.options.interactive === false) {
      return;
    }
    if ((e.target as Element).closest?.('.chart-legend-item')) {
      return;
    }
    const hit = this.hitPanel(e);
    if (!hit || !this.overlay) {
      return;
    }
    e.preventDefault();
    this.host.root.focus({ preventScroll: true });
    const r = hit.panel.rect;
    const rectEl = el('rect', { class: 'chart-zoom', x: hit.x, y: r.y, width: 0, height: r.h, 'vector-effect': 'non-scaling-stroke' });
    this.overlay.appendChild(rectEl);
    this.drag = { panel: hit.panel, x0: hit.x, y0: hit.y, rect: e.shiftKey, el: rectEl, pointer: e.pointerId };
    this.host.svg.setPointerCapture(e.pointerId);
    this.hideCross();
  }

  private onMove(e: PointerEvent): void {
    if (this.host.options.interactive === false) {
      return;
    }
    const d = this.drag;
    if (d) {
      const p = this.point(e);
      if (!p) {
        return;
      }
      const r = d.panel.rect;
      const x = Math.max(r.x, Math.min(r.x + r.w, p.x));
      const y = Math.max(r.y, Math.min(r.y + r.h, p.y));
      d.rect = d.rect || e.shiftKey;
      d.el.setAttribute('x', String(Math.min(x, d.x0)));
      d.el.setAttribute('width', String(Math.abs(x - d.x0)));
      if (d.rect) {
        d.el.setAttribute('y', String(Math.min(y, d.y0)));
        d.el.setAttribute('height', String(Math.abs(y - d.y0)));
      }
      return;
    }
    const hit = this.hitPanel(e);
    if (!hit) {
      this.hideCross();
      return;
    }
    this.showCross(hit.panel, hit.x, hit.y, e);
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      return;
    }
    const p = this.point(e);
    this.cancelDrag();
    if (!p) {
      return;
    }
    const r = d.panel.rect;
    const x = Math.max(r.x, Math.min(r.x + r.w, p.x));
    const y = Math.max(r.y, Math.min(r.y + r.h, p.y));
    const minDrag = 4 * this.host.unitsPerPx();
    if (Math.abs(x - d.x0) < minDrag) {
      return;
    }
    const xa = d.panel.x.invert(Math.min(x, d.x0));
    const xb = d.panel.x.invert(Math.max(x, d.x0));
    const z: ZoomState = { x: [Math.min(xa, xb), Math.max(xa, xb)] };
    if (d.rect && Math.abs(y - d.y0) >= minDrag) {
      const ya = d.panel.y.invert(Math.max(y, d.y0));
      const yb = d.panel.y.invert(Math.min(y, d.y0));
      z.y = [Math.min(ya, yb), Math.max(ya, yb)];
      if (d.panel.y2) {
        const a = d.panel.y2.invert(Math.max(y, d.y0));
        const b = d.panel.y2.invert(Math.min(y, d.y0));
        z.y2 = [Math.min(a, b), Math.max(a, b)];
      }
    }
    this.host.zoomTo(d.panel.index, z);
  }

  private cancelDrag(): void {
    if (this.drag) {
      try {
        this.host.svg.releasePointerCapture(this.drag.pointer);
      } catch {
        // already released
      }
      this.drag.el.remove();
      this.drag = undefined;
    }
  }

  private hideCross(): void {
    if (this.crossV && this.crossH) {
      this.crossV.style.display = this.crossH.style.display = 'none';
    }
    this.dots?.replaceChildren();
    this.tip.hidden = true;
  }

  private showCross(panel: PanelModel, x: number, y: number, e: PointerEvent): void {
    const r = panel.rect;
    if (!this.crossV || !this.crossH || !this.dots) {
      return;
    }
    const set = (l: SVGLineElement, a: Record<string, number>) => {
      for (const [k, v] of Object.entries(a)) {
        l.setAttribute(k, String(v));
      }
      l.style.display = '';
    };
    set(this.crossV, { x1: x, x2: x, y1: r.y, y2: r.y + r.h });
    set(this.crossH, { x1: r.x, x2: r.x + r.w, y1: y, y2: y });
    const xv = panel.x.invert(x);
    const yv = panel.y.invert(y);
    const header = this.host.options.readout ? this.host.options.readout(panel.index, xv, yv) : `${formatValue(xv)}, ${formatValue(yv)}`;
    const rows: { color: string; label: string; value: string }[] = [];
    const dots: SVGElement[] = [];
    const upp = this.host.unitsPerPx();
    const seen = new Set<string>();
    for (const rs of panel.series) {
      const s = rs.s;
      if (rs.hidden || s.type !== 'line' || rows.length >= 10) {
        continue;
      }
      const v = interpolateAt(s.x, s.y, xv);
      if (!Number.isFinite(v)) {
        continue;
      }
      const sy = s.yAxis === 'right' && panel.y2 ? panel.y2 : panel.y;
      const Y = sy.map(v);
      if (Y >= r.y - 1 && Y <= r.y + r.h + 1) {
        dots.push(el('circle', { cx: x, cy: Y, r: 3.2 * upp, fill: rs.color, class: 'chart-dot', 'vector-effect': 'non-scaling-stroke' }));
      }
      const label = s.label ?? (s.group && !seen.has(s.group) ? s.group : undefined);
      if (label) {
        seen.add(s.group ?? label);
        rows.push({ color: rs.color, label: plainText(label), value: formatValue(v) });
      }
    }
    this.dots.replaceChildren(...dots);
    // tooltip
    const tip = this.tip;
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'chart-tip-head';
    head.textContent = header;
    tip.appendChild(head);
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'chart-tip-row';
      const sw = document.createElement('span');
      sw.className = 'chart-tip-swatch';
      sw.style.background = row.color;
      const lab = document.createElement('span');
      lab.className = 'chart-tip-label';
      lab.textContent = row.label;
      const val = document.createElement('span');
      val.className = 'chart-tip-value';
      val.textContent = row.value;
      line.append(sw, lab, val);
      tip.appendChild(line);
    }
    tip.hidden = false;
    const rootBox = this.host.root.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = e.clientX - rootBox.left + 14;
    let top = e.clientY - rootBox.top + 14;
    if (left + tw > rootBox.width - 4) {
      left = e.clientX - rootBox.left - tw - 14;
    }
    if (top + th > rootBox.height - 4) {
      top = Math.max(4, e.clientY - rootBox.top - th - 14);
    }
    tip.style.transform = `translate(${Math.max(4, left)}px, ${top}px)`;
  }

  dispose(): void {
    this.off.forEach(f => f());
    this.tip.remove();
  }
}
