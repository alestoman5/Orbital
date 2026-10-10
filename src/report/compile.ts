// Report tab, file side: compile the .tex (tectonic | latexmk | pdflatex), parse LaTeX errors,
// save with mtime conflict detection + timestamped backups, and manage the figures folder.
// Node fs + child_process only (no vscode). Generalized from uv-vis/webapp/v_report.py
// (api_save, api_compile, api_images, api_import).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { killTree } from '../ml/proc';

export type LatexEngine = 'tectonic' | 'latexmk' | 'pdflatex';
export const LATEX_ENGINES: LatexEngine[] = ['tectonic', 'latexmk', 'pdflatex'];

export interface CompileCommand {
  command: string;
  args: string[];
  /** Folder of the .tex: relative \includegraphics / \input paths resolve from here. */
  cwd: string;
}

/**
 * Command line for one engine. The .tex is passed by file name with cwd = its folder (TeX engines
 * cope badly with spaces and backslashes in paths); outDir is absolute.
 *   tectonic  <tex> --outdir <out> --keep-logs
 *   latexmk   -pdf -interaction=nonstopmode -halt-on-error -outdir=<out> <tex>
 *   pdflatex  -interaction=nonstopmode -halt-on-error -output-directory=<out> <tex>   (one pass)
 * `executable` overrides the program (e.g. a full path from a setting).
 */
