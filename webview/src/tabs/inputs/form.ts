// The Input Builder form: geometry card plus collapsible sections bound to
// dotted spec paths. Fields register a "slot" per path so validation issues
// (SpecIssue.path) can be shown right under the field they concern.

import { Child, h, mount } from '../../ui/dom';
import { badge, button, field, icon, numberInput, section, segmented, select, textArea, textInput, toggle, Option } from '../../ui/components';
import { FUNCTIONALS, SOLVENTS, COMMON_BASIS_SETS, functionalInfo } from '../../../../src/inputs/catalog';
import { EXCITED_LABELS, InputSpec, JobType, MethodFamily } from '../../../../src/inputs/spec';
import { angle, dihedral, distance } from '../../../../src/chem/geometry';
import { geometrySummary, issueMatches, relevance, totalMemoryLabel } from '../../../../src/studio/tabs/inputs/shared';
import type { SpecIssue } from '../../../../src/inputs/spec';
import { combo, ComboItem, pills } from './widgets';
import { Model, basename, batchActive, xyzReference } from './model';

export interface FormHost {
  model: Model;
  /** Spec/model changed; `structural` rebuilds the form (sections appear / disappear). */
  changed(structural?: boolean): void;
  importActive(): void;
  pickFile(): void;
  pasteXyz(text: string): void;
}

interface Slot {
  path: string;
  el: HTMLElement;
  msg: HTMLElement;
}

// --- path helpers -----------------------------------------------------------

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<any>((o, k) => o[k], obj);
  target[last] = value;
}

// --- option lists -----------------------------------------------------------

const JOBS: { value: JobType; label: string; title: string }[] = [
  { value: 'sp', label: 'Single point', title: 'Energy (and properties) at the given geometry' },
  { value: 'opt', label: 'Opt', title: 'Geometry optimization to a minimum' },
  { value: 'freq', label: 'Freq', title: 'Harmonic frequencies at the given geometry' },
  { value: 'opt-freq', label: 'Opt + Freq', title: 'Optimization followed by frequencies (minimum check, thermochemistry)' },
  { value: 'optts', label: 'OptTS', title: 'Transition-state search' },
  { value: 'optts-freq', label: 'OptTS + Freq', title: 'TS search, then frequencies (one imaginary mode expected)' },
  { value: 'scan', label: 'Scan', title: 'Relaxed surface scan of one internal coordinate' }
];

const FAMILIES: Option<MethodFamily>[] = [
  { value: 'hf', label: 'Hartree–Fock', group: 'Mean field' },
  { value: 'dft', label: 'DFT', group: 'Mean field' },
  { value: 'mp2', label: 'MP2', group: 'Correlated' },
  { value: 'ccsd', label: 'CCSD', group: 'Correlated' },
  { value: 'ccsd(t)', label: 'CCSD(T)', group: 'Correlated' },
  { value: 'dlpno-ccsd(t)', label: 'DLPNO-CCSD(T)', group: 'Correlated' },
  { value: 'casscf', label: 'CASSCF', group: 'Multireference' },
  { value: 'nevpt2', label: 'NEVPT2 (on CASSCF)', group: 'Multireference' }
];

const KIND_LABEL: Record<string, string> = {
  gga: 'GGA', mgga: 'meta-GGA', hybrid: 'Global hybrid', rsh: 'Range-separated hybrid', 'double-hybrid': 'Double hybrid', composite: 'Composite (3c)'
};

const functionalItems = (): ComboItem[] => FUNCTIONALS.map(f => ({
  value: f.orca, group: KIND_LABEL[f.kind], hint: [f.builtInDispersion ? '+disp' : '', f.pyscf ? '' : 'ORCA only'].filter(Boolean).join(' · ')
}));

