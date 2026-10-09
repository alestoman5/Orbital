import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { host } from '../../src/studio/tabs/spectra/host';
import { SIGMA_PREFACTOR_EV_CM2, SIGMA_PREFACTOR_SI, broadenCrossSection, energyGrid, StateStick } from '../../src/studio/tabs/spectra/crossSection';
import { autoRange, curvesCsv, Curve } from '../../src/studio/tabs/spectra/analysis';
import { clearCaches, globToRegExp, spectrumStem } from '../../src/studio/tabs/spectra/sources';
import { trapezoid } from '../../src/chem/spectrumSets';
import type { AddFilesResult, CsvResult, LibraryResult, LoadResult, StatsResult } from '../../src/studio/tabs/spectra/types';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'spectra');
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const GLE = 'gle-augccpVDZ_adc3-augccpVDZ_n1000';
const CLASSICAL = 'classical-augccpVDZ_adc3-augccpVDZ_n1000';
const PIGLE = 'pigle-augccpVDZ_adc3-augccpVDZ_n1000';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

interface Fake {
  ctx: HostContext;
  log: string[];
  saved: { defaultName: string; data: string }[];
}

function fakeContext(workspace: string, settings: Record<string, unknown> = {}): Fake {
  const log: string[] = [];
  const saved: { defaultName: string; data: string }[] = [];
  const ctx: HostContext = {
    tab: 'spectra',
    extensionPath: '.',
    workspaceFolders: () => [workspace],
    storageDir: () => undefined,
    config: <T>(k: string, fallback: T) => (k in settings ? (settings[k] as T) : fallback),
    findFiles: async (include, o = {}) => {
      const base = o.base ?? workspace;
      const re = globToRegExp(include);
      const hits = walk(base).filter(f => re.test(path.relative(base, f).replace(/\\/g, '/')));
      return (o.max ? hits.slice(0, o.max) : hits).sort();
    },
    watch: (g: string) => {
      log.push(`watch ${g}`);
      return { dispose: () => log.push(`unwatch ${g}`) };
    },
    post: (name, payload) => log.push(`post ${name} ${JSON.stringify(payload)}`),
    navigate: tab => log.push(`navigate ${tab}`),
    saveFile: async p => {
      saved.push({ defaultName: p.defaultName, data: p.data });
      return `${workspace}/${p.defaultName}`;
    },
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    log: m => log.push(m)
  };
  return { ctx, log, saved };
}

const SETTINGS = { 'studio.spectraGlobs': ['*_n1000.dat'], 'studio.experimentGlobs': ['CH2OO_*.dat'] };
const call = <T>(m: string, params: unknown, ctx: HostContext) => host.methods[m](params, ctx) as Promise<T>;
const fileId = (stem: string) => `file:${path.join(FIX, `${stem}.dat`)}`;
const close = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-300);

// ORCA 6 style excitation table
function orcaOut(rows: [number, number][], terminated = true): string {
  const lines = [
    '----------------------------------------------------------------------------------------------------',
    '                     ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS',
    '----------------------------------------------------------------------------------------------------',
    '     Transition      Energy     Energy  Wavelength fosc(D2)      D2        DX        DY        DZ',
    '                      (eV)      (cm-1)    (nm)                 (au**2)    (au)      (au)      (au)',
    '----------------------------------------------------------------------------------------------------',
    ...rows.map(([e, f], i) => `  0-1A  ->  ${i + 1}-1A    ${e.toFixed(6)}   ${(e * 8065.544).toFixed(1)}   ${(1239.842 / e).toFixed(1)}   ${f.toFixed(9)}   0.10000   0.10000   0.00000   0.00000`),
    '',
    terminated ? '                             ****ORCA TERMINATED NORMALLY****' : ''
  ];
  return lines.join('\n');
}

