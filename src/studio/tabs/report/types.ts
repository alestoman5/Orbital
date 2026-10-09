// Request / response / event types of the "report" tab, shared by its host side
// (./host.ts) and its webview side (webview/src/tabs/report/). Types only — no
// runtime code, no imports of 'vscode', Node or DOM.

import type { TexDoc } from '../../../report/texDoc';

export type { TexDoc };

export type LatexEngine = 'tectonic' | 'latexmk' | 'pdflatex';

/** report.load result (also what report.reload / a successful save conflict reload returns). */
export interface ReportDoc {
  path: string;
  name: string;
  dir: string;
  doc: TexDoc;
  mtimeMs: number;
  /** <dir>/figures */
  figuresDir: string;
  /** Folders of \graphicspath{{a/}{b/}} relative to dir ('' = the .tex folder itself, always first). */
  graphicsPaths: string[];
  engine: LatexEngine;
  /** A PDF of an earlier compile exists in the build folder. */
  hasPdf: boolean;
}

/** report.save params / result. */
export interface SaveParams {
  path: string;
  doc: TexDoc;
  /** mtimeMs of the version the editor loaded (null = no conflict check). */
  mtimeMs: number | null;
  force?: boolean;
}
export type SaveResponse =
  | { status: 'saved'; mtimeMs: number; backupPath: string | null }
  | { status: 'unchanged'; mtimeMs: number }
  | { status: 'conflict'; mtimeMs: number | null };

export interface LatexError {
  line?: number;
  file?: string;
  message: string;
  context?: string;
}

/** report.compile result. */
export interface CompileResponse {
  ok: boolean;
  engine: LatexEngine;
  log: string;
  errors: (LatexError & { absPath?: string })[];
  hasPdf: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logPath: string | null;
}

/** report.pdf result: the compiled PDF as base64, or null when there is none. */
export type PdfResponse = { data: string; mtimeMs: number; size: number } | null;

export type ImportState = 'new' | 'same' | 'differs';

export interface FigureEntry {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** What to write in \includegraphics{...} for this file. */
  ref: string;
}

export interface ImportableFigure {
  path: string;
  /** Workspace-relative path for display. */
  rel: string;
  name: string;
  state: ImportState;
}

/** report.figures result. */
export interface FiguresResponse {
  figuresDir: string;
  inFolder: FigureEntry[];
  importable: ImportableFigure[];
}

/** report.thumb result. */
export type ThumbResponse =
  | { kind: 'image'; dataUrl: string; path: string }
  | { kind: 'pdf'; data: string; path: string }
  | { kind: 'missing'; tried: string[] }
  | { kind: 'too-large'; path: string; size: number };

/** report.addFigure params / result ("Send to report"). */
export interface AddFigureParams {
  texPath: string;
  doc: TexDoc;
  section: number;
  /** Block index to insert at (default: end of the section). */
  position?: number;
  name: string;
  /** Plain text is escaped; text with a backslash or $ is taken as LaTeX. */
  caption?: string;
  /** e.g. '0.85\\textwidth' */
  width?: string;
  pdf?: string;
  png?: string;
}
export interface AddFigureResponse {
  doc: TexDoc;
  includePath: string;
  files: string[];
  /** Index of the new block in the section. */
  block: number;
}
