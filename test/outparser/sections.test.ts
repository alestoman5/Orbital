import * as assert from 'assert';
import {
  parseCartesianCoordinatesBlock,
  parseFinalSinglePointEnergy,
  parseOptCycle,
  parseScfIterations,
  parseTerminationStatus,
  parseTotalRunTime,
  parseWarningLine
} from '../../src/outparser/sections';

function toLines(text: string): string[] {
  return text.split('\n');
}

describe('parseTerminationStatus', () => {
  it('recognizes normal termination', () => {
    const lines = toLines(`Some output\n****ORCA TERMINATED NORMALLY****\nTOTAL RUN TIME: 0 days 0 hours 0 minutes 1 seconds 0 msec\n`);
    const { value } = parseTerminationStatus(lines, 0);
    assert.strictEqual(value, 'normal-termination');
  });

  it('recognizes an aborted run', () => {
    const lines = toLines(`SCF NOT CONVERGED\nABORTING THE RUN\n`);
    const { value } = parseTerminationStatus(lines, 0);
    assert.strictEqual(value, 'error');
  });

  it('degrades to "running" when the file has content but no terminal marker (truncated mid-write)', () => {
    const lines = toLines(`Program Version 6.0.0\nSCF ITERATIONS\n  0    -76.01   0.0\n`);
    const { value } = parseTerminationStatus(lines, 0);
    assert.strictEqual(value, 'running');
  });

  it('reports "unknown" for an empty/blank file', () => {
    const lines = toLines(`\n\n`);
    const { value } = parseTerminationStatus(lines, 0);
    assert.strictEqual(value, 'unknown');
  });
});

describe('parseFinalSinglePointEnergy', () => {
  it('extracts the energy value', () => {
    const lines = toLines(
      `-------------------------   --------------------\nFINAL SINGLE POINT ENERGY       -76.338381235905\n-------------------------   --------------------\n`
    );
    const { value } = parseFinalSinglePointEnergy(lines, 0);
    assert.strictEqual(value, -76.338381235905);
  });

  it('returns undefined when the line never appears (truncated before energy is printed)', () => {
    const lines = toLines(`SCF ITERATIONS\n  0    -76.01   0.0\n`);
    const { value } = parseFinalSinglePointEnergy(lines, 0);
    assert.strictEqual(value, undefined);
  });
});

describe('parseOptCycle', () => {
  // Starts at the table's own title line — the preceding
  // "GEOMETRY OPTIMIZATION CYCLE   N" banner (and any CARTESIAN COORDINATES
  // block between it and this table) is the orchestrator's job, not this
  // function's; see parse.ts.
  const TABLE = [
    '          ----------------------|Geometry convergence|---------------------',
    '          Item                value                   Tolerance       Converged',
    '          ---------------------------------------------------------------------',
    '          Energy change       0.00000012            0.0000050000      YES',
    '          RMS gradient        0.00003456            0.0001000000      YES',
    '          MAX gradient        0.00008901            0.0003000000      NO',
    '          RMS step            0.00123456            0.0020000000      YES',
    '          MAX step            0.00234567            0.0040000000      YES',
    '          ---------------------------------------------------------------------'
  ];

  it('parses all five convergence metrics and tags the cycle number passed in', () => {
    const { value, nextIndex } = parseOptCycle(TABLE, 0, 2);
    assert.ok(value);
    assert.strictEqual(value!.cycle, 2);
    assert.strictEqual(value!.energyChange?.value, 0.00000012);
    assert.strictEqual(value!.energyChange?.converged, true);
    assert.strictEqual(value!.maxGradient?.converged, false);
    assert.strictEqual(value!.allConverged, false); // MAX gradient was NO
    assert.strictEqual(nextIndex, TABLE.length);
  });

  it('defaults cycle number to 0 when the caller does not pass one', () => {
    const { value } = parseOptCycle(TABLE, 0);
    assert.strictEqual(value!.cycle, 0);
  });

  it('reports allConverged=true only when every metric says YES', () => {
    const allYes = TABLE.map(l =>
      l.replace('MAX gradient        0.00008901            0.0003000000      NO', 'MAX gradient        0.00008901            0.0003000000      YES')
    );
    const { value } = parseOptCycle(allYes, 0, 2);
    assert.strictEqual(value!.allConverged, true);
  });

  it('stops at unrelated content following the table without consuming it', () => {
    const withTrailer = [...TABLE, '', '                          THE OPTIMIZATION HAS CONVERGED'];
    const { nextIndex } = parseOptCycle(withTrailer, 0, 2);
    assert.strictEqual(withTrailer[nextIndex].trim().length, 0); // stops at the blank line right after the table
  });

  it('degrades gracefully when the table is truncated mid-write (only two rows present)', () => {
    const truncated = TABLE.slice(0, 5); // title + columns + dashes + Energy change / RMS gradient rows
    const { value } = parseOptCycle(truncated, 0, 2);
    assert.ok(value);
    assert.strictEqual(value!.cycle, 2);
    assert.strictEqual(value!.energyChange?.value, 0.00000012);
    assert.strictEqual(value!.rmsGradient?.value, 0.00003456);
    assert.strictEqual(value!.maxGradient, undefined);
    assert.strictEqual(value!.allConverged, false); // not all 5 rows found
  });

  it('returns undefined when called on a line that is not the table title', () => {
    const { value, nextIndex } = parseOptCycle(['not a convergence table'], 0, 2);
    assert.strictEqual(value, undefined);
    assert.strictEqual(nextIndex, 1);
  });
});

