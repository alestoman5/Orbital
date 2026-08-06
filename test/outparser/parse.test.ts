import * as assert from 'assert';
import { parseOrcaOutput } from '../../src/outparser/parse';

// A realistic-but-constructed single-point .out fixture. Not captured from
// a real ORCA run (none was available in this environment) — built from
// the well-documented, stable sections (termination banner, FINAL SINGLE
// POINT ENERGY, CARTESIAN COORDINATES, TOTAL RUN TIME). See sections.ts for
// which sections are HIGH confidence vs. BEST-EFFORT.
const SINGLE_POINT_OUT = `
                                 *****************
                                 * O   R   C   A *
                                 *****************

Program Version 6.0.0

INPUT FILE
==========
NAME = water.inp
|  1> ! B3LYP def2-SVP
|  2> * xyz 0 1
|  3> O   0.000000   0.000000   0.000000
|  4> H   0.000000   0.757000   0.586000
|  5> H   0.000000  -0.757000   0.586000
|  6> *
|  7>

CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O      0.000000    0.000000    0.000000
  H      0.000000    0.757000    0.586000
  H      0.000000   -0.757000    0.586000

SCF ITERATIONS
--------------
ITER       Energy         Delta-E        Max-DP      RMS-DP      [F,P]     Damp
               ***  Starting incremental Fock matrix formation  ***
  0    -76.0122345698   0.000000000000 0.03456789  0.00123456  0.1234567 0.7000
  1    -76.0234567891  -0.011222219300 0.02345678  0.00098765  0.0987654 0.7000
  2    -76.0258932112  -0.002436522100 0.00034567  0.00009876  0.0098765 0.0000

                       ****Energy Check signals convergence****

-------------------------   --------------------
FINAL SINGLE POINT ENERGY       -76.025893211200
-------------------------   --------------------

Warning: the RIJCOSX approximation was used for the Fock matrix build

****ORCA TERMINATED NORMALLY****
TOTAL RUN TIME: 0 days 0 hours 0 minutes 4 seconds 812 msec
`;

const OPT_OUT = `
INPUT FILE
==========
|  1> ! B3LYP def2-SVP Opt
|  2> * xyz 0 1

                       *************************************************************
                       *                GEOMETRY OPTIMIZATION CYCLE   1            *
                       *************************************************************

CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O      0.000000    0.000000    0.000000
  H      0.000000    0.760000    0.590000
  H      0.000000   -0.760000    0.590000

          ----------------------|Geometry convergence|---------------------
          Item                value                   Tolerance       Converged
          ---------------------------------------------------------------------
          Energy change       0.00045000            0.0000050000      NO
          RMS gradient        0.00087000            0.0001000000      NO
          MAX gradient        0.00190000            0.0003000000      NO
          RMS step            0.01000000            0.0020000000      NO
          MAX step            0.02000000            0.0040000000      NO
          ---------------------------------------------------------------------

                       *************************************************************
                       *                GEOMETRY OPTIMIZATION CYCLE   2            *
                       *************************************************************

CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O      0.000000    0.000000    0.000000
  H      0.000000    0.757000    0.586000
  H      0.000000   -0.757000    0.586000

          ----------------------|Geometry convergence|---------------------
          Item                value                   Tolerance       Converged
          ---------------------------------------------------------------------
          Energy change       0.00000012            0.0000050000      YES
          RMS gradient        0.00003456            0.0001000000      YES
          MAX gradient        0.00008901            0.0003000000      YES
          RMS step            0.00123456            0.0020000000      YES
          MAX step            0.00234567            0.0040000000      YES
          ---------------------------------------------------------------------

                          THE OPTIMIZATION HAS CONVERGED

-------------------------   --------------------
FINAL SINGLE POINT ENERGY       -76.338381235905
-------------------------   --------------------

****ORCA TERMINATED NORMALLY****
TOTAL RUN TIME: 0 days 0 hours 0 minutes 12 seconds 456 msec
`;

