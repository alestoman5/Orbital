// "Setup" view of the Accelerated UV/Vis tab: the pipeline configuration as cards
// (molecule, ground state + sampling, excited states, training + ML, spectrum).
// Edits the AccelForm in place; structural choices (sampling kind, method) re-render.

import {
  CM_PER_KELVIN, EXCITED_METHODS, SAMPLING_LABELS, mdEntries, mdLengthPs, type AccelForm, type FieldError, type SamplingKind
} from '../../../../src/accel/spec';
import type { GleEntry, PickParams } from '../../../../src/studio/tabs/accel/types';
import { button, callout, card, field, numberInput, segmented, select, textInput, toggle } from '../../ui/components';
import { h, mount, type Child } from '../../ui/dom';
import type { ViewContext } from '../../view';

export interface FormHost {
  ctx: ViewContext;
  /** GLE matrices of the uv-vis library at the form temperature. */
  gle(): GleEntry[];
  /** Highest normal mode of the loaded project (cm^-1), if its optfreq stage is done. */
  highestMode(): number | null;
  reloadGle(): void;
  save(run: false | 'all' | 'minimum'): void;
}

export interface FormView {
  el: HTMLElement;
  setForm(f: AccelForm): void;
  setErrors(e: FieldError[]): void;
  refresh(): void;
}

const ORCA_HINT = 'ORCA simple-input keywords, e.g. PBE, B3LYP D3BJ, r2SCAN-3c';