describe('spectra: cross-section prefactor', () => {
  it('is π e² ħ / (2 m_e c ε₀) = 1.0976e-16 eV cm²', () => {
    assert.ok(close(SIGMA_PREFACTOR_SI, 1.7585648847930512e-39, 1e-12));
    assert.ok(close(SIGMA_PREFACTOR_EV_CM2, 1.0976098686463875e-16, 1e-12));
  });

  it('matches the PyNEAppLES COEFF·|μ|²·ΔE with |μ|² = 3f/(2ΔE[Eh])', () => {
    const EPS = 8.854188e-12;
    const HPRIME = 6.62607e-34 / (2 * Math.PI);
    const AU = 8.478354e-30;
    const COEFF = (Math.PI * AU ** 2 * 1e4) / (3 * HPRIME * EPS * 299792458);
    const perF = COEFF * 1.5 * 27.211396; // ΔE cancels: COEFF·(3f/(2ΔE/27.211396))·ΔE
    assert.ok(close(perF, SIGMA_PREFACTOR_EV_CM2, 1e-5), `${perF} vs ${SIGMA_PREFACTOR_EV_CM2}`);
  });

  it('∫σ dE = prefactor · Σf / N (exact sum)', () => {
    const sticks: StateStick[] = [
      { energyEv: 3.4, weight: 0.002, state: 0 }, { energyEv: 3.9, weight: 0.1, state: 1 },
      { energyEv: 3.5, weight: 0.004, state: 0 }, { energyEv: 4.1, weight: 0.12, state: 1 }
    ];
    const h = 0.2;
    const grid = energyGrid(sticks, h, 2000);
    const b = broadenCrossSection(sticks, grid, h, 2);
    const sumF = sticks.reduce((a, s) => a + s.weight, 0);
    const integral = trapezoid(b.total, b.energy);
    assert.ok(close(integral, (SIGMA_PREFACTOR_EV_CM2 * sumF) / 2, 1e-6), `${integral}`);
    // states add up to the total
    const s = b.total.map((_, i) => b.states[0][i] + b.states[1][i]);
    assert.ok(s.every((v, i) => close(v, b.total[i], 1e-12)));
    // relative scale: f per eV
    const rel = broadenCrossSection(sticks, grid, h, 2, 'relative');
    assert.ok(close(trapezoid(rel.total, rel.energy), sumF / 2, 1e-6));
    // peak of a single normalized Gaussian
    const one = broadenCrossSection([{ energyEv: 4, weight: 1, state: 0 }], [4], h, 1);
    assert.ok(close(one.total[0], SIGMA_PREFACTOR_EV_CM2 / (h * Math.sqrt(2 * Math.PI)), 1e-12));
  });

  it('binned broadening of a large ensemble keeps the integral and the shape', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sticks: StateStick[] = [];
    const N = 20000;
    for (let i = 0; i < N; i++) {
      sticks.push({ energyEv: 3.7 + 0.3 * (rnd() - 0.5), weight: 0.1 * rnd(), state: 0 });
      sticks.push({ energyEv: 5.5 + 0.4 * (rnd() - 0.5), weight: 0.02 * rnd(), state: 1 });
    }
    const h = 0.08;
    const grid = energyGrid(sticks, h, 2000);
    const binned = broadenCrossSection(sticks, grid, h, N); // 40 000 sticks × 2000 > 2e7 → binned path
    const sumF = sticks.reduce((a, s) => a + s.weight, 0);
    assert.ok(close(trapezoid(binned.total, binned.energy), (SIGMA_PREFACTOR_EV_CM2 * sumF) / N, 1e-4));
    // exact sum at every 40th grid point
    const peak = Math.max(...binned.total);
    const norm = SIGMA_PREFACTOR_EV_CM2 / (N * h * Math.sqrt(2 * Math.PI));
    for (let i = 0; i < grid.length; i += 40) {
      const exact = sticks.reduce((a, s) => a + s.weight * Math.exp(-((grid[i] - s.energyEv) ** 2) / (2 * h * h)), 0) * norm;
      assert.ok(Math.abs(exact - binned.total[i]) <= 2e-3 * peak, `${i}: ${exact} vs ${binned.total[i]}`);
    }
  });

  it('rejects h <= 0', () => {
    assert.throws(() => broadenCrossSection([], [1, 2], 0, 1), /h must be > 0/);
  });
});

