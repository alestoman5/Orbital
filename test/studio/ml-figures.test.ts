import * as assert from 'assert';
import { compareBarsFigure, curveFigure, gridAxis, gridFigure, parityFigure, short, variedParams } from '../../webview/src/tabs/ml/figures';
import { gridSummary, missingFor } from '../../webview/src/tabs/ml/form';
import { defaultForm, SPEC } from '../../src/ml/spec';

const RESULT = {
  n_features: 6, time_features_s: 0, n_train: 4, n_test: 2, time_fit_s: 0, time_predict_s: 0,
  train: { mae: 0.1, rmse: 0.1, r2: 0.99 }, test: { mae: 0.2, rmse: 0.25, r2: 0.95 },
  best_params: { kernel: 'rbf', alpha: 0.001, gamma: 0.01 }
};

describe('studio ml: figures', () => {
  it('formats short numbers', () => {
    assert.deepStrictEqual([short(0.0123456), short(1e-5), short(123456), short('rbf'), short(2)], ['0.0123', '1e-5', '1.23e5', 'rbf', '2']);
  });

  it('parity plot: equal aspect, y = x over the data range, null values dropped', () => {
    const f = parityFigure({ y_train: [1, 2, null], y_train_pred: [1.1, 2.1, 3], y_test: [3], y_test_pred: [2.9] }, RESULT, 'E');
    const p = f.panels[0];
    assert.strictEqual(p.equalAspect, true);
    assert.strictEqual(p.x.min, p.y.min);
    assert.strictEqual((p.series[1] as any).x.length, 2);
    assert.strictEqual(p.series[1].label, 'train (2)');
    assert.match((p.series[3] as any).text, /test MAE = 0\.2/);
  });

  it('learning curves are log-log lines with markers', () => {
    const f = curveFigure([{ label: 'a', curve: [{ n: 10, test_mae: 1 }, { n: 20, test_mae: 0.5 }] }, { curve: [] }]);
    assert.strictEqual(f.panels[0].series.length, 1);
    assert.ok(f.panels[0].x.log && f.panels[0].y.log);
  });

  it('detects log-spaced grid axes and categorical ones', () => {
    const a = gridAxis('alpha', [1e-6, 1e-5, 1e-4, 1e-3]);
    assert.strictEqual(a.log, true);
    assert.deepStrictEqual(a.coords, [-6, -5, -4, -3]);
    assert.strictEqual(a.label, 'log_{10} alpha');
    const l = gridAxis('n', [100, 200, 300]);
    assert.strictEqual(l.log, false);
    const c = gridAxis('kernel', ['rbf', 'laplacian']);
    assert.deepStrictEqual(c.coords, [0, 1]);
    assert.strictEqual(c.format(1), 'laplacian');
  });

  it('grid search: heatmap over two parameters, line over one, null without a grid', () => {
    const grid = [];
    for (const alpha of [1e-3, 1e-2, 1e-1]) for (const gamma of [1e-2, 1e-1]) grid.push({ kernel: 'rbf', alpha, gamma, cv_mae: alpha + gamma });
    assert.deepStrictEqual(variedParams(grid).map(v => v.key), ['alpha', 'gamma']);
    const g = gridFigure({ ...RESULT, grid })!;
    const hm = g.figure.panels[0].series[0] as any;
    assert.strictEqual(hm.type, 'heatmap');
    assert.strictEqual(hm.z.length, 2);          // gamma on y (2 values), alpha on x (3 values)
    assert.strictEqual(hm.z[0].length, 3);
    assert.strictEqual(hm.xEdges.length, 4);
    assert.strictEqual(hm.colorbarLabel, 'CV MAE');
    const one = gridFigure({ ...RESULT, grid: grid.filter(x => x.gamma === 1e-2) })!;
    assert.strictEqual(one.figure.panels[0].series[0].type, 'line');
    assert.strictEqual(gridFigure(RESULT as any), null);
  });

  it('comparison bars leave gaps between runs', () => {
    const f = compareBarsFigure([
      { id: 'a', name: 'A', rep: 'x', model: 'y', test: { mae: 1, rmse: 1, r2: 0 }, cv_mae: null, curve: [] },
      { id: 'b', name: 'B', rep: 'x', model: 'y', test: null, cv_mae: null, curve: [] },
      { id: 'c', name: 'C', rep: 'x', model: 'y', test: { mae: 2, rmse: 2, r2: 0 }, cv_mae: null, curve: [] }
    ]);
    const s = f.panels[0].series[0] as any;
    assert.deepStrictEqual(s.edges, [0.2, 0.8, 1.2, 1.8]);
    assert.deepStrictEqual(s.values, [1, 0, 2]);
    assert.strictEqual(f.panels[0].x.format!(1.5), 'C');
  });
});

describe('studio ml: form helpers', () => {
  it('summarizes the grid size', () => {
    const form = defaultForm('precomputed', 'KRR');
    assert.strictEqual(gridSummary(form), null);
    form.model.grid = true;
    form.model.params = { kernel: 'rbf', alpha: 'log:-6,-1,6', gamma: 'log:-3,1,7' };
    assert.strictEqual(gridSummary(form), '6 × 7 = 42 combinations × 5 folds');
    form.model.params = { kernel: 'rbf', alpha: '1,2,3', gamma: '1' };
    assert.strictEqual(gridSummary(form), '3 combinations × 5 folds');
  });

  it('lists missing optional packages of a method', () => {
    const env = { ok: true, python: '3', packages: { dscribe: null, ase: '3.22' }, missing_required: [] };
    assert.deepStrictEqual(missingFor(SPEC.rep.SOAP, env), ['dscribe']);
    assert.deepStrictEqual(missingFor(SPEC.rep.precomputed, env), []);
    assert.deepStrictEqual(missingFor(SPEC.rep.SOAP, undefined), []);
  });
});
