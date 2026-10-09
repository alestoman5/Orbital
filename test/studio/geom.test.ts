import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { clearCaches, host } from '../../src/studio/tabs/geom/host';
import {
  autoLabel,
  axisFromName,
  combineGlobs,
  decimateMinMax,
  globToRegExp,
  inferBonds,
  shortLabels,
  sketchAtoms
} from '../../src/studio/tabs/geom/analysis';
import type { DatViewResult, DistResult, HistogramPlot, Hist2dPlot, ListResult, MoleculeResult, ParseResult, TracePlot, XyzInfo } from '../../src/studio/tabs/geom/types';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'xyz');

function fakeContext(ws: string[], settings: Record<string, unknown> = {}, log: string[] = [], found: string[] = []): HostContext {
  return {
    tab: 'geom',
    extensionPath: '.',
    workspaceFolders: () => ws,
    storageDir: () => undefined,
    config: <T>(k: string, fallback: T) => (k in settings ? (settings[k] as T) : fallback),
    findFiles: async (include, options) => {
      log.push(`find ${include} exclude=${options?.exclude}`);
      return found;
    },
    watch: () => ({ dispose() {} }),
    post: (name, payload) => log.push(`post ${name} ${JSON.stringify(payload)}`),
    navigate: tab => log.push(`navigate ${tab}`),
    saveFile: async p => p.defaultName,
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    log: m => log.push(m)
  };
}

const call = <T>(method: string, params: unknown, ctx: HostContext) => Promise.resolve().then(() => host.methods[method](params, ctx)) as Promise<T>;

