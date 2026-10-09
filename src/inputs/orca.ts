// ORCA 6 input generator: InputSpec -> .inp text. Pure string logic, no
// Node / DOM / vscode imports. Keywords come from the same lists as the
// editor's completion and diagnostics (keywords.ts), and every generated
// input is checked in the tests with semanticFindings + lintDocument.

import { formatAtomLines } from '../chem/inputFile';
import { correlationAuxFor, functionalInfo, isHybrid, solventInfo } from './catalog';
import {
  InputSpec, SpecIssue, describeSpec, effectiveDispersion, effectiveReference, hasFrequencies,
  isComposite, isCorrelated, isTsSearch, validateSpec
} from './spec';

export interface GeneratedInput {
  text: string;
  /** Messages of warning severity (info-level issues are in `issues` only). */
  warnings: string[];
  /** Blocking problems; when non-empty, `text` only explains why nothing was generated. */
  errors: string[];
  /** Every issue validateSpec reported for this program. */
  issues: SpecIssue[];
}

/** The ORCA simple-input keywords, split into the method line and the job line. */
export interface OrcaKeywords {
  method: string[];
  job: string[];
}

/** Resolved RI setup: ORCA keywords for the "!" line (empty = exact integrals). */
export function orcaRiKeywords(spec: InputSpec): string[] {
  const fam = spec.method.family;
  const exc = spec.excited.method;
  const auxJ = spec.ri.auxJ?.trim() || 'def2/J';
  const auxC = spec.ri.auxC?.trim() || correlationAuxFor(spec.basis);
  const kind = fam === 'dft' ? functionalInfo(spec.method.functional)?.kind : undefined;
  if (isComposite(spec)) {
    return []; // 3c methods choose their own RI settings
  }
  const out: string[] = [];
  let mode = spec.ri.mode;
  if (mode === 'auto') {
    if (fam === 'dft') {
      mode = isHybrid(spec.method.functional) ? 'rijcosx' : 'rij';
    } else if (fam === 'hf') {
      mode = exc === 'eom-ccsd' ? 'none' : 'rijcosx';
    } else if (fam === 'mp2' || fam === 'dlpno-ccsd(t)') {
      mode = 'rijcosx';
    } else {
      mode = 'none'; // canonical CCSD(T), CASSCF, NEVPT2: exact integrals for benchmark-quality references
    }
  }
  switch (mode) {
    case 'rij': out.push('RI', auxJ); break;
    case 'rijcosx': out.push('RIJCOSX', auxJ); break;
    case 'rijk': out.push('RIJK', /^def2\/J$/i.test(auxJ) ? 'def2/JK' : auxJ); break;
    case 'none':
      if (fam === 'dft') {
        out.push('NoRI'); // ORCA 6 switches RI-J / RIJCOSX on by default for DFT
      }
      break;
  }
  const needsC = fam === 'dlpno-ccsd(t)' || (fam === 'mp2' && mode !== 'none') || kind === 'double-hybrid';
  if (needsC) {
    out.push(auxC);
  }
  return out;
}

function referenceKeyword(spec: InputSpec): string | undefined {
  const ref = effectiveReference(spec);
  if (spec.method.family === 'casscf' || spec.method.family === 'nevpt2') {
    return undefined; // CASSCF builds its own reference
  }
  const ks = spec.method.family === 'dft';
  if (ref === 'unrestricted') {
    return ks ? 'UKS' : 'UHF';
  }
  if (ref === 'restricted-open') {
    return ks ? 'ROKS' : 'ROHF';
  }
  return undefined;
}

