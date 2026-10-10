import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  compileCommand,
  figureImportState,
  importFigure,
  listFigures,
  parseLatexLog,
  runCompile,
  sanitizeFigureName,
  saveWithBackup,
  writeFigureFiles
} from '../../src/report/compile';

const FIX = path.join(__dirname, '../fixtures/report');
const HAVE_PDFLATEX = !process.env.ORBITAL_SKIP_LATEX && spawnSync('pdflatex', ['--version'], { windowsHide: true }).status === 0;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-report-'));
}

describe('report/compile: commands', () => {
  it('builds the command line of each engine', () => {
    const tex = path.resolve('/w/report/main.tex');
    const out = path.resolve('/w/.orbital/build');
    assert.deepStrictEqual(compileCommand('latexmk', tex, out), {
      command: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', '-halt-on-error', `-outdir=${out}`, 'main.tex'],
      cwd: path.dirname(tex)
    });
    assert.deepStrictEqual(compileCommand('pdflatex', tex, out).args,
      ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${out}`, 'main.tex']);
    assert.deepStrictEqual(compileCommand('tectonic', tex, out, '/opt/tectonic'),
      { command: '/opt/tectonic', args: ['main.tex', '--outdir', out, '--keep-logs'], cwd: path.dirname(tex) });
    assert.throws(() => compileCommand('lualatex' as never, tex, out), /unknown LaTeX engine/);
  });
});

describe('report/compile: parseLatexLog', () => {
  it('reads a real pdflatex -halt-on-error log (MiKTeX)', () => {
    const errs = parseLatexLog(fs.readFileSync(path.join(FIX, 'pdflatex-halt-on-error.log'), 'latin1'));
    assert.deepStrictEqual(errs, [{ message: 'Undefined control sequence.', line: 6, context: 'An undefined \\foobar' }]);
  });

  it('reads a real pdflatex nonstopmode log with two errors', () => {
    const errs = parseLatexLog(fs.readFileSync(path.join(FIX, 'pdflatex-nonstopmode.log'), 'latin1'));
    assert.deepStrictEqual(errs, [
      { message: 'Undefined control sequence.', line: 6, context: 'An undefined \\foobar' },
      { message: 'Missing $ inserted.', line: 10 }
    ]);
  });

  it('joins continued LaTeX Error lines, drops Emergency stop, reads file:line formats', () => {
    const log = [
      '! LaTeX Error: Unicode character ^^H (U+0008)',
      '               not set up for use with LaTeX.',
      '',
      'See the LaTeX manual or LaTeX Companion for explanation.',
      'l.3 \\begin',
      '! Emergency stop.',
      '<*> ./broken.tex',
      './chapters/intro.tex:12: Undefined control sequence.',
      'error: main.tex:7: Missing $ inserted',
      'C:\\w\\main.tex:9: LaTeX Error: Environment foo undefined.',
      '!  ==> Fatal error occurred, no output PDF file produced!'
    ].join('\r\n');
    assert.deepStrictEqual(parseLatexLog(log), [
      { message: 'LaTeX Error: Unicode character ^^H (U+0008) not set up for use with LaTeX.', line: 3, context: '\\begin' },
      { file: './chapters/intro.tex', line: 12, message: 'Undefined control sequence.' },
      { file: 'main.tex', line: 7, message: 'Missing $ inserted' },
      { file: 'C:\\w\\main.tex', line: 9, message: 'LaTeX Error: Environment foo undefined.' }
    ]);
    assert.deepStrictEqual(parseLatexLog('! Emergency stop.\n'), [{ message: 'Emergency stop.' }]);
    assert.deepStrictEqual(parseLatexLog('all fine\nOutput written on x.pdf\n'), []);
  });
});

describe('report/compile: runCompile with a fake engine', function () {
  this.timeout(30000);
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  // The fake "engine" is node itself: with engine 'tectonic' the first argument is the .tex file,
  // which node runs as a CommonJS script (unknown extensions load as JavaScript).
  const fake = (name: string, js: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, js);
    return p;
  };

  it('ok with a fresh PDF', async () => {
    const tex = fake('good.tex', `const fs=require('fs'),p=require('path');const o=process.argv[3];
      fs.writeFileSync(p.join(o,'good.pdf'),'%PDF-1.5');fs.writeFileSync(p.join(o,'good.log'),'fine');console.log('Output written');`);
    const r = await runCompile({ engine: 'tectonic', texPath: tex, outDir: path.join(dir, 'build'), executable: process.execPath });
    assert.strictEqual(r.ok, true, r.log);
    assert.strictEqual(r.pdfPath, path.join(dir, 'build', 'good.pdf'));
    assert.strictEqual(r.logPath, path.join(dir, 'build', 'good.log'));
    assert.deepStrictEqual([r.errors, r.exitCode, r.timedOut, r.log], [[], 0, false, 'Output written']);
  });

  it('failure: errors from the .log, else from the console output', async () => {
    const tex = fake('bad.tex', `const fs=require('fs'),p=require('path');const o=process.argv[3];
      fs.writeFileSync(p.join(o,'bad.log'),'! Undefined control sequence.\\nl.4 \\\\oops\\n');process.exit(1);`);
    const r = await runCompile({ engine: 'tectonic', texPath: tex, outDir: path.join(dir, 'b'), executable: process.execPath });
    assert.deepStrictEqual([r.ok, r.exitCode, r.pdfPath], [false, 1, null]);
    assert.deepStrictEqual(r.errors, [{ message: 'Undefined control sequence.', line: 4, context: '\\oops' }]);
    const tex2 = fake('bad2.tex', `console.error('error: bad2.tex:3: Undefined control sequence');process.exit(1);`);
    const r2 = await runCompile({ engine: 'tectonic', texPath: tex2, outDir: path.join(dir, 'b'), executable: process.execPath });
    assert.deepStrictEqual(r2.errors, [{ file: 'bad2.tex', line: 3, message: 'Undefined control sequence' }]);
    const tex3 = fake('bad3.tex', 'process.exit(2)');
    const r3 = await runCompile({ engine: 'tectonic', texPath: tex3, outDir: path.join(dir, 'b'), executable: process.execPath });
    assert.match(r3.errors[0].message, /exited with code 2/);
  });

  it('ok when the engine exits 0 and leaves an up-to-date PDF alone (latexmk: nothing to do)', async () => {
    const tex = fake('same.tex', 'console.log("All targets are up-to-date")');
    const out = path.join(dir, 'build');
    fs.mkdirSync(out);
    const old = (Date.now() - 60000) / 1000;
    fs.utimesSync(tex, old - 10, old - 10);
    fs.writeFileSync(path.join(out, 'same.pdf'), '%PDF-1.5');
    fs.utimesSync(path.join(out, 'same.pdf'), old, old);
    const r = await runCompile({ engine: 'tectonic', texPath: tex, outDir: out, executable: process.execPath });
    assert.strictEqual(r.ok, true, r.log);
    fs.utimesSync(tex, old + 5, old + 5);   // .tex newer than the PDF: a stale PDF is not success
    const r2 = await runCompile({ engine: 'tectonic', texPath: tex, outDir: out, executable: process.execPath });
    assert.strictEqual(r2.ok, false);
  });

  it('times out and kills the engine', async () => {
    const tex = fake('slow.tex', 'setTimeout(() => {}, 60000)');
    const r = await runCompile({ engine: 'tectonic', texPath: tex, outDir: path.join(dir, 'b'), executable: process.execPath, timeoutMs: 800 });
    assert.deepStrictEqual([r.ok, r.timedOut], [false, true]);
    assert.match(r.errors[0].message, /timed out/);
    assert.ok(r.durationMs < 15000);
  });

  it('a missing engine is reported, not thrown', async () => {
    const r = await runCompile({ engine: 'pdflatex', texPath: path.join(dir, 'x.tex'), outDir: dir, executable: path.join(dir, 'no-such-engine') });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0].message, /not found/);
  });
});

(HAVE_PDFLATEX ? describe : describe.skip)('report/compile: runCompile with the real pdflatex', function () {
  this.timeout(180000);
  let dir: string;
  before(() => { dir = tmpDir(); });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it('reports the error line of a broken document and builds a good one', async () => {
    fs.copyFileSync(path.join(FIX, 'broken.tex'), path.join(dir, 'broken.tex'));
    const bad = await runCompile({ engine: 'pdflatex', texPath: path.join(dir, 'broken.tex'), outDir: path.join(dir, 'build') });
    assert.strictEqual(bad.ok, false);
    assert.deepStrictEqual(bad.errors[0], { message: 'Undefined control sequence.', line: 6, context: 'An undefined \\foobar' });
    fs.writeFileSync(path.join(dir, 'good.tex'), '\\documentclass{article}\n\\begin{document}\nFine $x^2$.\n\\end{document}\n');
    const good = await runCompile({ engine: 'pdflatex', texPath: path.join(dir, 'good.tex'), outDir: path.join(dir, 'build') });
    assert.strictEqual(good.ok, true, good.log);
    assert.ok(good.pdfPath && fs.readFileSync(good.pdfPath).subarray(0, 4).toString() === '%PDF');
  });
});

describe('report/compile: saveWithBackup', () => {
  let dir: string, tex: string, backups: string;
  beforeEach(() => {
    dir = tmpDir();
    tex = path.join(dir, 'doc.tex');
    backups = path.join(dir, 'backups');
    fs.writeFileSync(tex, 'old\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('unchanged text: no write, no backup', () => {
    const m = fs.statSync(tex).mtimeMs;
    assert.deepStrictEqual(saveWithBackup(tex, 'old\n', m, backups), { status: 'unchanged', mtimeMs: m });
    assert.ok(!fs.existsSync(backups));
  });

  it('saves with a timestamped backup of the previous version', () => {
    const now = new Date(2026, 9, 9, 8, 7, 6);
    const r = saveWithBackup(tex, 'new\n', fs.statSync(tex).mtimeMs, backups, { now });
    assert.strictEqual(r.status, 'saved');
    assert.strictEqual(fs.readFileSync(tex, 'utf8'), 'new\n');
    const b = (r as { backupPath: string }).backupPath;
    assert.strictEqual(path.basename(b), 'doc.tex.20261009-080706');
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'old\n');
    assert.strictEqual(r.mtimeMs, fs.statSync(tex).mtimeMs);
    const r2 = saveWithBackup(tex, 'newer\n', r.mtimeMs!, backups, { now });
    assert.strictEqual(path.basename((r2 as { backupPath: string }).backupPath), 'doc.tex.20261009-080706-2');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['backups', 'doc.tex'], 'no temp files left');
  });

  it('conflict when the file changed on disk; force overwrites', () => {
    const m = fs.statSync(tex).mtimeMs;
    fs.writeFileSync(tex, 'edited elsewhere\n');
    fs.utimesSync(tex, new Date(), new Date(Date.now() + 5000));
    const r = saveWithBackup(tex, 'mine\n', m, backups);
    assert.deepStrictEqual(r, { status: 'conflict', mtimeMs: fs.statSync(tex).mtimeMs });
    assert.strictEqual(fs.readFileSync(tex, 'utf8'), 'edited elsewhere\n');
    const f = saveWithBackup(tex, 'mine\n', m, backups, { force: true });
    assert.strictEqual(f.status, 'saved');
    assert.strictEqual(fs.readFileSync((f as { backupPath: string }).backupPath, 'utf8'), 'edited elsewhere\n');
  });

  it('deleted file is a conflict; expected null creates it', () => {
    fs.unlinkSync(tex);
    assert.deepStrictEqual(saveWithBackup(tex, 'x', 123, backups), { status: 'conflict', mtimeMs: null });
    const r = saveWithBackup(tex, 'x', null, backups);
    assert.deepStrictEqual([r.status, (r as { backupPath: null }).backupPath], ['saved', null]);
    assert.strictEqual(fs.readFileSync(tex, 'utf8'), 'x');
  });
});

describe('report/compile: figures', () => {
  let dir: string, figs: string;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  beforeEach(() => { dir = tmpDir(); figs = path.join(dir, 'report', 'figures'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists image files only, by name; missing folder -> []', () => {
    assert.deepStrictEqual(listFigures(figs), []);
    fs.mkdirSync(figs, { recursive: true });
    for (const n of ['b.png', 'a.PDF', 'notes.txt', 'c.jpg']) fs.writeFileSync(path.join(figs, n), n);
    fs.mkdirSync(path.join(figs, 'sub.png'));
    assert.deepStrictEqual(listFigures(figs).map(f => f.name), ['a.PDF', 'b.png', 'c.jpg']);
    assert.strictEqual(listFigures(figs)[1].size, 5);
  });

  it('imports new / same / differs like api_images', () => {
    const src = path.join(dir, 'plot.png');
    fs.writeFileSync(src, 'one');
    assert.strictEqual(figureImportState(src, figs), 'new');
    assert.deepStrictEqual(importFigure(src, figs), { name: 'plot.png', dest: path.join(figs, 'plot.png'), state: 'new', copied: true });
    assert.strictEqual(importFigure(src, figs).state, 'same');
    fs.writeFileSync(src, 'two');
    assert.deepStrictEqual([importFigure(src, figs).state, importFigure(src, figs).copied], ['differs', false]);
    assert.strictEqual(fs.readFileSync(path.join(figs, 'plot.png'), 'utf8'), 'one');
    assert.strictEqual(importFigure(src, figs, { overwrite: true }).copied, true);
    assert.strictEqual(fs.readFileSync(path.join(figs, 'plot.png'), 'utf8'), 'two');
  });

  it('writes sent charts under a sanitized name', () => {
    const r = writeFigureFiles(figs, '../../evil/UV spectrum: S1 (300 K).svg',
      { pdf: Buffer.from('%PDF-1.4 x').toString('base64'), png: 'data:image/png;base64,' + PNG.toString('base64') },
      path.join(dir, 'report'));
    assert.strictEqual(r.base, 'UV_spectrum_S1_300_K');
    assert.deepStrictEqual(r.files, [path.join(figs, 'UV_spectrum_S1_300_K.pdf'), path.join(figs, 'UV_spectrum_S1_300_K.png')]);
    assert.strictEqual(r.includePath, 'figures/UV_spectrum_S1_300_K.pdf');
    assert.deepStrictEqual(fs.readFileSync(r.files[1]), PNG);
    assert.throws(() => writeFigureFiles(figs, 'x', { pdf: Buffer.from('<html>').toString('base64') }), /not a PDF/);
    assert.throws(() => writeFigureFiles(figs, 'x', {}), /no figure data/);
    assert.strictEqual(writeFigureFiles(figs, 'p', { png: PNG.toString('base64') }).includePath, 'p.png');
  });

  it('sanitizeFigureName', () => {
    assert.strictEqual(sanitizeFigureName(''), 'figure');
    assert.strictEqual(sanitizeFigureName('...'), 'figure');
    assert.strictEqual(sanitizeFigureName('CON'), '_CON');
    assert.strictEqual(sanitizeFigureName('a\\b\\c.d.png'), 'c.d');
    assert.strictEqual(sanitizeFigureName('ü-ñ'), 'figure');
    assert.strictEqual(sanitizeFigureName('x'.repeat(200)).length, 80);
  });
});