describe('spectra: helpers', () => {
  it('strips PyNEAppLES suffixes from stems', () => {
    assert.strictEqual(spectrumStem('/a/absspec.wigner_x.n1000.nm.cross.dat'), 'absspec.wigner_x.n1000');
    assert.strictEqual(spectrumStem('/a/gle-x_n1000.dat'), 'gle-x_n1000');
  });

  it('turns globs into anchored regular expressions', () => {
    assert.ok(globToRegExp('**/spectra_txt/*.dat').test('05-spectrum/spectra_txt/a.dat'));
    assert.ok(globToRegExp('**/spectra_txt/*.dat').test('spectra_txt/a.dat'));
    assert.ok(!globToRegExp('**/spectra_txt/*.dat').test('spectra_txt/sub/a.dat'));
    assert.ok(globToRegExp('**/*_exp.{dat,txt}').test('x/y_exp.txt'));
  });

  it('automatic range covers the signal region, rounded', () => {
    const x = Array.from({ length: 301 }, (_, i) => 200 + i);
    const c: Curve = { id: 'a', label: 'a', kind: 'nea', x, y: x.map(v => Math.exp(-(((v - 340) / 20) ** 2))), states: [] };
    const [a, b] = autoRange([c], 'nm');
    assert.ok(a <= 300 && a >= 270 && b >= 380 && b <= 410, `${a} ${b}`);
    assert.strictEqual(a % 10, 0);
  });

  it('CSV leaves cells outside a curve empty', () => {
    const c: Curve = { id: 'a', label: 'a,b', kind: 'exp', x: [300, 310], y: [1, 3], states: [] };
    const out = curvesCsv([c], 'nm', [298, 312], 2);
    const lines = out.text.trim().split('\n');
    assert.strictEqual(lines[0], 'wavelength_nm,a b:total');
    assert.strictEqual(lines[1], '2.980000000000000000e+02,');
    assert.strictEqual(lines[3], '3.020000000000000000e+02,1.399999999999999911e+00');
    assert.strictEqual(out.rows, 8);
  });
});

