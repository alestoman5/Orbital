import * as assert from 'assert';
import { unitConversionAt } from '../src/features/unitHover';

describe('unitHover: unitConversionAt', () => {
  it('converts an eV value under the cursor', () => {
    const line = '  0-1A  ->  2-1A    3.874500 eV';
    const hit = unitConversionAt(line, line.indexOf('3.87') + 2)!;
    assert.ok(hit.markdown.includes('| 320.0 | nm |'));
    assert.ok(hit.markdown.includes('| 31249.9 | cm-1 |'));
    assert.ok(hit.markdown.includes('| 0.14238525 | Eh |'));
  });

  it('does not offer nm / cm-1 for a total energy in Eh', () => {
    const line = 'Total Enthalpy                    ...   -571.74417973 Eh';
    const hit = unitConversionAt(line, line.indexOf('571'))!;
    assert.ok(hit.markdown.includes('kcal/mol'));
    assert.ok(!hit.markdown.includes('| nm |'));
  });

  it('understands ORCA cm**-1 and ignores numbers without a unit', () => {
    const line = '     7:    1600.00 cm**-1';
    assert.ok(unitConversionAt(line, line.indexOf('1600'))!.markdown.includes('eV'));
    assert.strictEqual(unitConversionAt('  0.012000000   0.06538', 4), undefined);
  });
});
