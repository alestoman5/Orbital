import * as assert from 'assert';
import {
  addSimpleKeywords,
  formatXyz,
  hasKeyword,
  parseOrcaInput,
  parseXyz,
  removeSimpleKeywords,
  replaceCoordinatesWithXyzFile,
  replaceSimpleKeyword
} from '../../src/chem/inputFile';

const INLINE = [
  '# CH2OO optimization',
  '! PBE aug-cc-pVDZ TightOpt Freq TightSCF  # production settings',
  '%pal nprocs 4 end',
  '%geom',
  '  Constraints',
  '    { B 0 1 C }',
  '  end',
  'end',
  '* xyz 0 1',
  'C   0.000000   0.000000   0.000000',
  'O   1.270000   0.000000   0.000000',
  'O   1.900000   1.100000   0.000000',
  'H  -0.550000   0.940000   0.000000',
  'H  -0.550000  -0.940000   0.000000',
  '*',
  ''
].join('\n');

describe('chem/inputFile: parseOrcaInput', () => {
  it('collects keywords (without comments), block names and the inline coordinate block', () => {
    const p = parseOrcaInput(INLINE);
    assert.deepStrictEqual(p.keywords, ['PBE', 'aug-cc-pVDZ', 'TightOpt', 'Freq', 'TightSCF']);
    assert.deepStrictEqual(p.blocks, ['pal', 'geom']);
    assert.strictEqual(p.coords!.type, 'xyz');
    assert.strictEqual(p.coords!.charge, 0);
    assert.strictEqual(p.coords!.multiplicity, 1);
    assert.strictEqual(p.coords!.headerLine, 8);
    assert.strictEqual(p.coords!.endLine, 14);
    assert.deepStrictEqual(p.coords!.atoms.map(a => a.symbol), ['C', 'O', 'O', 'H', 'H']);
    assert.strictEqual(p.coords!.atoms[1].line, 10);
    assert.ok(hasKeyword(p, 'tightopt'));
  });

  it('reads the one-line xyzfile form', () => {
    const p = parseOrcaInput('! PBE def2-SVP Opt\n* xyzfile -1 2 start.xyz\n');
    assert.strictEqual(p.coords!.type, 'xyzfile');
    assert.strictEqual(p.coords!.charge, -1);
    assert.strictEqual(p.coords!.multiplicity, 2);
    assert.strictEqual(p.coords!.file, 'start.xyz');
    assert.strictEqual(p.coords!.endLine, 1);
  });
});

describe('chem/inputFile: rewriting', () => {
  it('replaces only the coordinate block with an xyzfile line', () => {
    const out = replaceCoordinatesWithXyzFile(INLINE, 'job_disp.xyz');
    const lines = out.split('\n');
    assert.strictEqual(lines[8], '* xyzfile 0 1 job_disp.xyz');
    assert.strictEqual(lines.length, INLINE.split('\n').length - 6);
    assert.ok(out.includes('%geom\n  Constraints\n    { B 0 1 C }\n  end\nend'));
    assert.ok(out.startsWith('# CH2OO optimization\n! PBE aug-cc-pVDZ TightOpt Freq TightSCF  # production settings'));
  });

  it('replaces an existing xyzfile line too, and throws without coordinates', () => {
    assert.strictEqual(
      replaceCoordinatesWithXyzFile('! SP\n* xyzfile 0 1 a.xyz\n', 'b.xyz'),
      '! SP\n* xyzfile 0 1 b.xyz\n'
    );
    assert.throws(() => replaceCoordinatesWithXyzFile('! SP\n', 'b.xyz'), /No coordinate block/);
  });

  it('swaps a keyword on "!" lines only, case-insensitively, keeping comments', () => {
    const r = replaceSimpleKeyword(INLINE, 'AUG-CC-PVDZ', 'def2-SVPD');
    assert.strictEqual(r.count, 1);
    assert.ok(r.text.includes('! PBE def2-SVPD TightOpt Freq TightSCF  # production settings'));
  });

  it('adds and removes keywords', () => {
    const added = addSimpleKeywords('! PBE def2-SVP # c\n', ['IRC']);
    assert.strictEqual(added, '! PBE def2-SVP IRC # c\n');
    const removed = removeSimpleKeywords('! PBE def2-SVP OptTS Freq\n', ['optts', 'FREQ']);
    assert.strictEqual(removed, '! PBE def2-SVP\n');
  });

  it('round-trips .xyz files', () => {
    const atoms = parseOrcaInput(INLINE).coords!.atoms.map(({ symbol, x, y, z }) => ({ symbol, x, y, z }));
    const back = parseXyz(formatXyz(atoms, 'comment'));
    assert.deepStrictEqual(back, atoms);
  });
});
