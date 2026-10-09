import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lintDocument } from '../../src/diagnostics';
import { parseOrcaInput } from '../../src/chem/inputFile';
import { semanticFindings } from '../../src/semantic';
import { isKnownSimpleKeyword } from '../../src/keywords';
import { TEMPLATES, buildOrcaInput, buildPyscfScript, PROGRAMS } from '../../src/inputs';
import { __resetConfig, DiagnosticSeverity } from '../mocks/vscode';
import { makeCollection, makeDoc } from '../helpers/fakeDocument';
import { allCases, matchSnapshot, VARIANTS } from './helpers';

function lint(text: string) {
  __resetConfig();
  const collection = makeCollection();
  lintDocument(makeDoc(text.split('\n')) as any, collection as any);
  return (collection.diagnostics || []) as { message: string; severity: DiagnosticSeverity }[];
}

describe('inputs: templates', () => {
  it('have unique ids and at least one program each', () => {
    assert.strictEqual(new Set(TEMPLATES.map(t => t.id)).size, TEMPLATES.length);
    for (const t of TEMPLATES) {
      assert.ok(t.programs.length > 0, t.id);
    }
  });

  for (const t of TEMPLATES) {
    for (const program of PROGRAMS) {
      const supported = t.programs.includes(program);
      it(`${t.id} × ${program}: ${supported ? 'generates without errors' : 'is refused with an explanation'}`, () => {
        const r = program === 'orca' ? buildOrcaInput(t.build()) : buildPyscfScript(t.build());
        if (supported) {
          assert.deepStrictEqual(r.errors, []);
        } else {
          assert.ok(r.errors.length > 0);
          assert.match(r.text, /could not generate/);
        }
      });
    }
  }

  it('keep the geometry, charge and multiplicity of the base spec', () => {
    const base = VARIANTS.find(v => v.id === 'uks-radical-opt')!.spec;
    for (const t of TEMPLATES) {
      const s = t.build(base);
      assert.deepStrictEqual(s.geometry, base.geometry, t.id);
      assert.strictEqual(s.multiplicity, 2, t.id);
      assert.deepStrictEqual(s.resources, base.resources, t.id);
    }
  });
});

describe('inputs: snapshots', () => {
  for (const c of allCases()) {
    const ext = c.program === 'orca' ? 'inp' : 'py';
    it(`${c.id}.${c.program}.${ext}`, () => {
      const r = c.program === 'orca' ? buildOrcaInput(c.spec) : buildPyscfScript(c.spec);
      assert.deepStrictEqual(r.errors, []);
      matchSnapshot(`${c.id}.${c.program}.${ext}`, r.text);
    });
  }
});

describe('inputs: generated ORCA inputs', () => {
  for (const c of allCases().filter(x => x.program === 'orca')) {
    it(`${c.id}: no semantic errors, clean lint, round-trips through parseOrcaInput`, () => {
      const { text } = buildOrcaInput(c.spec);
      const findings = semanticFindings(text, { xyzFileAtoms: c.spec.geometry.xyzFile ? ['O', 'H', 'H'] : undefined });
      assert.deepStrictEqual(findings.filter(f => f.severity !== 'information'), [], JSON.stringify(findings));

      const diags = lint(text);
      assert.deepStrictEqual(diags.filter(d => d.severity !== DiagnosticSeverity.Information).map(d => d.message), []);

      const parsed = parseOrcaInput(text);
      for (const kw of parsed.keywords) {
        assert.ok(isKnownSimpleKeyword(kw), `unknown keyword ${kw}`);
      }
      assert.ok(parsed.coords);
      assert.strictEqual(parsed.coords!.charge, c.spec.charge);
      assert.strictEqual(parsed.coords!.multiplicity, c.spec.multiplicity);
      if (c.spec.geometry.xyzFile) {
        assert.strictEqual(parsed.coords!.type, 'xyzfile');
        assert.strictEqual(parsed.coords!.file, c.spec.geometry.xyzFile);
      } else {
        assert.strictEqual(parsed.coords!.atoms.length, c.spec.geometry.atoms.length);
        parsed.coords!.atoms.forEach((a, i) => {
          const e = c.spec.geometry.atoms[i];
          assert.strictEqual(a.symbol, e.symbol);
          assert.ok(Math.abs(a.x - e.x) < 1e-8 && Math.abs(a.y - e.y) < 1e-8 && Math.abs(a.z - e.z) < 1e-8);
        });
      }
      // one "!" line for the method, at most one more for the job
      assert.ok(parsed.lines.filter(l => l.startsWith('!')).length <= 2);
    });
  }

  it('writes the expected keywords and blocks for open-shell, solvation and excited states', () => {
    const smd = buildOrcaInput(VARIANTS.find(v => v.id === 'smd-tda-triplets')!.spec).text;
    assert.match(smd, /^! wB97X-D3BJ def2-TZVPD RIJCOSX def2\/J$/m);
    assert.match(smd, /^! CPCM\(acetonitrile\)$/m);
    assert.match(smd, /%cpcm\n {2}SMD true\n {2}SMDSolvent "acetonitrile"\nend/);
    assert.match(smd, /%tddft\n {2}NRoots 6\n {2}TDA true\n {2}Triplets true\n {2}IRoot 1\nend/);
    const uks = buildOrcaInput(VARIANTS.find(v => v.id === 'uks-radical-opt')!.spec).text;
    assert.match(uks, /^! UKS B3LYP def2-SVP RIJCOSX def2\/J D4$/m);
    assert.match(uks, /^! TightOpt TightSCF$/m);
    assert.match(uks, /^\* xyz 0 2$/m);
    const mp2 = buildOrcaInput(VARIANTS.find(v => v.id === 'rimp2-optfreq')!.spec).text;
    assert.match(mp2, /^! RI-MP2 cc-pVTZ RIJCOSX def2\/J cc-pVTZ\/C$/m);
    assert.match(mp2, /^! Opt NumFreq$/m);
    assert.ok(!/%pal/.test(mp2), 'no %pal for one process');
    const noRi = buildOrcaInput(VARIANTS.find(v => v.id === 'gga-noRI-freq-anion')!.spec).text;
    assert.match(noRi, /^! PBE def2-SVPD NoRI D3BJ$/m);
    assert.match(noRi, /%freq\n {2}Temp 350\.0\n {2}Pressure 2\.0\nend/);
    assert.match(noRi, /# --- user additions ---\n%output\n {2}Print\[P_Hirshfeld\] 1\nend/);
    const comp = buildOrcaInput(VARIANTS.find(v => v.id === 'composite-xyzfile')!.spec).text;
    assert.match(comp, /^! r2SCAN-3c$/m);
    assert.match(comp, /^\* xyzfile 0 1 molecule\.xyz$/m);
    assert.match(comp, /^# Cheap composite pre-optimization\.$/m);
  });
});

function findPython(): string | undefined {
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') {
      return cmd;
    }
  }
  return undefined;
}

