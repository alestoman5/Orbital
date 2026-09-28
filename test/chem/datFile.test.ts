import * as assert from 'assert';
import { linearFit, parseDat } from '../../src/chem/datFile';

describe('chem/datFile: parseDat', () => {
  it('reads an ABIN energies.dat header and columns', () => {
    const t = parseDat([
      ' #        Time[fs] E-potential           E-kinetic     E-Total    E-Total-Avg',
      '           0.48   -0.1894229132E+03    0.6729935766E-02   -0.1894161832E+03   -0.1894161832E+03',
      '           0.97   -0.1894230000E+03    0.6800000000E-02   -0.1894162000E+03   -0.1894161900E+03',
      ''
    ].join('\n'));
    assert.deepStrictEqual(t.columns, ['Time[fs]', 'E-potential', 'E-kinetic', 'E-Total', 'E-Total-Avg']);
    assert.deepStrictEqual(t.data[0], [0.48, 0.97]);
    assert.strictEqual(t.data[1][0], -189.4229132);
    assert.strictEqual(t.skipped, 0);
  });

  it('names columns generically when the header does not match and skips bad rows', () => {
    const t = parseDat('# a b\n1 2 3\n2 x 4\n3 4 5\n4 5\n');
    assert.deepStrictEqual(t.columns, ['x', 'col 2', 'col 3']);
    assert.deepStrictEqual(t.data[2], [3, 5]);
    assert.strictEqual(t.skipped, 2);
  });
});

describe('chem/datFile: linearFit', () => {
  it('recovers an exact line on a sub-range', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const y = [9, 9, 1, 3, 5, 7];
    const f = linearFit(x, y, 2, 6);
    assert.ok(Math.abs(f.slope - 2) < 1e-12);
    assert.ok(Math.abs(f.intercept + 3) < 1e-12);
  });

  it('returns NaN for fewer than two points', () => {
    assert.ok(Number.isNaN(linearFit([1], [1], 0, 1).slope));
  });
});