export function compileCommand(engine: LatexEngine, texPath: string, outDir: string, executable?: string): CompileCommand {
  const tex = path.basename(texPath);
  const cwd = path.dirname(path.resolve(texPath));
  const out = path.resolve(outDir);
  const command = executable || engine;
  switch (engine) {
    case 'tectonic':
      return { command, args: [tex, '--outdir', out, '--keep-logs'], cwd };
    case 'latexmk':
      return { command, args: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', `-outdir=${out}`, tex], cwd };
    case 'pdflatex':
      return { command, args: ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${out}`, tex], cwd };
    default:
      throw new Error(`unknown LaTeX engine: ${String(engine)}`);
  }
}

export interface LatexError {
  /** Source line (from 'l.<n>' or a file:line: message). */
  line?: number;
  /** File named by a file:line: error (tectonic, -file-line-error). */
  file?: string;
  message: string;
  /** Source text at the error ('l.6 An undefined \foobar' -> 'An undefined \foobar'). */
  context?: string;
}

/**
 * Errors of a TeX log (or of tectonic's console output):
 *   '! message' (continued on indented lines) + the 'l.<n> source' line that follows it,
 *   'file.tex:12: message' (-file-line-error) and 'error: file.tex:12: message' (tectonic).
 * The final '! ==> Fatal error occurred' line is dropped, '! Emergency stop.' too when there
 * are other errors.
 */
export function parseLatexLog(log: string): LatexError[] {
  const lines = log.split(/\r?\n/);
  const out: LatexError[] = [];
  const seen = new Set<string>();
  const add = (e: LatexError) => {
    const key = `${e.file ?? ''}:${e.line ?? ''}:${e.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(e); }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bang = /^! (.*)$/.exec(line);
    if (bang) {
      if (/^\s*==> Fatal error occurred/.test(bang[1])) continue;
      let message = bang[1].trim();
      let k = i + 1;
      while (k < lines.length && k <= i + 3 && /^\s+\S/.test(lines[k]) && !/^l\.\d+/.test(lines[k])) {
        message += ' ' + lines[k].trim();
        k++;
      }
      const e: LatexError = { message };
      for (let j = k; j < lines.length && j <= i + 40; j++) {
        if (/^! /.test(lines[j])) break;
        const l = /^l\.(\d+)(?: (.*))?$/.exec(lines[j]);
        if (l) {
          e.line = Number(l[1]);
          const ctx = (l[2] ?? '').trim();
          if (ctx) e.context = ctx;
          break;
        }
      }
      add(e);
      continue;
    }
    const fl = /^(?:error: )?((?:[A-Za-z]:)?[^:\s][^:]*\.(?:tex|sty|cls|bib|bbl|ltx)):(\d+): (.*)$/.exec(line);
    if (fl) add({ file: fl[1], line: Number(fl[2]), message: fl[3].trim() });
  }
  if (out.length > 1) return out.filter(e => e.message !== 'Emergency stop.');
  return out;
}

export interface CompileOptions {
  engine: LatexEngine;
  texPath: string;
  outDir: string;
  /** Default 240 s, as the original. */
  timeoutMs?: number;
  /** Program to run instead of the engine name. */
  executable?: string;
  /** Lines of console output to return (default 80). */
  tailLines?: number;
}

export interface CompileResult {
  ok: boolean;
  /** Last lines of the engine's stdout + stderr (or the reason it did not run). */
  log: string;
  errors: LatexError[];
  /** The PDF when this run produced one (fresh), else null. */
  pdfPath: string | null;
  /** The engine's .log file when there is one. */
  logPath: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function tail(text: string, n: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function freshFile(file: string, since: number): string | null {
  try {
    return fs.statSync(file).mtimeMs >= since - 2000 ? file : null;   // 2 s: coarse file system clocks
  } catch {
    return null;
  }
}

function upToDate(pdf: string, texPath: string): boolean {
  try {
    return fs.statSync(pdf).mtimeMs >= fs.statSync(texPath).mtimeMs;
  } catch {
    return false;
  }
}

/** Compile; never rejects (spawn failures and timeouts come back as ok = false). */
export function runCompile(opts: CompileOptions): Promise<CompileResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 240000;
  const nTail = opts.tailLines ?? 80;
  const base = path.basename(opts.texPath).replace(/\.tex$/i, '');
  const outDir = path.resolve(opts.outDir);
  const pdf = path.join(outDir, `${base}.pdf`);
  const logFile = path.join(outDir, `${base}.log`);
  let cmd: CompileCommand;
  try {
    cmd = compileCommand(opts.engine, opts.texPath, outDir, opts.executable);
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    const message = (e as Error).message;
    return Promise.resolve({ ok: false, log: message, errors: [{ message }], pdfPath: null, logPath: null,
      exitCode: null, timedOut: false, durationMs: 0 });
  }
  return new Promise(resolve => {
    let output = '';
    let timedOut = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    const finish = (exitCode: number | null, spawnError?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const logPath = freshFile(logFile, t0);
      let errors: LatexError[] = [];
      if (spawnError) {
        const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT';
        const message = missing ? `${cmd.command} not found (install it or set its path)` : spawnError.message;
        errors = [{ message }];
        output += (output ? '\n' : '') + message;
      } else {
        if (logPath) {
          try { errors = parseLatexLog(fs.readFileSync(logPath, 'latin1')); } catch { /* unreadable */ }
        }
        if (!errors.length) errors = parseLatexLog(output);
        if (timedOut) errors.unshift({ message: `compilation timed out after ${Math.round(timeoutMs / 1000)} s` });
      }
      // latexmk exits 0 without rewriting the PDF when it is up to date: accept a PDF newer than the .tex.
      const pdfPath = freshFile(pdf, t0) ?? (exitCode === 0 && upToDate(pdf, opts.texPath) ? pdf : null);
      const ok = !spawnError && !timedOut && exitCode === 0 && pdfPath !== null;
      if (!ok && !errors.length) errors = [{ message: `${cmd.command} exited with code ${exitCode}` }];
      resolve({ ok, log: tail(output, nTail), errors: ok ? [] : errors, pdfPath, logPath, exitCode,
        timedOut, durationMs: Date.now() - t0 });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish(null, e as Error);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void killTree(child.pid, 500);
    }, timeoutMs);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', e => finish(null, e));
    child.once('close', code => finish(code));
  });
}

// ------------------------------------------------------------------ save

export type SaveResult =
  | { status: 'saved'; mtimeMs: number; backupPath: string | null }
  | { status: 'unchanged'; mtimeMs: number }
  | { status: 'conflict'; mtimeMs: number | null };

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write via a temp file in the same folder + rename. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Save newText to texPath, as v_report.api_save:
 *   - conflict (nothing written) when the file's mtimeMs differs from expectedMtimeMs (it changed
 *     on disk since it was loaded) or it was deleted, unless opts.force; expectedMtimeMs null =
 *     no check (e.g. a new file);
 *   - unchanged (nothing written, no backup) when the content is already newText;
 *   - else a copy of the current file goes to backupsDir/<name>.<YYYYMMDD-HHMMSS>[-k], then the
 *     new text is written atomically.
 * Text is UTF-8. Returns the new mtimeMs to send back with the next save.
 */
export function saveWithBackup(texPath: string, newText: string, expectedMtimeMs: number | null, backupsDir: string,
  opts: { force?: boolean; now?: Date } = {}): SaveResult {
  let st: fs.Stats | null = null;
  try { st = fs.statSync(texPath); } catch { st = null; }
  if (!opts.force && expectedMtimeMs !== null && (!st || st.mtimeMs !== expectedMtimeMs)) {
    return { status: 'conflict', mtimeMs: st ? st.mtimeMs : null };
  }
  let backupPath: string | null = null;
  if (st) {
    const current = fs.readFileSync(texPath);
    if (current.equals(Buffer.from(newText, 'utf8'))) return { status: 'unchanged', mtimeMs: st.mtimeMs };
    fs.mkdirSync(backupsDir, { recursive: true });
    const base = `${path.basename(texPath)}.${stamp(opts.now)}`;
    backupPath = path.join(backupsDir, base);
    for (let k = 2; fs.existsSync(backupPath); k++) backupPath = path.join(backupsDir, `${base}-${k}`);
    fs.copyFileSync(texPath, backupPath);
  }
  writeFileAtomic(texPath, newText);
  return { status: 'saved', mtimeMs: fs.statSync(texPath).mtimeMs, backupPath };
}

// ------------------------------------------------------------------ figures

export const FIGURE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps'];

export interface FigureInfo { name: string; path: string; size: number; mtimeMs: number }

/** Image files directly in figuresDir (pdf, png, jpg, jpeg, eps), by name. Missing folder -> []. */
export function listFigures(figuresDir: string): FigureInfo[] {
  let names: string[];
  try { names = fs.readdirSync(figuresDir); } catch { return []; }
  const out: FigureInfo[] = [];
  for (const name of names) {
    if (!FIGURE_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
    const p = path.join(figuresDir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ name, path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type ImportState = 'new' | 'same' | 'differs';

/** How src compares with the file of the same name in figuresDir (as v_report.api_images). */
export function figureImportState(src: string, figuresDir: string): ImportState {
  const dest = path.join(figuresDir, path.basename(src));
  if (!fs.existsSync(dest)) return 'new';
  const a = fs.statSync(src), b = fs.statSync(dest);
  if (a.size !== b.size) return 'differs';
  return fs.readFileSync(src).equals(fs.readFileSync(dest)) ? 'same' : 'differs';
}

/**
 * Copy src into figuresDir under its own name. 'new' is copied; 'differs' only with overwrite
 * (the UI asks first); 'same' never.
 */
export function importFigure(src: string, figuresDir: string, opts: { overwrite?: boolean } = {}):
  { name: string; dest: string; state: ImportState; copied: boolean } {
  if (!fs.statSync(src).isFile()) throw new Error(`not a file: ${src}`);
  const name = path.basename(src);
  const dest = path.join(figuresDir, name);
  const state = figureImportState(src, figuresDir);
  const copied = state === 'new' || (state === 'differs' && Boolean(opts.overwrite));
  if (copied) {
    fs.mkdirSync(figuresDir, { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return { name, dest, state, copied };
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Safe file stem: no folders, no extension (.pdf/.png/.svg/.jpg), only [A-Za-z0-9_.-] (others -> '_'),
 * no leading dots, at most 80 chars, never a Windows device name; '' -> 'figure'.
 */
export function sanitizeFigureName(name: string): string {
  let s = String(name ?? '').split(/[\\/]/).pop() ?? '';
  s = s.replace(/\.(pdf|png|svg|jpe?g|eps)$/i, '');
  s = s.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^[._-]+/, '').replace(/[._]+$/, '').slice(0, 80);
  if (!s) s = 'figure';
  if (RESERVED.test(s)) s = '_' + s;
  return s;
}

function decode(data: string, magic: Buffer, kind: string): Buffer {
  const b64 = data.replace(/^data:[^,]*;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) {
    throw new Error(`the ${kind} data is not a ${kind.toUpperCase()} file`);
  }
  return buf;
}

/**
 * Write a chart sent to the report: <figuresDir>/<name>.pdf and/or .png from base64 (data: URLs
 * accepted), overwriting earlier versions. Returns the files and the path to use in
 * \includegraphics (relative to texDir when given, '/' separators; the PDF when there is one).
 */
export function writeFigureFiles(figuresDir: string, name: string, data: { pdf?: string; png?: string }, texDir?: string):
  { base: string; files: string[]; includePath: string } {
  if (!data || (!data.pdf && !data.png)) throw new Error('no figure data (pdf or png)');
  const base = sanitizeFigureName(name);
  const bufs: [string, Buffer][] = [];
  if (data.pdf) bufs.push(['.pdf', decode(data.pdf, Buffer.from('%PDF'), 'pdf')]);
  if (data.png) bufs.push(['.png', decode(data.png, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png')]);
  fs.mkdirSync(figuresDir, { recursive: true });
  const files = bufs.map(([ext, buf]) => {
    const p = path.join(figuresDir, base + ext);
    writeFileAtomic(p, buf);
    return p;
  });
  const main = files[0];
  const includePath = (texDir ? path.relative(texDir, main) : path.basename(main)).split(path.sep).join('/');
  return { base, files, includePath };
}
