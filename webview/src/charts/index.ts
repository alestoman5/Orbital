// Entry point of the chart engine. Tabs import from here only.

import './charts.css';
import type { ChartHandle, ExportOptions, Figure, FigureToolbarOptions, RenderOptions } from './api';
import { Chart } from './chart';
import { buildCsv } from './csv';
import { pdfBytes, pngBytes } from './export';
import { svgString } from './svgExport';
import { screenTheme } from './themes';
import { buildToolbar } from './toolbar';

export * from './api';

/** Draws `figure` into `container` (fills its width; height from the container or the figure size). */
export function render(container: HTMLElement, figure: Figure, options: RenderOptions = {}): ChartHandle {
  return new Chart(container, figure, options);
}

/** Standalone SVG document (publication preset unless asked otherwise). */
export function toSvg(figure: Figure, options: ExportOptions = {}): string {
  return svgString(figure, options, () => screenTheme(document.body, figure));
}

/** PDF bytes with vector text (via jsPDF + svg2pdf.js). */
export async function toPdf(figure: Figure, options: ExportOptions = {}): Promise<Uint8Array> {
  return pdfBytes(figure, options);
}

/** PNG bytes at options.dpi (default 600). */
export async function toPng(figure: Figure, options: ExportOptions = {}): Promise<Uint8Array> {
  return pngBytes(figure, options);
}

/** Values as CSV: one x column per distinct x array, then the series' y / lo / hi columns. */
export function toCsv(figure: Figure): string {
  return buildCsv(figure);
}

/**
 * Toolbar for a chart card: Screen / Publication switch, journal size picker,
 * export menu (SVG, PDF, PNG 300/600 dpi, CSV, copy PNG), Send to report.
 */
export function figureToolbar(options: FigureToolbarOptions): HTMLElement {
  return buildToolbar(options);
}
