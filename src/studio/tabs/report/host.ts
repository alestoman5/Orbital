// Host side of the "report" studio tab: load a .tex into the document model
// (src/report/texDoc.ts), save it back with mtime conflict detection and
// backups, compile it (src/report/compile.ts), serve the PDF and figure
// thumbnails, import figures and write figures sent from other tabs.
// Build output goes to <storageDir>/report-build, backups to
// <storageDir>/report-backups. Never imports 'vscode'.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext, TabHost } from '../../context';
import {
  escapeLatex, figureBlock, insertFigure, parseTex, serializeTex, type TexDoc
} from '../../../report/texDoc';
import {
  figureImportState, importFigure, LATEX_ENGINES, listFigures, runCompile, sanitizeFigureName, saveWithBackup,
  writeFigureFiles
} from '../../../report/compile';
import { isInside, rememberPicked, resolveUserPath } from '../ml/paths';
import type {
  AddFigureParams, AddFigureResponse, CompileResponse, FigureEntry, FiguresResponse, LatexEngine, PdfResponse,
  ReportDoc, SaveParams, SaveResponse, ThumbResponse
} from './types';

const MAX_THUMB_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 60 * 1024 * 1024;

export function engineOf(ctx: HostContext): LatexEngine {
  const e = ctx.config<string>('studio.latexEngine', 'latexmk');
  return (LATEX_ENGINES as string[]).includes(e) ? (e as LatexEngine) : 'latexmk';
}

function storageOr(ctx: HostContext, sub: string): string {
  const s = ctx.storageDir();
  return s ? path.join(s, sub) : path.join(os.tmpdir(), 'orbital', sub);
}

/** Build folder of one .tex (several reports do not overwrite each other's PDF). */
export function buildDir(ctx: HostContext, texPath: string): string {
  const stem = path.basename(texPath).replace(/\.tex$/i, '');
  let h = 0;
  for (const ch of path.resolve(texPath).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return path.join(storageOr(ctx, 'report-build'), `${sanitizeFigureName(stem)}-${h.toString(16)}`);
}

function pdfPathOf(ctx: HostContext, texPath: string): string {
  return path.join(buildDir(ctx, texPath), path.basename(texPath).replace(/\.tex$/i, '') + '.pdf');
}

function texPathOf(ctx: HostContext, p: unknown): string {
  const abs = resolveUserPath(ctx, p);
  if (!/\.tex$/i.test(abs)) throw new Error(`not a .tex file: ${abs}`);
  return abs;
}

/** Folders of \graphicspath in the preamble ('' first = the .tex folder). */
export function graphicsPaths(preamble: string): string[] {
  const out = [''];
  const m = /^[^%\n]*\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/m.exec(preamble);
  if (m) {
    for (const g of m[1].matchAll(/\{([^}]*)\}/g)) out.push(g[1].trim());
  }
  return out;
}

/** What to write in \includegraphics for a file in the figures folder. */
export function refFor(file: string, texDir: string, gpaths: string[]): string {
  for (const g of gpaths.slice(1)) {
    const dir = path.resolve(texDir, g);
    if (path.dirname(path.resolve(file)) === dir) return path.basename(file);
  }
  return path.relative(texDir, file).split(path.sep).join('/');
}

/** Candidate files for an \includegraphics argument, as TeX would look them up. */
export function candidates(ref: string, texDir: string, gpaths: string[]): string[] {
  const exts = path.extname(ref) ? [''] : ['.pdf', '.png', '.jpg', '.jpeg', '.eps'];
  const out: string[] = [];
  for (const g of gpaths) {
    for (const e of exts) out.push(path.resolve(texDir, g, ref + e));
  }
  return [...new Set(out)];
}

function load(ctx: HostContext, texPath: string): ReportDoc {
  const st = fs.statSync(texPath);
  const doc = parseTex(fs.readFileSync(texPath, 'utf8'));
  const dir = path.dirname(texPath);
  return {
    path: texPath, name: path.basename(texPath), dir, doc, mtimeMs: st.mtimeMs,
    figuresDir: path.join(dir, 'figures'), graphicsPaths: graphicsPaths(doc.preamble), engine: engineOf(ctx),
    hasPdf: fs.existsSync(pdfPathOf(ctx, texPath))
  };
}

function checkDoc(doc: unknown): TexDoc {
  const d = doc as TexDoc;
  if (!d || typeof d !== 'object' || typeof d.preamble !== 'string' || !Array.isArray(d.sections) || typeof d.end !== 'string') {
    throw new Error('invalid document model');
  }
  return d;
}

