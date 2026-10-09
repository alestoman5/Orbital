// Entry point of the chart engine. Tabs import from here only.
// SCAFFOLD STUB: render() draws a placeholder and the exports throw; the
// chart-engine agent replaces the bodies below, keeping these signatures.

import type { ChartHandle, ExportOptions, Figure, FigureToolbarOptions, RenderOptions } from './api';

export * from './api';

/** Draws `figure` into `container` (fills its width; height from the container or the figure size). */
export function render(container: HTMLElement, figure: Figure, options: RenderOptions = {}): ChartHandle {
  void options;
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', '0 0 640 360');
  el.setAttribute('class', 'chart');
  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', '320');
  text.setAttribute('y', '180');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('fill', 'currentColor');
  text.textContent = `chart engine not implemented (${figure.panels.reduce((n, p) => n + p.series.length, 0)} series)`;
  el.appendChild(text);
  container.replaceChildren(el);
  return {
    update: () => undefined,
    resetZoom: () => undefined,
    element: () => el,
    dispose: () => el.remove()
  };
}

/** Standalone SVG document (publication preset unless asked otherwise). */
export function toSvg(figure: Figure, options: ExportOptions = {}): string {
  void figure; void options;
  throw new Error('toSvg not implemented');
}

/** PDF bytes with vector text (via jsPDF + svg2pdf.js). */
export async function toPdf(figure: Figure, options: ExportOptions = {}): Promise<Uint8Array> {
  void figure; void options;
  throw new Error('toPdf not implemented');
}

/** PNG bytes at options.dpi (default 600). */
export async function toPng(figure: Figure, options: ExportOptions = {}): Promise<Uint8Array> {
  void figure; void options;
  throw new Error('toPng not implemented');
}

/** Values as CSV: one x column per distinct x array, then the series' y / lo / hi columns. */
export function toCsv(figure: Figure): string {
  void figure;
  throw new Error('toCsv not implemented');
}

/**
 * Toolbar for a chart card: Screen / Publication switch, journal size picker,
 * export menu (SVG, PDF, PNG 300/600 dpi, CSV, copy PNG), Send to report.
 */
export function figureToolbar(options: FigureToolbarOptions): HTMLElement {
  void options;
  const el = document.createElement('div');
  el.className = 'figure-toolbar';
  return el;
}
