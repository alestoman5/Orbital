import * as assert from 'assert';
import { parseOrcaOutput } from '../../src/outparser/parse';
import { summarizeRun } from '../../src/features/runSummary';

// Constructed Opt+Freq+TD-DFT output for water, laid out like ORCA 6.x
// (section titles, column layouts and banners copied from real ORCA 6
// outputs; the numbers are made up). Ends at a saddle point: mode 6 is
// imaginary.
const SADDLE_OUT = `
INPUT FILE
================================================================================
NAME = water.inp
|  1> ! PBE0 def2-SVP Opt Freq
|  2> %tddft nroots 2 end
|  3> * xyz 0 1
|  4> O 0 0 0
|  5> H 0 0.76 0.59
|  6> H 0 -0.76 0.59
|  7> *
|  8>
|  9>                          ****END OF INPUT****
================================================================================

               *           SCF CONVERGED AFTER  12 CYCLES          *

                    ***        THE OPTIMIZATION HAS CONVERGED     ***

---------------------------------
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O      0.000000    0.000000   -0.065600
  H      0.000000    0.757000    0.520500
  H      0.000000   -0.757000    0.520500

----------------------------
CARTESIAN COORDINATES (A.U.)
----------------------------
  NO LB      ZA    FRAG     MASS         X           Y           Z
   0 O     8.0000    0    15.999    0.000000    0.000000   -0.123966
   1 H     1.0000    0     1.008    0.000000    1.430522    0.983598
   2 H     1.0000    0     1.008    0.000000   -1.430522    0.983598

-------------------------   --------------------
FINAL SINGLE POINT ENERGY       -76.230000000000
-------------------------   --------------------

----------------------------------------------------------------------------------------------------
                     ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS
----------------------------------------------------------------------------------------------------
     Transition      Energy     Energy  Wavelength fosc(D2)      D2        DX        DY        DZ
                      (eV)      (cm-1)    (nm)                 (au**2)    (au)      (au)      (au)
----------------------------------------------------------------------------------------------------
  0-1A  ->  1-1A    7.500000   60491.6   165.3   0.012000000   0.06538   0.00000   0.00000  -0.25570
  0-1A  ->  2-1A    9.250000   74606.3   134.0   0.080000000   0.35000   0.10000  -0.57300   0.00000

----------------------------------------------------------------------------------------------------
                     ABSORPTION SPECTRUM VIA TRANSITION VELOCITY DIPOLE MOMENTS
----------------------------------------------------------------------------------------------------
  0-1A  ->  1-1A    7.500000   60491.6   165.3   0.999000000   0.06538   0.00000   0.00000  -0.25570

-----------------------
VIBRATIONAL FREQUENCIES
-----------------------

Scaling factor for frequencies =  1.000000000  (already applied!)

     0:       0.00 cm**-1
     1:       0.00 cm**-1
     2:       0.00 cm**-1
     3:       0.00 cm**-1
     4:       0.00 cm**-1
     5:       0.00 cm**-1
     6:    -312.45 cm**-1 ***imaginary mode***
     7:    3712.34 cm**-1
     8:    3801.20 cm**-1


------------
NORMAL MODES
------------

These modes are the Cartesian displacements weighted by the diagonal matrix
M(i,i)=1/sqrt(m[i]) where m[i] is the mass of the displaced atom
Thus, these vectors are normalized but *not* orthogonal

                  0          1          2          3          4          5
      0       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      1       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      2       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      3       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      4       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      5       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      6       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      7       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
      8       0.000000   0.000000   0.000000   0.000000   0.000000   0.000000
                  6          7          8
      0       0.000000   0.000000  -0.070000
      1       0.070000  -0.050000  -0.000000
      2       0.000000   0.000000   0.000000
      3      -0.550000   0.400000   0.560000
      4      -0.430000  -0.580000  -0.430000
      5       0.000000   0.000000   0.000000
      6       0.550000   0.400000   0.560000
      7      -0.430000   0.580000   0.430000
      8       0.000000   0.000000   0.000000

-----------
IR SPECTRUM
-----------

 Mode   freq       eps      Int      T**2         TX        TY        TZ
       cm**-1   L/(mol*cm) km/mol    a.u.
----------------------------------------------------------------------------
  7:   3712.34   0.001200    6.06  0.000101  ( 0.000000  0.000000 -0.010050)
  8:   3801.20   0.009500   48.01  0.000780  ( 0.000000 -0.027928  0.000000)

--------------------------
THERMOCHEMISTRY AT 298.15K
--------------------------

Temperature         ...   298.15 K
Total Enthalpy                    ...    -76.20500000 Eh
Total entropy correction          ...     -0.02100000 Eh    -13.18 kcal/mol
Final Gibbs free energy         ...    -76.22600000 Eh

                             ****ORCA TERMINATED NORMALLY****
TOTAL RUN TIME: 0 days 0 hours 1 minutes 5 seconds 120 msec
`;

