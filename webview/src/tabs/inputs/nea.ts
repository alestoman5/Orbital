// "NEA command" sub-tab: the form version of the orcaInp.nea.command quick
// picks (src/features/neaRuns.ts). The command line itself is built on the
// host (buildNeaCommand needs Node's path to make paths relative).

import { Child, debounce, h, mount } from '../../ui/dom';
import { button, callout, card, field, icon, iconButton, numberInput, segmented, skeleton, split, textInput } from '../../ui/components';
import type { ViewContext } from '../../view';
import type { NeaCommandResult, NeaInfo, NeaScriptName } from '../../../../src/studio/tabs/inputs/types';
import { combo } from './widgets';
import { NeaForm, basename } from './model';

const SCRIPTS: { value: NeaScriptName; label: string; desc: string }[] = [
  { value: 'from_geometry.py', label: 'From geometry', desc: 'One geometry (or molden / MD trajectory): sample an ensemble, then compute the spectrum.' },
  { value: 'from_ensemble.py', label: 'From ensemble', desc: 'A multi-XYZ file of geometries you already have: compute the spectrum.' },
  { value: 'compare_ensembles.py', label: 'Compare ensembles', desc: 'Several geometry sets (or finished working directories): one comparison plot.' }
];

const METHODS = ['adc(2)', 'adc(2)-x', 'adc(3)'].map(v => ({ value: v }));
const BASES = ['aug-cc-pVDZ', 'aug-cc-pVTZ', 'cc-pVDZ', 'cc-pVTZ', 'def2-SVPD', 'def2-TZVPD', 'd-aug-cc-pVDZ'].map(v => ({ value: v }));

export class NeaView {
  readonly el = h('div.ib-nea');
  private info?: NeaInfo;
  private result?: NeaCommandResult;
  private error?: string;
  private readonly previewEl = h('div.ib-nea-preview');

  constructor(private ctx: ViewContext, private form: () => NeaForm, private persist: () => void, private currentGeometry: () => string | undefined) {}

  private get f(): NeaForm { return this.form(); }

  render(): void {
    mount(this.el, split(this.formEl(), this.previewEl, { sidebarWidth: 410 }));
    this.renderPreview();
    if (!this.info) {
      void this.ctx.rpc<NeaInfo>('neaInfo').then(i => { this.info = i; this.renderPreview(); }).catch(() => undefined);
    }
    this.update();
  }

  private changed(rebuild = false): void {
    this.persist();
    if (rebuild) {
      this.render();
    } else {
      this.update();
    }
  }