describe('geom tab host', () => {
  let tmp: string;
  let ctx: HostContext;
  const three = path.join(FIXTURES, 'three.xyz');
  const reordered = path.join(FIXTURES, 'reordered.xyz');

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geomtab-'));
    ctx = fakeContext([FIXTURES, tmp]);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => clearCaches());

  describe('coordinates', () => {
    it('parses specs into labelled coordinates with kind, unit and axis label', async () => {
      const r = await call<ParseResult>('parse', { specs: ['O-O: 2-3', 'COO: 1-2-3', 'HCOO: 4-1-2-3', 'bad', 'x: 1'], file: three }, ctx);
      assert.deepStrictEqual(r.coords.map(c => [c.label, c.kind, c.unit, c.axis]), [
        ['O-O', 'bond', 'Å', 'r(O2–O3) / Å'],
        ['COO', 'angle', '°', '∠(C1–O2–O3) / °'],
        ['HCOO', 'dihedral', '°', 'φ(H4–C1–O2–O3) / °']
      ]);
      assert.strictEqual(r.errors.length, 2);
    });

    it('names atoms by index without a reference file', async () => {
      const r = await call<ParseResult>('parse', { specs: ['d: 1 2'] }, ctx);
      assert.strictEqual(r.coords[0].axis, 'r(1–2) / Å');
      assert.strictEqual(autoLabel([2, 3], ['C', 'O', 'O']), 'O2–O3');
    });

    it('rejects paths outside the workspace', async () => {
      await assert.rejects(call('molecule', { path: path.join(path.parse(tmp).root, 'elsewhere', 'nope.xyz') }, ctx), /outside the workspace/);
      await assert.rejects(call('distributions', { files: 'x', specs: [], mode: 'histogram', coord: 0 }, ctx), /list of strings/);
    });
  });

  describe('library', () => {
    it('reports frames, atoms and a truncated tail', async () => {
      const cut = path.join(tmp, 'cut.xyz');
      const text = fs.readFileSync(three, 'utf8');
      fs.writeFileSync(cut, text.slice(0, text.lastIndexOf('O3')));
      const info = await call<XyzInfo[]>('xyzInfo', { paths: [three, cut] }, ctx);
      assert.deepStrictEqual([info[0].frames, info[0].atoms, info[0].incompleteTail], [3, 5, false]);
      assert.deepStrictEqual([info[1].frames, info[1].incompleteTail], [2, true]);
    });

    it('excludes geom_* folders by default and labels files by unique suffix', async () => {
      const log: string[] = [];
      const found = [path.join(tmp, 'a', 'geoms.xyz'), path.join(tmp, 'b', 'geoms.xyz'), path.join(tmp, 'geom_0001', 'x.xyz')];
      found.forEach(f => {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, fs.readFileSync(three));
      });
      const r = await call<ListResult>('listXyz', {}, fakeContext([tmp], {}, log, found));
      assert.deepStrictEqual(r.files.map(f => f.label), ['a/geoms.xyz', 'b/geoms.xyz']);
      assert.ok(log[0].includes('**/geom_*/**') && log[0].includes('**/node_modules/**'), log[0]);
    });

    it('returns the first frame as atoms, bonds and a planar projection', async () => {
      const m = await call<MoleculeResult>('molecule', { path: three }, ctx);
      assert.strictEqual(m.atoms.length, 5);
      assert.deepStrictEqual(m.bonds, [[1, 2], [1, 4], [1, 5], [2, 3]]);
      // planar molecule: no depth
      assert.ok(m.atoms.every(a => Math.abs(a.depth) < 1e-9));
    });
  });

  describe('distributions', () => {
    const oo = [[0.6, 1.2, 0], [0.6, 1.25, 0.1], [0.61, 1.3, -0.1]].map(d => Math.hypot(...d));
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

    it('summarizes every file × coordinate and counts order mismatches', async () => {
      const r = await call<DistResult>('distributions', { files: [three, reordered], specs: ['O-O: 2-3', 'COO: 1-2-3'], mode: 'histogram', coord: 0, bins: 4 }, ctx);
      assert.strictEqual(r.summary.length, 4);
      const s = r.summary[0];
      assert.strictEqual(s.n, 3);
      assert.ok(Math.abs(s.mean - mean(oo)) < 1e-12);
      assert.ok(Math.abs(s.median - oo[1]) < 1e-12);
      assert.ok(Number.isFinite(s.tau) && Number.isFinite(s.sem));
      assert.deepStrictEqual(r.files.map(f => f.orderMismatches > 0), [false, true]);
    });

    it('builds density histograms on common edges with optional KDE', async () => {
      const r = await call<DistResult>('distributions', { files: [three, three], specs: ['O-O: 2-3'], mode: 'histogram', coord: 0, bins: 5, kde: true }, ctx);
      const plot = r.plot as HistogramPlot;
      assert.strictEqual(plot.kind, 'histogram');
      assert.strictEqual(plot.edges.length, 6);
      assert.ok(Math.abs(plot.edges[0] - Math.min(...oo)) < 1e-12 && Math.abs(plot.edges[5] - Math.max(...oo)) < 1e-12);
      const w = plot.edges[1] - plot.edges[0];
      const area = plot.series[0].values.reduce((a, v) => a + v * w, 0);
      assert.ok(Math.abs(area - 1) < 1e-12);
      assert.strictEqual(plot.kde!.grid.length, 400);
      assert.ok(Math.abs(plot.series[0].mean - mean(oo)) < 1e-12);
    });

    it('returns traces against the file frame index (with stride) and a 2D histogram', async () => {
      const t = await call<DistResult>('distributions', { files: [three], specs: ['O-O: 2-3'], mode: 'trace', coord: 0, stride: 2 }, ctx);
      const tr = t.plot as TracePlot;
      assert.deepStrictEqual(tr.series[0].x, [0, 2]);
      assert.ok(Math.abs(tr.series[0].y[1] - oo[2]) < 1e-12);
      const h = await call<DistResult>('distributions', { files: [three], specs: ['O-O: 2-3', 'COO: 1-2-3'], mode: '2d', coord: 0, coord2: 1, bins: 3 }, ctx);
      const p = h.plot as Hist2dPlot;
      assert.strictEqual(p.z.length, 3);
      assert.strictEqual(p.z[0].length, 3);
      let mass = 0;
      p.z.forEach((row, iy) => row.forEach((v, ix) => { mass += v * (p.xEdges[ix + 1] - p.xEdges[ix]) * (p.yEdges[iy + 1] - p.yEdges[iy]); }));
      assert.ok(Math.abs(mass - 1) < 1e-9);
    });

    it('posts progress events and flags out-of-range indices', async () => {
      const log: string[] = [];
      const r = await call<DistResult>('distributions', { files: [three], specs: ['far: 1-9'], mode: 'histogram', coord: 0 }, fakeContext([FIXTURES], {}, log));
      assert.ok(log.some(l => l.startsWith('post progress') && l.includes('"fraction":1')));
      assert.strictEqual(r.files[0].outOfRange, true);
      assert.strictEqual(r.summary[0].n, 0);
    });
  });

  describe('trajectory (.dat)', () => {
    let dat: string;
    before(() => {
      dat = path.join(tmp, 'energies.dat');
      const rows = ['#  Time[fs] E-potential Temperature'];
      for (let i = 0; i < 1001; i++) {
        const t = i * 0.5;
        rows.push(`${t.toFixed(2)} ${(-189.4 + 2e-6 * t + 1e-4 * Math.sin(i)).toExponential(10)} ${300 + 5 * Math.cos(i / 3)}`);
      }
      rows.push('garbage line');
      fs.writeFileSync(dat, rows.join('\n'));
    });

    it('detects numeric column files', async () => {
      const txt = path.join(tmp, 'notes.dat');
      fs.writeFileSync(txt, 'hello world\n');
      const info = await call<any[]>('datInfo', { paths: [dat, txt] }, ctx);
      assert.deepStrictEqual([info[0].ok, info[0].columns, info[0].rows, info[0].skipped], [true, ['Time[fs]', 'E-potential', 'Temperature'], 1001, 1]);
      assert.strictEqual(info[1].ok, false);
    });

    it('reports the slope per ps for an fs time axis, end − start and decimates', async () => {
      const r = await call<DatViewResult>('datView', { path: dat, maxPoints: 200 }, ctx);
      assert.strictEqual(r.xLabel, 't / fs');
      assert.deepStrictEqual(r.series.map(s => s.axis), ['E-potential', 'T / K']);
      const e = r.series[0];
      assert.strictEqual(e.stats.slopeUnit, 'ps');
      assert.ok(Math.abs(e.stats.slope - 2e-3) < 2e-5, String(e.stats.slope));
      assert.ok(Math.abs(e.stats.slopeX * 1000 - e.stats.slope) < 1e-15);
      assert.strictEqual(e.stats.n, 1001);
      assert.ok(e.x.length <= 200 && !r.full);
      assert.ok(Math.abs(e.stats.delta - ((-189.4 + 2e-6 * 500 + 1e-4 * Math.sin(1000)) - (-189.4))) < 1e-8);
    });

    it('restricts statistics to the visible range', async () => {
      const r = await call<DatViewResult>('datView', { path: dat, columns: [2], xMin: 100, xMax: 200 }, ctx);
      assert.strictEqual(r.series.length, 1);
      assert.deepStrictEqual(r.xRange, [100, 200]);
      assert.strictEqual(r.rows, 201);
      assert.ok(r.full);
      assert.strictEqual(r.series[0].x.length, 201);
    });
  });
});