describe('spectra host: library, load, stats, csv', () => {
  beforeEach(() => clearCaches());

  it('finds NEA files and the experiment, with name fields', async () => {
    const { ctx } = fakeContext(FIX, SETTINGS);
    const lib = await call<LibraryResult>('library', {}, ctx);
    assert.deepStrictEqual(lib.fieldNames, ['sampling', 'geometry', 'method', 'basis', 'n']);
    const byName = Object.fromEntries(lib.items.map(i => [i.name, i]));
    assert.strictEqual(lib.items.length, 4);
    for (const s of [GLE, CLASSICAL, PIGLE]) {
      assert.strictEqual(byName[s].kind, 'nea');
      assert.ok(byName[s].hasCi);
      assert.strictEqual(byName[s].nStates, 2);
      assert.strictEqual(byName[s].xUnit, 'nm');
    }
    assert.deepStrictEqual(byName[GLE].fields, { name: GLE, sampling: 'gle', geometry: 'augccpVDZ', method: 'adc3', basis: 'augccpVDZ', n: '1000' });
    assert.strictEqual(byName.CH2OO_Ting.kind, 'exp');
    assert.strictEqual(byName.CH2OO_Ting.error, undefined);
  });

  it('reports an invalid name pattern instead of failing', async () => {
    const { ctx } = fakeContext(FIX, { ...SETTINGS, 'studio.spectrumNamePattern': '(?<a>' });
    const lib = await call<LibraryResult>('library', {}, ctx);
    assert.strictEqual(lib.items.length, 4);
    assert.match(lib.warnings.join(), /not a valid regular expression/);
    assert.deepStrictEqual(lib.fieldNames, []);
  });

  it('band statistics and consistency match uv-vis spectra.py', async () => {
    const { ctx } = fakeContext(FIX, SETTINGS);
    const st = await call<StatsResult>('stats', { ids: [GLE, CLASSICAL, PIGLE].map(fileId), refId: fileId(GLE), axis: 'nm', range: [250, 500] }, ctx);
    assert.deepStrictEqual(st.window, [250, 500]);
    assert.strictEqual(st.thresholdPct, 80);
    for (const row of st.rows) {
      const e = expected.spectra[row.label].band;
      assert.ok(close(row.xmax, e.lmax, 1e-12), row.label);
      assert.ok(close(row.peak, e.peak, 1e-12));
      assert.ok(close(row.centroid, e.centroid, 1e-9));
      assert.ok(close(row.integral, e.integral, 1e-9));
      // interpolated FWHM: within one grid spacing of the grid-limited one
      assert.ok(Math.abs(row.fwhm - e.fwhm) < 3, `${row.fwhm} vs ${e.fwhm}`);
    }
    const ref = st.rows.find(r => r.isRef)!;
    assert.strictEqual(ref.label, GLE);
    for (const other of [CLASSICAL, PIGLE]) {
      const row = st.rows.find(r => r.label === other)!;
      const e = expected.compare.find((c: any) => c.ref === GLE && c.other === other && c.confidence === 0.95);
      assert.ok(close(row.consistentPct! / 100, e.consistent_frac, 1e-12));
      assert.ok(close(row.shift!, e.shift_nm, 1e-9));
    }
    assert.strictEqual(st.rows.find(r => r.label === CLASSICAL)!.verdict, 'different');
    assert.strictEqual(st.rows.find(r => r.label === PIGLE)!.verdict, 'same within noise');
  });

  it('max/exp uses the experiment peak in the window', async () => {
    const { ctx } = fakeContext(FIX, SETTINGS);
    const ting = `file:${path.join(FIX, 'CH2OO_Ting.dat')}`;
    const st = await call<StatsResult>('stats', { ids: [fileId(GLE), ting], experiment: [ting], axis: 'nm', range: [250, 500] }, ctx);
    const gle = st.rows.find(r => r.label === GLE)!;
    assert.ok(close(gle.maxOverExp!, expected.spectra[GLE].band.peak / expected.experiment.peak, 1e-12));
    assert.strictEqual(st.experimentLabel, 'CH2OO_Ting');
    const exp = st.rows.find(r => r.kind === 'exp')!;
    assert.ok(close(exp.xmax, expected.experiment.band.lmax, 1e-12));
  });

  it('load gives downsampled series, an automatic window and differences', async () => {
    const { ctx } = fakeContext(FIX, SETTINGS);
    const ting = `file:${path.join(FIX, 'CH2OO_Ting.dat')}`;
    const res = await call<LoadResult>('load', {
      ids: [fileId(GLE), fileId(CLASSICAL), ting], experiment: [ting], refId: fileId(GLE), axis: 'nm',
      difference: true, states: true, expScale: 'ref'
    }, ctx);
    assert.deepStrictEqual(res.errors, []);
    assert.ok(res.range[0] >= 200 && res.range[0] <= 260 && res.range[1] >= 450 && res.range[1] <= 700, String(res.range));
    for (const s of res.series) {
      assert.ok(s.x.length <= 2000 && s.x.length > 10);
      assert.ok(s.x.every((v, i) => i === 0 || v > s.x[i - 1]));
    }
    const gle = res.series.find(s => s.label === GLE)!;
    assert.ok(gle.lo && gle.hi && gle.states?.length === 2);
    const exp = res.series.find(s => s.kind === 'exp')!;
    assert.ok(exp.scale! > 1 && exp.scale! < 1.5, String(exp.scale));
    assert.strictEqual(res.difference!.length, 1);
    assert.strictEqual(res.difference![0].x.length, 1000);
    assert.ok(res.difference![0].lo && res.difference![0].hi);
  });

  it('converts to eV and wavenumbers and normalizes', async () => {
    const { ctx } = fakeContext(FIX, SETTINGS);
    const ev = await call<LoadResult>('load', { ids: [fileId(GLE)], axis: 'eV', normalize: true }, ctx);
    const s = ev.series[0];
    assert.ok(Math.abs(Math.max(...s.y) - 1) < 1e-12);
    const peakX = s.x[s.y.indexOf(Math.max(...s.y))];
    assert.ok(Math.abs(peakX - 1239.84198 / expected.spectra[GLE].band.lmax) < 1e-9);
    const cm = await call<StatsResult>('stats', { ids: [fileId(GLE)], axis: 'cm-1', range: [20000, 50000] }, ctx);
    assert.ok(Math.abs(cm.rows[0].xmax - 1e7 / expected.spectra[GLE].band.lmax) < 1);
    const rel = await call<StatsResult>('stats', { ids: [fileId(GLE)], axis: 'nm', range: [250, 500], yScale: 'relative' }, ctx);
    assert.ok(close(rel.rows[0].peak, expected.spectra[GLE].band.peak / SIGMA_PREFACTOR_EV_CM2, 1e-12));
  });

  it('validates parameters and paths', async () => {
    const { ctx } = fakeContext(FIX, SETTINGS);
    await assert.rejects(call('load', { ids: [fileId(GLE)], axis: 'Hz' }, ctx), /axis/);
    await assert.rejects(call('load', { ids: 'x', axis: 'nm' }, ctx), /ids/);
    await assert.rejects(call('load', { ids: [fileId(GLE)], axis: 'nm', range: [500, 200] }, ctx), /range/);
    await assert.rejects(call('load', { ids: [fileId(GLE)], axis: 'nm', h: -1 }, ctx), /h must/);
    const res = await call<LoadResult>('load', { ids: [`file:${path.join(os.tmpdir(), 'nope', 'secret.dat')}`, 'bogus'], axis: 'nm' }, ctx);
    assert.strictEqual(res.series.length, 0);
    assert.match(res.errors[0].message, /outside the workspace/);
    assert.match(res.errors[1].message, /invalid id/);
  });

  it('exports the resampled CSV through saveFile', async () => {
    const { ctx, saved } = fakeContext(FIX, SETTINGS);
    const r = await call<CsvResult>('csv', { ids: [fileId(GLE), fileId(PIGLE)], axis: 'nm', range: [250, 500] }, ctx);
    assert.strictEqual(r.rows, 251);
    assert.strictEqual(r.columns, 7);
    assert.strictEqual(saved[0].defaultName, 'spectra_250-500nm.csv');
    const lines = saved[0].data.trim().split('\n');
    assert.strictEqual(lines[0], `wavelength_nm,${GLE}:total,${GLE}:ci_low,${GLE}:ci_high,${PIGLE}:total,${PIGLE}:ci_low,${PIGLE}:ci_high`);
    assert.strictEqual(lines.length, 252);
  });

  it('watches the globs and posts a debounced changed event', async () => {
    const { ctx, log } = fakeContext(FIX, SETTINGS);
    let fire: ((p: string) => void) | undefined;
    ctx.watch = (g, cb) => {
      log.push(`watch ${g}`);
      fire = cb;
      return { dispose: () => log.push(`unwatch ${g}`) };
    };
    const d = host.activate!(ctx) as { dispose(): void };
    assert.deepStrictEqual(log, ['watch *_n1000.dat', 'watch CH2OO_*.dat']);
    fire!('a');
    fire!('b');
    await new Promise(r => setTimeout(r, 500));
    assert.deepStrictEqual(log.filter(l => l.startsWith('post')), ['post changed {"path":"b"}']);
    d.dispose();
    assert.ok(log.includes('unwatch CH2OO_*.dat'));
  });
});