  private update = debounce(async () => {
    try {
      const f = this.f;
      this.result = await this.ctx.rpc<NeaCommandResult>('neaCommand', { ...f, outDir: f.outDir.trim() || undefined });
      this.error = undefined;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.renderPreview();
  }, 120);

  private num(label: string, key: keyof NeaForm, opts: { min?: number; step?: number; unit?: string; hint?: string } = {}): HTMLElement {
    const input = numberInput(this.f[key] as number, v => { (this.f as any)[key] = v; this.changed(); }, { min: opts.min, step: opts.step ?? 1 });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        (this.f as any)[key] = v;
        this.changed();
      }
    });
    return field(label, opts.unit ? h('div.ib-unit', null, input, h('span', null, opts.unit)) : input, opts.hint);
  }

  private formEl(): HTMLElement {
    const f = this.f;
    const compare = f.script === 'compare_ensembles.py';
    const script = SCRIPTS.find(s => s.value === f.script)!;
    const cur = this.currentGeometry();
    const inputs = h('div.ib-nea-inputs', null,
      f.inputs.length === 0 ? h('div.ib-nea-empty.muted', null, 'No input yet: the preview uses a placeholder.') : null,
      f.inputs.map((p, k) => h('div.ib-nea-input', { title: p }, icon(/\.\w+$/.test(p) ? 'file' : 'folder'), h('span.mono', null, basename(p)), h('span.muted.ib-nea-dir', null, p.replace(/[\\/][^\\/]*$/, '')),
        iconButton('close', 'Remove', () => { f.inputs.splice(k, 1); this.changed(true); }))),
      h('div.row', null,
        button(compare ? 'Add sets…' : f.inputs.length ? 'Replace…' : 'Pick file…', () => void this.pick(), { icon: 'folder' }),
        cur && !f.inputs.includes(cur) ? button(`Use ${basename(cur)}`, () => { f.inputs = compare ? [...f.inputs, cur] : [cur]; this.changed(true); }, { variant: 'ghost', title: cur }) : null));
    const body: Child[] = [
      field('Script', segmented(SCRIPTS.map(s => ({ value: s.value, label: s.label })), f.script, v => {
        f.script = v;
        if (v !== 'compare_ensembles.py') {
          f.inputs = f.inputs.slice(0, 1);
        }
        this.changed(true);
      }), script.desc),
      field(compare ? 'Geometry sets' : 'Input', inputs)
    ];
    if (f.script === 'from_geometry.py') {
      const sampling: Child[] = [
        field('Sampling', segmented([{ value: 'wigner', label: 'Wigner' }, { value: 'md', label: 'MD trajectory' }], f.sampling, v => { f.sampling = v; this.changed(true); })),
        this.num('Samples', 'nsamples', { min: 1 })
      ];
      if (f.sampling === 'wigner') {
        sampling.push(h('div.ib-grid2', null,
          field('Sampling method', combo({ value: f.sampleMethod, items: ['PBE', 'PBE0', 'B3LYP', 'CAM-B3LYP', 'wB97X-D'].map(v => ({ value: v })), onChange: v => { f.sampleMethod = v; this.changed(); } })),
          field('Sampling basis', combo({ value: f.sampleBasis, items: BASES, onChange: v => { f.sampleBasis = v; this.changed(); } }))),
          this.num('Temperature', 'temperature', { min: 0, unit: 'K', hint: 'Wigner distribution temperature' }));
      } else {
        sampling.push(h('div.ib-grid3', null, this.num('Skip', 'skip', { min: 0 }), this.num('Stride', 'stride', { min: 1 }), this.num('Beads', 'beads', { min: 1 })));
      }
      body.push(h('div.ib-nea-group', null, h('div.ib-mini-title', null, 'Ensemble sampling'), sampling));
    }
    body.push(h('div.ib-nea-group', null, h('div.ib-mini-title', null, 'Excited states'),
      h('div.ib-grid2', null,
        field('Method', combo({ value: f.method, items: METHODS, onChange: v => { f.method = v; this.changed(); } })),
        field('Basis', combo({ value: f.basis, items: BASES, onChange: v => { f.basis = v; this.changed(); } }))),
      h('div.ib-grid2', null, this.num('States', 'nstates', { min: 1 }), this.num('Parallel jobs', 'jobs', { min: 1, hint: '-j: geometries computed at once' }))));
    body.push(field('Output directory', textInput(f.outDir, v => { f.outDir = v; this.changed(); }, { mono: true, placeholder: compare ? 'runs/compare' : `runs/<input>${f.script === 'from_geometry.py' ? `_${f.sampling}` : ''}` }), 'Relative to the repository root; empty = the script default.'));
    return h('div.ib-nea-form', null, body);
  }

  private async pick(): Promise<void> {
    const compare = this.f.script === 'compare_ensembles.py';
    try {
      const paths = await this.ctx.rpc<string[]>('pickInputs', { many: compare, folders: compare });
      if (paths.length > 0) {
        this.f.inputs = compare ? [...this.f.inputs, ...paths.filter(p => !this.f.inputs.includes(p))] : [paths[0]];
        this.changed(true);
      }
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private renderPreview(): void {
    const r = this.result;
    const info = this.info;
    const parts: Child[] = [];
    if (info && info.source === 'none') {
      parts.push(callout('warn', h('b', null, 'scripts/from_geometry.py was not found in the workspace. '),
        'The command assumes it runs from ', h('span.mono', null, r?.cwd ?? 'the workspace folder'), '. Set ', h('code', null, 'orcaInp.nea.scriptsDir'), ' to the uv-vis scripts folder.'));
    }
    if (this.error) {
      parts.push(callout('bad', this.error));
    }
    if (!r) {
      parts.push(card({ title: 'Command' }, skeleton(2)));
    } else {
      const cd = `cd ${/\s/.test(r.cwd) ? `"${r.cwd}"` : r.cwd} && ${r.command}`;
      parts.push(card({
        title: 'Command',
        subtitle: info?.source === 'setting' ? 'Scripts folder from orcaInp.nea.scriptsDir' : info?.source === 'search' ? 'Scripts folder found in the workspace' : undefined,
        actions: [
          button('Copy with cd', () => void navigator.clipboard.writeText(cd).then(() => this.ctx.toast('Copied', 'success')), { variant: 'ghost', title: cd }),
          button('Copy command', () => void navigator.clipboard.writeText(r.command).then(() => this.ctx.toast('Copied', 'success')), { variant: 'ghost', icon: 'copy' }),
          button('Send to terminal', () => void this.ctx.studio('runInTerminal', { command: r.command, cwd: r.cwd, name: 'NEA' })
            .then(() => this.ctx.toast('Typed into the NEA terminal — review it, then press Enter', 'success')), {
            variant: 'primary', icon: 'terminal', disabled: !!r.placeholder, title: 'Types the command into a terminal in the run folder (not executed)'
          })
        ],
        class: 'ib-nea-cmd'
      },
        h('div.ib-cmd', { class: r.placeholder ? 'placeholder' : '' }, h('span.ib-cmd-prompt', { 'aria-hidden': 'true' }, '$'), h('code', null, this.colorize(r.command))),
        h('div.ib-cmd-meta', null, icon('terminal'), h('span', null, 'Run from '), h('span.mono', null, r.cwd)),
        r.placeholder ? h('div.ib-cmd-meta.muted', null, icon('info'), 'Pick an input to replace the placeholder geometry path.') : null,
        h('div.ib-cmd-meta.muted', null, icon('info'), '"Send to terminal" types the command without running it, so you can check it first.')));
      parts.push(card({ title: 'What it does' }, h('ol.ib-steps', null, this.steps().map(s => h('li', null, s)))));
    }
    mount(this.previewEl, parts);
  }

  private colorize(cmd: string): Child[] {
    return cmd.split(/(\s+)/).map(w => (/^-{1,2}[a-zA-Z]/.test(w) ? h('span.tk-option', null, w) : /^scripts\//.test(w) ? h('span.tk-function', null, w) : /^python$/.test(w) ? h('span.tk-keyword', null, w) : w));
  }

  private steps(): string[] {
    const f = this.f;
    const exc = `${f.method.toUpperCase()}/${f.basis}, ${f.nstates} state${f.nstates > 1 ? 's' : ''} per geometry, ${f.jobs} in parallel`;
    if (f.script === 'from_geometry.py') {
      return [
        f.sampling === 'wigner'
          ? `ORCA opt + freq at ${f.sampleMethod}/${f.sampleBasis}, then draw ${f.nsamples.toLocaleString()} Wigner samples at ${f.temperature} K`
          : `Take ${f.nsamples.toLocaleString()} frames of the trajectory (skip ${f.skip}, stride ${f.stride}, ${f.beads} bead${f.beads > 1 ? 's' : ''})`,
        `Excited states: ${exc}`,
        'Nuclear-ensemble spectrum with bootstrap confidence band'
      ];
    }
    if (f.script === 'from_ensemble.py') {
      return [`Excited states for every geometry of the ensemble: ${exc}`, 'Nuclear-ensemble spectrum with confidence band'];
    }
    return [`Compute (or reuse) each set: ${exc}`, 'One comparison plot of all spectra'];
  }
}
