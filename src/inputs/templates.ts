// Named job presets. Each template turns a base spec (geometry, charge,
// multiplicity, resources from the user) into a complete InputSpec with
// sensible modern defaults, and says which programs it is written for.
// Pure logic, no Node / DOM / vscode imports.

import { distance } from '../chem/geometry';
import { InputSpec, Program, cloneSpec, defaultSpec } from './spec';

export type TemplateId =
  | 'tddft-spectrum'
  | 'opt-freq-wigner'
  | 'adc3-sp'
  | 'eom-ccsd'
  | 'ts-irc'
  | 'casscf-nevpt2'
  | 'relaxed-scan'
  | 'dlpno-ccsd-t';

export interface InputTemplate {
  id: TemplateId;
  name: string;
  description: string;
  /** Programs this template generates for, preferred first. */
  programs: Program[];
  /**
   * Builds the spec. Geometry, charge, multiplicity, comment, xyzFile and (when
   * `base` is given) resources and title are taken from `base`.
   */
  build(base?: InputSpec): InputSpec;
}

function start(base: InputSpec | undefined, name: string): InputSpec {
  const d = defaultSpec();
  const s = cloneSpec(d);
  s.title = name;
  if (base) {
    const b = cloneSpec(base);
    s.geometry = b.geometry;
    s.charge = b.charge;
    s.multiplicity = b.multiplicity;
    s.comment = b.comment;
    s.resources = b.resources;
    s.extras = b.extras;
    if (b.title && b.title !== d.title) {
      s.title = b.title;
    }
  }
  return s;
}