describe('inputs: generated PySCF scripts', function () {
  this.timeout(60000);
  const python = findPython();
  const cases = allCases().filter(x => x.program === 'pyscf');

  it('declare their extra packages', () => {
    for (const c of cases) {
      const r = buildPyscfScript(c.spec);
      assert.strictEqual(r.requires[0], 'pyscf');
      assert.strictEqual(r.requires.includes('geometric'), /geometric_solver/.test(r.text), c.id);
      assert.strictEqual(r.requires.includes('pyscf-dispersion'), /mf\.disp =|d3bj"/.test(r.text), c.id);
    }
  });

  it('excited-state scripts write the keys the Calculations tab reads', () => {
    for (const c of cases.filter(x => x.spec.excited.method !== 'none')) {
      const t = buildPyscfScript(c.spec).text;
      for (const key of ['"converged"', 'result["excitation_energies_ev"]', 'result["time_adc_s"]']) {
        assert.ok(t.includes(key), `${c.id}: ${key}`);
      }
      if (c.spec.excited.method !== 'eom-ccsd') {
        assert.ok(t.includes('result["oscillator_strengths"]'), c.id);
      }
    }
  });

  it('all parse with ast.parse and compile with py_compile', function () {
    if (!python) {
      console.log('      (skipped: no Python 3 interpreter on PATH)');
      this.skip();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-pyscf-'));
    try {
      const files = cases.map(c => {
        const f = path.join(dir, `${c.id}.py`);
        fs.writeFileSync(f, buildPyscfScript(c.spec).text);
        return f;
      });
      const check = [
        'import ast, py_compile, sys',
        'for f in sys.argv[1:]:',
        '    ast.parse(open(f, encoding="utf8").read(), f)',
        '    py_compile.compile(f, doraise=True)',
        'print("ok", len(sys.argv) - 1)'
      ].join('\n');
      const r = spawnSync(python!, ['-c', check, ...files], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout.trim(), `ok ${files.length}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('import nothing heavy before the thread variables are set', () => {
    for (const c of cases) {
      const t = buildPyscfScript(c.spec).text;
      const env = t.indexOf('os.environ[var]');
      assert.ok(env > 0, c.id);
      assert.ok(t.indexOf('import numpy') > env && t.indexOf('import pyscf') > env, c.id);
    }
  });

  it('write result.json atomically and exit 1 on non-convergence', () => {
    for (const c of cases) {
      const t = buildPyscfScript(c.spec).text;
      assert.match(t, /os\.replace\(path \+ "\.tmp", path\)/);
      assert.match(t, /if not converged:\n\s+sys\.exit\(/);
      assert.match(t, /finish\(converged, /);
    }
  });

  it('bake the spec into the argparse defaults', () => {
    const t = buildPyscfScript(TEMPLATES.find(x => x.id === 'tddft-spectrum')!.build()).text;
    assert.match(t, /"--basis", default="def2-TZVP"/);
    assert.match(t, /"--xc", default="camb3lyp"/);
    assert.match(t, /"--nstates", type=int, default=10/);
    assert.match(t, /"--tda", action=argparse\.BooleanOptionalAction, default=False/);
    const adc = buildPyscfScript(TEMPLATES.find(x => x.id === 'adc3-sp')!.build()).text;
    assert.match(adc, /"--method", default="adc\(3\)"/);
    assert.match(adc, /myadc = adc\.ADC\(mf, frozen=ncore\)/);
    assert.match(adc, /mf = scf\.RHF\(mol\)\n(?!\s+mf = mf\.density_fit)/);
  });
});