describe('spectra host: stick sources', () => {
  let tmp: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectra-test-'));
    fs.writeFileSync(path.join(tmp, 'single.out'), orcaOut([[3.4, 0.002], [3.9, 0.1], [5.6, 0.0074]]));
    const outs = path.join(tmp, 'outs');
    fs.mkdirSync(outs);
    fs.writeFileSync(path.join(outs, 'g1.out'), orcaOut([[3.5, 0.01], [4.0, 0.12]]));
    fs.writeFileSync(path.join(outs, 'g2.out'), orcaOut([[3.6, 0.02], [4.1, 0.10]]));
    fs.writeFileSync(path.join(outs, 'g3.out'), orcaOut([[3.6, 0.02]], false));
    const geoms = path.join(tmp, 'ens');
    const results: (object | string | null)[] = [
      { converged: true, excitation_energies_ev: [2.97, 3.73], oscillator_strengths: [4.8e-5, 0.126] },
      { converged: true, excitation_energies_ev: [3.05, 3.81], oscillator_strengths: [6e-5, 0.118] },
      { converged: false },
      '{ broken',
      null
    ];
    results.forEach((r, i) => {
      const d = path.join(geoms, `geom_${String(i + 1).padStart(4, '0')}`);
      fs.mkdirSync(d, { recursive: true });
      if (r !== null) fs.writeFileSync(path.join(d, 'result.json'), typeof r === 'string' ? r : JSON.stringify(r));
    });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => clearCaches());

  it('adds a single .out, a folder of .out files and a geom set', async () => {
    const { ctx } = fakeContext(tmp, { 'spectrum.singleGeometryBandwidth': 0.25 });
    const add = await call<AddFilesResult>('addFiles', { paths: [path.join(tmp, 'single.out'), path.join(tmp, 'outs'), path.join(tmp, 'ens'), path.join(tmp, 'missing.out')] }, ctx);
    assert.strictEqual(add.ids.length, 3);
    assert.strictEqual(add.accepted.length, 3);
    assert.match(add.errors.join(), /missing\.out: does not exist/);
    assert.deepStrictEqual(add.ids.map(i => i.split(':')[0]), ['out', 'outdir', 'geom']);
    const lib = await call<LibraryResult>('library', { extra: add.accepted }, ctx);
    const by = Object.fromEntries(lib.items.map(i => [i.source, i]));
    assert.strictEqual(by.out.kind, 'sticks');
    assert.strictEqual(by.out.nGeometries, 1);
    assert.strictEqual(by.out.nStates, 3);
    assert.strictEqual(by.out.defaultH, 0.25);
    assert.strictEqual(by.outdir.nGeometries, 2);
    assert.strictEqual(by.outdir.skipped, 1);
    assert.strictEqual(by.geom.nGeometries, 2);
    assert.strictEqual(by.geom.skipped, 3);
    assert.ok(by.geom.defaultH === by.geom.silverman && by.geom.silverman! > 0);
  });

  it('broadens sticks into an absolute cross section with the right integral', async () => {
    const { ctx } = fakeContext(tmp);
    const add = await call<AddFilesResult>('addFiles', { paths: [path.join(tmp, 'ens'), path.join(tmp, 'single.out')] }, ctx);
    const [geomId, outId] = add.ids;
    const res = await call<LoadResult>('load', { ids: [geomId, outId], axis: 'eV', range: [0.5, 9], h: 0.15, sticks: true, states: true }, ctx);
    assert.deepStrictEqual(res.errors, []);
    const geom = res.series.find(s => s.id === geomId)!;
    const sumF = 4.8e-5 + 0.126 + 6e-5 + 0.118;
    assert.ok(close(trapezoid(geom.y, geom.x), (SIGMA_PREFACTOR_EV_CM2 * sumF) / 2, 1e-4));
    assert.strictEqual(geom.h, 0.15);
    assert.strictEqual(geom.states!.length, 2);
    assert.strictEqual(geom.sticks!.x.length, 4);
    const single = res.series.find(s => s.id === outId)!;
    assert.ok(close(trapezoid(single.y, single.x), SIGMA_PREFACTOR_EV_CM2 * (0.002 + 0.1 + 0.0074), 1e-4));
    // in nm the sticks move to λ = hc/E and the default h is used
    const nm = await call<LoadResult>('load', { ids: [outId], axis: 'nm', sticks: true }, ctx);
    assert.strictEqual(nm.series[0].h, 0.2);
    assert.ok(nm.series[0].sticks!.x.some(x => Math.abs(x - 1239.84198 / 3.9) < 1e-6));
  });

  it('marks a folder without converged geometries as unreadable', async () => {
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(path.join(bad, 'geom_0001'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'geom_0001', 'result.json'), '');
    const { ctx } = fakeContext(tmp);
    const lib = await call<LibraryResult>('library', { extra: [bad] }, ctx);
    const it = lib.items.find(i => i.source === 'geom')!;
    assert.match(it.error!, /no converged geometry \(1 geom_\* folders: 1 unreadable\)/);
  });
});
