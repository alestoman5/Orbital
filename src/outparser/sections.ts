// One exported function per .out section, each taking the whole file split
// into `lines` plus a `startIndex` to scan forward from, and returning the
// parsed data plus the index the caller should resume scanning from
// (`nextIndex`). Every parser is tolerant of a truncated/mid-write file: if
// a block opens but never closes, whatever was parsed before the text ran
// out is returned instead of throwing.
//
// Confidence notes (per section, see individual doc comments below):
//   - HIGH confidence (directly matches widely-documented, stable ORCA
//     output strings): termination banner, FINAL SINGLE POINT ENERGY,
//     CARTESIAN COORDINATES (ANGSTROEM), TOTAL RUN TIME, "Warning:" lines.
//   - BEST-EFFORT / TODO (table layout not independently verified against
//     a real ORCA 6.x run in this environment — regexes are written to be
//     tolerant of minor spacing/column differences, but the exact header
//     wording could be off): geometry-convergence table, SCF iteration log.
//     If real output disagrees, these are the two parsers to re-check first.

import { Excitation, GeometryAtom, OptCycle, OptCycleMetric, OrcaStatus, ScfCycle } from './types';
import { columnsOf, parseColumnBlockMatrix } from '../chem/hess';
import { EV_TO_CM1 } from '../chem/elements';

export interface SectionResult<T> {
  value: T;
  nextIndex: number;
}

// --- 1. Termination status --------------------------------------------

const NORMAL_TERMINATION_MARKER = '****ORCA TERMINATED NORMALLY****';
// ORCA 5 prints "ABORTING THE RUN"; ORCA 6 prints "... aborting the run" (lower case).
const ABORT_MARKER_RE = /aborting the run/i;

/**
 * HIGH confidence. Scans forward from `startIndex` for ORCA's normal-
 * termination banner or its "aborting" marker. If neither is found before
 * the text runs out, the job is assumed still running (unless the scanned
 * region had no content at all, in which case the status is 'unknown').
 */
export function parseTerminationStatus(lines: string[], startIndex: number): SectionResult<OrcaStatus> {
  let sawContent = false;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length > 0) {
      sawContent = true;
    }
    if (line.includes(NORMAL_TERMINATION_MARKER)) {
      return { value: 'normal-termination', nextIndex: i + 1 };
    }
    if (ABORT_MARKER_RE.test(line)) {
      return { value: 'error', nextIndex: i + 1 };
    }
  }
  return { value: sawContent ? 'running' : 'unknown', nextIndex: lines.length };
}

// --- 2. FINAL SINGLE POINT ENERGY ---------------------------------------

const FINAL_ENERGY_RE = /FINAL SINGLE POINT ENERGY\s+(-?\d+\.\d+)/;

/**
 * HIGH confidence. `FINAL SINGLE POINT ENERGY` followed by the energy in
 * Hartree is a stable, well-known ORCA output line, e.g.:
 *   FINAL SINGLE POINT ENERGY       -76.338381235905
 * If the run errors out before this line is printed, `value` is undefined.
 */
export function parseFinalSinglePointEnergy(
  lines: string[],
  startIndex: number
): SectionResult<number | undefined> {
  for (let i = startIndex; i < lines.length; i++) {
    const m = FINAL_ENERGY_RE.exec(lines[i]);
    if (m) {
      return { value: parseFloat(m[1]), nextIndex: i + 1 };
    }
  }
  return { value: undefined, nextIndex: lines.length };
}

// --- 3. Geometry optimization cycles ------------------------------------

// "GEOMETRY OPTIMIZATION CYCLE   N" is its own banner, printed *before* that
// cycle's CARTESIAN COORDINATES block, which in turn comes *before* the
// "Geometry convergence" table — so the table is not adjacent to the cycle
// header. parseOptCycle below only owns the table itself (exactly what the
// task's phase-1 spec calls out: "parse the Geometry convergence table");
// tracking which cycle a table belongs to is simple sequential bookkeeping
// left to the orchestrator (parse.ts), the same way diagnostics.ts tracks
// `blockStack`/`coordOpenLine` as loop-local state rather than its own
// section parser.
export const OPT_CYCLE_HEADER_RE = /GEOMETRY OPTIMIZATION CYCLE\s+(\d+)/;
const CONVERGENCE_TITLE_RE = /Geometry convergence/i;
const CONVERGENCE_COLUMNS_RE = /Item\s+value\s+Tolerance\s+Converged/i;
const CONVERGENCE_DASHES_RE = /^\s*-+\s*$/;
const CONVERGENCE_ROW_RE =
  /^\s*(Energy change|RMS gradient|MAX gradient|RMS step|MAX step)\s+(-?[\d.]+)\s+([\d.]+)\s+(YES|NO)\b/i;

