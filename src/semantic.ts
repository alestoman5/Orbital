// Semantic (chemistry-aware) checks on an .inp file, on top of the purely
// structural ones in diagnostics.ts: charge/multiplicity parity, atom
// order against a reference, conflicting runtypes, OptTS without a
// Hessian, %tddft without NRoots, memory over-subscription, several
// orbital basis sets on the "!" line. Pure logic, no `vscode` import —
// diagnostics.ts turns the findings into vscode.Diagnostics.

import { BASIS_KEYWORDS } from './keywords';
import { parseOrcaInput } from './chem/inputFile';
import { checkAtomOrder, checkChargeMultiplicity } from './chem/geometry';

export type FindingSeverity = 'error' | 'warning' | 'information';

export interface Finding {
  line: number;
  severity: FindingSeverity;
  message: string;
}

export interface SemanticOptions {
  /** Atoms of an external xyzfile, if the caller could read it. */
  xyzFileAtoms?: string[];
  /** Reference element order, e.g. ["C", "O", "O", "H", "H"]; empty/undefined = check off. */
  referenceAtomOrder?: string[];
  /** Physical memory in MB, for the %maxcore check; undefined = check off. */
  totalMemoryMB?: number;
}

const JOB_KINDS: { kind: string; re: RegExp }[] = [
  { kind: 'Opt', re: /^(OPT|NORMALOPT|LOOSEOPT|TIGHTOPT|VERYTIGHTOPT|COPT|L-OPT|L-OPTH|EXTOPT)$/i },
  { kind: 'OptTS', re: /^OPTTS$/i },
  { kind: 'ScanTS', re: /^SCANTS$/i },
  { kind: 'IRC', re: /^IRC$/i },
  { kind: 'NEB', re: /^(ZOOM-|FAST-|FLAT-|LOOSE-|TIGHT-)?NEB(-TS|-CI|-IDPP|-MMFTS)?$/i },
  { kind: 'MD', re: /^MD$/i },
  { kind: 'GOAT', re: /^GOAT$/i }
];

// Basis-set-looking tokens that are not in BASIS_KEYWORDS literally.
const BASIS_PATTERN_RES = [
  /^(aug-|d-aug-)?cc-p(w?C)?V[DTQ56](\+d)?Z(-DK3?|-PP|-F12)?$/i,
  /^(ma-)?(DKH|ZORA)-def2-/i,
  /^(aug-)?(pcseg|pcSseg|pc)-\d$/i
];

/** True for an orbital (not auxiliary) basis-set token on the "!" line. */
export function isOrbitalBasis(token: string): boolean {
  if (token.includes('/')) {
    return false; // auxiliary basis (def2/J, cc-pVTZ/C, ...)
  }
  const lower = token.toLowerCase();
  return BASIS_KEYWORDS.some(b => b.toLowerCase() === lower) || BASIS_PATTERN_RES.some(r => r.test(token));
}

function firstKeywordLine(lines: string[], predicate: (tok: string) => boolean): number {
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].split('#')[0];
    if (/^\s*!/.test(code) && code.trim().slice(1).trim().split(/\s+/).some(predicate)) {
      return i;
    }
  }
  return 0;
}

function blockLine(lines: string[], name: string): number {
  const re = new RegExp(`^\\s*%${name}\\b`, 'i');
  return lines.findIndex(l => re.test(l));
}

/** Text of a %block from its header to the matching "end" (inclusive), or ''. */
function blockText(lines: string[], name: string): string {
  const start = blockLine(lines, name);
  if (start < 0) {
    return '';
  }
  if (/\bend\s*$/i.test(lines[start].split('#')[0])) {
    return lines[start];
  }
  let depth = 0;
  const out: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const code = lines[i].split('#')[0];
    out.push(code);
    if (/^\s*(Constraints|Scan|Nuclei)\b/i.test(code) && !/\bend\s*$/i.test(code)) {
      depth++;
    } else if (/^\s*end\b/i.test(code)) {
      if (depth === 0) {
        break;
      }
      depth--;
    }
  }
  return out.join('\n');
}

