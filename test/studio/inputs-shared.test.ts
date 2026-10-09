// Pure helpers of the Input Builder: shared host/webview logic
// (src/studio/tabs/inputs/shared.ts) and the webview model (generation,
// file names, xyzfile references), which runs without a DOM.

import * as assert from 'assert';
import {
  defaultFileName, formatBytes, formula, formulaUnicode, geometrySummary, issueMatches, mergeSpec, normalizeFileName,
  relevance, sortIssues, totalMemoryLabel
} from '../../src/studio/tabs/inputs/shared';
import { applyTemplate } from '../../src/inputs/templates';
import { defaultSpec, SpecIssue } from '../../src/inputs/spec';
import { batchActive, defaultModel, effectiveSpec, fileName, generate, restoreModel, xyzReference } from '../../webview/src/tabs/inputs/model';

const CH2OO = [
  { symbol: 'O', x: 0, y: 0, z: 0 }, { symbol: 'C', x: 1, y: 0, z: 0 }, { symbol: 'O', x: 2, y: 0, z: 0 },
  { symbol: 'h', x: 0, y: 1, z: 0 }, { symbol: 'H', x: 0, y: 2, z: 0 }
];

describe('inputs tab: shared helpers', () => {
  it('writes formulas in Hill order', () => {
    assert.strictEqual(formula(CH2OO), 'CH2O2');
    assert.strictEqual(formulaUnicode(CH2OO), 'CH₂O₂');
    assert.strictEqual(geometrySummary(CH2OO), 'CH₂O₂ · 5 atoms');
    assert.strictEqual(formula([{ symbol: 'O', x: 0, y: 0, z: 0 }, { symbol: 'H', x: 0, y: 0, z: 1 }, { symbol: 'H', x: 0, y: 1, z: 0 }]), 'H2O');
    assert.strictEqual(formula([{ symbol: 'Cl', x: 0, y: 0, z: 0 }, { symbol: 'Na', x: 0, y: 0, z: 1 }]), 'ClNa');
    assert.strictEqual(geometrySummary([]), 'No atoms');
    assert.strictEqual(geometrySummary([{ symbol: 'He', x: 0, y: 0, z: 0 }]), 'He · 1 atom');
  });

  it('derives file names from formula, method and job', () => {
    const base = defaultSpec();
    base.geometry.atoms = CH2OO;
    assert.strictEqual(defaultFileName(applyTemplate('tddft-spectrum', base), 'orca'), 'ch2o2_camb3lyp_tddft.inp');
    assert.strictEqual(defaultFileName(applyTemplate('adc3-sp', base), 'pyscf'), 'ch2o2_adc3.py');
    assert.strictEqual(defaultFileName(applyTemplate('opt-freq-wigner', base), 'orca'), 'ch2o2_pbe0_optfreq.inp');
    assert.strictEqual(defaultFileName(applyTemplate('dlpno-ccsd-t', base), 'orca'), 'ch2o2_dlpnoccsdt_sp.inp');
    const empty = defaultSpec();
    empty.geometry.atoms = [];
    assert.strictEqual(defaultFileName(empty, 'orca', 'My Mol.xyz'), 'mymol_pbe0_sp.inp');
    assert.strictEqual(defaultFileName(empty, 'pyscf'), 'job_pbe0_sp.py');
  });

  it('normalizes typed file names', () => {
    assert.strictEqual(normalizeFileName('my job', 'orca'), 'my_job.inp');
    assert.strictEqual(normalizeFileName('run.inp', 'pyscf'), 'run.py');
    assert.strictEqual(normalizeFileName('a/b:c', 'orca'), 'a_b_c.inp');
    assert.strictEqual(normalizeFileName('  ', 'pyscf'), 'job.py');
  });

  it('shows only the sections that apply', () => {
    const s = defaultSpec();
    let r = relevance(s, 'hybrid');
    assert.deepStrictEqual([r.functional, r.cas, r.scan, r.ts, r.freq, r.excitedOptions, r.frozenCore, r.auxC], [true, false, false, false, false, false, false, false]);
    s.method.family = 'nevpt2';
    s.job = 'scan';
    r = relevance(s);
    assert.deepStrictEqual([r.functional, r.cas, r.scan, r.frozenCore, r.dispersion], [false, true, true, true, false]);
    const c = defaultSpec();
    c.method.functional = 'r2SCAN-3c';
    assert.deepStrictEqual([relevance(c, 'composite').basis, relevance(c, 'composite').ri], [false, false]);
    c.job = 'optts-freq';
    c.excited.method = 'tddft';
    assert.deepStrictEqual([relevance(c).ts, relevance(c).freq, relevance(c).tda, relevance(c).optConvergence], [true, true, true, true]);
  });

  it('matches issues to fields by dotted path', () => {
    const i = (path: string): SpecIssue => ({ severity: 'error', path, message: '' });
    assert.ok(issueMatches(i('scan.atoms[1]'), 'scan.atoms'));
    assert.ok(issueMatches(i('geometry.atoms[2].symbol'), 'geometry'));
    assert.ok(issueMatches(i('excited.nroots'), 'excited.nroots'));
    assert.ok(!issueMatches(i('excited.nroots'), 'excited.n'));
    assert.ok(!issueMatches(i('scan.atomsX'), 'scan.atoms'));
    const sorted = sortIssues([{ ...i('a'), severity: 'info' }, { ...i('b'), severity: 'warning' }, i('c'), i('d')]);
    assert.deepStrictEqual(sorted.map(x => x.path), ['c', 'd', 'b', 'a']);
  });

  it('formats sizes and total memory', () => {
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(2048), '2.0 kB');
    assert.strictEqual(formatBytes(5.5 * 1024 * 1024), '5.5 MB');
    assert.strictEqual(totalMemoryLabel(4, 2000), '8 GB');
    assert.strictEqual(totalMemoryLabel(16, 2000), '32 GB');
    assert.strictEqual(totalMemoryLabel(1, 500), '500 MB');
    assert.strictEqual(totalMemoryLabel(3, 1500), '4.5 GB');
    assert.strictEqual(totalMemoryLabel(0, 2000), '–');
  });

  it('merges spec patches one level deep', () => {
    const s = mergeSpec(defaultSpec(), { excited: { nroots: 20 }, job: 'opt', bogus: 1 });
    assert.deepStrictEqual([s.excited.nroots, s.excited.method, s.job], [20, 'none', 'opt']);
    assert.ok(!('bogus' in s));
  });
});