describe('parseOrcaOutput: single-point job', () => {
  const parsed = parseOrcaOutput(SINGLE_POINT_OUT);

  it('reports normal termination', () => {
    assert.strictEqual(parsed.status, 'normal-termination');
  });

  it('parses total run time in seconds', () => {
    assert.ok(parsed.totalRunTimeSeconds !== undefined);
    assert.ok(Math.abs(parsed.totalRunTimeSeconds! - 4.812) < 1e-9);
  });

  it('produces exactly one job segment', () => {
    assert.strictEqual(parsed.jobs.length, 1);
  });

  it('parses the final single-point energy', () => {
    assert.strictEqual(parsed.jobs[0].finalEnergyHartree, -76.0258932112);
  });

  it('parses the CARTESIAN COORDINATES block into finalGeometry', () => {
    assert.strictEqual(parsed.jobs[0].finalGeometry?.length, 3);
    assert.strictEqual(parsed.jobs[0].finalGeometry?.[0].symbol, 'O');
  });

  it('collects SCF cycles', () => {
    assert.strictEqual(parsed.jobs[0].scfCycles.length, 3);
    assert.strictEqual(parsed.jobs[0].scfCycles[2].energy, -76.0258932112);
  });

  it('collects warnings', () => {
    assert.deepStrictEqual(parsed.jobs[0].warnings, [
      'the RIJCOSX approximation was used for the Fock matrix build'
    ]);
  });
});

describe('parseOrcaOutput: geometry optimization job', () => {
  const parsed = parseOrcaOutput(OPT_OUT);

  it('collects both optimization cycles, in order', () => {
    assert.strictEqual(parsed.jobs[0].optCycles.length, 2);
    assert.strictEqual(parsed.jobs[0].optCycles[0].cycle, 1);
    assert.strictEqual(parsed.jobs[0].optCycles[1].cycle, 2);
  });

  it('flags the first cycle as not converged and the second as converged', () => {
    assert.strictEqual(parsed.jobs[0].optCycles[0].allConverged, false);
    assert.strictEqual(parsed.jobs[0].optCycles[1].allConverged, true);
  });

  it('keeps the LAST CARTESIAN COORDINATES block, not the first', () => {
    // First block has H at y=0.760/0.590 (cycle 1), last has y=0.757/0.586 (cycle 2, converged).
    const geom = parsed.jobs[0].finalGeometry;
    assert.strictEqual(geom?.[1].y, 0.757);
    assert.strictEqual(geom?.[1].z, 0.586);
  });

  it('parses the final energy from after optimization converged', () => {
    assert.strictEqual(parsed.jobs[0].finalEnergyHartree, -76.338381235905);
  });
});

describe('parseOrcaOutput: truncated/mid-write file', () => {
  it('does not throw, and reports status "running" with partial data', () => {
    const truncated = SINGLE_POINT_OUT.split('FINAL SINGLE POINT ENERGY')[0]; // cut before energy line
    let parsed;
    assert.doesNotThrow(() => {
      parsed = parseOrcaOutput(truncated);
    });
    assert.strictEqual(parsed!.status, 'running');
    assert.strictEqual(parsed!.jobs[0].finalEnergyHartree, undefined);
    // What came before the cut point should still have parsed correctly.
    assert.strictEqual(parsed!.jobs[0].finalGeometry?.length, 3);
    assert.ok(parsed!.jobs[0].scfCycles.length > 0);
  });

  it('handles an empty file', () => {
    const parsed = parseOrcaOutput('');
    assert.strictEqual(parsed.status, 'unknown');
    assert.strictEqual(parsed.jobs.length, 1);
    assert.deepStrictEqual(parsed.jobs[0].scfCycles, []);
  });

  it('handles a file that is truncated mid-CARTESIAN-COORDINATES-block', () => {
    const idx = SINGLE_POINT_OUT.indexOf('H      0.000000   -0.757000');
    const truncated = SINGLE_POINT_OUT.slice(0, idx);
    const parsed = parseOrcaOutput(truncated);
    assert.strictEqual(parsed.jobs[0].finalGeometry?.length, 2); // O and first H only
  });
});

describe('parseOrcaOutput: multi-job splitting on $new_job', () => {
  const MULTI_JOB = `
INPUT FILE
==========
|  1> ! B3LYP def2-SVP
|  2> * xyz 0 1
|  3> O 0 0 0
|  4> *
|  5> $new_job
|  6> ! B3LYP def2-TZVP
|  7> * xyz 0 1
|  8> O 0 0 0
|  9> *

-------------------------   --------------------
FINAL SINGLE POINT ENERGY       -75.900000000000
-------------------------   --------------------

$new_job

-------------------------   --------------------
FINAL SINGLE POINT ENERGY       -76.100000000000
-------------------------   --------------------

****ORCA TERMINATED NORMALLY****
TOTAL RUN TIME: 0 days 0 hours 0 minutes 8 seconds 0 msec
`;

  it('splits into separate job segments and parses each energy independently', () => {
    const parsed = parseOrcaOutput(MULTI_JOB);
    assert.strictEqual(parsed.jobs.length, 2);
    assert.strictEqual(parsed.jobs[0].finalEnergyHartree, -75.9);
    assert.strictEqual(parsed.jobs[1].finalEnergyHartree, -76.1);
  });
});
