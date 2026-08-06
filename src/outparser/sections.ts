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

import { GeometryAtom, OptCycle, OptCycleMetric, OrcaStatus, ScfCycle } from './types';

export interface SectionResult<T> {
  value: T;
  nextIndex: number;
}

// --- 1. Termination status --------------------------------------------

const NORMAL_TERMINATION_MARKER = '****ORCA TERMINATED NORMALLY****';
const ABORT_MARKER = 'ABORTING THE RUN';

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
    if (line.includes(ABORT_MARKER)) {
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