const METRIC_FIELD: Record<string, keyof Pick<OptCycle, 'energyChange' | 'rmsGradient' | 'maxGradient' | 'rmsStep' | 'maxStep'>> = {
  'energy change': 'energyChange',
  'rms gradient': 'rmsGradient',
  'max gradient': 'maxGradient',
  'rms step': 'rmsStep',
  'max step': 'maxStep'
};

/**
 * BEST-EFFORT / TODO: not independently verified against a real ORCA 6.x
 * run in this environment. Expects `lines[startIndex]` to be the
 * "Geometry convergence" table's title line, then scans forward for its
 * five metric rows (Energy change / RMS gradient / MAX gradient / RMS step
 * / MAX step, each "<value> <tolerance> YES|NO"), tolerating the table's own
 * column-header and dashed-underline decoration in between. Stops at the
 * first line that isn't a metric row or table decoration (e.g. a blank
 * line, or unrelated content following a truncated table), so it never
 * consumes content that belongs to another section. `cycleNumber` — looked
 * up by the caller from the preceding "GEOMETRY OPTIMIZATION CYCLE   N"
 * banner — is copied straight into the result. `allConverged` is only true
 * when all five rows were found and all reported YES.
 */
export function parseOptCycle(
  lines: string[],
  startIndex: number,
  cycleNumber = 0
): SectionResult<OptCycle | undefined> {
  if (!CONVERGENCE_TITLE_RE.test(lines[startIndex])) {
    return { value: undefined, nextIndex: startIndex + 1 };
  }
  const cycle: OptCycle = { cycle: cycleNumber, allConverged: false };
  let foundCount = 0;
  let allYes = true;
  let i = startIndex + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const row = CONVERGENCE_ROW_RE.exec(line);
    if (row) {
      const field = METRIC_FIELD[row[1].toLowerCase()];
      const metric: OptCycleMetric = {
        value: parseFloat(row[2]),
        tolerance: parseFloat(row[3]),
        converged: row[4].toUpperCase() === 'YES'
      };
      cycle[field] = metric;
      foundCount++;
      allYes = allYes && metric.converged;
      continue;
    }
    if (CONVERGENCE_DASHES_RE.test(line) || CONVERGENCE_COLUMNS_RE.test(line)) {
      continue; // table's own decoration — keep scanning
    }
    break; // anything else ends the table (done, or truncated file)
  }
  cycle.allConverged = foundCount === 5 && allYes;
  return { value: cycle, nextIndex: i };
}

// --- 4. Final CARTESIAN COORDINATES (ANGSTROEM) block -------------------

const CARTESIAN_HEADER_RE = /^\s*CARTESIAN COORDINATES \(ANGSTROEM\)\s*$/;
const ATOM_LINE_RE = /^\s*([A-Za-z]{1,3})\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/;

/**
 * HIGH confidence. Expects `lines[startIndex]` to be the
 * "CARTESIAN COORDINATES (ANGSTROEM)" header, followed by a dashed
 * underline and then one "<element> <x> <y> <z>" row per atom, terminated
 * by a blank line (or end of input, if truncated mid-block). A .out file
 * prints this block multiple times (e.g. once per optimization step); the
 * caller is responsible for keeping only the last one seen before
 * termination — this function just parses whichever occurrence starts at
 * `startIndex`.
 */
export function parseCartesianCoordinatesBlock(
  lines: string[],
  startIndex: number
): SectionResult<GeometryAtom[] | undefined> {
  if (!CARTESIAN_HEADER_RE.test(lines[startIndex])) {
    return { value: undefined, nextIndex: startIndex + 1 };
  }
  let i = startIndex + 1;
  // Skip the dashed underline, if present.
  if (i < lines.length && /^\s*-+\s*$/.test(lines[i])) {
    i++;
  }
  const atoms: GeometryAtom[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i++; // consume the trailing blank line
      break;
    }
    const m = ATOM_LINE_RE.exec(line);
    if (!m) {
      break; // not an atom row — block is done (or malformed; stop here)
    }
    atoms.push({ symbol: m[1], x: parseFloat(m[2]), y: parseFloat(m[3]), z: parseFloat(m[4]) });
  }
  return { value: atoms, nextIndex: i };
}

