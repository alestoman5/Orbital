import * as assert from 'assert';
import { columnsOf, hessAtomsToGeometry, parseColumnBlockMatrix, parseHessFile } from '../../src/chem/hess';
import { BOHR_TO_ANGSTROM } from '../../src/chem/elements';

// Constructed water .hess in ORCA's layout: 9 Cartesian dofs, $normal_modes
// printed in blocks of 5 columns (as .hess does), coordinates in bohr.
// Mode 6 is given a negative frequency to exercise imaginary handling.
const WATER_HESS = `
$orca_hessian_file

$act_atom
  0

$hessian
9
                    0          1
      0      0.1E+00    0.2E+00
$vibrational_frequencies
9
    0        0.000000
    1        0.000000
    2        0.000000
    3        0.000000
    4        0.000000
    5        0.000000
    6     -150.250000
    7     3700.500000
    8     3800.750000
$normal_modes
9 9
                    0          1          2          3          4
      0      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      1      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      2      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      3      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      4      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      5      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      6      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      7      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      8      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
                    5          6          7          8
      0      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00  -0.0700000000E+00
      1      0.0000000000E+00   0.0700000000E+00  -0.0500000000E+00   0.0000000000E+00
      2      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      3      0.0000000000E+00  -0.5500000000E+00   0.4000000000E+00   0.5600000000E+00
      4      0.0000000000E+00  -0.4300000000E+00  -0.5800000000E+00  -0.4300000000E+00
      5      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
      6      0.0000000000E+00   0.5500000000E+00   0.4000000000E+00   0.5600000000E+00
      7      0.0000000000E+00  -0.4300000000E+00   0.5800000000E+00   0.4300000000E+00
      8      0.0000000000E+00   0.0000000000E+00   0.0000000000E+00   0.0000000000E+00
$atoms
3
 O     15.99900      0.000000000000     0.000000000000    -0.120000000000
 H      1.00800      1.430000000000     0.000000000000     0.960000000000
 H      1.00800     -1.430000000000     0.000000000000     0.960000000000
$actual_temperature
  0.000000

$end
`;

describe('chem/hess: parseHessFile', () => {
  const data = parseHessFile(WATER_HESS)!;

  it('reads atoms with masses and bohr coordinates', () => {
    assert.strictEqual(data.atoms.length, 3);
    assert.deepStrictEqual(data.atoms[0], { symbol: 'O', mass: 15.999, xBohr: 0, yBohr: 0, zBohr: -0.12 });
    assert.strictEqual(data.atoms[1].xBohr, 1.43);
  });

  it('reads all 3N frequencies, keeping the imaginary one negative', () => {
    assert.strictEqual(data.frequenciesCm1.length, 9);
    assert.strictEqual(data.frequenciesCm1[6], -150.25);
    assert.strictEqual(data.frequenciesCm1[8], 3800.75);
  });

  it('assembles normal modes across column blocks as modes[k][dof]', () => {
    assert.strictEqual(data.normalModes.length, 9);
    assert.strictEqual(data.normalModes[6].length, 9);
    assert.strictEqual(data.normalModes[6][1], 0.07);
    assert.strictEqual(data.normalModes[6][3], -0.55);
    assert.strictEqual(data.normalModes[8][0], -0.07);
    assert.ok(data.normalModes[0].every(v => v === 0));
  });

  it('returns undefined when frequencies/modes are missing (e.g. an optimizer Hessian)', () => {
    assert.strictEqual(parseHessFile('$orca_hessian_file\n$hessian\n3\n$atoms\n1\n H 1.008 0 0 0\n'), undefined);
  });

  it('converts .hess atoms to Ångström geometry', () => {
    const g = hessAtomsToGeometry(data.atoms);
    assert.ok(Math.abs(g[1].x - 1.43 * BOHR_TO_ANGSTROM) < 1e-12);
    assert.strictEqual(g[0].symbol, 'O');
  });
});

describe('chem/hess: parseColumnBlockMatrix', () => {
  it('reads 6-column .out-style blocks and leaves missing (truncated) entries as NaN', () => {
    const lines = [
      '                  0          1          2          3          4          5',
      '      0       0.100000   0.200000   0.300000   0.400000   0.500000   0.600000',
      '      1       1.100000   1.200000   1.300000   1.400000   1.500000   1.600000',
      '                  6',
      '      0       0.700000'
    ];
    const { matrix } = parseColumnBlockMatrix(lines, 0, 2, 7);
    assert.strictEqual(matrix[0][5], 0.6);
    assert.strictEqual(matrix[1][2], 1.3);
    assert.strictEqual(matrix[0][6], 0.7);
    assert.ok(Number.isNaN(matrix[1][6]));
    assert.deepStrictEqual(columnsOf(matrix)[0], [0.1, 1.1]);
  });
});