describe('geom analysis helpers', () => {
  it('shortens labels to unique suffixes', () => {
    assert.deepStrictEqual(shortLabels(['/w/MD/CMD/geoms.xyz', '/w/MD/GLE/geoms.xyz', '/w/x/movie.xyz']), ['CMD/geoms.xyz', 'GLE/geoms.xyz', 'movie.xyz']);
  });

  it('combines and matches exclude globs', () => {
    assert.strictEqual(combineGlobs(['**/{node_modules,.git}/**', '**/geom_*/**']), '{**/node_modules/**,**/.git/**,**/geom_*/**}');
    const re = globToRegExp('**/geom_*/**');
    assert.ok(re.test('ens/geom_0001/x.xyz') && re.test('geom_1/a.xyz') && !re.test('MD/geoms.xyz'));
    assert.ok(globToRegExp('**/*.{cross,molar}.dat').test('a/b.nm.cross.dat'));
  });

  it('keeps spikes when decimating', () => {
    const n = 100000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map(i => (i === 61803 ? 9 : Math.sin(i / 1000)));
    const d = decimateMinMax(x, y, 0, n, 1000);
    assert.ok(d.x.length <= 1000);
    assert.ok(d.y.includes(9));
    assert.ok(d.x.every((v, i) => i === 0 || v > d.x[i - 1]));
  });

  it('labels axes from column names', () => {
    assert.strictEqual(axisFromName('Time[fs]'), 't / fs');
    assert.strictEqual(axisFromName('E-pot[eV]'), 'E-pot / eV');
    assert.strictEqual(axisFromName('E-Total'), 'E-Total');
  });

  it('infers bonds and projects a linear molecule onto its axis', () => {
    const atoms = [{ symbol: 'O', x: 0, y: 0, z: 0 }, { symbol: 'C', x: 0, y: 0, z: 1.16 }, { symbol: 'O', x: 0, y: 0, z: 2.32 }];
    assert.deepStrictEqual(inferBonds(atoms), [[1, 2], [2, 3]]);
    const s = sketchAtoms(atoms);
    assert.ok(Math.abs(Math.abs(s[2].px - s[0].px) - 2.32) < 1e-9);
  });
});
