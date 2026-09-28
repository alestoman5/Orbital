import * as assert from 'assert';
import {
  angle,
  checkAtomOrder,
  checkChargeMultiplicity,
  dihedral,
  distance,
  measure,
  parseWatchSpec
} from '../../src/chem/geometry';
import { atomicNumber } from '../../src/chem/elements';

const P = (x: number, y: number, z: number, symbol = 'X') => ({ symbol, x, y, z });

describe('chem/geometry: internal coordinates', () => {
  it('distance, angle, dihedral', () => {
    assert.strictEqual(distance(P(0, 0, 0), P(3, 4, 0)), 5);
    assert.ok(Math.abs(angle(P(1, 0, 0), P(0, 0, 0), P(0, 1, 0)) - 90) < 1e-12);
    // IUPAC sign: looking along b->c (+z), x rotated onto y is clockwise -> +90
    assert.ok(Math.abs(dihedral(P(1, 0, 0), P(0, 0, 0), P(0, 0, 1), P(0, 1, 1)) - 90) < 1e-9);
    assert.ok(Math.abs(dihedral(P(1, 0, 0), P(0, 0, 0), P(0, 0, 1), P(0, -1, 1)) + 90) < 1e-9);
    assert.ok(Math.abs(Math.abs(dihedral(P(1, 0, 0), P(0, 0, 0), P(0, 0, 1), P(-1, 0, 1))) - 180) < 1e-9);
  });

  it('parses watch specs with 1-based indices and reports bad ones', () => {
    const { coords, errors } = parseWatchSpec(['O-O: 2-3', 'C-O-O: 1 2 3', 'bad', 'x: 0-1']);
    assert.deepStrictEqual(coords, [{ label: 'O-O', atoms: [2, 3] }, { label: 'C-O-O', atoms: [1, 2, 3] }]);
    assert.strictEqual(errors.length, 2);
  });

  it('measures watched coordinates, undefined when out of range', () => {
    const g = [P(0, 0, 0), P(1.5, 0, 0)];
    assert.strictEqual(measure(g, { label: 'b', atoms: [1, 2] }), 1.5);
    assert.strictEqual(measure(g, { label: 'b', atoms: [1, 3] }), undefined);
  });
});

describe('chem/geometry: atom order', () => {
  it('normalizes labels and finds the first mismatch', () => {
    assert.strictEqual(checkAtomOrder(['c', 'O1', 'O', 'H', 'H'], ['C', 'O', 'O', 'H', 'H']), undefined);
    assert.deepStrictEqual(checkAtomOrder(['C', 'O', 'H', 'O', 'H'], ['C', 'O', 'O', 'H', 'H']), { index: 2, found: 'H', expected: 'O' });
    assert.deepStrictEqual(checkAtomOrder(['C', 'O'], ['C', 'O', 'O']), { lengthFound: 2, lengthExpected: 3 });
  });
});

describe('chem/geometry: charge/multiplicity parity', () => {
  it('knows element labels, including two-letter ones and dummies', () => {
    assert.strictEqual(atomicNumber('Cl'), 17);
    assert.strictEqual(atomicNumber('CL'), 17);
    assert.strictEqual(atomicNumber('C1'), 6);
    assert.strictEqual(atomicNumber('DA'), 0);
    assert.strictEqual(atomicNumber('Zz'), undefined);
  });

  it('accepts consistent charge/multiplicity', () => {
    const ch2oo = ['C', 'O', 'O', 'H', 'H'];
    assert.strictEqual(checkChargeMultiplicity(ch2oo, 0, 1), undefined);
    assert.strictEqual(checkChargeMultiplicity(ch2oo, 0, 3), undefined);
    assert.strictEqual(checkChargeMultiplicity(ch2oo, 1, 2), undefined);
  });

  it('rejects parity mismatches and impossible multiplicities', () => {
    assert.match(checkChargeMultiplicity(['O', 'H', 'H'], 0, 2)!, /10 electrons \(even\).*allowed: 1, 3, 5/);
    assert.match(checkChargeMultiplicity(['O', 'H'], 0, 1)!, /9 electrons \(odd\)/);
    assert.match(checkChargeMultiplicity(['H'], 0, 4)!, /needs 3 unpaired/);
    assert.match(checkChargeMultiplicity(['H'], 2, 1)!, /leaves -1 electrons/);
  });

  it('stays silent for unknown element labels', () => {
    assert.strictEqual(checkChargeMultiplicity(['Zz', 'H'], 0, 2), undefined);
  });
});