describe('inputs tab: webview model', () => {
  it('generates ORCA and PySCF text with requires from the same spec', () => {
    const m = defaultModel();
    m.spec = applyTemplate('opt-freq-wigner', m.spec);
    let g = generate(m);
    assert.deepStrictEqual([g.errors, g.requires], [[], []]);
    assert.match(g.text, /^! PBE0 def2-TZVP RIJCOSX def2\/J D3BJ$/m);
    assert.deepStrictEqual(g.supported, ['orca', 'pyscf']);
    m.program = 'pyscf';
    g = generate(m);
    assert.deepStrictEqual(g.requires, ['pyscf', 'geometric', 'pyscf-dispersion']);
    assert.strictEqual(fileName(m), 'h2o_pbe0_optfreq.py');
    m.fileName = 'custom name.inp';
    assert.strictEqual(fileName(m), 'custom_name.py');
  });

  it('reports unsupported combinations per program', () => {
    const m = defaultModel();
    m.spec = applyTemplate('adc3-sp', m.spec);
    m.program = 'orca';
    const g = generate(m);
    assert.ok(g.errors.length > 0);
    assert.deepStrictEqual(g.supported, ['pyscf']);
    assert.ok(g.issues.some(i => i.program === 'orca' && i.path === 'excited.method'));
  });

  it('references the source .xyz next to the input, or writes a companion', () => {
    const m = defaultModel();
    m.useXyzFile = true;
    m.source = { kind: 'xyz', name: 'geom.xyz', path: 'C:\\w\\geom.xyz', xyzPath: 'C:\\w\\geom.xyz', frames: 1 };
    assert.deepStrictEqual(xyzReference(m), { name: 'geom.xyz' });
    assert.match(generate(m).text, /^\* xyzfile 0 1 geom\.xyz$/m);
    m.source = { kind: 'out', name: 'opt.out', path: '/w/opt.out', frames: 1 };
    const ref = xyzReference(m);
    assert.strictEqual(ref.name, 'h2o_pbe0_sp.xyz');
    assert.match(ref.companion!.content, /^3\n/);
    m.useXyzFile = false;
    assert.strictEqual(effectiveSpec(m).geometry.xyzFile, undefined);
  });

  it('switches to batch mode for ensembles unless turned off, and ignores xyzfile there', () => {
    const m = defaultModel();
    m.source = { kind: 'xyz', name: 'e.xyz', path: '/w/e.xyz', xyzPath: '/w/e.xyz', frames: 10 };
    m.useXyzFile = true;
    assert.ok(batchActive(m));
    assert.strictEqual(effectiveSpec(m).geometry.xyzFile, undefined);
    m.batch.enabled = false;
    assert.ok(!batchActive(m));
  });

  it('restores saved state over defaults', () => {
    const m = restoreModel({ program: 'pyscf', spec: { job: 'opt' } as any, batch: { maxFrames: 5 } as any });
    assert.deepStrictEqual([m.program, m.spec.job, m.spec.method.functional, m.batch.maxFrames, m.batch.slurm], ['pyscf', 'opt', 'PBE0', 5, true]);
    assert.strictEqual(restoreModel(undefined).program, 'orca');
    assert.strictEqual(restoreModel({ program: 'gaussian' as any }).program, 'orca');
  });
});