describe('outparser: frequencies, normal modes, IR, thermo, excitations', () => {
  const parsed = parseOrcaOutput(SADDLE_OUT);
  const job = parsed.jobs[0];

  it('reads all 3N frequencies including the imaginary one', () => {
    assert.deepStrictEqual(job.frequenciesCm1, [0, 0, 0, 0, 0, 0, -312.45, 3712.34, 3801.2]);
  });

  it('reads NORMAL MODES across 6-column blocks', () => {
    assert.strictEqual(job.normalModes!.length, 9);
    assert.deepStrictEqual(job.normalModes![6], [0, 0.07, 0, -0.55, -0.43, 0, 0.55, -0.43, 0]);
    assert.ok(Object.is(job.normalModes![8][1], -0)); // "-0.000000" keeps its sign
  });

  it('reads the IR eps column per mode (0 for modes without a row)', () => {
    assert.deepStrictEqual(job.irEpsilon, [0, 0, 0, 0, 0, 0, 0, 0.0012, 0.0095]);
  });

  it('reads thermochemistry lines', () => {
    assert.deepStrictEqual(job.thermo, { temperatureK: 298.15, enthalpy: -76.205, entropy: -0.021, gibbs: -76.226 });
  });

  it('reads the ORCA 6 electric-dipole absorption table and ignores the velocity-gauge one', () => {
    assert.strictEqual(job.excitations!.length, 2);
    assert.deepStrictEqual(job.excitations![1], {
      state: 2, label: '2-1A', energyEv: 9.25, energyCm1: 74606.3, wavelengthNm: 134.0,
      fosc: 0.08, d2: 0.35, dx: 0.1, dy: -0.573, dz: 0
    });
    assert.strictEqual(job.excitations![0].fosc, 0.012);
  });

  it('reads the bohr coordinate block with masses, SCF/opt banners and the input echo', () => {
    assert.deepStrictEqual(job.finalGeometryBohr![1], { symbol: 'H', mass: 1.008, xBohr: 0, yBohr: 1.430522, zBohr: 0.983598 });
    assert.strictEqual(job.scfConverged, true);
    assert.strictEqual(job.optConverged, true);
    assert.strictEqual(parsed.inputEcho[0], '! PBE0 def2-SVP Opt Freq');
  });

  it('summarizes the run as a saddle point of an optimization', () => {
    const s = summarizeRun(parsed);
    assert.strictEqual(s.kind, 'opt');
    assert.strictEqual(s.verdict, 'saddle');
    assert.deepStrictEqual(s.imaginary, [{ index: 6, freq: -312.45 }]);
    assert.strictEqual(s.energy, -76.23);
  });
});

describe('outparser: ORCA 5 absorption table layout', () => {
  it('reads state / cm-1 / nm / fosc / T2 / TX TY TZ and derives eV', () => {
    const text = [
      '-----------------------------------------------------------------------------',
      '         ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS',
      '-----------------------------------------------------------------------------',
      'State   Energy    Wavelength  fosc         T2        TX        TY        TZ  ',
      '        (cm-1)      (nm)                 (au**2)    (au)      (au)      (au) ',
      '-----------------------------------------------------------------------------',
      '   1   31250.0    320.0   0.500000000   6.46700   2.54300   0.00000   0.00000',
      ''
    ].join('\n');
    const exc = parseOrcaOutput(text).jobs[0].excitations!;
    assert.strictEqual(exc.length, 1);
    assert.strictEqual(exc[0].state, 1);
    assert.ok(Math.abs(exc[0].energyEv - 3.8745) < 1e-3);
    assert.strictEqual(exc[0].dx, 2.543);
  });
});

describe('outparser: failure markers and run summary verdicts', () => {
  const wrap = (body: string, end = '****ORCA TERMINATED NORMALLY****') =>
    `|  1> ! PBE def2-SVP ${body}\n${end}\n`;

  it('SCF not converged -> failed', () => {
    const p = parseOrcaOutput(`|  1> ! PBE def2-SVP\n*   SCF NOT CONVERGED AFTER 125 CYCLES   *\n****ORCA TERMINATED NORMALLY****\n`);
    const s = summarizeRun(p);
    assert.strictEqual(p.jobs[0].scfConverged, false);
    assert.strictEqual(s.verdict, 'failed');
    assert.ok(s.problems.includes('SCF not converged'));
  });

  it('optimizer gave up -> failed', () => {
    const p = parseOrcaOutput(wrap('Opt\nThe optimization did not converge but reached the maximum number of\n'));
    assert.strictEqual(summarizeRun(p).verdict, 'failed');
  });

  it('OptTS with one imaginary mode -> ts-ok; with two -> ts-bad', () => {
    const freqs = (list: string) => `-----------------------\nVIBRATIONAL FREQUENCIES\n-----------------------\n\n${list}\n\n`;
    const one = parseOrcaOutput(`|  1> ! PBE def2-SVP OptTS Freq\nTHE OPTIMIZATION HAS CONVERGED\n${freqs('     0:     -800.00 cm**-1\n     1:     100.00 cm**-1')}****ORCA TERMINATED NORMALLY****\n`);
    assert.strictEqual(summarizeRun(one).verdict, 'ts-ok');
    const two = parseOrcaOutput(`|  1> ! PBE def2-SVP OptTS Freq\nTHE OPTIMIZATION HAS CONVERGED\n${freqs('     0:     -800.00 cm**-1\n     1:     -90.00 cm**-1')}****ORCA TERMINATED NORMALLY****\n`);
    assert.strictEqual(summarizeRun(two).verdict, 'ts-bad');
  });

  it('T1 diagnostic above 0.02 is reported as a problem', () => {
    const p = parseOrcaOutput(`|  1> ! CCSD(T) cc-pVDZ\nT1 diagnostic                              ...      0.0312\n****ORCA TERMINATED NORMALLY****\n`);
    const s = summarizeRun(p);
    assert.strictEqual(s.t1, 0.0312);
    assert.ok(s.problems.some(x => x.startsWith('T1 = 0.0312')));
    assert.strictEqual(s.verdict, 'ok');
  });

  it('a still-running file is "running"', () => {
    assert.strictEqual(summarizeRun(parseOrcaOutput('|  1> ! PBE def2-SVP Opt\nsomething\n')).verdict, 'running');
  });
});