export const TEMPLATES: InputTemplate[] = [
  {
    id: 'tddft-spectrum',
    name: 'TD-DFT vertical spectrum',
    description: 'CAM-B3LYP/def2-TZVP, 10 singlet roots, full TD-DFT (no TDA) for reliable oscillator strengths.',
    programs: ['orca', 'pyscf'],
    build(base) {
      const s = start(base, 'TD-DFT vertical spectrum');
      // Range-separated hybrid: valence, Rydberg-like and charge-transfer states without
      // the strong underestimation of global hybrids. Full TD-DFT rather than TDA because
      // TDA oscillator strengths are not reliable for absorption intensities.
      s.method = { family: 'dft', functional: 'CAM-B3LYP', reference: 'auto', pno: 'normal' };
      s.basis = 'def2-TZVP';
      s.dispersion = 'none'; // no effect on vertical excitation energies
      s.excited = { method: 'tddft', nroots: 10, triplets: false, tda: false, iroot: 0 };
      s.convergence = { scf: 'tight', opt: 'normal' };
      return s;
    }
  },
  {
    id: 'opt-freq-wigner',
    name: 'Opt + Freq for Wigner sampling',
    description: 'PBE0-D3BJ/def2-TZVP tight optimization and analytic frequencies: the minimum and normal modes a Wigner sampling needs.',
    programs: ['orca', 'pyscf'],
    build(base) {
      const s = start(base, 'Opt + Freq for Wigner sampling');
      // Wigner sampling uses every normal mode: loose thresholds leave small imaginary or
      // spurious low modes that would be sampled with huge amplitudes, hence TightOpt/TightSCF.
      s.method = { family: 'dft', functional: 'PBE0', reference: 'auto', pno: 'normal' };
      s.basis = 'def2-TZVP';
      s.dispersion = 'd3bj';
      s.job = 'opt-freq';
      s.convergence = { scf: 'tight', opt: 'tight' };
      s.freq = { temperature: 298.15, pressureAtm: 1 };
      return s;
    }
  },
  {
    id: 'adc3-sp',
    name: 'ADC(3) single point',
    description: 'RHF + EE-ADC(3)/aug-cc-pVDZ, 2 states, frozen core: the per-geometry job of the uv-vis NEA scripts (run_adc.py).',
    programs: ['pyscf'],
    build(base) {
      const s = start(base, 'ADC(3) single point');
      s.method = { family: 'hf', functional: '', reference: 'auto', pno: 'normal' };
      s.basis = 'aug-cc-pVDZ'; // diffuse functions: low-lying Rydberg states
      s.ri = { mode: 'none', auxJ: 'def2/J', auxC: '' }; // exact integrals, as in run_adc.py
      s.dispersion = 'none';
      s.excited = { method: 'adc3', nroots: 2, triplets: false, tda: false, iroot: 0 };
      s.frozenCore = true;
      if (!base) {
        s.resources = { nprocs: 1, maxcoreMB: 3000 }; // one core per geometry, many in parallel
      }
      return s;
    }
  },
  {
    id: 'eom-ccsd',
    name: 'EOM-CCSD excitations',
    description: 'RHF reference, EOM-EE-CCSD/aug-cc-pVDZ, 5 singlet roots, frozen core.',
    programs: ['orca', 'pyscf'],
    build(base) {
      const s = start(base, 'EOM-CCSD excitations');
      s.method = { family: 'hf', functional: '', reference: 'auto', pno: 'normal' };
      s.basis = 'aug-cc-pVDZ';
      s.ri = { mode: 'none', auxJ: 'def2/J', auxC: '' };
      s.dispersion = 'none';
      s.excited = { method: 'eom-ccsd', nroots: 5, triplets: false, tda: false, iroot: 0 };
      s.frozenCore = true;
      s.convergence = { scf: 'tight', opt: 'normal' };
      if (!base) {
        s.resources = { nprocs: 4, maxcoreMB: 4000 };
      }
      return s;
    }
  },
  {
    id: 'ts-irc',
    name: 'TS search + IRC prep',
    description: 'OptTS from an exact Hessian (Calc_Hess) followed by Freq: confirms one imaginary mode and leaves the .hess an IRC starts from.',
    programs: ['orca', 'pyscf'],
    build(base) {
      const s = start(base, 'TS search + IRC prep');
      s.method = { family: 'dft', functional: 'PBE0', reference: 'auto', pno: 'normal' };
      s.basis = 'def2-SVP'; // TS searches are usually done in a double-zeta basis, refined by single points
      s.dispersion = 'd3bj';
      s.job = 'optts-freq';
      s.ts = { calcHess: true, recalcHess: 0 };
      s.convergence = { scf: 'tight', opt: 'normal' };
      return s;
    }
  },
  {
    id: 'casscf-nevpt2',
    name: 'CASSCF/NEVPT2',
    description: 'CASSCF on a small active space plus strongly contracted NEVPT2 (def2-TZVP). Adjust nel/norb to your chemistry.',
    programs: ['orca', 'pyscf'],
    build(base) {
      const s = start(base, 'CASSCF/NEVPT2');
      s.method = { family: 'nevpt2', functional: '', reference: 'auto', pno: 'normal' };
      s.basis = 'def2-TZVP';
      s.ri = { mode: 'none', auxJ: 'def2/J', auxC: '' };
      s.dispersion = 'none';
      // Smallest active space compatible with the spin: (2,2) singlet, (3,3) doublet, ...
      const n = Math.max(2, s.multiplicity + 1);
      s.cas = { nel: n, norb: n, nroots: 1 };
      s.convergence = { scf: 'tight', opt: 'normal' };
      return s;
    }
  },
  {
    id: 'relaxed-scan',
    name: 'Relaxed scan',
    description: 'Relaxed scan of the bond between atoms 0 and 1 (from its current length +1 Å, 11 points), PBE0-D3BJ/def2-SVP.',
    programs: ['orca', 'pyscf'],
    build(base) {
      const s = start(base, 'Relaxed scan');
      s.method = { family: 'dft', functional: 'PBE0', reference: 'auto', pno: 'normal' };
      s.basis = 'def2-SVP';
      s.dispersion = 'd3bj';
      s.job = 'scan';
      const at = s.geometry.atoms;
      const d0 = at.length >= 2 ? Math.round(distance(at[0], at[1]) * 100) / 100 : 1.0;
      s.scan = { coordinate: 'B', atoms: [0, 1], start: d0, end: Math.round((d0 + 1) * 100) / 100, points: 11 };
      return s;
    }
  },
  {
    id: 'dlpno-ccsd-t',
    name: 'DLPNO-CCSD(T) single point',
    description: 'DLPNO-CCSD(T)/def2-TZVPP with TightPNO, def2-TZVPP/C and RIJCOSX: near-canonical CCSD(T) energies for reaction energies and barriers.',
    programs: ['orca'],
    build(base) {
      const s = start(base, 'DLPNO-CCSD(T) single point');
      // TightPNO is the recommended setting for reaction energies, barriers and noncovalent
      // interactions; NormalPNO is cheaper but errors of ~1 kcal/mol are common.
      s.method = { family: 'dlpno-ccsd(t)', functional: '', reference: 'auto', pno: 'tight' };
      s.basis = 'def2-TZVPP';
      s.ri = { mode: 'auto', auxJ: 'def2/J', auxC: 'def2-TZVPP/C' };
      s.dispersion = 'none';
      s.frozenCore = true;
      s.convergence = { scf: 'tight', opt: 'normal' };
      if (!base) {
        s.resources = { nprocs: 8, maxcoreMB: 4000 };
      }
      return s;
    }
  }
];

export function templateById(id: string): InputTemplate | undefined {
  return TEMPLATES.find(t => t.id === id);
}

/** Spec of template `id` on top of `base` (throws on an unknown id). */
export function applyTemplate(id: string, base?: InputSpec): InputSpec {
  const t = templateById(id);
  if (!t) {
    throw new Error(`Unknown input template "${id}".`);
  }
  return t.build(base);
}
