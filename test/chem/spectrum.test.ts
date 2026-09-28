import * as assert from 'assert';
import {
  boltzmannWeights,
  broaden,
  buildPyneapplesInput,
  convertEnergy,
  describeBand,
  linspace,
  silvermanBandwidth,
  transitionDipoleFromFosc
} from '../../src/chem/spectrum';
import { Excitation } from '../../src/outparser/types';

const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

describe('chem/spectrum: unit conversion', () => {
  it('matches the textbook values', () => {
    close(convertEnergy(320, 'nm', 'eV'), 3.8745, 1e-3);
    close(convertEnergy(320, 'nm', 'cm-1'), 31250, 1);
    close(convertEnergy(1, 'eV', 'cm-1'), 8065.54, 0.01);
    close(convertEnergy(1, 'Eh', 'kcal/mol'), 627.509, 1e-3);
    close(convertEnergy(1, 'Eh', 'eV'), 27.2114, 1e-4);
    close(convertEnergy(convertEnergy(4.2, 'eV', 'nm'), 'nm', 'eV'), 4.2, 1e-12);
  });
});

describe('chem/spectrum: broadening and band descriptors', () => {
  it('a single stick broadens to a Gaussian with area f/N, FWHM 2.355 h and centroid at the stick', () => {
    const grid = linspace(2, 6, 4001);
    const y = broaden([{ energyEv: 4, weight: 0.8 }], grid, 0.2, 2);
    const d = describeBand(grid, y);
    close(d.integral, 0.4, 1e-6);
    close(d.maxX, 4, 1e-3);
    close(d.centroid, 4, 1e-6);
    close(d.fwhm, 2 * Math.sqrt(2 * Math.LN2) * 0.2, 1e-3);
  });

  it('Silverman bandwidth follows (4/3n)^(1/5) s with Kish effective sample size', () => {
    const sticks = [3.8, 4.0, 4.2, 4.4].map(e => ({ energyEv: e, weight: 1 }));
    const s = Math.sqrt(((0.3 ** 2 + 0.1 ** 2) * 2) / 4);
    close(silvermanBandwidth(sticks), Math.pow(4 / 12, 0.2) * s, 1e-12);
  });
});

describe('chem/spectrum: PyNEAppLES export', () => {
  const exc = (e: number): Excitation => ({ state: 1, energyEv: e, energyCm1: 0, wavelengthNm: 0, fosc: 0.1, d2: 1, dx: 0.5, dy: -0.25, dz: 0 });

  it('writes energy / "dx dy dz" lines per state and skips incomplete geometries', () => {
    const r = buildPyneapplesInput(
      [
        { name: 'geom_1.out', ok: true, excitations: [exc(3.1), exc(4.2)] },
        { name: 'geom_2.out', ok: false, excitations: [exc(3.0), exc(4.0)] },
        { name: 'geom_3.out', ok: true, excitations: [exc(3.2)] },
        { name: 'geom_4.out', ok: true },
        { name: 'geom_5.out', ok: true, excitations: [exc(3.3), exc(4.4)] }
      ],
      2
    );
    assert.strictEqual(r.nUsed, 2);
    assert.deepStrictEqual(r.skipped.map(s => s.name), ['geom_2.out', 'geom_3.out', 'geom_4.out']);
    const lines = r.text.trimEnd().split('\n');
    assert.strictEqual(lines.length, 8);
    assert.deepStrictEqual([lines[0], lines[2], lines[4], lines[6]], ['3.100000', '4.200000', '3.300000', '4.400000']);
    // |mu|^2 = 3 f / (2 E[au]); direction of (DX, DY, DZ) kept
    const mu = lines[1].split(' ').map(Number);
    close(mu[0] ** 2 + mu[1] ** 2 + mu[2] ** 2, (3 * 0.1) / (2 * (3.1 / 27.211386245988)), 1e-5);
    close(mu[0] / mu[1], -2, 1e-4);
    assert.strictEqual(mu[2], 0);
  });

  it('explains why a geometry was skipped', () => {
    const r = buildPyneapplesInput([
      { name: 'a', ok: false, status: 'unknown' },
      { name: 'b', ok: false, status: 'running' },
      { name: 'c', ok: false, status: 'error' }
    ], 2);
    assert.deepStrictEqual(r.skipped.map(s => s.reason), [
      'empty or not an ORCA output', 'unfinished (still running, or killed)', 'did not terminate normally'
    ]);
    assert.strictEqual(r.text, '');
  });

  it('puts the dipole along x when ORCA printed all components as zero', () => {
    const [x, y, z] = transitionDipoleFromFosc({ ...exc(4), fosc: 1e-6, dx: 0, dy: 0, dz: 0 });
    assert.ok(x > 0);
    assert.strictEqual(y, 0);
    assert.strictEqual(z, 0);
  });
});

describe('chem/spectrum: Boltzmann weights', () => {
  it('equal energies share equally; 1 kcal/mol at 298 K gives ~84:16', () => {
    assert.deepStrictEqual(boltzmannWeights([-1, -1], 300), [0.5, 0.5]);
    const w = boltzmannWeights([-100, -100 + 1 / 627.509474], 298.15);
    close(w[0], 0.844, 1e-3);
    close(w[0] + w[1], 1, 1e-12);
  });
});
