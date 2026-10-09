import * as assert from 'assert';
import {
  InputSpec, SpecIssue, applyTemplate, correlationAuxFor, defaultSpec, describeSpec, normalizeSpec,
  orcaRiKeywords, supportedPrograms, validateSpec
} from '../../src/inputs';

function edit(f: (s: InputSpec) => void): InputSpec {
  const s = defaultSpec();
  f(s);
  return s;
}

const errors = (issues: SpecIssue[]) => issues.filter(i => i.severity === 'error');
const hasIssue = (issues: SpecIssue[], severity: string, path: string, re?: RegExp) =>
  issues.some(i => i.severity === severity && i.path === path && (!re || re.test(i.message)));

describe('inputs: defaultSpec / normalizeSpec', () => {
  it('the default spec is valid for both programs', () => {
    assert.deepStrictEqual(errors(validateSpec(defaultSpec())), []);
    assert.deepStrictEqual(supportedPrograms(defaultSpec()), ['orca', 'pyscf']);
  });

  it('round-trips through JSON and fills missing fields', () => {
    const s = defaultSpec();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
    const n = normalizeSpec({ basis: 'cc-pVDZ', excited: { nroots: 3 } } as any);
    assert.strictEqual(n.basis, 'cc-pVDZ');
    assert.strictEqual(n.excited.nroots, 3);
    assert.strictEqual(n.excited.method, 'none');
    assert.strictEqual(n.resources.nprocs, 4);
  });

  it('describes a spec in one line', () => {
    assert.strictEqual(describeSpec(applyTemplate('tddft-spectrum')), 'single point: TD-DFT (10 roots) CAM-B3LYP/def2-TZVP');
    assert.strictEqual(describeSpec(applyTemplate('opt-freq-wigner')), 'opt + freq: PBE0-D3BJ/def2-TZVP');
  });
});