describe('parseCartesianCoordinatesBlock', () => {
  const BLOCK = [
    'CARTESIAN COORDINATES (ANGSTROEM)',
    '---------------------------------',
    '  O      0.000000    0.000000    0.000000',
    '  H      0.000000    0.757000    0.586000',
    '  H      0.000000   -0.757000    0.586000',
    ''
  ];

  it('parses all atoms in the block', () => {
    const { value, nextIndex } = parseCartesianCoordinatesBlock(BLOCK, 0);
    assert.strictEqual(value?.length, 3);
    assert.deepStrictEqual(value?.[0], { symbol: 'O', x: 0, y: 0, z: 0 });
    assert.strictEqual(value?.[2].y, -0.757);
    assert.strictEqual(nextIndex, BLOCK.length);
  });

  it('returns whatever atoms were parsed when the block is truncated mid-write (no trailing blank line)', () => {
    const truncated = BLOCK.slice(0, 4); // header + dashes + O + H, cut off mid-block
    const { value } = parseCartesianCoordinatesBlock(truncated, 0);
    assert.strictEqual(value?.length, 2);
  });

  it('returns undefined and does not advance past the header line when called on a non-matching line', () => {
    const { value, nextIndex } = parseCartesianCoordinatesBlock(['not a coordinates header'], 0);
    assert.strictEqual(value, undefined);
    assert.strictEqual(nextIndex, 1);
  });
});

describe('parseTotalRunTime', () => {
  it('converts days/hours/minutes/seconds/msec into total seconds', () => {
    const lines = ['TOTAL RUN TIME: 0 days 0 hours 0 minutes 12 seconds 456 msec'];
    const { value } = parseTotalRunTime(lines, 0);
    assert.ok(value !== undefined);
    assert.ok(Math.abs(value! - 12.456) < 1e-9);
  });

  it('handles a run that took hours', () => {
    const lines = ['TOTAL RUN TIME: 1 days 2 hours 3 minutes 4 seconds 5 msec'];
    const { value } = parseTotalRunTime(lines, 0);
    const expected = 86400 + 2 * 3600 + 3 * 60 + 4 + 0.005;
    assert.ok(Math.abs(value! - expected) < 1e-9);
  });

  it('returns undefined when the line never appears (truncated/still running)', () => {
    const { value } = parseTotalRunTime(['still going...'], 0);
    assert.strictEqual(value, undefined);
  });
});

describe('parseWarningLine', () => {
  it('extracts the warning text', () => {
    const { value } = parseWarningLine(['Warning: the basis set is not fully optimized for this element'], 0);
    assert.strictEqual(value, 'the basis set is not fully optimized for this element');
  });

  it('returns undefined for a non-warning line', () => {
    const { value, nextIndex } = parseWarningLine(['just a regular line'], 0);
    assert.strictEqual(value, undefined);
    assert.strictEqual(nextIndex, 1);
  });
});

describe('parseScfIterations (best-effort)', () => {
  const BLOCK = [
    'ITER       Energy         Delta-E        Max-DP      RMS-DP      [F,P]     Damp',
    '               ***  Starting incremental Fock matrix formation  ***',
    '  0    -76.0122345698   0.000000000000 0.03456789  0.00123456  0.1234567 0.7000',
    '  1    -76.0234567891  -0.011222219300 0.02345678  0.00098765  0.0987654 0.7000',
    ''
  ];

  it('collects one ScfCycle per numbered row, skipping decorative lines', () => {
    const { value } = parseScfIterations(BLOCK, 0);
    assert.strictEqual(value.length, 2);
    assert.strictEqual(value[0].cycle, 0);
    assert.strictEqual(value[1].deltaE, -0.0112222193);
  });

  it('degrades gracefully when the log is truncated mid-write (header only, no rows yet)', () => {
    const { value } = parseScfIterations([BLOCK[0]], 0);
    assert.deepStrictEqual(value, []);
  });

  it('returns an empty array when called on a non-header line', () => {
    const { value, nextIndex } = parseScfIterations(['not an scf header'], 0);
    assert.deepStrictEqual(value, []);
    assert.strictEqual(nextIndex, 1);
  });
});