// --- 4b. CARTESIAN COORDINATES (A.U.) block --------------------------------

export const CARTESIAN_AU_HEADER_RE = /^\s*CARTESIAN COORDINATES \(A\.U\.\)\s*$/;
const AU_ATOM_LINE_RE =
  /^\s*\d+\s+([A-Za-z]{1,3})\s+-?\d+\.\d+\s+\d+\s+(\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/;

/**
 * HIGH confidence. The bohr-unit twin of the Ångström block, with masses:
 *   CARTESIAN COORDINATES (A.U.)
 *   ----------------------------
 *     NO LB      ZA    FRAG     MASS         X           Y           Z
 *      0 N     7.0000    0    14.007    0.171609   -0.001087    0.113020
 * Kept because SHARC's ORCA_freq.py writes these exact (6-decimal bohr)
 * values into Molden files; converting the Å block instead differs in the
 * last digit. Rows end at the first non-matching line.
 */
export function parseCartesianBohrBlock(
  lines: string[],
  startIndex: number
): SectionResult<{ symbol: string; mass: number; xBohr: number; yBohr: number; zBohr: number }[]> {
  if (!CARTESIAN_AU_HEADER_RE.test(lines[startIndex])) {
    return { value: [], nextIndex: startIndex + 1 };
  }
  const atoms: { symbol: string; mass: number; xBohr: number; yBohr: number; zBohr: number }[] = [];
  let i = startIndex + 1;
  for (; i < lines.length; i++) {
    const m = AU_ATOM_LINE_RE.exec(lines[i]);
    if (m) {
      atoms.push({
        symbol: m[1],
        mass: parseFloat(m[2]),
        xBohr: parseFloat(m[3]),
        yBohr: parseFloat(m[4]),
        zBohr: parseFloat(m[5])
      });
      continue;
    }
    if (atoms.length > 0 || i - startIndex > 4) {
      break;
    }
  }
  return { value: atoms, nextIndex: i };
}

// --- 5. TOTAL RUN TIME ---------------------------------------------------

const RUN_TIME_RE =
  /TOTAL RUN TIME:\s*(\d+)\s*days?\s*(\d+)\s*hours?\s*(\d+)\s*minutes?\s*(\d+)\s*seconds?\s*(\d+)\s*msec/i;

/**
 * HIGH confidence. "TOTAL RUN TIME: 0 days 0 hours 0 minutes 12 seconds 456
 * msec" is ORCA's standard closing line, printed right after the
 * termination banner. Converts to total seconds (as a float, msec folded
 * into the fractional part).
 */
export function parseTotalRunTime(lines: string[], startIndex: number): SectionResult<number | undefined> {
  for (let i = startIndex; i < lines.length; i++) {
    const m = RUN_TIME_RE.exec(lines[i]);
    if (m) {
      const [, days, hours, minutes, seconds, msec] = m;
      const total =
        parseInt(days, 10) * 86400 +
        parseInt(hours, 10) * 3600 +
        parseInt(minutes, 10) * 60 +
        parseInt(seconds, 10) +
        parseInt(msec, 10) / 1000;
      return { value: total, nextIndex: i + 1 };
    }
  }
  return { value: undefined, nextIndex: lines.length };
}

// --- 6. Warning: lines ----------------------------------------------------

const WARNING_RE = /^\s*Warning:\s*(.*)$/;

/**
 * HIGH confidence. ORCA prints ad-hoc "Warning: ..." lines throughout a
 * .out file (SCF, geometry, input-sanity warnings, etc). Only checks
 * `lines[startIndex]` — the caller drives this one line at a time as part
 * of its scan, same as any other per-line dispatch.
 */
export function parseWarningLine(lines: string[], startIndex: number): SectionResult<string | undefined> {
  const m = WARNING_RE.exec(lines[startIndex]);
  return { value: m ? m[1].trim() : undefined, nextIndex: startIndex + 1 };
}

// --- SCF iteration log (best-effort; not in the Phase 1 priority list,
//     but the JobSegment shape asks for it) --------------------------------

const SCF_HEADER_RE = /ITER\s+Energy\s+Delta-E/i;
const SCF_ROW_RE = /^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/;

/**
 * BEST-EFFORT / TODO: not independently verified against a real ORCA 6.x
 * run in this environment — the "ITER Energy Delta-E ..." header and
 * per-iteration row format are recalled from general familiarity with
 * ORCA's SCF log, not confirmed against current output. Expects
 * `lines[startIndex]` to be that header line, then collects consecutive
 * "<iter> <energy> <deltaE> ..." rows until a non-matching line appears.
 */
export function parseScfIterations(lines: string[], startIndex: number): SectionResult<ScfCycle[]> {
  if (!SCF_HEADER_RE.test(lines[startIndex])) {
    return { value: [], nextIndex: startIndex + 1 };
  }
  const cycles: ScfCycle[] = [];
  let i = startIndex + 1;
  for (; i < lines.length; i++) {
    const row = SCF_ROW_RE.exec(lines[i]);
    if (!row) {
      // Tolerate one non-matching decorative line (e.g. "*** Starting
      // incremental Fock matrix formation ***") before giving up, since
      // ORCA interleaves those with the numeric rows.
      if (lines[i].trim().length === 0 || /^\s*\*+/.test(lines[i])) {
        continue;
      }
      break;
    }
    cycles.push({ cycle: parseInt(row[1], 10), energy: parseFloat(row[2]), deltaE: parseFloat(row[3]) });
  }
  return { value: cycles, nextIndex: i };
}

// --- 7. VIBRATIONAL FREQUENCIES ------------------------------------------

export const VIB_FREQ_HEADER_RE = /^\s*VIBRATIONAL FREQUENCIES\s*$/;
const VIB_FREQ_ROW_RE = /^\s*(\d+):\s+(-?\d+\.\d+)\s+cm\*\*-1/;

/**
 * HIGH confidence. Expects `lines[startIndex]` to be the "VIBRATIONAL
 * FREQUENCIES" title, followed by a dashed underline, a "Scaling factor
 * for frequencies" line and then one row per Cartesian dof:
 *      0:         0.00 cm**-1
 *      6:      -312.45 cm**-1 ***imaginary mode***
 * Imaginary modes are printed as negative numbers. Stops at the first
 * non-row line after the rows start.
 */
export function parseVibrationalFrequencies(lines: string[], startIndex: number): SectionResult<number[]> {
  if (!VIB_FREQ_HEADER_RE.test(lines[startIndex])) {
    return { value: [], nextIndex: startIndex + 1 };
  }
  const freqs: number[] = [];
  let i = startIndex + 1;
  for (; i < lines.length; i++) {
    const row = VIB_FREQ_ROW_RE.exec(lines[i]);
    if (row) {
      freqs[parseInt(row[1], 10)] = parseFloat(row[2]);
      continue;
    }
    if (freqs.length > 0 || i - startIndex > 8) {
      break; // table done, or preamble much longer than expected
    }
  }
  return { value: Array.from(freqs, f => (f === undefined ? NaN : f)), nextIndex: i };
}

// --- 7b. IR SPECTRUM ------------------------------------------------------

export const IR_SPECTRUM_HEADER_RE = /^\s*IR SPECTRUM\s*$/;
const IR_ROW_RE = /^\s*(\d+):\s+(-?\d+\.\d+)\s+(\d+\.\d+)/;

/**
 * HIGH confidence. Rows of the "IR SPECTRUM" table,
 *   "  6:     25.38   0.000013    0.07  0.000164  ( 0.000003  0.012801 -0.000088)",
 * keyed by mode index; returns the eps column (L/(mol*cm)), which is what
 * SHARC's ORCA_freq.py writes into the Molden [INT] section. Modes without
 * a row (translations/rotations) are 0.
 */
export function parseIrSpectrum(lines: string[], startIndex: number): SectionResult<number[]> {
  if (!IR_SPECTRUM_HEADER_RE.test(lines[startIndex])) {
    return { value: [], nextIndex: startIndex + 1 };
  }
  const eps: number[] = [];
  let sawRow = false;
  let i = startIndex + 1;
  for (; i < lines.length; i++) {
    const row = IR_ROW_RE.exec(lines[i]);
    if (row) {
      eps[parseInt(row[1], 10)] = parseFloat(row[3]);
      sawRow = true;
      continue;
    }
    if (sawRow || i - startIndex > 8) {
      break;
    }
  }
  return { value: Array.from(eps, e => (e === undefined ? 0 : e)), nextIndex: i };
}

// --- 8. NORMAL MODES ------------------------------------------------------

export const NORMAL_MODES_HEADER_RE = /^\s*NORMAL MODES\s*$/;

/**
 * HIGH confidence for the layout (same column-block matrix as the .hess
 * file's $normal_modes, 6 columns per block in .out). Expects
 * `lines[startIndex]` to be the "NORMAL MODES" title; `nDof` (3N) comes
 * from the preceding VIBRATIONAL FREQUENCIES table. Returns modes[k] =
 * 3N-long Cartesian displacement vector of mode k.
 */
export function parseNormalModes(lines: string[], startIndex: number, nDof: number): SectionResult<number[][]> {
  if (!NORMAL_MODES_HEADER_RE.test(lines[startIndex]) || nDof <= 0) {
    return { value: [], nextIndex: startIndex + 1 };
  }
  const { matrix, nextIndex } = parseColumnBlockMatrix(lines, startIndex + 1, nDof, nDof);
  return { value: columnsOf(matrix), nextIndex };
}

// --- 9. Thermochemistry (single lines) -------------------------------------

export type ThermoKey = 'enthalpy' | 'entropy' | 'gibbs' | 'temperatureK';

const THERMO_LINE_RES: { key: ThermoKey; re: RegExp }[] = [
  { key: 'enthalpy', re: /^\s*Total Enthalpy\s+\.\.\.\s+(-?\d+\.\d+)\s+Eh/ },
  { key: 'entropy', re: /^\s*Total entropy correction\s+\.\.\.\s+(-?\d+\.\d+)\s+Eh/ },
  { key: 'gibbs', re: /^\s*Final Gibbs free energy\s+\.\.\.\s+(-?\d+\.\d+)\s+Eh/ },
  { key: 'temperatureK', re: /^\s*Temperature\s+\.\.\.\s+(\d+\.\d+)\s+K/ }
];

/**
 * HIGH confidence. ORCA's THERMOCHEMISTRY section prints one quantity per
 * line ("Total Enthalpy   ...   -76.29... Eh", "Final Gibbs free energy
 * ...", "Temperature ... 298.15 K"). Checks only `lines[startIndex]`; the
 * caller merges the per-line results.
 */
export function parseThermoLine(
  lines: string[],
  startIndex: number
): SectionResult<{ key: ThermoKey; value: number } | undefined> {
  const line = lines[startIndex];
  for (const { key, re } of THERMO_LINE_RES) {
    const m = re.exec(line);
    if (m) {
      return { value: { key, value: parseFloat(m[1]) }, nextIndex: startIndex + 1 };
    }
  }
  return { value: undefined, nextIndex: startIndex + 1 };
}

// --- 10. ABSORPTION SPECTRUM (electric dipole) ------------------------------

export const ABSORPTION_HEADER_RE = /^\s*ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS\s*$/;
const NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)';
// ORCA 6.x: "  0-1A  ->  1-1A    4.271398   34451.2   290.3   0.012345678   0.12345   0.10000   0.20000   0.30000"
const ABS_ROW_ORCA6_RE = new RegExp(
  `^\\s*(\\S+)\\s*->\\s*(\\S+)\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s*$`
);
// ORCA 5.x: "   1   34451.2    290.3   0.012345678   0.12345   0.10000   0.20000   0.30000"
const ABS_ROW_ORCA5_RE = new RegExp(
  `^\\s*(\\d+)\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s*$`
);