/** Plain text captions are escaped; anything with a backslash or $ is taken as LaTeX. */
export function captionTex(caption: string | undefined): string {
  const c = (caption ?? '').trim();
  return /[\\$]/.test(c) ? c : escapeLatex(c);
}

export const host: TabHost = {
  id: 'report',
  methods: {
    /** The .tex of the studio.reportFile setting (null when unset). */
    defaultFile(_p: unknown, ctx: HostContext): { path: string | null; engine: LatexEngine } {
      const s = String(ctx.config('studio.reportFile', '') || '').trim();
      let p: string | null = null;
      if (s) {
        p = path.resolve(ctx.workspaceFolders()[0] ?? process.cwd(), s);
        rememberPicked([p]);   // set by the user in their settings
      }
      return { path: p, engine: engineOf(ctx) };
    },

    async pickTex(_p: unknown, ctx: HostContext): Promise<string | null> {
      const got = await ctx.pickFiles({ title: 'Open LaTeX report', canSelectFiles: true, filters: { LaTeX: ['tex'] } });
      if (!got.length) return null;
      rememberPicked(got);
      return got[0];
    },

    /** Workspace .tex files, for the open-report picker. */
    async texFiles(_p: unknown, ctx: HostContext): Promise<string[]> {
      return ctx.findFiles('**/*.tex', { max: 200 });
    },

    load(p: { path: string }, ctx: HostContext): ReportDoc {
      return load(ctx, texPathOf(ctx, p?.path));
    },

    /** Text the model serializes to (preview of what Save writes). */
    serialize(p: { doc: TexDoc }): string {
      return serializeTex(checkDoc(p?.doc));
    },

    save(p: SaveParams, ctx: HostContext): SaveResponse {
      const texPath = texPathOf(ctx, p?.path);
      const text = serializeTex(checkDoc(p.doc));
      const expected = typeof p.mtimeMs === 'number' ? p.mtimeMs : null;
      const r = saveWithBackup(texPath, text, expected, storageOr(ctx, 'report-backups'), { force: Boolean(p.force) });
      if (r.status === 'saved') ctx.log(`report: saved ${texPath}${r.backupPath ? ` (backup ${r.backupPath})` : ''}`);
      return r;
    },

    async compile(p: { path: string }, ctx: HostContext): Promise<CompileResponse> {
      const texPath = texPathOf(ctx, p?.path);
      const engine = engineOf(ctx);
      const timeoutSec = Number(ctx.config('studio.compileTimeoutSec', 240)) || 240;
      const executable = String(ctx.config('studio.latexPath', '') || '').trim() || undefined;
      const outDir = buildDir(ctx, texPath);
      const opts = { engine, texPath, outDir, timeoutMs: timeoutSec * 1000, executable, tailLines: 120 };
      let r = await runCompile(opts);
      if (!r.ok && engine === 'latexmk' && /error in previous invocation/i.test(r.log)) {
        // latexmk refuses to rerun after a failure until a source changes (e.g. a package was
        // installed meanwhile): forget its state and compile once more
        const fdb = path.join(outDir, path.basename(texPath).replace(/\.tex$/i, '') + '.fdb_latexmk');
        try { fs.unlinkSync(fdb); } catch { /* none */ }
        r = await runCompile(opts);
      }
      const dir = path.dirname(texPath);
      return {
        ok: r.ok, engine, log: r.log, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, logPath: r.logPath,
        hasPdf: fs.existsSync(pdfPathOf(ctx, texPath)),
        errors: r.errors.map(e => ({ ...e, absPath: e.line !== undefined ? path.resolve(dir, e.file ?? path.basename(texPath)) : undefined }))
      };
    },

    pdf(p: { path: string }, ctx: HostContext): PdfResponse {
      const file = pdfPathOf(ctx, texPathOf(ctx, p?.path));
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { return null; }
      if (st.size > MAX_PDF_BYTES) throw new Error(`the PDF is too large to preview (${Math.round(st.size / 1e6)} MB)`);
      return { data: fs.readFileSync(file).toString('base64'), mtimeMs: st.mtimeMs, size: st.size };
    },

    /** Open a file of the report (error locations, the log) in an editor. */
    async open(p: { path: string; line?: number; texPath: string }, ctx: HostContext): Promise<void> {
      const texPath = texPathOf(ctx, p?.texPath);
      const roots = [path.dirname(texPath), storageOr(ctx, 'report-build')];
      const file = resolveUserPath(ctx, p?.path, roots);
      await ctx.openFile({ path: file, line: typeof p.line === 'number' ? Math.max(0, p.line) : undefined, beside: true });
    },

    async figures(p: { path: string }, ctx: HostContext): Promise<FiguresResponse> {
      const texPath = texPathOf(ctx, p?.path);
      const dir = path.dirname(texPath);
      const doc = parseTex(fs.readFileSync(texPath, 'utf8'));
      const gp = graphicsPaths(doc.preamble);
      const figuresDir = path.join(dir, 'figures');
      const inFolder: FigureEntry[] = listFigures(figuresDir).map(f => ({ ...f, ref: refFor(f.path, dir, gp) }));
      const globs = ctx.config<string[]>('studio.figureGlobs', ['**/plots/*.{png,pdf}', '**/figures/*.{png,pdf}']);
      const seen = new Set<string>();
      const importable = [];
      const ws = ctx.workspaceFolders()[0];
      for (const g of Array.isArray(globs) ? globs : []) {
        for (const f of await ctx.findFiles(String(g), { max: 400 })) {
          const abs = path.resolve(f);
          if (seen.has(abs) || isInside(abs, figuresDir)) continue;
          seen.add(abs);
          rememberPicked([abs]);
          importable.push({ path: abs, rel: ws ? path.relative(ws, abs).split(path.sep).join('/') : abs, name: path.basename(abs), state: figureImportState(abs, figuresDir) });
        }
      }
      return { figuresDir, inFolder, importable: importable.slice(0, 400) };
    },

    /** Thumbnail of an image: `file` (absolute) or `ref` (an \includegraphics argument of the .tex). */
    thumb(p: { texPath: string; file?: string; ref?: string }, ctx: HostContext): ThumbResponse {
      const texPath = texPathOf(ctx, p?.texPath);
      const dir = path.dirname(texPath);
      let tried: string[];
      if (p.file) {
        tried = [resolveUserPath(ctx, p.file, [dir])];
      } else {
        const ref = String(p.ref ?? '').trim();
        if (!ref) return { kind: 'missing', tried: [] };
        const doc = parseTex(fs.readFileSync(texPath, 'utf8'));
        tried = candidates(ref, dir, graphicsPaths(doc.preamble));
      }
      const file = tried.find(f => fs.existsSync(f) && fs.statSync(f).isFile());
      if (!file) return { kind: 'missing', tried };
      const size = fs.statSync(file).size;
      if (size > MAX_THUMB_BYTES) return { kind: 'too-large', path: file, size };
      const ext = path.extname(file).toLowerCase();
      const data = fs.readFileSync(file).toString('base64');
      if (ext === '.pdf') return { kind: 'pdf', data, path: file };
      const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.svg' ? 'image/svg+xml' : '';
      if (!mime) return { kind: 'missing', tried };
      return { kind: 'image', dataUrl: `data:${mime};base64,${data}`, path: file };
    },

    import(p: { texPath: string; src: string; overwrite?: boolean }, ctx: HostContext) {
      const texPath = texPathOf(ctx, p?.texPath);
      const src = resolveUserPath(ctx, p?.src);
      const figuresDir = path.join(path.dirname(texPath), 'figures');
      const r = importFigure(src, figuresDir, { overwrite: Boolean(p.overwrite) });
      const doc = parseTex(fs.readFileSync(texPath, 'utf8'));
      return { ...r, ref: refFor(r.dest, path.dirname(texPath), graphicsPaths(doc.preamble)) };
    },

    /** Send to report: write the figure files and insert a figure block into the (unsaved) model. */
    addFigure(p: AddFigureParams, ctx: HostContext): AddFigureResponse {
      const texPath = texPathOf(ctx, p?.texPath);
      const doc = checkDoc(p.doc);
      const sec = Number(p.section);
      if (!Number.isInteger(sec) || !doc.sections[sec]) throw new Error(`no section ${p.section}`);
      const dir = path.dirname(texPath);
      const w = writeFigureFiles(path.join(dir, 'figures'), String(p.name ?? ''), { pdf: p.pdf, png: p.png }, dir);
      const gp = graphicsPaths(doc.preamble);
      const ref = refFor(w.files[0], dir, gp);
      const block = figureBlock(ref, captionTex(p.caption), `fig:${w.base}`, String(p.width || '0.85\\textwidth'));
      const at = p.position === undefined || p.position === null ? doc.sections[sec].blocks.length : Number(p.position);
      insertFigure(doc, sec, block, at);
      return { doc, includePath: ref, files: w.files, block: at };
    }
  }
};
