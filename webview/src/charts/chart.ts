// The live chart behind render(): sizes the figure to its container
// (screen) or to its physical size scaled to fit (publication), re-renders on
// resize / theme change / zoom, and owns the interaction layer.

import { JOURNAL_SIZES, type ChartHandle, type Figure, type RenderOptions } from './api';
import { buildFigure, type FigureModel, type ZoomState } from './figure';
import { Interaction } from './interact';
import { fitScale, screenHeight } from './layout';
import { clearMeasureCache, publicationTheme, PUBLICATION_FONT, screenTheme, type Theme } from './themes';

let chartCounter = 0;

function compatible(a: Figure, b: Figure): boolean {
  if (a.panels.length !== b.panels.length || (a.layout?.kind ?? 'stack') !== (b.layout?.kind ?? 'stack')) {
    return false;
  }
  return a.panels.every((p, i) => {
    const q = b.panels[i];
    return !!p.x.log === !!q.x.log && !!p.y.log === !!q.y.log && (p.x.label ?? '') === (q.x.label ?? '') && (p.y.label ?? '') === (q.y.label ?? '');
  });
}

export class Chart implements ChartHandle {
  readonly root: HTMLDivElement;
  readonly svg: SVGSVGElement;
  private figure: Figure;
  private zoom: (ZoomState | undefined)[] = [];
  private hidden = new Set<string>();
  private current: FigureModel | undefined;
  private scale = 1;
  private lastSize = '';
  private readonly id = `oc${++chartCounter}-`;
  private readonly interaction: Interaction;
  private readonly ro: ResizeObserver | undefined;
  private readonly mo: MutationObserver | undefined;
  private frame = 0;
  private disposed = false;
  /** Time of the last render in ms (performance checks). */
  lastRenderMs = 0;

  constructor(private readonly container: HTMLElement, figure: Figure, private readonly options: RenderOptions) {
    this.figure = figure;
    this.root = document.createElement('div');
    this.root.className = 'chart';
    this.root.tabIndex = 0;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'chart-svg');
    this.svg.setAttribute('role', 'img');
    this.root.appendChild(this.svg);
    container.replaceChildren(this.root);
    this.interaction = new Interaction({
      root: this.root,
      svg: this.svg,
      model: () => this.current,
      unitsPerPx: () => 1 / this.scale,
      zoomTo: (panel, z) => this.zoomTo(panel, z),
      reset: () => this.resetZoom(),
      toggle: key => this.toggle(key),
      options
    });
    if (options.interactive === false) {
      this.root.classList.add('static');
    }
    this.render();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.schedule());
      this.ro.observe(container);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.mo = new MutationObserver(() => {
        if ((this.figure.preset ?? 'screen') === 'screen') {
          this.lastSize = '';
          this.schedule();
        }
      });
      this.mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    document.fonts?.ready.then(() => {
      if (!this.disposed) {
        clearMeasureCache();
        this.lastSize = '';
        this.render();
      }
    }).catch(() => undefined);
  }

  private schedule(): void {
    if (this.frame) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) {
        this.render(true);
      }
    });
  }

  private preset(): 'screen' | 'publication' {
    return this.figure.preset ?? 'screen';
  }

  /** Height of the container without our content (0 when it has no own height). */
  private containerHeight(): number {
    this.root.style.display = 'none';
    const h = this.container.clientHeight;
    this.root.style.display = '';
    const cs = getComputedStyle(this.container);
    return Math.max(0, h - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0'));
  }

  private render(fromResize = false): void {
    const t0 = performance.now();
    const cs = getComputedStyle(this.container);
    const availW = Math.max(120, this.container.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0'));
    const ch = this.containerHeight();
    const sizeKey = `${Math.round(availW)}x${Math.round(ch)}`;
    if (fromResize && sizeKey === this.lastSize) {
      return;
    }
    this.lastSize = sizeKey;
    const dpr = window.devicePixelRatio || 1;
    let theme: Theme;
    let w: number;
    let h: number;
    let cssW: number;
    let cssH: number;
    if (this.preset() === 'publication') {
      const size = this.figure.size ?? JOURNAL_SIZES['acs-1col'];
      theme = publicationTheme(this.figure);
      w = size.widthIn * 72;
      h = size.heightIn * 72;
      const px = 96 / 72;
      this.scale = fitScale(w * px, h * px, availW, ch > 40 ? ch : 620, 2.5) * px;
      cssW = w * this.scale;
      cssH = h * this.scale;
      this.root.classList.add('publication');
    } else {
      theme = screenTheme(this.root, this.figure);
      w = availW;
      h = screenHeight(availW, ch);
      this.scale = 1;
      cssW = w;
      cssH = h;
      this.root.classList.remove('publication');
    }
    const model = buildFigure(this.figure, {
      theme,
      width: w,
      height: h,
      pxPerUnit: this.scale * dpr,
      idPrefix: this.id,
      zoom: this.zoom,
      hidden: this.hidden,
      background: theme.preset === 'publication'
    });
    this.current = model;
    const svg = this.svg;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(Math.round(cssW * 100) / 100));
    svg.setAttribute('height', String(Math.round(cssH * 100) / 100));
    svg.setAttribute('font-family', theme.preset === 'publication' && theme.arimo ? `Arimo, ${PUBLICATION_FONT}` : theme.fontFamily);
    svg.innerHTML = model.body;
    this.interaction.attach();
    this.lastRenderMs = performance.now() - t0;
    this.root.dataset.renderMs = this.lastRenderMs.toFixed(1);
  }

  private zoomTo(panel: number, z: ZoomState): void {
    const m = this.current;
    const targets = m?.sharedX && z.x ? m.panels.map(p => p.index) : [panel];
    for (const i of targets) {
      const prev = this.zoom[i] ?? {};
      this.zoom[i] = i === panel ? { ...prev, ...z } : { ...prev, x: z.x };
    }
    this.lastSize = '';
    this.render();
    for (const i of targets) {
      const x = this.zoom[i]?.x;
      if (x) {
        this.options.onZoom?.(i, x[0], x[1]);
      }
    }
  }

  private toggle(key: string): void {
    if (this.hidden.has(key)) {
      this.hidden.delete(key);
    } else {
      this.hidden.add(key);
    }
    this.lastSize = '';
    this.render();
  }

  update(figure: Figure): void {
    if (!compatible(this.figure, figure)) {
      this.zoom = [];
    }
    this.figure = figure;
    this.lastSize = '';
    this.render();
  }

  resetZoom(): void {
    const had = this.zoom.some(Boolean);
    this.zoom = [];
    this.lastSize = '';
    this.render();
    if (had) {
      this.current?.panels.forEach(p => this.options.onZoom?.(p.index, p.x.lo, p.x.hi));
    }
  }

  element(): SVGSVGElement {
    return this.svg;
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
    }
    this.ro?.disconnect();
    this.mo?.disconnect();
    this.interaction.dispose();
    this.root.remove();
  }
}