/**
 * HIGH confidence for the ORCA 6 layout (transition, E[eV], E[cm-1],
 * λ[nm], fosc, D2, DX, DY, DZ — the same columns the claude_chem NEA
 * scripts parse) and the ORCA 5 layout (state, E[cm-1], λ, fosc, T2, TX,
 * TY, TZ). Only the plain electric-dipole table matches — "SOC CORRECTED
 * ..." and velocity-gauge tables have different titles. Skips the column
 * header and dashes, then reads rows until the first non-row line.
 */
export function parseAbsorptionSpectrum(lines: string[], startIndex: number): SectionResult<Excitation[]> {
  if (!ABSORPTION_HEADER_RE.test(lines[startIndex])) {
    return { value: [], nextIndex: startIndex + 1 };
  }
  const rows: Excitation[] = [];
  let i = startIndex + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m6 = ABS_ROW_ORCA6_RE.exec(line);
    if (m6) {
      const [, , to, ev, cm, nm, f, d2, dx, dy, dz] = m6;
      const stateNum = parseInt(to, 10);
      rows.push({
        state: Number.isFinite(stateNum) ? stateNum : rows.length + 1,
        label: to,
        energyEv: parseFloat(ev),
        energyCm1: parseFloat(cm),
        wavelengthNm: parseFloat(nm),
        fosc: parseFloat(f),
        d2: parseFloat(d2),
        dx: parseFloat(dx),
        dy: parseFloat(dy),
        dz: parseFloat(dz)
      });
      continue;
    }
    const m5 = ABS_ROW_ORCA5_RE.exec(line);
    if (m5) {
      const [, st, cm, nm, f, d2, dx, dy, dz] = m5;
      rows.push({
        state: parseInt(st, 10),
        energyEv: parseFloat(cm) / EV_TO_CM1,
        energyCm1: parseFloat(cm),
        wavelengthNm: parseFloat(nm),
        fosc: parseFloat(f),
        d2: parseFloat(d2),
        dx: parseFloat(dx),
        dy: parseFloat(dy),
        dz: parseFloat(dz)
      });
      continue;
    }
    if (rows.length > 0 || i - startIndex > 8) {
      break;
    }
  }
  return { value: rows, nextIndex: i };
}

