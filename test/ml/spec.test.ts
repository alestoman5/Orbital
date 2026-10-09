import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildConfig,
  defaultForm,
  gridSize,
  MAX_JOBS,
  MlForm,
  parseParams,
  parseValues,
  ParamType,
  pyFloat,
  SPEC,
  targetLabel
} from '../../src/ml/spec';

// Expected outputs recorded from the verbatim v_ml.py functions: test/fixtures/ml/v_ml_parity.py
const PARITY = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/ml/v_ml_parity.json'), 'utf8'));

/** Original web form (v_ml.py shape) -> MlForm. */
function fromOriginal(f: any): MlForm {
  return {
    name: f.name,
    data: { xyz: f.data.xyz, csv: f.data.csv, column: f.data.column, n_mol: f.data.n_mol },
    rep: f.rep, model: f.model, split: f.split, n_jobs: f.n_jobs
  };
}

describe('ml/spec: parseValues parity with v_ml.parse_values', () => {
  for (const c of PARITY.values) {
    it(`${JSON.stringify(c.text)} as ${c.type}`, () => {
      if ('error' in c) {
        assert.throws(() => parseValues(c.text, c.type as ParamType));
      } else {
        assert.deepStrictEqual(parseValues(c.text, c.type as ParamType), c.ok);
      }
    });
  }

  it('rejects what Python float() rejects and non-finite values', () => {
    for (const t of ['0x10', '1e', '', ' ', '1 2', 'inf', 'nan', '1__0']) assert.throws(() => pyFloat(t), t);
    assert.strictEqual(pyFloat(' 1_000.5 '), 1000.5);
    assert.strictEqual(pyFloat('-.5e-3'), -0.0005);
  });
});

describe('ml/spec: buildConfig parity with v_ml.build_config', () => {
  for (const [name, c] of Object.entries<any>(PARITY.configs)) {
    it(name, () => {
      const r = buildConfig(fromOriginal(c.form));
      if ('error' in c) {
        assert.strictEqual(r.config, null);
        assert.ok(r.errors.length > 0);
        return;
      }
      assert.deepStrictEqual(r.errors, []);
      const cfg = r.config!;
      const exp = c.ok;
      assert.strictEqual(cfg.name, exp.name);
      assert.deepStrictEqual(cfg.rep, exp.rep);
      assert.deepStrictEqual(cfg.model, exp.model);
      assert.deepStrictEqual(cfg.split, exp.split);
      assert.strictEqual(cfg.n_jobs, exp.n_jobs);
      assert.strictEqual(cfg.data.n_mol, exp.data.n_mol);
      assert.strictEqual(cfg.data.column, exp.data.column);
    });
  }
});

describe('ml/spec: buildConfig', () => {
  const form = (): MlForm => {
    const f = defaultForm('CM', 'KRR');
    f.data = { xyz: '/d/m.xyz', csv: '/d/y.csv', column: 'E', header: true, n_mol: '' };
    return f;
  };

  it('builds the full schema from the defaults', () => {
    const r = buildConfig(form(), { cacheDir: '/cache' });
    assert.deepStrictEqual(r.config, {
      schema: 1, name: '',
      data: { xyz: '/d/m.xyz', csv: '/d/y.csv', column: 'E', header: true, n_mol: null },
      rep: { name: 'CM', variance: true, scale: true, params: { permutation: 'sorted_l2', n_atoms_max: null } },
      model: { name: 'KRR', grid: false, params: { kernel: 'rbf', alpha: 0.001, gamma: 0.0001 } },
      split: { test_size: 0.2, seed: 42, cv: 5, curve: [] },
      n_jobs: 8, cache_dir: '/cache'
    });
  });

  it('returns structured errors for every bad field', () => {
    const f = form();
    f.data.csv = '';
    f.data.n_mol = '0';
    f.model.params = { kernel: 'poly', alpha: '1,2', gamma: 'x' };
    f.split = { test_size: '-1', seed: '1.5', cv: '1', curve: '10,abc' };
    const r = buildConfig(f);
    assert.strictEqual(r.config, null);
    assert.deepStrictEqual(r.errors.map(e => e.field).sort(), [
      'data.csv', 'data.n_mol', 'model.params.alpha', 'model.params.gamma', 'model.params.kernel',
      'split.curve', 'split.cv', 'split.seed', 'split.test_size'
    ]);
    assert.match(r.errors.find(e => e.field === 'model.params.alpha')!.message, /only allowed in grid search mode/);
  });

  it('checks files through fileExists and clamps n_jobs to maxJobs', () => {
    const f = form();
    f.n_jobs = 64;
    const r = buildConfig(f, { fileExists: p => p.endsWith('.csv') });
    assert.deepStrictEqual(r.errors, [{ field: 'data.xyz', message: 'file not found: /d/m.xyz' }]);
    assert.strictEqual(buildConfig(f).config!.n_jobs, MAX_JOBS);
    assert.strictEqual(buildConfig(f, { maxJobs: 4 }).config!.n_jobs, 4);
  });

  it('precomputed features need a path but no XYZ', () => {
    const f = form();
    f.rep = { name: 'precomputed', params: {}, variance: false, scale: true };
    f.data.xyz = '';
    assert.deepStrictEqual(buildConfig(f).errors.map(e => e.field), ['rep.params.path']);
    f.rep.params = { path: ' /d/X.npy ' };
    const cfg = buildConfig(f).config!;
    assert.deepStrictEqual(cfg.rep, { name: 'precomputed', variance: false, scale: true, params: { path: '/d/X.npy' } });
    assert.strictEqual(cfg.data.xyz, null);
  });

  it('grid search keeps lists; missing params take the SPEC default', () => {
    const f = form();
    f.model = { name: 'GPR', grid: true, params: { length_scale: 'log:0,2,3', alpha: '1e-4,1e-2' } };
    const cfg = buildConfig(f).config!;
    assert.deepStrictEqual(cfg.model.params, { kernel: 'RBF', length_scale: [1, 10, 100], alpha: [0.0001, 0.01], optimize: false });
    assert.strictEqual(gridSize(cfg.model.params), 6);
  });

  it('a headerless CSV needs a column index', () => {
    const f = form();
    f.data.header = false;
    assert.deepStrictEqual(buildConfig(f).errors.map(e => e.field), ['data.column']);
    f.data.column = 2;
    assert.strictEqual(buildConfig(f).config!.data.column, '2');
  });

  it('parseParams: bool truthiness and invalid choice', () => {
    const r = parseParams(SPEC.model.GPR.params, { kernel: 'X', optimize: 'false' }, false);
    assert.deepStrictEqual(r.errors, [{ field: 'params.kernel', message: 'kernel: invalid choice' }]);
    assert.strictEqual(r.params.optimize, false);
    assert.strictEqual(parseParams(SPEC.model.GPR.params, { optimize: true }, false).params.optimize, true);
  });

  it('every SPEC default parses and every method lists its packages', () => {
    for (const group of [SPEC.rep, SPEC.model]) {
      for (const m of Object.values(group)) {
        if (m.name === 'precomputed') continue;
        assert.deepStrictEqual(parseParams(m.params, undefined, false).errors, [], m.name);
        assert.ok(Array.isArray(m.requires));
      }
    }
    assert.strictEqual(targetLabel({ data: { csv: 'C:\\a\\t.csv', column: 'E' } as any }), 't.csv:E');
  });
});
