import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v8 from 'v8';
import * as vm from 'vm';
import { parseWatchSpec } from '../../src/chem/geometry';
import {
  TrajectoryCache, autocorrelationTime, commonEdges, countFrames, histogram, histogram2d, kde, kdeBandwidth,
  meanWithError, readFirstFrame, scanTrajectory, summary
} from '../../src/chem/xyzTrajectory';

const DIR = path.join(__dirname, '..', 'fixtures', 'xyz');
const THREE = path.join(DIR, 'three.xyz');
const REORDERED = path.join(DIR, 'reordered.xyz');
const stats = JSON.parse(fs.readFileSync(path.join(DIR, 'stats_expected.json'), 'utf8'));
const { coords } = parseWatchSpec(['O-O: 2-3', 'C-O: 1-2', 'COO: 1-2-3', 'HCOO: 4-1-2-3', 'bad: 2-9']);

function close(a: number, b: number, rel: number, what = ''): void {
  assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-300), `${what}: ${a} vs ${b}`);
}

describe('chem/xyzTrajectory', () => {
  let tmp: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xyztraj-'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads the first frame', () => {
    const f = readFirstFrame(THREE);
    assert.strictEqual(f.natoms, 5);
    assert.deepStrictEqual(f.symbols, ['C', 'O', 'O', 'H', 'H']);
    assert.strictEqual(f.comment, 'frame 1 ICOND 1');
    assert.deepStrictEqual(f.atoms[2], { symbol: 'O', x: 1.87, y: 1.2, z: 0 });
    const empty = path.join(tmp, 'empty.xyz');
    fs.writeFileSync(empty, '');
    assert.throws(() => readFirstFrame(empty), /no complete XYZ frame/);
  });

  it('measures watched coordinates per frame (extra columns, numbered labels)', () => {
    const s = scanTrajectory(THREE, coords);
    assert.strictEqual(s.nFrames, 3);
    assert.strictEqual(s.nSampled, 3);
    assert.strictEqual(s.orderMismatches, 0, 'C1/O2 labels count as C/O');
    assert.deepStrictEqual(s.comments, ['frame 1 ICOND 1', 'frame 2', 'frame 3']);
    close(s.values[0][0], Math.hypot(0.6, 1.2), 1e-12, 'O-O frame 1');
    close(s.values[0][1], Math.hypot(0.6, 1.25, 0.1), 1e-12, 'O-O frame 2');
    close(s.values[1][2], 1.28, 1e-12, 'C-O frame 3');
    assert.ok(s.values[2][0] > 90 && s.values[2][0] < 180);
    assert.ok(Number.isNaN(s.values[4][0]), 'out-of-range index gives NaN');
    assert.strictEqual(s.truncated, false);
    assert.strictEqual(s.incompleteTail, false);
  });

  it('handles CRLF line endings', () => {
    const crlf = path.join(tmp, 'crlf.xyz');
    fs.writeFileSync(crlf, fs.readFileSync(THREE, 'utf8').replace(/\r?\n/g, '\r\n'));
    const s = scanTrajectory(crlf, coords);
    assert.strictEqual(s.nFrames, 3);
    assert.strictEqual(s.comments[1], 'frame 2');
    close(s.values[0][1], Math.hypot(0.6, 1.25, 0.1), 1e-12, 'O-O');
    assert.strictEqual(countFrames(crlf), 3);
    assert.strictEqual(readFirstFrame(crlf).symbols[4], 'H');
  });

  it('flags frames with a different atom order and an incomplete tail', () => {
    const s = scanTrajectory(REORDERED, coords.slice(0, 1));
    assert.strictEqual(s.nFrames, 3);
    assert.strictEqual(s.orderMismatches, 1);
    assert.strictEqual(s.firstMismatchFrame, 1);
    assert.strictEqual(s.incompleteTail, true);
    assert.strictEqual(countFrames(REORDERED), 3);
  });

  it('applies stride and maxFrames', () => {
    const s = scanTrajectory(THREE, coords.slice(0, 1), { stride: 2 });
    assert.strictEqual(s.nSampled, 2);
    assert.strictEqual(s.nFrames, 3);
    close(s.values[0][1], Math.hypot(0.61, 1.3, 0.1), 1e-12, 'frame 3 via stride');
    const m = scanTrajectory(THREE, coords.slice(0, 1), { maxFrames: 2 });
    assert.deepStrictEqual([m.nSampled, m.nFrames, m.truncated], [2, 2, true]);
    const all = scanTrajectory(THREE, coords.slice(0, 1), { maxFrames: 3 });
    assert.strictEqual(all.truncated, false);
  });

  it('caches scans by path, mtime, coordinates and stride (LRU)', () => {
    const cache = new TrajectoryCache(2);
    const a = cache.scan(THREE, coords);
    assert.strictEqual(cache.scan(THREE, coords), a);
    assert.notStrictEqual(cache.scan(THREE, coords, { stride: 2 }), a);
    cache.scan(REORDERED, coords);
    assert.strictEqual(cache.size, 2);
    assert.notStrictEqual(cache.scan(THREE, coords), a, 'evicted');
    const f = path.join(tmp, 'changing.xyz');
    fs.copyFileSync(THREE, f);
    const before = cache.scan(f, coords);
    fs.writeFileSync(f, fs.readFileSync(REORDERED));
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    assert.notStrictEqual(cache.scan(f, coords), before);
  });

  describe('100 000-frame file', function () {
    this.timeout(60000);
    const N = 100000;
    let file: string;
    let expectedOO: Float64Array;
    before(() => {
      file = path.join(tmp, 'big.xyz');
      expectedOO = new Float64Array(N);
      const fd = fs.openSync(file, 'w');
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
      const parts: string[] = [];
      for (let i = 0; i < N; i++) {
        const o1 = [1.27 + 0.05 * rnd(), 0.05 * rnd(), 0.05 * rnd()];
        const o2 = [1.87 + 0.05 * rnd(), 1.2 + 0.05 * rnd(), 0.05 * rnd()];
        const p = (v: number[]) => v.map(c => c.toFixed(12).padStart(18)).join(' ');
        const o1s = o1.map(c => Number(c.toFixed(12)));
        const o2s = o2.map(c => Number(c.toFixed(12)));
        expectedOO[i] = Math.hypot(o2s[0] - o1s[0], o2s[1] - o1s[1], o2s[2] - o1s[2]);
        parts.push(`5\n i = ${i}, time = ${i * 10}\nC ${p([0, 0, 0])}\nO ${p(o1)}\nO ${p(o2)}\nH ${p([-0.54, 0.94, 0])}\nH ${p([-0.54, -0.94, 0])}\n`);
        if (parts.length === 5000) {
          fs.writeSync(fd, parts.join(''));
          parts.length = 0;
        }
      }
      fs.writeSync(fd, parts.join(''));
      fs.closeSync(fd);
    });

    it('streams it fast without holding the file in memory', () => {
      const size = fs.statSync(file).size;
      const t0 = Date.now();
      const s = scanTrajectory(file, coords.slice(0, 3));
      const ms = Date.now() - t0;
      // live heap (after a forced GC) at every chunk of a second scan
      v8.setFlagsFromString('--expose_gc');
      const gc = vm.runInNewContext('gc') as () => void;
      gc();
      const live = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
      const heap0 = live();
      let peak = heap0;
      let progressCalls = 0;
      scanTrajectory(file, coords.slice(0, 3), {
        onProgress: () => {
          progressCalls++;
          gc();
          peak = Math.max(peak, live());
        }
      });
      const growth = peak - heap0;
      assert.strictEqual(s.nFrames, N);
      assert.strictEqual(s.values[0].length, N);
      assert.ok(ms < 3000, `scan took ${ms} ms`);
      console.log(`      100k frames, ${(size / 1e6).toFixed(1)} MB: scan ${ms} ms, live heap growth ${(growth / 1e6).toFixed(1)} MB`);
      assert.ok(progressCalls >= Math.floor(size / (1 << 20)), 'progress per chunk');
      // holding the file (or its lines) would keep more than its size alive; the scan keeps
      // three Float64Arrays (2.4 MB, up to twice that while growing) and a 1 MB buffer
      assert.ok(growth < size / 4, `heap grew ${(growth / 1e6).toFixed(1)} MB for a ${(size / 1e6).toFixed(1)} MB file`);
      let worst = 0;
      for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(s.values[0][i] - expectedOO[i]));
      assert.ok(worst < 1e-12, `max |O-O - direct| = ${worst}`);
      const t1 = Date.now();
      assert.strictEqual(countFrames(file), N);
      assert.ok(Date.now() - t1 < 3000);
    });
  });

  describe('statistics', () => {
    it('histogram matches np.histogram(density=True)', () => {
      const h = histogram(stats.x, { bins: 20, density: true });
      h.edges.forEach((e, i) => close(e, stats.hist.edges[i], 1e-12, `edge ${i}`));
      h.values.forEach((v, i) => close(v, stats.hist.values[i], 1e-9, `bin ${i}`));
      const counts = histogram([1, 2, 2, 3, NaN], { bins: 2 });
      assert.deepStrictEqual(counts, { edges: [1, 2, 3], values: [1, 3] });
      assert.deepStrictEqual(histogram([5, 5], { bins: 1 }).edges, [4.5, 5.5]);
      assert.deepStrictEqual(histogram([0, 10], { bins: 2, range: [0, 4] }).values, [1, 0]);
    });

    it('histogram2d matches np.histogram2d', () => {
      const a = stats.x.slice(0, -1);
      const b = stats.x.slice(1);
      const h = histogram2d(a, b, 6, 4);
      h.edgesA.forEach((e, i) => close(e, stats.hist2d.edgesA[i], 1e-12, `edgeA ${i}`));
      assert.deepStrictEqual(h.counts, stats.hist2d.counts);
    });

    it('commonEdges spans all arrays', () => {
      assert.deepStrictEqual(commonEdges([[1, 2], [0, 3]], 3), [0, 1, 2, 3]);
    });

    it('kde matches scipy.stats.gaussian_kde (Scott, Silverman)', () => {
      const scott = kde(stats.x, stats.grid);
      const silver = kde(stats.x, stats.grid, 'silverman');
      stats.grid.forEach((_: number, i: number) => {
        close(scott[i], stats.kde_scott[i], 1e-9, `scott ${i}`);
        close(silver[i], stats.kde_silverman[i], 1e-9, `silverman ${i}`);
      });
      assert.ok(kdeBandwidth(stats.x, 'silverman') > kdeBandwidth(stats.x, 'scott'));
      const fixed = kde([0], [0], 1);
      close(fixed[0], 1 / Math.sqrt(2 * Math.PI), 1e-15, 'unit kernel');
    });

    it('summary uses the population sd like numpy std', () => {
      const s = summary(stats.x);
      close(s.mean, stats.mean, 1e-12, 'mean');
      close(s.sd, stats.std, 1e-9, 'sd');
      close(s.median, stats.median, 1e-15, 'median');
      assert.strictEqual(s.n, 3000);
      assert.deepStrictEqual(summary([1, NaN, 3]), { n: 2, mean: 2, sd: 1, min: 1, max: 3, median: 2 });
    });

    it('autocorrelationTime and meanWithError match spectra.py', () => {
      close(autocorrelationTime(stats.x), stats.tau, 1e-9, 'tau AR(1)');
      close(autocorrelationTime(stats.white), stats.tau_white, 1e-9, 'tau white');
      close(autocorrelationTime(stats.osc), stats.tau_osc, 1e-9, 'tau oscillating');
      const m = meanWithError(stats.x);
      for (const k of ['mean', 'sd', 'tau', 'se', 'n'] as const) close(m[k], stats.mwe[k], 1e-9, k);
      assert.ok(Number.isNaN(autocorrelationTime([2, 2, 2])));
    });
  });
});