// --- 11. Single-line status markers ------------------------------------------

export type StatusMarker =
  | { kind: 't1'; value: number }
  | { kind: 'd1'; value: number }
  | { kind: 'scf'; converged: boolean }
  | { kind: 'opt'; converged: boolean };

const T1_RE = /^\s*T1 diagnostic\s*(?:\.\.\.)?\s*(\d+\.\d+)/i;
const D1_RE = /^\s*D1 diagnostic\s*(?:\.\.\.)?\s*(\d+\.\d+)/i;
const SCF_CONVERGED_RE = /SCF CONVERGED AFTER\s+\d+\s+CYCLES/i;
const SCF_NOT_CONVERGED_RE = /SCF NOT CONVERGED AFTER/i;
const OPT_CONVERGED_RE = /THE OPTIMIZATION HAS CONVERGED/i;
const OPT_NOT_CONVERGED_RE = /The optimization did not converge/i;

/**
 * HIGH confidence for the SCF/optimizer banners ("SCF CONVERGED AFTER 12
 * CYCLES", "SCF NOT CONVERGED AFTER 125 CYCLES", "THE OPTIMIZATION HAS
 * CONVERGED", "The optimization did not converge but reached the maximum
 * number of optimization cycles"). BEST-EFFORT for the MDCI diagnostics
 * wording ("T1 diagnostic ... 0.0123", "D1 diagnostic ... 0.0456") — not
 * verified against a real ORCA 6.x CCSD run. Checks only `lines[startIndex]`.
 */
