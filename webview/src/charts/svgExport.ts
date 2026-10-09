// Standalone SVG export (DOM-free for the publication preset): physical size in
// pt, concrete colors, text kept as <text> so Illustrator/Inkscape can edit it.

import { JOURNAL_SIZES, type ExportOptions, type Figure, type FigureSize } from './api';
import { buildFigure, svgDocument, type FigureModel } from './figure';
import { PUBLICATION_FONT, publicationTheme, type Theme } from './themes';

let exportCounter = 0;

export function exportSize(figure: Figure, options: ExportOptions = {}): FigureSize {
  const s = options.size ?? figure.size ?? JOURNAL_SIZES['acs-1col'];
  return { widthIn: Math.max(0.5, s.widthIn), heightIn: Math.max(0.5, s.heightIn) };
}

export interface ExportBuild {
  model: FigureModel;
  theme: Theme;
  widthPt: number;
  heightPt: number;
}

/**
 * Builds the figure for export at its physical size (1 user unit = 1 pt).
 * `screenTheme` supplies the theme when the screen preset is asked for.
 */
export function buildForExport(figure: Figure, options: ExportOptions = {}, extra: { pxPerUnit?: number; fontFor?: (cp: number) => string; screenTheme?: () => Theme } = {}): ExportBuild {
  const size = exportSize(figure, options);
  const widthPt = size.widthIn * 72;
  const heightPt = size.heightIn * 72;
  const theme = options.preset === 'screen' && extra.screenTheme ? { ...extra.screenTheme(), crisp: false } : publicationTheme(figure);
  const model = buildFigure(figure, {
    theme,
    width: widthPt,
    height: heightPt,
    pxPerUnit: extra.pxPerUnit ?? 6,
    idPrefix: `ox${++exportCounter}-`,
    background: !options.transparent,
    fontFor: extra.fontFor
  });
  return { model, theme, widthPt, heightPt };
}

const pt = (v: number) => `${Math.round(v * 1000) / 1000}pt`;

export function exportFontFamily(theme: Theme): string {
  return theme.preset === 'publication' && theme.arimo ? PUBLICATION_FONT : theme.fontFamily;
}

/** Standalone SVG document (publication preset unless asked otherwise). */
export function svgString(figure: Figure, options: ExportOptions = {}, screenTheme?: () => Theme): string {
  const b = buildForExport(figure, options, { screenTheme });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svgDocument(b.model, { width: pt(b.widthPt), height: pt(b.heightPt), fontFamily: exportFontFamily(b.theme) })}\n`;
}