export function orcaKeywords(spec: InputSpec): OrcaKeywords {
  const fam = spec.method.family;
  const exc = spec.excited.method;
  const method: string[] = [];
  const job: string[] = [];

  const ref = referenceKeyword(spec);
  if (ref) {
    method.push(ref);
  }
  switch (fam) {
    case 'hf': method.push(exc === 'eom-ccsd' ? 'EOM-CCSD' : 'HF'); break;
    case 'dft': method.push(spec.method.functional.trim()); break;
    case 'mp2': method.push(spec.ri.mode === 'none' ? 'MP2' : 'RI-MP2'); break;
    case 'ccsd': method.push('CCSD'); break;
    case 'ccsd(t)': method.push('CCSD(T)'); break;
    case 'dlpno-ccsd(t)': method.push('DLPNO-CCSD(T)'); break;
    case 'casscf': break; // the %casscf block alone selects CASSCF
    case 'nevpt2': method.push('SC-NEVPT2'); break; // strongly contracted, same flavour as PySCF mrpt.NEVPT
  }
  if (!isComposite(spec)) {
    method.push(spec.basis.trim());
  }
  method.push(...orcaRiKeywords(spec));
  const disp = effectiveDispersion(spec);
  if (disp !== 'none') {
    method.push(disp === 'd3bj' ? 'D3BJ' : 'D4');
  }
  if (fam === 'dlpno-ccsd(t)') {
    method.push({ loose: 'LoosePNO', normal: 'NormalPNO', tight: 'TightPNO' }[spec.method.pno ?? 'normal']);
  }

  // Job line: run type, convergence, solvation, frozen core.
  const optKw = { normal: 'Opt', tight: 'TightOpt', verytight: 'VeryTightOpt' }[spec.convergence.opt];
  const freqKw = fam === 'mp2' || fam === 'casscf' ? 'NumFreq' : 'Freq';
  switch (spec.job) {
    case 'sp': break;
    case 'opt': job.push(optKw); break;
    case 'freq': job.push(freqKw); break;
    case 'opt-freq': job.push(optKw, freqKw); break;
    case 'optts': job.push('OptTS'); break;
    case 'optts-freq': job.push('OptTS', freqKw); break;
    case 'scan': job.push(optKw); break;
  }
  if (spec.convergence.scf === 'tight') {
    job.push('TightSCF');
  } else if (spec.convergence.scf === 'verytight') {
    job.push('VeryTightSCF');
  }
  if (spec.solvation.model !== 'none') {
    job.push(`CPCM(${solventInfo(spec.solvation.solvent)?.id ?? spec.solvation.solvent})`);
  }
  if (!spec.frozenCore && (isCorrelated(fam) || exc === 'eom-ccsd')) {
    job.push('NoFrozenCore');
  }
  return { method, job };
}

function block(name: string, body: string[]): string[] {
  return [`%${name}`, ...body.map(l => `  ${l}`), 'end'];
}

const fmt = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

function scanLine(spec: InputSpec): string {
  const s = spec.scan;
  const digits = s.coordinate === 'B' ? 3 : 1;
  return `${s.coordinate} ${s.atoms.join(' ')} = ${s.start.toFixed(digits)}, ${s.end.toFixed(digits)}, ${s.points}`;
}

/** The %blocks (without %pal / %maxcore / coordinates), in a stable order. */
export function orcaBlocks(spec: InputSpec): string[] {
  const out: string[] = [];
  const exc = spec.excited.method;
  const fam = spec.method.family;

  if (exc === 'tddft') {
    const body = [`NRoots ${spec.excited.nroots}`, `TDA ${spec.excited.tda ? 'true' : 'false'}`];
    if (spec.excited.triplets) {
      body.push('Triplets true');
    }
    if (spec.excited.iroot > 0) {
      body.push(`IRoot ${spec.excited.iroot}`);
    }
    out.push(...block('tddft', body));
  }
  if (exc === 'eom-ccsd') {
    out.push(...block('mdci', [`NRoots ${spec.excited.nroots}`]));
  }
  if (fam === 'casscf' || fam === 'nevpt2') {
    const body = [`Nel ${spec.cas.nel}`, `Norb ${spec.cas.norb}`, `Mult ${spec.multiplicity}`, `NRoots ${spec.cas.nroots}`];
    out.push(...block('casscf', body));
  }
  if (spec.solvation.model === 'smd') {
    const name = solventInfo(spec.solvation.solvent)?.id ?? spec.solvation.solvent;
    out.push(...block('cpcm', ['SMD true', `SMDSolvent "${name}"`]));
  }
  const geom: string[] = [];
  if (isTsSearch(spec.job)) {
    if (spec.ts.calcHess) {
      geom.push('Calc_Hess true');
    }
    if (spec.ts.recalcHess > 0) {
      geom.push(`Recalc_Hess ${spec.ts.recalcHess}`);
    }
    if (spec.convergence.opt !== 'normal') {
      geom.push('Convergence Tight'); // TightOpt next to OptTS would read as a second job type
    }
  }
  if (spec.job === 'scan') {
    geom.push('Scan', `  ${scanLine(spec)}`, 'end');
  }
  if (geom.length > 0) {
    out.push(...block('geom', geom));
  }
  if (hasFrequencies(spec.job)) {
    const body = [`Temp ${fmt(spec.freq.temperature)}`];
    if (spec.freq.pressureAtm !== 1) {
      body.push(`Pressure ${fmt(spec.freq.pressureAtm)}`);
    }
    out.push(...block('freq', body));
  }
  return out;
}