describe('inputs: validateSpec', () => {
  it('rejects a missing geometry and unknown elements', () => {
    assert.ok(hasIssue(validateSpec(edit(s => { s.geometry.atoms = []; })), 'error', 'geometry.atoms'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.geometry.atoms[1].symbol = 'Xx'; })), 'error', 'geometry.atoms[1].symbol'));
    assert.deepStrictEqual(errors(validateSpec(edit(s => { s.geometry = { atoms: [], xyzFile: 'mol.xyz' }; }))), []);
    assert.ok(hasIssue(validateSpec(edit(s => { s.geometry = { atoms: [], xyzFile: 'my mol.xyz' }; })), 'error', 'geometry.xyzFile'));
  });

  it('checks charge/multiplicity parity', () => {
    assert.ok(hasIssue(validateSpec(edit(s => { s.multiplicity = 2; })), 'error', 'multiplicity', /incompatible/));
    assert.ok(hasIssue(validateSpec(edit(s => { s.multiplicity = 0; })), 'error', 'multiplicity'));
    assert.deepStrictEqual(errors(validateSpec(edit(s => { s.charge = 1; s.multiplicity = 2; }))), []);
  });

  it('asks for an open-shell reference when multiplicity > 1 and restricted is forced', () => {
    const issues = validateSpec(edit(s => { s.multiplicity = 3; s.method.reference = 'restricted'; }));
    assert.ok(hasIssue(issues, 'error', 'method.reference', /UKS/));
    const hf = validateSpec(edit(s => { s.multiplicity = 3; s.method.family = 'hf'; s.method.reference = 'restricted'; }));
    assert.ok(hasIssue(hf, 'error', 'method.reference', /UHF/));
    assert.deepStrictEqual(errors(validateSpec(edit(s => { s.multiplicity = 3; }))), []);
  });

  it('needs nroots, a matching reference and a closed shell for triplets', () => {
    assert.ok(hasIssue(validateSpec(edit(s => { s.excited = { ...s.excited, method: 'tddft', nroots: 0 }; })), 'error', 'excited.nroots'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.excited.method = 'adc3'; })), 'error', 'method.family', /HF reference/));
    assert.ok(hasIssue(validateSpec(edit(s => { s.method.family = 'mp2'; s.excited.method = 'tddft'; })), 'error', 'excited.method'));
    assert.ok(hasIssue(validateSpec(edit(s => {
      s.multiplicity = 3; s.excited = { ...s.excited, method: 'tddft', triplets: true };
    })), 'error', 'excited.triplets'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.excited = { ...s.excited, method: 'tddft', iroot: 11 }; })), 'error', 'excited.iroot'));
  });

  it('only allows TD-DFT excited-state optimizations, and only with IRoot', () => {
    assert.ok(hasIssue(validateSpec(edit(s => { s.job = 'opt'; s.excited = { ...s.excited, method: 'tddft', iroot: 0 }; })), 'error', 'excited.iroot'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.job = 'freq'; s.excited.method = 'tddft'; })), 'error', 'job', /Frequencies/));
    const ok = edit(s => { s.job = 'opt'; s.excited = { ...s.excited, method: 'tddft', iroot: 1 }; });
    assert.deepStrictEqual(supportedPrograms(ok), ['orca']);
  });

  it('checks the CAS space', () => {
    const cas = (nel: number, norb: number, mult = 1) => validateSpec(edit(s => {
      s.method.family = 'casscf'; s.multiplicity = mult; s.cas = { nel, norb, nroots: 1 };
    }));
    assert.deepStrictEqual(errors(cas(2, 2)), []);
    assert.ok(hasIssue(cas(6, 2), 'error', 'cas.nel', /do not fit/));
    assert.ok(hasIssue(cas(3, 3), 'error', 'cas.nel', /multiplicity/));
    assert.ok(hasIssue(cas(12, 8), 'error', 'cas.nel', /only 10/));
    assert.ok(hasIssue(cas(4, 1, 5), 'error', 'cas.norb'));
  });

  it('checks the scan definition', () => {
    const scan = (f: (s: InputSpec) => void) => validateSpec(edit(s => { s.job = 'scan'; f(s); }));
    assert.deepStrictEqual(errors(scan(() => undefined)), []);
    assert.ok(hasIssue(scan(s => { s.scan.atoms = [0, 1, 2]; }), 'error', 'scan.atoms', /needs 2/));
    assert.ok(hasIssue(scan(s => { s.scan.atoms = [0, 5]; }), 'error', 'scan.atoms[1]'));
    assert.ok(hasIssue(scan(s => { s.scan.points = 1; }), 'error', 'scan.points'));
    assert.ok(hasIssue(scan(s => { s.scan.end = s.scan.start; }), 'error', 'scan.end'));
    assert.ok(hasIssue(scan(s => { s.scan = { coordinate: 'A', atoms: [1, 0, 2], start: 90, end: 200, points: 5 }; }), 'error', 'scan.end'));
    assert.ok(hasIssue(scan(s => { s.scan.start = -1; }), 'error', 'scan.start'));
  });

  it('checks memory and processes', () => {
    assert.ok(hasIssue(validateSpec(edit(s => { s.resources.maxcoreMB = 50; })), 'error', 'resources.maxcoreMB'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.resources.nprocs = 0; })), 'error', 'resources.nprocs'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.method.family = 'ccsd(t)'; s.resources.maxcoreMB = 500; })), 'warning', 'resources.maxcoreMB'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.resources = { nprocs: 64, maxcoreMB: 16000 }; })), 'warning', 'resources.maxcoreMB'));
  });

  it('checks basis / auxiliary basis pairing', () => {
    assert.ok(hasIssue(validateSpec(edit(s => {
      s.method.family = 'dlpno-ccsd(t)'; s.basis = 'cc-pVTZ'; s.ri.auxC = 'def2-TZVP/C';
    })), 'warning', 'ri.auxC', /fitted for def2-TZVP/));
    assert.ok(hasIssue(validateSpec(edit(s => { s.ri.auxJ = 'def2-TZVP/C'; })), 'error', 'ri.auxJ'));
    assert.ok(hasIssue(validateSpec(edit(s => { s.basis = 'def2-XYZ'; })), 'warning', 'basis'));
    assert.strictEqual(correlationAuxFor('def2-TZVP'), 'def2-TZVP/C');
    assert.strictEqual(correlationAuxFor('aug-cc-pVTZ'), 'aug-cc-pVTZ/C');
    assert.strictEqual(correlationAuxFor('ma-def2-TZVP'), 'def2-TZVP/C');
    assert.strictEqual(correlationAuxFor('6-31G*'), 'AutoAux');
  });

  it('resolves RI per method family', () => {
    assert.deepStrictEqual(orcaRiKeywords(defaultSpec()), ['RIJCOSX', 'def2/J']);
    assert.deepStrictEqual(orcaRiKeywords(edit(s => { s.method.functional = 'PBE'; })), ['RI', 'def2/J']);
    assert.deepStrictEqual(orcaRiKeywords(edit(s => { s.method.family = 'ccsd(t)'; })), []);
    assert.deepStrictEqual(orcaRiKeywords(edit(s => { s.method.family = 'mp2'; s.basis = 'def2-TZVP'; })), ['RIJCOSX', 'def2/J', 'def2-TZVP/C']);
    assert.deepStrictEqual(orcaRiKeywords(edit(s => { s.ri.mode = 'rijk'; })), ['RIJK', 'def2/JK']);
    assert.deepStrictEqual(orcaRiKeywords(edit(s => { s.method.functional = 'r2SCAN-3c'; })), []);
  });

  it('reports the method × program support matrix', () => {
    const progs = (f: (s: InputSpec) => void) => supportedPrograms(edit(f));
    assert.deepStrictEqual(progs(s => { s.method.family = 'hf'; s.excited.method = 'adc2'; }), ['pyscf']);
    assert.deepStrictEqual(progs(s => { s.method.family = 'hf'; s.excited.method = 'eom-ccsd'; }), ['orca', 'pyscf']);
    assert.deepStrictEqual(progs(s => { s.method.family = 'dlpno-ccsd(t)'; }), ['orca']);
    assert.deepStrictEqual(progs(s => { s.method.functional = 'r2SCAN-3c'; s.basis = ''; }), ['orca']);
    assert.deepStrictEqual(progs(s => { s.method.functional = 'B2PLYP'; }), ['orca']);
    assert.deepStrictEqual(progs(s => { s.method.family = 'ccsd(t)'; s.job = 'opt'; }), []);
    assert.deepStrictEqual(progs(s => { s.method.family = 'mp2'; s.job = 'opt'; }), ['orca']);
    assert.deepStrictEqual(progs(s => { s.basis = 'ma-def2-SVP'; }), ['orca']);
    assert.deepStrictEqual(progs(s => { s.method.family = 'ccsd(t)'; s.solvation.model = 'cpcm'; }), ['orca']);
    assert.deepStrictEqual(progs(s => { s.method.functional = 'wB97M-V'; s.job = 'freq'; }), ['orca']);
    // tagged per program when no program is given
    const both = validateSpec(edit(s => { s.method.family = 'dlpno-ccsd(t)'; }));
    assert.ok(both.some(i => i.program === 'pyscf' && i.severity === 'error'));
    assert.ok(!both.some(i => i.program === 'orca' && i.severity === 'error'));
  });

  it('notes built-in dispersion and composite basis sets', () => {
    assert.ok(hasIssue(validateSpec(edit(s => { s.method.functional = 'wB97X-V'; s.dispersion = 'd4'; })), 'info', 'dispersion', /already includes/));
    assert.ok(hasIssue(validateSpec(edit(s => { s.method.functional = 'r2SCAN-3c'; })), 'info', 'basis', /composite/));
    assert.ok(hasIssue(validateSpec(edit(s => { s.solvation = { model: 'cpcm', solvent: 'lava' }; })), 'error', 'solvation.solvent'));
  });
});