export function createForm(host: FormHost, initial: AccelForm, onChange: (f: AccelForm) => void): FormView {
  let f = initial;
  let errors: FieldError[] = [];
  const el = h('div.accel-form');

  const changed = (structural = false) => {
    onChange(f);
    if (structural) render();
  };
  const err = (prefix: string) => {
    const m = errors.filter(e => e.field === prefix || e.field.startsWith(prefix + '.'));
    return m.length ? h('div.accel-field-error', null, m.map(e => e.message).join('; ')) : null;
  };
  const num = (get: () => number, set: (v: number) => void, o: { min?: number; max?: number; step?: number; structural?: boolean } = {}) =>
    numberInput(get(), v => { set(v); changed(o.structural); }, o);
  const txt = (get: () => string, set: (v: string) => void, o: { placeholder?: string; mono?: boolean } = {}) =>
    textInput(get(), v => { set(v); changed(); }, o);

  const pathField = (label: string, kind: PickParams['kind'], get: () => string, set: (v: string) => void, hint?: string, errKey?: string): HTMLElement => {
    const input = txt(get, set, { mono: true, placeholder: kind === 'workdir' ? 'runs/molecule' : 'path' });
    return h('div', null, field(label, h('div.accel-path', null, input,
      button('', async () => {
        const p = await host.ctx.rpc<string | null>('pick', { kind });
        if (p) {
          set(p);
          input.value = p;
          changed(kind === 'geometry');
        }
      }, { icon: kind === 'workdir' ? 'folder' : 'file', variant: 'ghost', title: 'Browse…' })), hint), err(errKey ?? kind));
  };

  function moleculeCard(): HTMLElement {
    return card({ title: 'Molecule', subtitle: 'Closed-shell singlet; atom order is kept through the whole pipeline' },
      pathField('Start geometry (.xyz)', 'geometry', () => f.geometry, v => { f.geometry = v; }),
      pathField('Work directory', 'workdir', () => f.workdir, v => { f.workdir = v; }, 'accel.json, state.json and one folder per stage'),
      h('div.accel-row2', null,
        field('Name', txt(() => f.name, v => { f.name = v; }, { placeholder: 'work directory name' }), 'label of the spectra'),
        field('Charge', num(() => f.charge, v => { f.charge = Math.round(v); }, { step: 1 }))),
      err('name'), err('charge'));
  }

  function gleSelect(): Child {
    const s = f.sampling;
    const lib = host.gle().filter(g => g.kind === s.kind && (s.kind !== 'pigle' || g.beads === s.beads));
    const hm = host.highestMode();
    const opts = [
      { value: 'auto', label: 'auto: smallest ħω_max/kT covering the highest mode' },
      ...lib.map(g => ({ value: g.name, label: `${g.name}: ${g.description}${g.omegaMax ? ` (ω_max ${Math.round(g.omegaMax)} cm⁻¹)` : ''}` })),
      { value: 'custom', label: 'custom GLE-A / GLE-C files' }
    ];
    if (!opts.some(o => o.value === s.gle)) opts.splice(1, 0, { value: s.gle, label: `${s.gle} (not in the library)` });
    const notes: Child[] = [];
    const chosen = s.gle === 'auto' ? lib.filter(g => g.omegaMax === null || hm === null || g.omegaMax >= hm).sort((a, b) => (a.hwKT ?? 1e9) - (b.hwKT ?? 1e9))[0] : lib.find(g => g.name === s.gle);
    if (!lib.length && s.gle !== 'custom') {
      notes.push(callout('warn', `No ${SAMPLING_LABELS[s.kind]} matrix${s.kind === 'pigle' ? ` for ${s.beads} beads` : ''} in scripts/gle/library.json: add one (gle4md.org) or use custom files.`));
    } else if (chosen && hm !== null && chosen.omegaMax !== null) {
      const ok = chosen.omegaMax >= hm;
      notes.push(callout(ok ? 'ok' : 'bad', `${chosen.name}: ω_max ${Math.round(chosen.omegaMax)} cm⁻¹ at ${s.temperature} K ${ok ? '≥' : '<'} highest mode ${Math.round(hm)} cm⁻¹${ok ? '' : ' — the sampling stage will refuse it'}.`));
    } else if (chosen && chosen.omegaMax === null) {
      notes.push(callout('info', `${chosen.name}: ω_max unknown (matrix parameters not identified) — check it suits the highest mode.`));
    } else if (hm === null) {
      notes.push(h('div.accel-note', null, 'The match against the highest normal mode is checked once the frequencies are known.'));
    }
    return h('div', null,
      field('GLE matrix', select(opts, s.gle, v => { s.gle = v; changed(true); }),
        s.kind === 'gle' ? `rescaled from the library temperature; qt-20_6 covers ${Math.round(20 * CM_PER_KELVIN * s.temperature)} cm⁻¹ at ${s.temperature} K` : 'rescaled from the library temperature; PI+GLE matrices are specific to the bead count'),
      s.gle === 'custom' ? h('div.accel-row2', null,
        pathField('GLE-A (a.u.)', 'gle', () => s.glePathA, v => { s.glePathA = v; }, undefined, 'sampling.gle'),
        pathField('GLE-C (eV)', 'gle', () => s.glePathC, v => { s.glePathC = v; }, undefined, 'sampling.gle')) : null,
      notes, err('sampling.gle'));
  }

  function samplingCard(): HTMLElement {
    const s = f.sampling;
    const g = f.ground;
    const md = s.kind !== 'wigner';
    const body: Child[] = [
      field('Sampling', segmented<SamplingKind>([
        { value: 'wigner', label: 'Wigner' }, { value: 'gle', label: 'GLE' }, { value: 'pigle', label: 'PI+GLE' }
      ], s.kind, v => {
        s.kind = v;
        if (v !== 'wigner') g.program = 'orca';
        changed(true);
      }), md ? 'ABIN molecular dynamics with a colored-noise thermostat, ORCA forces' : 'harmonic Wigner distribution of the normal modes (SHARC wigner.py)'),
      h('div.accel-row2', null,
        field('Program', select([{ value: 'orca', label: 'ORCA' }, { value: 'pyscf', label: 'PySCF (geomeTRIC)' }], g.program, v => { g.program = v; changed(true); })),
        field('Temperature / K', num(() => s.temperature, v => { s.temperature = v; host.reloadGle(); }, { min: 1, structural: true }))),
      md && g.program !== 'orca' ? callout('warn', 'MD needs ORCA (ABIN calls ORCA for the forces).') : null,
      h('div.accel-row2', null,
        field('Method', txt(() => g.method, v => { g.method = v; }, { mono: true }), g.program === 'orca' ? ORCA_HINT : 'PySCF xc functional, or HF'),
        field('Basis', txt(() => g.basis, v => { g.basis = v; }, { mono: true }))),
      g.program === 'orca' ? h('div.accel-row2', null,
        field('Extra keywords', txt(() => g.keywords, v => { g.keywords = v; }, { mono: true }), 'opt+freq adds TightOpt Freq'),
        field('Cores (opt+freq)', num(() => g.nprocs, v => { g.nprocs = Math.round(v); }, { min: 1, step: 1 }), 'small molecules: 1 is fastest')) : null,
      err('ground')
    ];
    if (!md) {
      body.push(h('div.accel-row2', null,
        field('Samples', num(() => s.nsamples, v => { s.nsamples = Math.round(v); }, { min: 10, step: 1000 }), 'the whole ensemble; the model predicts all of them'),
        field('Seed', num(() => s.seed, v => { s.seed = Math.round(v); }, { min: 0, step: 1 }), 'same seed ⇒ paired ensembles')), err('sampling.nsamples'));
    } else {
      body.push(
        h('div.accel-row3', null,
          field('Steps', num(() => s.nsteps, v => { s.nsteps = Math.round(v); }, { min: 1, step: 1000, structural: true })),
          field('dt / a.u.', num(() => s.dt, v => { s.dt = v; }, { min: 1, max: 100, step: 1, structural: true })),
          field('Write every', num(() => s.nwritex, v => { s.nwritex = Math.round(v); }, { min: 1, step: 1, structural: true }), 'steps')),
        h('div.accel-row3', null,
          field('Equilibration / ps', num(() => s.equilPs, v => { s.equilPs = v; }, { min: 0, step: 0.5, structural: true })),
          s.kind === 'pigle' ? field('Beads', num(() => s.beads, v => { s.beads = Math.round(v); }, { min: 2, step: 1, structural: true })) : h('div'),
          h('div.accel-note', null, `${mdLengthPs(s).toFixed(1)} ps, ${mdEntries(s).toLocaleString()} entries after equilibration`)),
        toggle('Run ABIN here', s.launch, v => { s.launch = v; changed(); }, { hint: 'off: the stage writes the ABIN directory and waits for movie.xyz (run it on a cluster)' }),
        gleSelect(), err('sampling'));
    }
    return card({ title: 'Ground state & sampling', subtitle: 'Optimisation + frequencies first; MD also checks the GLE matrix against the frequencies' }, ...body);
  }

  function excitedCard(): HTMLElement {
    const x = f.excited;
    const td = x.method === 'tddft' || x.method === 'tda';
    const labels: Record<string, string> = { 'adc(2)': 'ADC(2)', 'adc(2)-x': 'ADC(2)-x', 'adc(3)': 'ADC(3)', tddft: 'TD-DFT', tda: 'TDA (TD-DFT)' };
    return card({ title: 'Excited states', subtitle: 'PySCF; the same level at the minimum and on the training geometries' },
      h('div.accel-row2', null,
        field('Method', select(EXCITED_METHODS.map(m => ({ value: m, label: labels[m] })), x.method, v => { x.method = v; changed(true); })),
        field('Basis', txt(() => x.basis, v => { x.basis = v; }, { mono: true }))),
      td ? field('Functional', txt(() => x.xc, v => { x.xc = v; }, { mono: true }), 'PySCF xc, e.g. PBE0, CAM-B3LYP, wB97X-D') : null,
      h('div.accel-row3', null,
        field('States at the minimum', num(() => f.minimum.nstates, v => { f.minimum.nstates = Math.round(v); }, { min: 1, max: 30, step: 1, structural: true }), '6–7 to find the dominant one'),
        field('Followed state', select([{ value: '0', label: 'auto: brightest' }, ...Array.from({ length: f.minimum.nstates }, (_, i) => ({ value: String(i + 1), label: `S${i + 1}` }))],
          String(f.minimum.targetState), v => { f.minimum.targetState = Number(v); changed(); }), 'its root index across the ensemble'),
        field('Memory / MB', num(() => x.memory, v => { x.memory = Math.round(v); }, { min: 100, step: 500 }))),
      h('div.accel-toggles', null,
        td ? null : toggle('Frozen core', x.frozenCore, v => { x.frozenCore = v; changed(); }),
        toggle('Cube files of the orbitals', f.minimum.cubes, v => { f.minimum.cubes = v; changed(); }, { hint: 'MOs of the main transitions at the minimum, for the 3D viewer' })),
      err('excited'), err('minimum'));
  }

  function gridRow(label: string, g: [number, number, number], hint: string): HTMLElement {
    return field(label, h('div.accel-row3', null,
      numberInput(g[0], v => { g[0] = v; changed(); }, { step: 1 }),
      numberInput(g[1], v => { g[1] = v; changed(); }, { step: 1 }),
      numberInput(g[2], v => { g[2] = Math.round(v); changed(); }, { min: 1, max: 40, step: 1 })), hint);
  }

  function mlCard(): HTMLElement {
    const m = f.mbtr;
    const k = f.krr;
    return card({ title: 'Training set & machine learning', subtitle: 'MBTR (inverse distances) + kernel ridge regression of E and f of the followed state' },
      h('div.accel-row2', null,
        field('Training geometries', num(() => f.train.n, v => { f.train.n = Math.round(v); }, { min: 10, step: 100 }), 'evenly spread over the ensemble'),
        field('Parallel jobs', num(() => f.train.jobs, v => { f.train.jobs = Math.round(v); }, { min: 1, step: 1 }), 'single-core excitation jobs')),
      err('train'),
      h('div.accel-subhead', null, 'MBTR grid'),
      h('div.accel-row3', null,
        field('Points', num(() => m.n, v => { m.n = Math.round(v); }, { min: 10, max: 2000, step: 10 })),
        field('Width / Å⁻¹', num(() => m.sigma, v => { m.sigma = v; }, { min: 0.001, step: 0.01 }), 'Gaussian σ'),
        field('Histogram frames', num(() => m.maxFrames, v => { m.maxFrames = Math.round(v); }, { min: 100, step: 1000 }), 'for the range')),
      toggle('Range from the histograms of the ensemble (min − σ … max + σ)', m.autoRange, v => { m.autoRange = v; changed(true); }),
      m.autoRange ? null : h('div.accel-row2', null,
        field('min / Å⁻¹', num(() => m.min, v => { m.min = v; }, { min: 0, step: 0.05 })),
        field('max / Å⁻¹', num(() => m.max, v => { m.max = v; }, { min: 0, step: 0.05 }))),
      err('mbtr'),
      h('div.accel-subhead', null, 'KRR grid search (log₁₀ min, max, points)'),
      gridRow('Alpha', k.alpha, 'α, regularisation'),
      gridRow('Gamma factor', k.gamma, 'γ = factor / (n_features · var X)'),
      h('div.accel-row2', null,
        field('CV folds', num(() => k.cv, v => { k.cv = Math.round(v); }, { min: 2, max: 20, step: 1 })),
        field('Cores', num(() => k.nJobs, v => { k.nJobs = Math.round(v); }, { min: 1, step: 1 }))),
      toggle('Nested CV (honest error + parity plot)', k.nested, v => { k.nested = v; changed(); }),
      err('krr'));
  }

  function spectrumCard(): HTMLElement {
    const s = f.spectrum;
    return card({ title: 'Spectrum', subtitle: 'PyNEAppLES KDE with bootstrap confidence band' },
      h('div.accel-row3', null,
        field('Bandwidth', select([{ value: 'silverman', label: 'Silverman' }, { value: 'cv', label: 'cross-validation' }, { value: 'dev', label: 'dev' }], s.bandwidth, v => { s.bandwidth = v; changed(); })),
        field('Confidence', num(() => s.confidence, v => { s.confidence = v; }, { min: 0.5, max: 0.999, step: 0.01 })),
        field('Resampling', select([{ value: 'auto', label: 'auto (cbb for MD)' }, { value: 'bootstrap', label: 'bootstrap' }, { value: 'cbb', label: 'circular block' }], s.ealg, v => { s.ealg = v; changed(); }))),
      h('div.accel-row2', null,
        field('Cores', num(() => s.ncores, v => { s.ncores = Math.round(v); }, { min: 1, step: 1 })),
        h('div.accel-toggles', null, toggle('Also from the training set alone', s.direct, v => { s.direct = v; changed(); }))),
      pathField('Experiment (optional)', 'experiment', () => s.experiment, v => { s.experiment = v; }, 'two columns: nm, cross section', 'spectrum.experiment'),
      err('spectrum'));
  }

  function render(): void {
    mount(el,
      h('div.accel-form-grid', null, moleculeCard(), samplingCard(), excitedCard(), mlCard(), spectrumCard()),
      h('div.accel-form-actions', null,
        errors.length ? callout('bad', `${errors.length} field${errors.length > 1 ? 's' : ''} to fix`) : null,
        button('Save', () => host.save(false), { variant: 'secondary', icon: 'download', title: 'Write accel.json' }),
        button('Save & run to the minimum', () => host.save('minimum'), { variant: 'secondary', icon: 'play', title: 'opt+freq and the excited-state scan: see the dominant state before sampling' }),
        button('Save & run all', () => host.save('all'), { variant: 'primary', icon: 'play' })));
  }

  render();
  return {
    el,
    setForm(nf) { f = nf; errors = []; render(); },
    setErrors(e) { errors = e; render(); },
    refresh: render
  };
}
