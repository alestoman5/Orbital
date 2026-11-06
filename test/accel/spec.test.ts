import * as assert from 'assert';
import {
  configToForm, defaultForm, formToConfig, mdEntries, mdLengthPs, runCommand, shellQuote, validateForm, type AccelForm
} from '../../src/accel/spec';

const valid = (): AccelForm => ({ ...defaultForm(), workdir: 'runs/h2co', geometry: '/ws/h2co.xyz' });

describe('accel spec', () => {
  it('accepts the defaults with a geometry and a work directory', () => {
    assert.deepStrictEqual(validateForm(valid()), []);
    const errs = validateForm(defaultForm()).map(e => e.field);
    assert.deepStrictEqual(errs.sort(), ['geometry', 'workdir']);
  });

  it('round-trips form -> accel.json -> form', () => {
    const f = valid();
    f.name = 'h2co';
    f.sampling = { ...f.sampling, kind: 'pigle', beads: 8, gle: 'custom', glePathA: 'A', glePathC: 'C', temperature: 250 };
    f.excited = { ...f.excited, method: 'tda', xc: 'CAM-B3LYP' };
    f.minimum.targetState = 2;
    f.mbtr = { ...f.mbtr, autoRange: false, min: 0.3, max: 1.1 };
    f.krr.alpha = [-9, -3, 7];
    f.spectrum.experiment = 'exp.dat';
    const cfg = formToConfig(f);
    assert.deepStrictEqual(cfg.sampling.md.gle, { A: 'A', C: 'C' });
    assert.deepStrictEqual(cfg.mbtr.range, [0.3, 1.1]);
    assert.deepStrictEqual(cfg.krr.alpha, [-9, -3, 7]);
    assert.strictEqual(cfg.minimum.target_state, 2);
    assert.deepStrictEqual(configToForm(JSON.parse(JSON.stringify(cfg)), f.workdir), f);
  });

  it('maps "auto" settings to the driver defaults', () => {
    const cfg = formToConfig(valid());
    assert.strictEqual(cfg.name, null);
    assert.strictEqual(cfg.minimum.target_state, null);
    assert.strictEqual(cfg.mbtr.range, 'auto');
    assert.strictEqual(cfg.sampling.md.gle, 'auto');
    assert.deepStrictEqual(cfg.krr.gamma_factor, [-2, 1, 7]);
  });

  it('falls back to defaults for missing or broken keys', () => {
    const f = configToForm({ sampling: { kind: 'nonsense' }, krr: { alpha: [1, 2] }, excited: { method: 'cc3' } }, '/w');
    assert.strictEqual(f.sampling.kind, 'wigner');
    assert.deepStrictEqual(f.krr.alpha, defaultForm().krr.alpha);
    assert.strictEqual(f.excited.method, 'adc(3)');
  });

  it('checks MD constraints', () => {
    const f = valid();
    f.sampling.kind = 'gle';
    f.ground.program = 'pyscf';
    f.sampling.equilPs = 1000;
    f.train.n = 10 ** 6;
    const fields = validateForm(f).map(e => e.field);
    assert.ok(fields.includes('ground.program'));
    assert.ok(fields.includes('sampling.equilPs'));
    assert.ok(fields.includes('train.n'));
  });

  it('counts MD entries after equilibration like accel/sampling.py', () => {
    const s = { ...defaultForm().sampling, kind: 'pigle' as const, nsteps: 204000, dt: 20, nwritex: 10, equilPs: 2, beads: 4 };
    assert.ok(Math.abs(mdLengthPs(s) - 98.69) < 0.01);
    // 20400 written steps, ceil(2000 fs / 4.838 fs) = 414 dropped, x 4 beads
    assert.strictEqual(mdEntries(s), (20400 - 414) * 4);
  });

  it('builds the run command with quoting', () => {
    assert.strictEqual(shellQuote("a b'c"), `'a b'\\''c'`);
    assert.strictEqual(runCommand('python', '/u/scripts/accelerated.py', '/w/my run', { until: 'minimum' }),
      `python /u/scripts/accelerated.py run '/w/my run' --until minimum`);
    assert.strictEqual(runCommand('py', 's.py', '/w', { only: 'train', until: 'spectrum', redo: 'train' }), 'py s.py run /w --only train --redo train');
  });
});