function commentLines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trimEnd()).filter((l, i, a) => l.length > 0 || (i > 0 && i < a.length - 1)).map(l => (l ? `# ${l}` : '#'));
}

function errorText(spec: InputSpec, errors: string[]): string {
  return [
    `# ${spec.title || 'ORCA input'}`,
    '# Orbital Studio could not generate this ORCA input:',
    ...errors.map(e => `#   - ${e}`),
    ''
  ].join('\n');
}

export function buildOrcaInput(spec: InputSpec): GeneratedInput {
  const issues = validateSpec(spec, 'orca');
  const errors = issues.filter(i => i.severity === 'error').map(i => `${i.path}: ${i.message}`);
  const warnings = issues.filter(i => i.severity === 'warning').map(i => `${i.path}: ${i.message}`);
  if (errors.length > 0) {
    return { text: errorText(spec, errors), warnings, errors, issues };
  }

  const lines: string[] = [];
  lines.push(`# ${spec.title || 'ORCA job'}`);
  if (spec.comment.trim()) {
    lines.push(...commentLines(spec.comment));
  }
  lines.push(`# ${describeSpec(spec)}`);
  lines.push('# Generated by Orbital Studio for ORCA 6. Run with the full path: /path/to/orca job.inp > job.out');
  lines.push('');

  const kw = orcaKeywords(spec);
  lines.push(`! ${kw.method.join(' ')}`);
  if (kw.job.length > 0) {
    lines.push(`! ${kw.job.join(' ')}`);
  }
  lines.push('');

  if (spec.resources.nprocs > 1) {
    lines.push(`%pal nprocs ${spec.resources.nprocs} end`);
  }
  lines.push(`%maxcore ${spec.resources.maxcoreMB}`);

  const blocks = orcaBlocks(spec);
  if (blocks.length > 0) {
    lines.push('', ...blocks);
  }
  const extras = spec.extras.orca.trim();
  if (extras) {
    lines.push('', '# --- user additions ---', ...extras.split(/\r?\n/).map(l => l.trimEnd()));
  }
  lines.push('');

  const xyz = spec.geometry.xyzFile?.trim();
  if (xyz) {
    lines.push(`* xyzfile ${spec.charge} ${spec.multiplicity} ${xyz}`);
  } else {
    lines.push(`* xyz ${spec.charge} ${spec.multiplicity}`, ...formatAtomLines(spec.geometry.atoms), '*');
  }
  if (spec.job === 'optts-freq') {
    lines.push(
      '',
      '# Next step (IRC from this TS): same "!" method line with IRC instead of OptTS Freq,',
      '# the optimized geometry (job.xyz) and the Hessian of this run:',
      '#   %irc InitHess read Hess_Filename "job.hess" end'
    );
  }
  lines.push('');
  return { text: lines.join('\n'), warnings, errors, issues };
}