export function semanticFindings(text: string, options: SemanticOptions = {}): Finding[] {
  const input = parseOrcaInput(text);
  const { lines, keywords, coords } = input;
  const findings: Finding[] = [];
  const upper = keywords.map(k => k.toUpperCase());

  // 1. Charge / multiplicity parity (inline atoms or a readable xyzfile).
  if (coords) {
    const symbols = coords.atoms.length > 0 ? coords.atoms.map(a => a.symbol) : options.xyzFileAtoms;
    if (symbols && symbols.length > 0) {
      const problem = checkChargeMultiplicity(symbols, coords.charge, coords.multiplicity);
      if (problem) {
        findings.push({ line: coords.headerLine, severity: 'error', message: `Charge/multiplicity: ${problem}` });
      }

      // 2. Atom order against the configured reference.
      const ref = options.referenceAtomOrder;
      if (ref && ref.length > 0) {
        const mismatch = checkAtomOrder(symbols, ref);
        if (mismatch) {
          let line = coords.headerLine;
          let message: string;
          if ('index' in mismatch) {
            line = coords.atoms[mismatch.index]?.line ?? coords.headerLine;
            message = `Atom ${mismatch.index + 1} is ${mismatch.found}, but the reference order (orcaInp.referenceAtomOrder = "${ref.join(' ')}") expects ${mismatch.expected}. Downstream scripts (Wigner, MD, ML) rely on a fixed atom order.`;
          } else {
            message = `${mismatch.lengthFound} atoms, but the reference order (orcaInp.referenceAtomOrder) has ${mismatch.lengthExpected}.`;
          }
          findings.push({ line, severity: 'warning', message });
        }
      }
    }
  }

  // 3. Conflicting runtypes.
  const kinds = new Set<string>();
  for (const tok of upper) {
    for (const { kind, re } of JOB_KINDS) {
      if (re.test(tok)) {
        kinds.add(kind);
      }
    }
  }
  if (kinds.size > 1) {
    const kindList = [...kinds];
    findings.push({
      line: firstKeywordLine(lines, t => JOB_KINDS.some(k => k.re.test(t))),
      severity: 'warning',
      message: `Several job types on the "!" line (${kindList.join(', ')}) — ORCA runs only one; use $new_job or %compound for multi-step jobs.`
    });
  }

  // 4. OptTS without a Hessian to start from.
  if (kinds.has('OptTS')) {
    const geom = blockText(lines, 'geom');
    if (!/\b(Calc_Hess\s+true|InHess\b|Recalc_Hess)/i.test(geom) && !upper.some(t => /NEB-TS/.test(t))) {
      findings.push({
        line: firstKeywordLine(lines, t => /^OPTTS$/i.test(t)),
        severity: 'information',
        message: 'OptTS without an exact starting Hessian: add %geom Calc_Hess true end (or InHess Read + InHessName) — a model Hessian often misses the TS mode.'
      });
    }
  }

  // 5. Freq on a geometry that doesn't come from an optimization.
  const hasFreq = upper.some(t => /^(FREQ|NUMFREQ|ANFREQ)$/.test(t));
  if (hasFreq && kinds.size === 0 && coords && coords.type === 'xyz') {
    findings.push({
      line: firstKeywordLine(lines, t => /^(FREQ|NUMFREQ|ANFREQ)$/i.test(t)),
      severity: 'information',
      message: 'Frequencies without Opt on an inline geometry: they are only meaningful at a stationary point optimized with the same method/basis.'
    });
  }

  // 6. %tddft / %cis without NRoots.
  for (const name of ['tddft', 'cis']) {
    const block = blockText(lines, name);
    if (block && !/\bnroots\b/i.test(block)) {
      findings.push({
        line: blockLine(lines, name),
        severity: 'information',
        message: `%${name} without NRoots — ORCA falls back to its default number of states; set NRoots explicitly for reproducible spectra.`
      });
    }
  }

  // 7. %maxcore x nprocs vs. physical memory.
  if (options.totalMemoryMB !== undefined) {
    const maxcoreLine = lines.findIndex(l => /^\s*%maxcore\s+\d+/i.test(l));
    if (maxcoreLine >= 0) {
      const maxcore = parseInt(/%maxcore\s+(\d+)/i.exec(lines[maxcoreLine])![1], 10);
      const palBlock = /nprocs\s+(\d+)/i.exec(blockText(lines, 'pal'));
      const palKw = upper.map(t => /^PAL(\d+)$/.exec(t)).find(m => m);
      const nprocs = palBlock ? parseInt(palBlock[1], 10) : palKw ? parseInt(palKw[1], 10) : 1;
      const total = maxcore * nprocs;
      if (total > 0.75 * options.totalMemoryMB) {
        findings.push({
          line: maxcoreLine,
          severity: 'warning',
          message: `%maxcore ${maxcore} MB x ${nprocs} process(es) = ${total} MB, more than 75 % of this machine's ${Math.round(options.totalMemoryMB)} MB — ORCA may run out of memory (it can exceed %maxcore). Ignore if the job runs on another machine.`
        });
      }
    }
  }

  // 8. More than one orbital basis set.
  const bases = keywords.filter(isOrbitalBasis);
  if (bases.length > 1) {
    findings.push({
      line: firstKeywordLine(lines, isOrbitalBasis),
      severity: 'warning',
      message: `Several orbital basis sets on the "!" line (${bases.join(', ')}) — only one is used.`
    });
  }

  return findings;
}