export function parseStatusMarker(lines: string[], startIndex: number): SectionResult<StatusMarker | undefined> {
  const line = lines[startIndex];
  let m: RegExpExecArray | null;
  let value: StatusMarker | undefined;
  if ((m = T1_RE.exec(line))) {
    value = { kind: 't1', value: parseFloat(m[1]) };
  } else if ((m = D1_RE.exec(line))) {
    value = { kind: 'd1', value: parseFloat(m[1]) };
  } else if (SCF_NOT_CONVERGED_RE.test(line)) {
    value = { kind: 'scf', converged: false };
  } else if (SCF_CONVERGED_RE.test(line)) {
    value = { kind: 'scf', converged: true };
  } else if (OPT_CONVERGED_RE.test(line)) {
    value = { kind: 'opt', converged: true };
  } else if (OPT_NOT_CONVERGED_RE.test(line)) {
    value = { kind: 'opt', converged: false };
  }
  return { value, nextIndex: startIndex + 1 };
}

// --- 12. Input echo ------------------------------------------------------------

const INPUT_ECHO_RE = /^\|\s*\d+>\s?(.*)$/;

/**
 * HIGH confidence. ORCA reproduces the input deck near the top of the .out
 * as "|  1> ! PBE aug-cc-pVDZ TightOpt Freq". Collects every such line (in
 * order) with the prefix stripped, scanning from startIndex to the end.
 */
export function parseInputEcho(lines: string[], startIndex: number): SectionResult<string[]> {
  const echo: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const m = INPUT_ECHO_RE.exec(lines[i]);
    if (m) {
      echo.push(m[1]);
    }
  }
  return { value: echo, nextIndex: lines.length };
}
