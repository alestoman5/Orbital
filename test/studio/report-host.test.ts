import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { buildDir, candidates, captionTex, graphicsPaths, host, refFor } from '../../src/studio/tabs/report/host';
import { serializeTex } from '../../src/report/texDoc';
import type {
  AddFigureResponse, CompileResponse, FiguresResponse, ReportDoc, SaveResponse, ThumbResponse
} from '../../src/studio/tabs/report/types';

const FIX = path.join(__dirname, '../fixtures/report');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

interface Fake { ctx: HostContext; ws: string; tex: string; log: string[] }

function fake(settings: Record<string, unknown> = {}): Fake {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-rephost-'));
  const dir = path.join(ws, 'report');
  fs.mkdirSync(path.join(dir, 'figures'), { recursive: true });
  const tex = path.join(dir, 'tasks_summary.tex');
  fs.copyFileSync(path.join(FIX, 'tasks_summary.tex'), tex);
  fs.writeFileSync(path.join(dir, 'figures', 'hist_OO.png'), PNG);
  fs.mkdirSync(path.join(ws, 'plots'));
  fs.writeFileSync(path.join(ws, 'plots', 'hist_OO.png'), PNG);
  fs.writeFileSync(path.join(ws, 'plots', 'new.pdf'), PDF);
  const log: string[] = [];
  const ctx: HostContext = {
    tab: 'report',
    extensionPath: '.',
    workspaceFolders: () => [ws],
    storageDir: () => {
      const d = path.join(ws, '.orbital');
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    config: <T>(k: string, fallback: T) => (k in settings ? (settings as any)[k] : fallback),
    findFiles: async glob => (glob.includes('plots') ? [path.join(ws, 'plots', 'hist_OO.png'), path.join(ws, 'plots', 'new.pdf')] : glob.includes('figures') ? [path.join(dir, 'figures', 'hist_OO.png')] : []),
    watch: () => ({ dispose() {} }),
    post: () => undefined,
    navigate: () => undefined,
    saveFile: async () => undefined,
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    log: m => log.push(m)
  };
  return { ctx, ws, tex, log };
}

const call = <T>(f: Fake, method: string, params?: unknown) =>
  Promise.resolve().then(() => host.methods[method](params, f.ctx)) as Promise<T>;

describe('studio report host: helpers', () => {
  it('reads \\graphicspath and resolves figure references like TeX', () => {
    assert.deepStrictEqual(graphicsPaths('\\usepackage{graphicx}\n\\graphicspath{{figures/}{img/}}\n'), ['', 'figures/', 'img/']);
    assert.deepStrictEqual(graphicsPaths('% \\graphicspath{{x/}}\n'), ['']);
    const dir = path.resolve('/r');
    assert.deepStrictEqual(candidates('a.png', dir, ['', 'figures/']), [path.join(dir, 'a.png'), path.join(dir, 'figures', 'a.png')]);
    assert.strictEqual(candidates('a', dir, ['']).length, 5);
    assert.strictEqual(refFor(path.join(dir, 'figures', 'a.pdf'), dir, ['', 'figures/']), 'a.pdf');
    assert.strictEqual(refFor(path.join(dir, 'figures', 'a.pdf'), dir, ['']), 'figures/a.pdf');
  });

  it('escapes plain captions and keeps LaTeX ones', () => {
    assert.strictEqual(captionTex('MAE 5% & more'), 'MAE 5\\% \\& more');
    assert.strictEqual(captionTex('$\\lambda$ / nm'), '$\\lambda$ / nm');
  });
});

describe('studio report host: methods', () => {
  it('loads the .tex into the model', async () => {
    const f = fake();
    const r = await call<ReportDoc>(f, 'load', { path: f.tex });
    assert.strictEqual(r.name, 'tasks_summary.tex');
    assert.ok(r.doc.sections.length >= 5);
    assert.deepStrictEqual(r.graphicsPaths, ['', 'figures/']);
    assert.strictEqual(r.engine, 'latexmk');
    assert.strictEqual(r.hasPdf, false);
    assert.strictEqual(serializeTex(r.doc), fs.readFileSync(f.tex, 'utf8'));
  });

  it('refuses files outside the workspace and non-.tex files', async () => {
    const f = fake();
    await assert.rejects(call(f, 'load', { path: path.join(os.tmpdir(), 'x.tex') }), /outside the workspace/);
    await assert.rejects(call(f, 'load', { path: path.join(f.ws, 'plots', 'new.pdf') }), /not a \.tex/);
  });

  it('saving an untouched model is a no-op (no write, no backup)', async () => {
    const f = fake();
    const before = fs.statSync(f.tex).mtimeMs;
    const r = await call<ReportDoc>(f, 'load', { path: f.tex });
    const doc = JSON.parse(JSON.stringify(r.doc));   // as it travels through postMessage
    const s = await call<SaveResponse>(f, 'save', { path: f.tex, doc, mtimeMs: r.mtimeMs });
    assert.strictEqual(s.status, 'unchanged');
    assert.strictEqual(fs.statSync(f.tex).mtimeMs, before);
    assert.ok(!fs.existsSync(path.join(f.ws, '.orbital', 'report-backups')));
  });

  it('saves an edit with a backup and detects a conflict', async () => {
    const f = fake();
    const original = fs.readFileSync(f.tex, 'utf8');
    const r = await call<ReportDoc>(f, 'load', { path: f.tex });
    r.doc.sections[0].title = 'Renamed task';
    const s = await call<SaveResponse>(f, 'save', { path: f.tex, doc: r.doc, mtimeMs: r.mtimeMs });
    assert.strictEqual(s.status, 'saved');
    const text = fs.readFileSync(f.tex, 'utf8');
    assert.match(text, /\\section\*\{Renamed task\}/);
    assert.strictEqual(text.length, original.length - 'Task 1: Opt+freq PBE, 7 basis sets'.length + 'Renamed task'.length);
    const backups = fs.readdirSync(path.join(f.ws, '.orbital', 'report-backups'));
    assert.strictEqual(backups.length, 1);
    // someone else edits the file: saving with the old mtime is a conflict, force overwrites
    fs.writeFileSync(f.tex, text + '% external\n');
    fs.utimesSync(f.tex, new Date(), new Date(Date.now() + 5000));
    r.doc.sections[0].title = 'Again';
    const c = await call<SaveResponse>(f, 'save', { path: f.tex, doc: r.doc, mtimeMs: (s as any).mtimeMs });
    assert.strictEqual(c.status, 'conflict');
    assert.match(fs.readFileSync(f.tex, 'utf8'), /% external/);
    const forced = await call<SaveResponse>(f, 'save', { path: f.tex, doc: r.doc, mtimeMs: (s as any).mtimeMs, force: true });
    assert.strictEqual(forced.status, 'saved');
    assert.doesNotMatch(fs.readFileSync(f.tex, 'utf8'), /% external/);
  });

  it('writes an incoming figure and inserts a figure block (document stays unsaved)', async () => {
    const f = fake();
    const r = await call<ReportDoc>(f, 'load', { path: f.tex });
    const nBlocks = r.doc.sections[1].blocks.length;
    const res = await call<AddFigureResponse>(f, 'addFigure', {
      texPath: f.tex, doc: r.doc, section: 1, name: 'ML parity: test?', caption: 'Parity, test set (MAE 0.2 eV)',
      pdf: PDF.toString('base64'), png: PNG.toString('base64')
    });
    assert.strictEqual(res.includePath, 'ML_parity_test.pdf');   // \graphicspath{{figures/}}
    assert.deepStrictEqual(res.files.map(p => path.basename(p)), ['ML_parity_test.pdf', 'ML_parity_test.png']);
    assert.ok(fs.existsSync(path.join(path.dirname(f.tex), 'figures', 'ML_parity_test.pdf')));
    const sec = res.doc.sections[1];
    assert.strictEqual(sec.blocks.length, nBlocks + 1);
    assert.strictEqual(res.block, nBlocks);
    const b = sec.blocks[nBlocks] as any;
    assert.deepStrictEqual([b.type, b.path, b.label], ['figure', 'ML_parity_test.pdf', 'fig:ML_parity_test']);
    const text = serializeTex(res.doc);
    assert.match(text, /\\includegraphics\[width=0\.85\\textwidth\]\{ML_parity_test\.pdf\}\n\\caption\{Parity, test set \(MAE 0\.2 eV\)\}/);
    assert.strictEqual(fs.readFileSync(f.tex, 'utf8'), fs.readFileSync(path.join(FIX, 'tasks_summary.tex'), 'utf8'));
    await assert.rejects(call(f, 'addFigure', { texPath: f.tex, doc: r.doc, section: 99, name: 'x', png: PNG.toString('base64') }), /no section/);
    await assert.rejects(call(f, 'addFigure', { texPath: f.tex, doc: r.doc, section: 0, name: 'x', png: PDF.toString('base64') }), /not a PNG/);
  });

  it('lists figures and importable images with their state, imports and thumbnails them', async () => {
    const f = fake();
    const r = await call<FiguresResponse>(f, 'figures', { path: f.tex });
    assert.deepStrictEqual(r.inFolder.map(x => [x.name, x.ref]), [['hist_OO.png', 'hist_OO.png']]);
    assert.deepStrictEqual(r.importable.map(x => [x.rel, x.state]), [['plots/hist_OO.png', 'same'], ['plots/new.pdf', 'new']]);
    const imp = await call<any>(f, 'import', { texPath: f.tex, src: path.join(f.ws, 'plots', 'new.pdf') });
    assert.deepStrictEqual([imp.copied, imp.ref], [true, 'new.pdf']);
    const t1 = await call<ThumbResponse>(f, 'thumb', { texPath: f.tex, ref: 'hist_OO.png' });
    assert.strictEqual(t1.kind, 'image');
    assert.match((t1 as any).dataUrl, /^data:image\/png;base64,iVBOR/);
    const t2 = await call<ThumbResponse>(f, 'thumb', { texPath: f.tex, ref: 'new' });
    assert.strictEqual(t2.kind, 'pdf');
    const t3 = await call<ThumbResponse>(f, 'thumb', { texPath: f.tex, ref: 'nothing.png' });
    assert.strictEqual(t3.kind, 'missing');
  });

  it('compile with a missing engine reports a clean error', async function () {
    this.timeout(20000);
    const f = fake({ 'studio.latexEngine': 'pdflatex', 'studio.latexPath': 'no-such-latex-binary-xyz' });
    const r = await call<CompileResponse>(f, 'compile', { path: f.tex });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.engine, 'pdflatex');
    assert.strictEqual(r.hasPdf, false);
    assert.deepStrictEqual(r.errors.map(e => e.message), ['no-such-latex-binary-xyz not found (install it or set its path)']);
    assert.strictEqual(await call(f, 'pdf', { path: f.tex }), null);
  });

  it('serves the compiled PDF from the build folder', async () => {
    const f = fake();
    const out = buildDir(f.ctx, f.tex);
    assert.ok(out.startsWith(path.join(f.ws, '.orbital', 'report-build')));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'tasks_summary.pdf'), PDF);
    const p = await call<any>(f, 'pdf', { path: f.tex });
    assert.strictEqual(Buffer.from(p.data, 'base64').toString(), PDF.toString());
    assert.strictEqual((await call<ReportDoc>(f, 'load', { path: f.tex })).hasPdf, true);
  });

  it('reads the report file setting', async () => {
    const f = fake({ 'studio.reportFile': 'report/tasks_summary.tex' });
    const r = await call<any>(f, 'defaultFile');
    assert.strictEqual(r.path, f.tex);
  });
});