function basisGroup(b: string): string {
  if (/^ma-/i.test(b)) return 'Minimally augmented';
  if (/^def2/i.test(b)) return 'Karlsruhe def2';
  if (/cc-p/i.test(b)) return 'Dunning correlation-consistent';
  if (/^\d-/.test(b)) return 'Pople';
  return 'Other';
}
const basisItems = (): ComboItem[] => {
  const order = ['Karlsruhe def2', 'Minimally augmented', 'Dunning correlation-consistent', 'Pople', 'Other'];
  return COMMON_BASIS_SETS.map(b => ({ value: b, group: basisGroup(b), hint: /aug-|D$|^ma-|\+/.test(b) ? 'diffuse' : '' }))
    .sort((a, b) => order.indexOf(a.group!) - order.indexOf(b.group!));
};

// --- form -------------------------------------------------------------------

export class Form {
  readonly el = h('div.ib-form');
  private slots: Slot[] = [];
  private sections = new Map<string, HTMLDetailsElement>();
  private key = '';

  constructor(private host: FormHost) {}

  private get m(): Model { return this.host.model; }
  private get s(): InputSpec { return this.host.model.spec; }

  /** Rebuilds when the set of visible fields changed (or always with `force`). */
  render(force = false): void {
    const kind = functionalInfo(this.s.method.functional)?.kind;
    const key = JSON.stringify([relevance(this.s, kind), this.m.program, this.s.excited.method, this.s.solvation.model, this.m.source, batchActive(this.m), this.m.useXyzFile, this.s.scan.coordinate, this.m.pasteText.length > 0]);
    if (!force && key === this.key) {
      this.refreshDerived();
      return;
    }
    this.key = key;
    this.slots = [];
    this.sections.clear();
    // Keep focus and caret in the control being edited across the rebuild.
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const owner = active && this.el.contains(active) ? (active.closest('[data-path]') as HTMLElement | null) : null;
    const focus = owner ? { path: owner.dataset.path!, tag: active!.tagName.toLowerCase(), start: active!.selectionStart, end: active!.selectionEnd } : undefined;
    mount(this.el, this.geometryCard(), this.build());
    if (focus) {
      const el = this.el.querySelector(`[data-path="${focus.path}"] ${focus.tag}`) as HTMLInputElement | null;
      if (el) {
        el.focus({ preventScroll: true });
        try {
          if (focus.start !== null) {
            el.setSelectionRange(focus.start, focus.end);
          }
        } catch {
          // number inputs have no selection
        }
      }
    }
  }

