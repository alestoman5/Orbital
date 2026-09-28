import * as assert from 'assert';
import { semanticFindings } from '../src/semantic';

const CH2OO = (header = '* xyz 0 1', atoms = ['C', 'O', 'O', 'H', 'H']) =>
  [header, ...atoms.map((s, i) => `${s}  ${i}.000 0.000 0.000`), '*'].join('\n');

describe('semantic: clean inputs produce no findings', () => {
  it("the study-guide Opt+Freq input is clean", () => {
    const text = '! PBE aug-cc-pVDZ TightOpt Freq TightSCF\n' + CH2OO();
    assert.deepStrictEqual(semanticFindings(text, { referenceAtomOrder: ['C', 'O', 'O', 'H', 'H'], totalMemoryMB: 16000 }), []);
  });

  it('xyzfile inputs without readable atoms skip atom-based checks', () => {
    assert.deepStrictEqual(semanticFindings('! PBE def2-SVP Opt\n* xyzfile 0 2 start.xyz\n'), []);
  });
});

describe('semantic: charge/multiplicity and atom order', () => {
  it('flags an impossible multiplicity on the coordinate header', () => {
    const f = semanticFindings('! PBE def2-SVP\n' + CH2OO('* xyz 0 2'));
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'error');
    assert.strictEqual(f[0].line, 1);
    assert.match(f[0].message, /24 electrons/);
  });

  it('uses xyzfile atoms when the caller supplies them', () => {
    const f = semanticFindings('! SP\n* xyzfile 0 2 a.xyz\n', { xyzFileAtoms: ['O', 'H', 'H'] });
    assert.strictEqual(f[0]?.severity, 'error');
  });

  it('flags atom-order deviations at the offending atom line', () => {
    const f = semanticFindings('! SP\n' + CH2OO('* xyz 0 1', ['C', 'O', 'H', 'O', 'H']), { referenceAtomOrder: ['C', 'O', 'O', 'H', 'H'] });
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].line, 4);
    assert.match(f[0].message, /Atom 3 is H/);
  });
});

describe('semantic: job setup', () => {
  it('warns about several job types', () => {
    const f = semanticFindings('! PBE def2-SVP Opt OptTS\n' + CH2OO());
    assert.ok(f.some(x => /Several job types.*Opt, OptTS/.test(x.message)));
  });

  it('suggests Calc_Hess for OptTS, but not when a Hessian is set up', () => {
    const bare = semanticFindings('! PBE def2-SVP OptTS Freq\n' + CH2OO());
    assert.ok(bare.some(x => /OptTS without an exact starting Hessian/.test(x.message)));
    const withHess = semanticFindings('! PBE def2-SVP OptTS Freq\n%geom\n  Calc_Hess true\nend\n' + CH2OO());
    assert.ok(!withHess.some(x => /OptTS without/.test(x.message)));
  });

  it('notes Freq on an inline, non-optimized geometry', () => {
    const f = semanticFindings('! PBE def2-SVP Freq\n' + CH2OO());
    assert.ok(f.some(x => /only meaningful at a stationary point/.test(x.message)));
  });

  it('notes %tddft without NRoots, not with it', () => {
    assert.ok(semanticFindings('! PBE0 def2-SVP\n%tddft\n  TDA false\nend\n' + CH2OO()).some(x => /without NRoots/.test(x.message)));
    assert.ok(!semanticFindings('! PBE0 def2-SVP\n%tddft nroots 5 end\n' + CH2OO()).some(x => /without NRoots/.test(x.message)));
  });

  it('warns when %maxcore x nprocs exceeds 75 % of memory (PALn or %pal)', () => {
    const f = semanticFindings('! PBE def2-SVP PAL8\n%maxcore 4000\n' + CH2OO(), { totalMemoryMB: 16000 });
    assert.ok(f.some(x => /32000 MB/.test(x.message)));
    const g = semanticFindings('! PBE def2-SVP\n%pal nprocs 2 end\n%maxcore 4000\n' + CH2OO(), { totalMemoryMB: 16000 });
    assert.ok(!g.some(x => /MB/.test(x.message)));
  });

  it('warns about two orbital basis sets but not about auxiliary ones', () => {
    assert.ok(semanticFindings('! PBE def2-SVP def2-TZVP\n' + CH2OO()).some(x => /Several orbital basis sets/.test(x.message)));
    assert.ok(!semanticFindings('! PBE0 def2-TZVP def2/J RIJCOSX\n' + CH2OO()).some(x => /basis sets/.test(x.message)));
    assert.ok(!semanticFindings('! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C\n' + CH2OO()).some(x => /basis sets/.test(x.message)));
  });
});
