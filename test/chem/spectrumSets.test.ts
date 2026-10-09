import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  SAME_THRESHOLD, bandStats, bandStatsInterpolated, compareSpectra, comparisonVerdict, convertSpectrum,
  convertSpectrumAxis, detectXUnit, differenceWithCi, formatE18, interp, normalQuantile, normalizeToMax,
  npLinspace, parseNeaSpectrum, parseSpectrumName, parseTwoColumn, resampleCsv, stepGrid, unitFromFileName,
  NeaSpectrum
} from '../../src/chem/spectrumSets';

const DIR = path.join(__dirname, '..', 'fixtures', 'spectra');
const expected = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const WINDOW: [number, number] = expected.window;

function load(stem: string): NeaSpectrum {
  return parseNeaSpectrum(fs.readFileSync(path.join(DIR, `${stem}.dat`), 'utf8'));
}

function close(actual: number, want: number, rel = 1e-6, what = ''): void {
  const ok = actual === want || Math.abs(actual - want) <= rel * Math.max(Math.abs(want), 1e-300);
  assert.ok(ok, `${what}: ${actual} vs ${want} (rel ${Math.abs(actual - want) / Math.abs(want)})`);
}

describe('chem/spectrumSets', () => {
  describe('parity with scripts/spectra.py', () => {
    it('normalQuantile matches statistics.NormalDist.inv_cdf', () => {
      close(normalQuantile(0.975), expected.z95, 1e-14, 'z95');
      close(normalQuantile(0.95), expected.z90, 1e-14, 'z90');
      close(normalQuantile(0.995), expected.z99, 1e-14, 'z99');
      close(normalQuantile(1e-10), expected.z_tail, 1e-14, 'tail');
      close(normalQuantile(0.3), expected.z_mid, 1e-14, 'mid');
      assert.strictEqual(normalQuantile(0.5), 0);
      assert.ok(Number.isNaN(normalQuantile(1.5)));
    });

    it('reads the spectra like load_spectrum (sorted, all columns)', () => {
      for (const [stem, e] of Object.entries<any>(expected.spectra)) {
        const s = load(stem);
        assert.strictEqual(s.x.length, e.n);
        assert.strictEqual(s.x[0], e.x_first);
        assert.strictEqual(s.x[s.x.length - 1], e.x_last);
        assert.strictEqual(s.states.length, e.ncols - 4);
        assert.strictEqual(s.unit, 'nm');
        assert.strictEqual(s.skipped, 0);
        assert.ok(s.lo && s.hi);
      }
    });

    it('bandStats matches band_stats on 250-500 nm', () => {
      for (const [stem, e] of Object.entries<any>(expected.spectra)) {
        const s = load(stem);
        const b = bandStats(s.x, s.y, WINDOW);
        for (const k of ['lmax', 'peak', 'centroid', 'fwhm', 'integral'] as const) {
          close(b[k], e.band[k], 1e-6, `${stem} ${k}`);
        }
      }
    });

    it('compareSpectra matches compare (consistent_frac exactly)', () => {
      for (const c of expected.compare) {
        const r = compareSpectra(load(c.ref), load(c.other), WINDOW, c.confidence, c.signal_frac);
        const what = `${c.ref} vs ${c.other} @${c.confidence}/${c.signal_frac}`;
        close(r.shift_nm, c.shift_nm, 1e-6, `${what} shift`);
        close(r.max_diff_rel, c.max_diff_rel, 1e-6, `${what} max_diff`);
        close(r.median_ci_half_rel, c.median_ci_half_rel, 1e-6, `${what} ci_half`);
        assert.strictEqual(r.consistent_frac, c.consistent_frac, `${what} consistent_frac`);
      }
    });

    it('differenceWithCi matches draw_diff', () => {
      const grid = npLinspace(WINDOW[0], WINDOW[1], 1000);
      for (const d of expected.diff) {
        const r = differenceWithCi(load(d.ref), load(d.other), grid, 0.95);
        d.idx.forEach((k: number, i: number) => {
          close(r.diff[k], d.diff[i], 1e-9, `diff[${k}]`);
          close(r.lo[k], d.lo[i], 1e-9, `lo[${k}]`);
          close(r.hi[k], d.hi[i], 1e-9, `hi[${k}]`);
        });
      }
    });

    it('parseTwoColumn reproduces load_experiment on CH2OO_Ting.dat', () => {
      const e = parseTwoColumn(fs.readFileSync(path.join(DIR, 'CH2OO_Ting.dat'), 'utf8'), { dropNonPositive: true });
      assert.strictEqual(e.x.length, expected.experiment.n);
      assert.strictEqual(e.x.length + e.dropped, expected.experiment.n_raw);
      assert.strictEqual(e.delimiter, 'tab');
      const b = bandStats(e.x, e.y, WINDOW);
      for (const k of ['lmax', 'peak', 'centroid', 'fwhm', 'integral'] as const) {
        close(b[k], expected.experiment.band[k], 1e-6, `experiment ${k}`);
      }
    });
  });

  it('verdict uses SAME_THRESHOLD', () => {
    assert.strictEqual(SAME_THRESHOLD, expected.same_threshold);
    const base = { shift_nm: 0, max_diff_rel: 0, median_ci_half_rel: 0 };
    assert.strictEqual(comparisonVerdict({ ...base, consistent_frac: 0.8 }), 'same within noise');
    assert.strictEqual(comparisonVerdict({ ...base, consistent_frac: 0.79 }), 'different');
    const gle = load('gle-augccpVDZ_adc3-augccpVDZ_n1000');
    assert.strictEqual(compareSpectra(gle, gle, WINDOW).consistent_frac, 1);
  });

  it('interp has np.interp semantics', () => {
    const x = [1, 2, 4];
    const y = [10, 20, 0];
    assert.deepStrictEqual(interp([0, 1, 1.5, 2, 3, 4, 5], x, y), [10, 10, 15, 20, 10, 0, 0]);
    assert.deepStrictEqual(interp([3, 1.5], x, y), [10, 15]);
  });

  it('parses 2-column spectra, rejects 3 columns, counts malformed lines', () => {
    const s = parseNeaSpectrum('# x y\n3 30\n1 10\nbad line\n2 20 5\n2 20\n');
    assert.deepStrictEqual(s.x, [1, 2, 3]);
    assert.deepStrictEqual(s.y, [10, 20, 30]);
    assert.strictEqual(s.lo, undefined);
    assert.strictEqual(s.skipped, 2);
    assert.throws(() => parseNeaSpectrum('1 2 3\n'), /3-column/);
    assert.strictEqual(parseNeaSpectrum('1 2\n', { unit: 'eV' }).unit, 'eV');
  });

  it('detects the x unit', () => {
    assert.strictEqual(detectXUnit([2, 3, 6]), 'eV');
    assert.strictEqual(detectXUnit([200, 600, 2000]), 'nm');
    assert.strictEqual(detectXUnit([20000, 40000, 60000]), 'cm-1');
    assert.strictEqual(unitFromFileName('absspec.adc3.nm.cross.dat'), 'nm');
    assert.strictEqual(unitFromFileName('absspec.adc3.ev.cross.dat'), 'eV');
    assert.strictEqual(unitFromFileName('spectrum.dat'), undefined);
  });

  it('parseTwoColumn handles delimiters, headers and decimal commas', () => {
    const semi = parseTwoColumn('wavelength;sigma\n300,5;1,5E-18\n250,0;-1\n310;2\n');
    assert.strictEqual(semi.delimiter, ';');
    assert.deepStrictEqual(semi.header, ['wavelength;sigma']);
    assert.deepStrictEqual(semi.x, [250, 300.5, 310]);
    assert.deepStrictEqual(semi.y, [-1, 1.5e-18, 2]);
    const csv = parseTwoColumn('x,y\r\n1,2\r\n3,oops\r\n0,1,9\r\n', { dropNonPositive: true });
    assert.strictEqual(csv.delimiter, ',');
    assert.deepStrictEqual(csv.x, [0, 1]);
    assert.strictEqual(csv.skipped, 1);
    const ws = parseTwoColumn('% comment\n 1   0\n 2   4\n', { dropNonPositive: true });
    assert.deepStrictEqual([ws.x, ws.y, ws.dropped, ws.delimiter], [[2], [4], 1, 'whitespace']);
  });

  it('bandStatsInterpolated interpolates the half-maximum crossings', () => {
    const x = npLinspace(-5, 5, 11);
    const y = x.map(v => Math.exp(-v * v / 2));
    const grid = bandStats(x, y, [-5, 5]);
    const fine = bandStatsInterpolated(x, y, [-5, 5]);
    assert.strictEqual(grid.fwhm, 2);
    assert.ok(Math.abs(fine.fwhm - 2.3548) < 0.1, String(fine.fwhm));
    assert.strictEqual(fine.centroid, grid.centroid);
  });

  it('converts axes keeping x ascending', () => {
    const { x, order } = convertSpectrumAxis([200, 400, 300], 'nm', 'eV');
    assert.deepStrictEqual(order, [1, 2, 0]);
    assert.ok(x[0] < x[1] && x[1] < x[2]);
    close(x[2], 1239.84198 / 200, 1e-12, 'eV');
    const s = convertSpectrum(parseNeaSpectrum('200 1 0 2 1\n400 3 2 4 3\n'), 'eV');
    assert.deepStrictEqual([s.y, s.lo, s.states[0], s.unit], [[3, 1], [2, 0], [3, 1], 'eV']);
  });

  it('normalizeToMax divides all columns by max(total)', () => {
    const n = normalizeToMax(parseNeaSpectrum('1 2 1 3 2\n2 4 3 5 4\n'));
    assert.deepStrictEqual([n.y, n.lo, n.hi, n.states[0]], [[0.5, 1], [0.25, 0.75], [0.75, 1.25], [0.5, 1]]);
  });

  it('resampleCsv writes the data_csv layout', () => {
    const csv = resampleCsv([{ name: 'a', x: [250, 252], y: [0, 2], lo: [0, 1], hi: [0, 3] }, { name: 'b', x: [250, 252], y: [1, 1] }], stepGrid(250, 252));
    const lines = csv.trim().split('\n');
    assert.strictEqual(lines[0], 'wavelength_nm,a:total,a:ci_low,a:ci_high,b:total');
    assert.strictEqual(lines.length, 4);
    assert.strictEqual(lines[2], ['2.510000000000000000e+02', '1.000000000000000000e+00', '5.000000000000000000e-01', '1.500000000000000000e+00', '1.000000000000000000e+00'].join(','));
    assert.strictEqual(formatE18(1.5e-17), '1.500000000000000030e-17'); // same digits as Python '%.18e'
    assert.strictEqual(formatE18(0.1), '1.000000000000000056e-01');
  });

  it('parseSpectrumName splits stems with named groups', () => {
    const pat = '(?<sampling>.+?)-(?<geometry>.+?)_adc3-(?<basis>.+?)_n(?<n>\\d+)$';
    assert.deepStrictEqual(parseSpectrumName('gle-augccpVDZ_adc3-augccpVDZ_n1000', pat), {
      name: 'gle-augccpVDZ_adc3-augccpVDZ_n1000', sampling: 'gle', geometry: 'augccpVDZ', basis: 'augccpVDZ', n: '1000'
    });
    assert.deepStrictEqual(parseSpectrumName('wigner-def2SVPD_adc3-def2SVPD_n5000', pat).basis, 'def2SVPD');
    assert.deepStrictEqual(parseSpectrumName('CH2OO_Ting', pat), { name: 'CH2OO_Ting' });
    assert.deepStrictEqual(parseSpectrumName('anything'), { name: 'anything' });
    assert.throws(() => parseSpectrumName('x', '(?<bad'));
  });
});