  /** Shows `issues` under their fields; returns the issues no visible field took. */
  showIssues(issues: SpecIssue[]): SpecIssue[] {
    const taken = new Set<SpecIssue>();
    const rank = { error: 0, warning: 1, info: 2 } as const;
    for (const slot of this.slots) {
      const mine = issues.filter(i => issueMatches(i, slot.path)).sort((a, b) => rank[a.severity] - rank[b.severity]);
      mine.forEach(i => taken.add(i));
      slot.el.classList.remove('sev-error', 'sev-warning', 'sev-info');
      if (mine.length === 0) {
        mount(slot.msg);
        continue;
      }
      slot.el.classList.add(`sev-${mine[0].severity}`);
      mount(slot.msg, mine.slice(0, 3).map(i => h('div.fi-issue', { class: `sev-${i.severity}` },
        icon(i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'),
        h('span', null, i.program ? h('b', null, i.program === 'orca' ? 'ORCA: ' : 'PySCF: ') : null, i.message))));
    }
    for (const [, sec] of this.sections) {
      const bad = sec.querySelector('.sev-error') ? 'error' : sec.querySelector('.sev-warning') ? 'warning' : '';
      sec.querySelector('summary')?.setAttribute('data-sev', bad);
    }
    return issues.filter(i => !taken.has(i));
  }

  /** Opens the section of the field for `issue`, scrolls to it and focuses its control. */
  reveal(issue: SpecIssue): void {
    const slot = this.slots.filter(s => issueMatches(issue, s.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!slot) {
      return;
    }
    const det = slot.el.closest('details');
    if (det) {
      det.open = true;
    }
    const sc = slot.el.closest('.tab-content') as HTMLElement | null;
    if (sc) {
      const top = slot.el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      sc.scrollTo({ top: sc.scrollTop + top - sc.clientHeight / 3, behavior: 'smooth' });
    }
    slot.el.classList.add('flash');
    setTimeout(() => slot.el.classList.remove('flash'), 1200);
    (slot.el.querySelector('input, select, textarea') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  // --- building blocks ------------------------------------------------------

  private slot(path: string, el: HTMLElement): HTMLElement {
    const msg = h('div.fi-msgs');
    el.append(msg);
    el.dataset.path = path;
    this.slots.push({ path, el, msg });
    return el;
  }

  private fld(label: string, path: string, control: Child, hint?: string): HTMLElement {
    return this.slot(path, field(label, control, hint));
  }

  private num(label: string, path: string, opts: { min?: number; max?: number; step?: number; unit?: string; structural?: boolean; int?: boolean } = {}): HTMLElement {
    const input = numberInput(getPath(this.s, path) as number, v => {
      setPath(this.s, path, opts.int ? Math.round(v) : v);
      this.host.changed(opts.structural);
    }, opts);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        setPath(this.s, path, opts.int ? Math.round(v) : v);
        this.host.changed(false);
      }
    });
    const ctl = opts.unit ? h('div.ib-unit', null, input, h('span', null, opts.unit)) : input;
    return this.fld(label, path, ctl);
  }

  private seg<T extends string>(label: string, path: string, options: Option<T>[], structural = true): HTMLElement {
    return this.fld(label, path, segmented(options, getPath(this.s, path) as T, v => { setPath(this.s, path, v); this.host.changed(structural); }));
  }

  private tog(label: string, path: string, hint?: string, structural = false): HTMLElement {
    const t = toggle(label, !!getPath(this.s, path), v => { setPath(this.s, path, v); this.host.changed(structural); }, { hint });
    return this.slot(path, h('div.field.ib-toggle', null, t, hint ? h('span.field-hint', null, hint) : null));
  }

  private sec(id: string, title: string, summary: string, defaultOpen: boolean, ...body: Child[]): HTMLDetailsElement {
    const open = this.m.open[id] ?? defaultOpen;
    const d = section(title, open, ...body);
    d.dataset.sec = id;
    const sum = d.querySelector('summary')!;
    sum.append(h('span.ib-sum', { 'data-sum': id }, summary));
    d.addEventListener('toggle', () => { this.m.open[id] = d.open; });
    this.sections.set(id, d);
    return d;
  }

  /** Values derived from the spec that change without a rebuild (section summaries, memory total). */
  private refreshDerived(): void {
    for (const [id] of this.sections) {
      const el = this.el.querySelector(`[data-sum="${id}"]`);
      if (el) {
        el.textContent = this.summaryOf(id);
      }
    }
    const mem = this.el.querySelector('.ib-mem');
    if (mem) {
      mount(mem as HTMLElement, this.memoryLine());
    }
    const cur = this.el.querySelector('.ib-scan-now');
    if (cur) {
      cur.textContent = this.scanNow();
    }
  }

  private summaryOf(id: string): string {
    const s = this.s;
    switch (id) {
      case 'job': return JOBS.find(j => j.value === s.job)?.label ?? s.job;
      case 'method': return s.method.family === 'dft' ? s.method.functional : FAMILIES.find(f => f.value === s.method.family)?.label ?? '';
      case 'basis': return functionalInfo(s.method.functional)?.kind === 'composite' && s.method.family === 'dft' ? 'built in' : s.basis;
      case 'solv': return s.solvation.model === 'none' ? 'gas phase' : `${s.solvation.model.toUpperCase()} · ${s.solvation.solvent}`;
      case 'exc': return s.excited.method === 'none' ? 'off' : `${EXCITED_LABELS[s.excited.method]} · ${s.excited.nroots} roots`;
      case 'cas': return `CAS(${s.cas.nel},${s.cas.norb})`;
      case 'scan': return `${s.scan.coordinate} ${s.scan.atoms.join('-')} · ${s.scan.points} pts`;
      case 'ts': return s.ts.calcHess ? 'exact Hessian' : 'model Hessian';
      case 'freq': return `${s.freq.temperature} K`;
      case 'res': return `${s.resources.nprocs} × ${s.resources.maxcoreMB} MB`;
      case 'conv': return `SCF ${s.convergence.scf}`;
      case 'extras': {
        const t = (this.m.program === 'orca' ? s.extras.orca : s.extras.pyscf).trim();
        return t ? `${t.split('\n').length} line(s)` : 'none';
      }
      default: return '';
    }
  }

  // --- geometry ---------------------------------------------------------------

  private geometryCard(): HTMLElement {
    const m = this.m;
    const src = m.source;
    const atoms = this.s.geometry.atoms;
    const kindLabel = { xyz: 'XYZ', inp: 'ORCA input', out: 'ORCA output', paste: 'pasted', default: 'example' }[src.kind];
    const pasteOpen = this.m.open['paste'] ?? false;
    const paste = textArea(m.pasteText, v => this.host.pasteXyz(v), { rows: 6, placeholder: '3\nwater\nO  0.000  0.000  0.117\nH  0.000  0.757 -0.469\nH  0.000 -0.757 -0.469\n\n(multi-frame XYZ switches on batch mode)' });
    const same = (a?: string, b?: string) => !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
    const active = m.activeFile && !same(m.activeFile, src.path) ? m.activeFile : undefined;
    const xyzRef = xyzReference(m);
    const card = h('div.ib-geom', null,
      h('div.ib-geom-head', null,
        h('div.ib-geom-mark', null, icon('geom')),
        h('div.ib-geom-id', null,
          h('div.ib-formula', null, geometrySummary(atoms)),
          h('div.ib-geom-src', { title: src.path ?? '' }, badge(kindLabel, src.kind === 'default' ? 'muted' : 'info'), h('span', null, src.name), src.note ? h('span.muted', null, ` · ${src.note}`) : null))),
      h('div.ib-geom-actions', null,
        active ? button(`Use ${basename(active)}`, () => this.host.importActive(), { icon: 'file', title: active }) : null,
        button('Open file…', () => this.host.pickFile(), { icon: 'folder', title: '.xyz (first frame or ensemble), .inp (coordinate block), .out (final geometry of the last job)' }),
        button(pasteOpen ? 'Hide paste' : 'Paste XYZ', () => { this.m.open['paste'] = !pasteOpen; this.render(true); }, { variant: 'ghost' })),
      pasteOpen ? paste : null,
      h('div.ib-grid2', null, this.num('Charge', 'charge', { step: 1, int: true }), this.num('Multiplicity', 'multiplicity', { min: 1, step: 1, int: true })),
      src.frames > 1
        ? h('div.field.ib-toggle.ib-batch-toggle', null,
            toggle(`Batch mode: one job per frame (${src.frames.toLocaleString()} frames)`, m.batch.enabled, v => { m.batch.enabled = v; this.host.changed(true); }),
            h('span.field-hint', null, m.batch.enabled ? 'The preview shows the job of frame 1.' : 'Off: a single input for frame 1.'))
        : null,
      !batchActive(m)
        ? h('div.field.ib-toggle', null,
            toggle('Read coordinates from file (* xyzfile)', m.useXyzFile, v => { m.useXyzFile = v; this.host.changed(true); }),
            h('span.field-hint', null, m.useXyzFile
              ? (xyzRef.companion ? `References ${xyzRef.name}; it is written next to the input on save.` : `References ${xyzRef.name} next to the input.`)
              : 'Off: coordinates inline in the input.'))
        : null
    );
    return this.slot('geometry', card);
  }

  // --- sections ---------------------------------------------------------------

  private build(): Child[] {
    const s = this.s;
    const m = this.m;
    const fi = functionalInfo(s.method.functional);
    const rel = relevance(s, fi?.kind);
    const out: Child[] = [];

    out.push(this.sec('job', 'Job', this.summaryOf('job'), true,
      this.fld('Job type', 'job', pills(JOBS, s.job, v => { s.job = v; this.host.changed(true); })),
      this.fld('Title', 'title', textInput(s.title, v => { s.title = v; this.host.changed(); })),
      this.fld('Comment', 'comment', textArea(s.comment, v => { s.comment = v; this.host.changed(); }, { rows: 2, mono: false, placeholder: 'Written as comment lines / the script docstring' }))));

    const method: Child[] = [
      this.fld('Method family', 'method.family', select(FAMILIES, s.method.family, v => { s.method.family = v; this.host.changed(true); }))
    ];
    if (rel.functional) {
      method.push(this.fld('Functional', 'method.functional',
        combo({ value: s.method.functional, items: functionalItems(), placeholder: 'Search or type an ORCA keyword', onChange: v => { s.method.functional = v; this.host.changed(true); } }),
        fi?.note));
    }
    method.push(this.fld('Reference', 'method.reference', select([
      { value: 'auto', label: 'Auto (restricted for singlets)' },
      { value: 'restricted', label: s.method.family === 'dft' ? 'Restricted (RKS)' : 'Restricted (RHF)' },
      { value: 'unrestricted', label: s.method.family === 'dft' ? 'Unrestricted (UKS)' : 'Unrestricted (UHF)' },
      { value: 'restricted-open', label: s.method.family === 'dft' ? 'Restricted open-shell (ROKS)' : 'Restricted open-shell (ROHF)' }
    ], s.method.reference, v => { s.method.reference = v; this.host.changed(); })));
    if (rel.pno) {
      method.push(this.seg('PNO thresholds', 'method.pno', [{ value: 'loose', label: 'Loose' }, { value: 'normal', label: 'Normal' }, { value: 'tight', label: 'Tight' }], false));
    }
    if (rel.dispersion) {
      method.push(this.seg('Dispersion', 'dispersion', [{ value: 'none', label: 'None' }, { value: 'd3bj', label: 'D3(BJ)' }, { value: 'd4', label: 'D4' }], false));
    }
    if (rel.frozenCore) {
      method.push(this.tog('Frozen core', 'frozenCore', 'Freeze core orbitals in the correlation treatment'));
    }
    out.push(this.sec('method', 'Method', this.summaryOf('method'), true, method));

    const basis: Child[] = [];
    if (rel.basis) {
      basis.push(this.fld('Orbital basis', 'basis', combo({ value: s.basis, items: basisItems(), placeholder: 'Search or type a basis', onChange: v => { s.basis = v; this.host.changed(true); } })));
    } else {
      basis.push(h('p.muted.ib-note', null, `${s.method.functional} brings its own basis set, dispersion and corrections.`));
    }
    if (rel.ri) {
      basis.push(this.fld('Resolution of identity', 'ri.mode', select([
        { value: 'auto', label: 'Auto (RIJCOSX for hybrids, RI-J for pure DFT)' },
        { value: 'none', label: 'None (exact integrals)' },
        { value: 'rij', label: 'RI-J' },
        { value: 'rijcosx', label: 'RIJCOSX' },
        { value: 'rijk', label: 'RI-JK' }
      ], s.ri.mode, v => { s.ri.mode = v; this.host.changed(true); })));
      if (s.ri.mode !== 'none') {
        basis.push(h('div.ib-grid2', null,
          this.fld('Coulomb aux (J)', 'ri.auxJ', combo({ value: s.ri.auxJ, items: [{ value: 'def2/J' }, { value: 'def2/JK' }, { value: 'AutoAux' }], onChange: v => { s.ri.auxJ = v; this.host.changed(); } })),
          rel.auxC ? this.fld('Correlation aux (C)', 'ri.auxC', combo({
            value: s.ri.auxC, placeholder: 'matching /C', items: [{ value: '', label: 'Matching /C set', hint: 'auto' }, { value: 'AutoAux' }, ...COMMON_BASIS_SETS.map(b => ({ value: `${b.replace(/^ma-/, '')}/C` })).filter((v, i, a) => a.findIndex(x => x.value === v.value) === i)],
            onChange: v => { s.ri.auxC = v; this.host.changed(); }
          })) : null));
      }
    }
    out.push(this.sec('basis', 'Basis & RI', this.summaryOf('basis'), true, basis));

    const solv: Child[] = [this.seg('Model', 'solvation.model', [{ value: 'none', label: 'Gas phase' }, { value: 'cpcm', label: 'C-PCM' }, { value: 'smd', label: 'SMD' }])];
    if (s.solvation.model !== 'none') {
      solv.push(this.fld('Solvent', 'solvation.solvent', combo({
        value: s.solvation.solvent, free: false, placeholder: 'Search solvents',
        items: SOLVENTS.map(x => ({ value: x.id, label: x.label, hint: `ε ${x.eps.toFixed(1)}` })),
        onChange: v => { s.solvation.solvent = v; this.host.changed(); }
      })));
    }
    out.push(this.sec('solv', 'Solvation', this.summaryOf('solv'), s.solvation.model !== 'none', solv));

    const exc: Child[] = [this.fld('Excited-state method', 'excited.method', select([
      { value: 'none', label: 'None (ground state)' },
      { value: 'tddft', label: s.method.family === 'hf' ? 'CIS / TDHF' : 'TD-DFT / TDA', group: 'On HF / DFT' },
      { value: 'adc2', label: 'ADC(2)', group: 'On HF (wave function)' },
      { value: 'adc2x', label: 'ADC(2)-x', group: 'On HF (wave function)' },
      { value: 'adc3', label: 'ADC(3)', group: 'On HF (wave function)' },
      { value: 'eom-ccsd', label: 'EOM-CCSD', group: 'On HF (wave function)' }
    ], s.excited.method, v => { s.excited.method = v; this.host.changed(true); }))];
    if (rel.excitedOptions) {
      exc.push(h('div.ib-grid2', null, this.num('Roots', 'excited.nroots', { min: 1, step: 1, int: true }), this.num('IRoot', 'excited.iroot', { min: 0, step: 1, int: true })));
      exc.push(this.tog('Triplets', 'excited.triplets', 'Also compute triplet states (closed-shell references)'));
      if (rel.tda) {
        exc.push(this.tog('Tamm–Dancoff (TDA)', 'excited.tda', 'Cheaper and robust for geometries; full TD-DFT gives better oscillator strengths'));
      }
    }
    out.push(this.sec('exc', 'Excited states', this.summaryOf('exc'), s.excited.method !== 'none', exc));

    if (rel.cas) {
      out.push(this.sec('cas', 'Active space', this.summaryOf('cas'), true,
        h('div.ib-grid3', null,
          this.num('Electrons', 'cas.nel', { min: 1, step: 1, int: true }),
          this.num('Orbitals', 'cas.norb', { min: 1, step: 1, int: true }),
          this.num('Roots', 'cas.nroots', { min: 1, step: 1, int: true }))));
    }

    if (rel.scan) {
      const unit = s.scan.coordinate === 'B' ? 'Å' : '°';
      const atomsInput = textInput(s.scan.atoms.join(' '), v => {
        s.scan.atoms = v.split(/[\s,]+/).filter(Boolean).map(Number).filter(n => Number.isFinite(n));
        this.host.changed();
      }, { mono: true, placeholder: s.scan.coordinate === 'B' ? '0 1' : s.scan.coordinate === 'A' ? '0 1 2' : '0 1 2 3' });
      out.push(this.sec('scan', 'Scan', this.summaryOf('scan'), true,
        this.fld('Coordinate', 'scan.coordinate', segmented([{ value: 'B', label: 'Bond' }, { value: 'A', label: 'Angle' }, { value: 'D', label: 'Dihedral' }], s.scan.coordinate, v => {
          s.scan.coordinate = v;
          const need = { B: 2, A: 3, D: 4 }[v];
          s.scan.atoms = Array.from({ length: need }, (_, i) => s.scan.atoms[i] ?? i);
          this.host.changed(true);
        })),
        this.fld('Atoms (0-based)', 'scan.atoms', atomsInput),
        h('div.ib-scan-now.muted', null, this.scanNow()),
        h('div.ib-grid3', null,
          this.num('Start', 'scan.start', { unit }),
          this.num('End', 'scan.end', { unit }),
          this.num('Points', 'scan.points', { min: 2, step: 1, int: true }))));
    }

    if (rel.ts) {
      out.push(this.sec('ts', 'Transition state', this.summaryOf('ts'), true,
        this.tog('Exact starting Hessian (Calc_Hess)', 'ts.calcHess', 'Strongly recommended: the model Hessian often misses the TS mode'),
        this.num('Recalculate Hessian every N steps', 'ts.recalcHess', { min: 0, step: 1, int: true })));
    }

    if (rel.freq) {
      out.push(this.sec('freq', 'Thermochemistry', this.summaryOf('freq'), true,
        h('div.ib-grid2', null, this.num('Temperature', 'freq.temperature', { min: 1, unit: 'K' }), this.num('Pressure', 'freq.pressureAtm', { min: 0.001, unit: 'atm' }))));
    }

    out.push(this.sec('res', 'Resources', this.summaryOf('res'), false,
      h('div.ib-grid2', null,
        this.num('Processes', 'resources.nprocs', { min: 1, step: 1, int: true }),
        this.num('Memory per core', 'resources.maxcoreMB', { min: 100, step: 100, int: true, unit: 'MB' })),
      h('div.ib-mem', null, this.memoryLine())));

    const conv: Child[] = [this.seg('SCF', 'convergence.scf', [{ value: 'normal', label: 'Normal' }, { value: 'tight', label: 'Tight' }, { value: 'verytight', label: 'Very tight' }], false)];
    if (rel.optConvergence) {
      conv.push(this.seg('Geometry', 'convergence.opt', [{ value: 'normal', label: 'Normal' }, { value: 'tight', label: 'Tight' }, { value: 'verytight', label: 'Very tight' }], false));
    }
    out.push(this.sec('conv', 'Convergence', this.summaryOf('conv'), false, conv));

    const ex = m.program === 'orca' ? 'extras.orca' : 'extras.pyscf';
    out.push(this.sec('extras', 'Extras', this.summaryOf('extras'), false,
      this.fld(m.program === 'orca' ? 'ORCA blocks' : 'Python code', ex,
        textArea(getPath(s, ex) as string, v => { setPath(s, ex, v); this.host.changed(); }, { rows: 5, placeholder: m.program === 'orca' ? '%scf\n  MaxIter 300\nend' : '# runs after the calculation, before result.json is written' }),
        m.program === 'orca' ? 'Inserted verbatim before the coordinates.' : 'Inserted verbatim before result.json is written.')));
    return out;
  }

  private memoryLine(): Child {
    const { nprocs, maxcoreMB } = this.s.resources;
    const total = totalMemoryLabel(nprocs, maxcoreMB);
    const orca = this.m.program === 'orca';
    const request = orca ? totalMemoryLabel(nprocs, Math.round(maxcoreMB * 1.25)) : total;
    return [
      h('span.ib-mem-total', null, h('b', null, total), ' in total'),
      h('span.muted', null, orca ? ` · ORCA can exceed %maxcore: request ≈ ${request} from the queue` : ' · passed to PySCF as max_memory')
    ];
  }

  private scanNow(): string {
    const at = this.s.geometry.atoms;
    const idx = this.s.scan.atoms;
    const get = (i: number) => at[i];
    if (idx.some(i => !Number.isInteger(i) || !get(i))) {
      return '';
    }
    const c = this.s.scan.coordinate;
    if (c === 'B' && idx.length === 2) {
      return `Current: ${distance(get(idx[0]), get(idx[1])).toFixed(3)} Å (${at[idx[0]].symbol}${idx[0]}–${at[idx[1]].symbol}${idx[1]})`;
    }
    if (c === 'A' && idx.length === 3) {
      return `Current: ${angle(get(idx[0]), get(idx[1]), get(idx[2])).toFixed(1)}°`;
    }
    if (c === 'D' && idx.length === 4) {
      return `Current: ${dihedral(get(idx[0]), get(idx[1]), get(idx[2]), get(idx[3])).toFixed(1)}°`;
    }
    return '';
  }
}
