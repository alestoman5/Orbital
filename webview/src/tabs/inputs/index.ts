// Webview side of the "inputs" studio tab: the Input Builder. A form on the
// left edits one InputSpec; the right column shows validation, the live
// ORCA / PySCF preview (generated here from src/inputs) and, for ensembles,
// the planned batch. The NEA sub-tab builds uv-vis NEA command lines.

import './inputs.css';
import type { TabInstance, TabView, ViewContext } from '../../view';
import { Child, debounce, h, mount } from '../../ui/dom';
import { badge, busy, button, callout, card, emptyState, icon, iconButton, kpi, numberInput, segmented, skeleton, split, subTabs, textInput, toggle } from '../../ui/components';
import { TEMPLATES, applyTemplate } from '../../../../src/inputs/templates';
import { describeSpec, Program, SpecIssue, supportIssues } from '../../../../src/inputs/spec';
import { splitEnsemble } from '../../../../src/inputs/batch';
import { formatBytes, mergeSpec, sortIssues } from '../../../../src/studio/tabs/inputs/shared';
import type {
  BatchPlanParams, BatchPlanResult, InputsNavigateArgs, LoadedGeometry, SaveInputResult, WriteBatchResult
} from '../../../../src/studio/tabs/inputs/types';
import { Form } from './form';
import { Generated, Model, applyGeometry, basename, batchActive, dirname, effectiveSpec, fileName, generate, restoreModel, xyzReference } from './model';
import { codeView } from './widgets';
import { NeaView } from './nea';

const PROGRAM_LABEL: Record<Program, string> = { orca: 'ORCA', pyscf: 'PySCF' };

class InputsApp {
  model: Model;
  private form: Form;
  private gen: Generated;
  private nea: NeaView;
  private readonly body = h('div.ib-body');
  private readonly galleryEl = h('div.ib-gallery');
  private readonly statusEl = h('div.ib-status');
  private readonly issuesEl = h('div.ib-issues');
  private readonly batchEl = h('div.ib-batch-host');
  private readonly codeEl = h('div.ib-code-host');
  private plan?: BatchPlanResult;
  private planKey = '';
  private planLoading = false;
  private lastBatchFolder?: string;
  private savePathText = '';
  private scriptTab: 'job' | 'run_all' | 'slurm' = 'job';
  private raf = 0;

  constructor(private root: HTMLElement, private ctx: ViewContext) {
    this.model = restoreModel(ctx.state<Partial<Model> | undefined>('model', undefined));
    this.form = new Form({
      model: this.model,
      changed: structural => this.changed(structural),
      importActive: () => this.model.activeFile && void this.loadFile(this.model.activeFile),
      pickFile: () => void this.pickFile(),
      pasteXyz: text => this.pasteXyz(text)
    });
    this.gen = generate(this.model);
    this.nea = new NeaView(ctx, () => this.model.nea, () => this.persist(), () => this.model.source.path);
    root.append(this.body);
    this.renderActions();
    this.layout();
  }

  // --- state ----------------------------------------------------------------

  private persist = debounce(() => {
    const m = this.model;
    this.ctx.setState('model', { ...m, pasteText: m.pasteText.length < 200_000 ? m.pasteText : '' });
  }, 250);

  changed(structural = false): void {
    if (structural) {
      this.form.render();
    }
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.form.render();
      this.refresh();
    });
  }

  private setProgram(p: Program): void {
    if (this.model.program === p) {
      return;
    }
    this.model.program = p;
    this.renderActions();
    this.renderGallery();
    this.form.render();
    this.refresh();
  }

  // --- layout ---------------------------------------------------------------

  private renderActions(): void {
    this.ctx.setActions(h('div.row', { title: 'Program the input is generated for' },
      segmented<Program>([{ value: 'orca', label: 'ORCA' }, { value: 'pyscf', label: 'PySCF' }], this.model.program, p => this.setProgram(p))));
  }

  private layout(): void {
    const tabs = subTabs([{ value: 'input', label: 'Input file' }, { value: 'nea', label: 'NEA command' }], this.model.sub, v => {
      this.model.sub = v;
      this.persist();
      this.layout();
    });
    if (this.model.sub === 'nea') {
      mount(this.body, tabs, this.nea.el);
      this.nea.render();
      return;
    }
    const preview = h('div.ib-preview', null, this.statusEl, this.issuesEl, this.batchEl, this.codeEl);
    mount(this.body, tabs, this.galleryEl, split(this.form.el, preview, { sidebarWidth: 410 }));
    this.renderGallery();
    this.form.render(true);
    this.refresh();
  }

  // --- template gallery -----------------------------------------------------

  private renderGallery(): void {
    const m = this.model;
    const head = h('button.ib-gallery-head', { type: 'button', 'aria-expanded': String(m.galleryOpen), onclick: () => { m.galleryOpen = !m.galleryOpen; this.persist(); this.renderGallery(); } },
      icon('chevronRight', 'icon chevron'), h('span.ib-gallery-title', null, 'Templates'),
      h('span.muted', null, m.galleryOpen ? 'Applying a template keeps the geometry, charge and multiplicity' : TEMPLATES.find(t => t.id === m.template)?.name ?? `${TEMPLATES.length} presets`));
    const cards = TEMPLATES.map(t => {
      const ok = t.programs.includes(m.program);
      const on = m.template === t.id;
      return h('button.ib-tpl', {
        type: 'button', class: [on ? 'on' : '', ok ? '' : 'off'].join(' '), disabled: !ok, 'aria-pressed': String(on),
        title: ok ? t.description : `${t.name} is written for ${t.programs.map(p => PROGRAM_LABEL[p]).join(' / ')} only; switch the program to use it.`,
        onclick: () => this.useTemplate(t.id)
      },
        h('div.ib-tpl-name', null, t.name, on ? icon('check', 'icon ib-tpl-check') : null),
        h('div.ib-tpl-desc', null, t.description),
        h('div.ib-tpl-progs', null, t.programs.map(p => h('span.ib-prog', { class: `p-${p}${p === m.program ? ' cur' : ''}` }, PROGRAM_LABEL[p]))));
    });
    mount(this.galleryEl, head, m.galleryOpen ? h('div.ib-tpl-row', null, cards) : null);
    this.galleryEl.classList.toggle('open', m.galleryOpen);
  }

  private useTemplate(id: string): void {
    const t = TEMPLATES.find(x => x.id === id);
    if (!t) {
      this.ctx.toast(`Unknown template "${id}"`, 'warning');
      return;
    }
    const geometry = this.model.spec.geometry;
    this.model.spec = applyTemplate(id, this.model.spec);
    this.model.spec.geometry = geometry;
    this.model.template = id;
    this.model.fileName = '';
    if (!t.programs.includes(this.model.program)) {
      this.setProgram(t.programs[0]);
    }
    this.renderGallery();
    this.form.render(true);
    this.refresh();
  }

  // --- geometry -------------------------------------------------------------

  async loadFile(path: string): Promise<void> {
    try {
      const g = await this.ctx.rpc<LoadedGeometry>('loadGeometry', { path });
      this.takeGeometry(g);
      this.ctx.toast(`Loaded ${g.name}: ${g.atoms.length} atoms${g.frames > 1 ? `, ${g.frames} frames` : ''}`, 'success');
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private async pickFile(): Promise<void> {
    try {
      const g = await this.ctx.rpc<LoadedGeometry | null>('pickGeometry');
      if (g) {
        this.takeGeometry(g);
      }
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private takeGeometry(g: LoadedGeometry): void {
    applyGeometry(this.model, g);
    this.model.batch.enabled = true;
    this.lastBatchFolder = undefined;
    this.form.render(true);
    this.refresh();
  }

  private pasteXyz(text: string): void {
    const m = this.model;
    m.pasteText = text;
    const frames = text.trim() ? splitEnsemble(text.trim() + '\n') : [];
    if (frames.length === 0) {
      this.changed(false);
      return;
    }
    applyGeometry(m, { kind: 'paste', name: 'Pasted XYZ', atoms: frames[0].atoms, frames: frames.length, comment: frames[0].comment, note: frames.length > 1 ? `${frames.length} frames` : undefined });
    m.pasteText = text;
    this.changed(true);
  }

  // --- right column -----------------------------------------------------------

  refresh(): void {
    const m = this.model;
    this.gen = generate(m);
    const leftover = this.form.showIssues(this.gen.issues);
    this.renderStatus();
    this.renderIssues(this.gen.issues, leftover);
    this.renderCode();
    if (batchActive(m)) {
      this.schedulePlan();
    } else {
      mount(this.batchEl);
    }
    this.updateSavePath();
    this.persist();
  }

  private renderStatus(): void {
    const m = this.model;
    const g = this.gen;
    const errors = g.issues.filter(i => i.severity === 'error').length;
    const warnings = g.issues.filter(i => i.severity === 'warning').length;
    const other: Program = m.program === 'orca' ? 'pyscf' : 'orca';
    const progErrors = g.issues.filter(i => i.severity === 'error' && i.program === m.program);
    const generic = g.issues.some(i => i.severity === 'error' && !i.program);
    const parts: Child[] = [
      h('div.ib-status-main', null,
        h('div.ib-status-title', null, describeSpec(effectiveSpec(m))),
        h('div.ib-status-meta', null,
          badge(PROGRAM_LABEL[m.program], 'accent'),
          errors ? badge(`${errors} error${errors > 1 ? 's' : ''}`, 'bad') : badge('Ready to save', 'ok'),
          warnings ? badge(`${warnings} warning${warnings > 1 ? 's' : ''}`, 'warn') : null,
          h('span.ib-support', { title: 'Programs that can generate this combination' },
            (['orca', 'pyscf'] as Program[]).map(p => h('span.ib-support-p', { class: g.supported.includes(p) ? 'yes' : 'no' }, icon(g.supported.includes(p) ? 'check' : 'close'), PROGRAM_LABEL[p])))))
    ];
    mount(this.statusEl, parts);
    if (progErrors.length > 0 && !generic && g.supported.includes(other)) {
      this.statusEl.append(callout('warn',
        h('div', null, h('b', null, `${PROGRAM_LABEL[m.program]} cannot generate this combination. `), `${PROGRAM_LABEL[other]} can.`),
        h('div.ib-callout-actions', null, button(`Switch to ${PROGRAM_LABEL[other]}`, () => this.setProgram(other), { variant: 'primary' }))));
    } else if (progErrors.length > 0 && !generic && g.supported.length === 0) {
      const why = supportIssues(effectiveSpec(m), other).filter(i => i.severity === 'error');
      this.statusEl.append(callout('bad',
        h('div', null, h('b', null, 'Neither ORCA nor PySCF generates this combination. '), `${PROGRAM_LABEL[m.program]}: see the errors below. ${PROGRAM_LABEL[other]}:`),
        h('ul.ib-issue-list.ib-why', null, why.map(i => h('li', null, h('button.ib-issue', { type: 'button', onclick: () => this.form.reveal(i) }, h('span', null, i.message), h('code.ib-issue-path', null, i.path)))))));
    }
  }

  private renderIssues(all: SpecIssue[], leftover: SpecIssue[]): void {
    const sorted = sortIssues(all);
    const item = (i: SpecIssue) => h('li', null,
      h('button.ib-issue', { type: 'button', title: leftover.includes(i) ? i.path : `Show ${i.path}`, onclick: () => this.form.reveal(i) },
        i.program ? h('span.ib-issue-prog', null, PROGRAM_LABEL[i.program]) : null,
        h('span', null, i.message), h('code.ib-issue-path', null, i.path)));
    const errors = sorted.filter(i => i.severity === 'error');
    const warnings = sorted.filter(i => i.severity === 'warning');
    const infos = sorted.filter(i => i.severity === 'info');
    const blocks: Child[] = [];
    if (errors.length) {
      blocks.push(callout('bad', h('div.ib-issue-head', null, `${errors.length} error${errors.length > 1 ? 's' : ''}: nothing is generated until fixed`), h('ul.ib-issue-list', null, errors.map(item))));
    }
    if (warnings.length) {
      blocks.push(callout('warn', h('div.ib-issue-head', null, `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`), h('ul.ib-issue-list', null, warnings.map(item))));
    }
    if (infos.length) {
      const open = this.model.open['notes'] ?? false;
      const d = h('details.ib-notes', { open }, h('summary', null, icon('info'), `${infos.length} note${infos.length > 1 ? 's' : ''}`), h('ul.ib-issue-list', null, infos.map(item)));
      d.addEventListener('toggle', () => { this.model.open['notes'] = d.open; });
      blocks.push(d);
    }
    mount(this.issuesEl, blocks);
  }

  private renderCode(): void {
    const m = this.model;
    const g = this.gen;
    const name = fileName(m);
    const nameInput = textInput(m.fileName || name, v => {
      m.fileName = v.trim() === name ? '' : v;
      this.updateSavePath();
      this.persist();
    }, { mono: true, placeholder: name });
    nameInput.classList.add('ib-filename');
    nameInput.addEventListener('change', () => this.renderCode());
    const blocked = g.errors.length > 0;
    const actions = [
      m.fileName ? iconButton('refresh', 'Reset to the automatic name', () => { m.fileName = ''; this.renderCode(); this.updateSavePath(); }) : null,
      iconButton('copy', 'Copy to clipboard', () => void navigator.clipboard.writeText(g.text).then(() => this.ctx.toast('Copied', 'success'))),
      button('Save as…', e => void this.save(e, true, false), { variant: 'ghost', disabled: blocked, title: 'Choose where to save' }),
      button('Save', e => void this.save(e, false, false), { disabled: blocked, title: 'Save next to the source geometry' }),
      button('Save & open', e => void this.save(e, false, true), { variant: batchActive(m) ? 'secondary' : 'primary', icon: 'external', disabled: blocked, title: 'Save, then open it in the editor (ORCA language features)' })
    ].filter(Boolean) as Node[];
    const head = h('div.ib-code-head', null,
      h('div.ib-code-name', null, icon(m.program === 'orca' ? 'file' : 'terminal'), nameInput),
      h('div.ib-code-actions', null, actions));
    const dest = h('div.ib-dest.muted', { title: this.savePathText }, this.savePathText ? ['Saves to ', h('span.mono', null, this.savePathText)] : '');
    const xyz = m.useXyzFile && !batchActive(m) ? xyzReference(m) : undefined;
    const lang = m.program === 'orca' ? 'orca' : 'python';
    const parts: Child[] = [head, dest];
    if (xyz?.companion) {
      parts.push(h('div.ib-foot.muted', null, icon('info'), `${xyz.companion.name} is written next to the input (unless it exists).`));
    }
    if (m.program === 'pyscf') {
      parts.push(h('div.ib-requires', null,
        h('div.ib-req-row', null, h('span.ib-req-label', null, 'Requires'), g.requires.map(r => h('span.ib-pkg', null, r)),
          h('code.ib-pip', null, `pip install ${g.requires.join(' ')}`),
          iconButton('copy', 'Copy pip command', () => void navigator.clipboard.writeText(`pip install ${g.requires.join(' ')}`))),
        h('div.ib-req-note.muted', null, icon('calcs'), 'Writes result.json next to the script: the run shows up in Calculations.')));
    }
    parts.push(codeView(g.text, lang, { copy: false, dim: blocked }));
    mount(this.codeEl, h('div.card.ib-code', null, parts));
  }

  private updateSavePath = debounce(async () => {
    const m = this.model;
    try {
      const p = await this.ctx.rpc<string>('savePath', { fileName: fileName(m), sourcePath: m.source.path });
      this.savePathText = dirname(p);
    } catch {
      this.savePathText = '';
    }
    const dest = this.codeEl.querySelector('.ib-dest');
    if (dest) {
      mount(dest, this.savePathText ? ['Saves to ', h('span.mono', null, this.savePathText)] : '');
      dest.setAttribute('title', this.savePathText);
    }
  }, 200);

  private async save(e: MouseEvent, dialog: boolean, open: boolean): Promise<void> {
    const m = this.model;
    if (this.gen.errors.length > 0) {
      this.ctx.toast('Fix the errors first: the input is not generated.', 'error');
      return;
    }
    const xyz = m.useXyzFile && !batchActive(m) ? xyzReference(m) : undefined;
    const r = await busy(e.currentTarget as HTMLButtonElement, () => this.ctx.rpc<SaveInputResult>('saveInput', {
      text: this.gen.text, fileName: fileName(m), sourcePath: m.source.path, dialog, open, companion: xyz?.companion
    }));
    if (r?.path) {
      this.ctx.toast(`Saved ${basename(r.path)}${r.companionWritten ? ` and ${basename(r.companionWritten)}` : ''}`, 'success');
    }
  }

  // --- batch ----------------------------------------------------------------

  private batchParams(): BatchPlanParams {
    const m = this.model;
    return {
      source: m.source.path ? { path: m.source.path } : { text: m.pasteText, name: 'pasted' },
      spec: effectiveSpec(m),
      program: m.program,
      maxFrames: m.batch.maxFrames > 0 ? m.batch.maxFrames : undefined,
      dirPrefix: m.batch.dirPrefix,
      slurm: m.batch.slurm
    };
  }

  private schedulePlan(): void {
    const params = this.batchParams();
    const key = JSON.stringify(params);
    if (key === this.planKey && this.plan) {
      this.renderBatch();
      return;
    }
    this.planKey = key;
    if (this.gen.errors.length > 0) {
      this.plan = undefined;
      this.planLoading = false;
      this.renderBatch();
      return;
    }
    this.planLoading = true;
    this.renderBatch();
    this.runPlan(key, params);
  }

  private runPlan = debounce(async (key: string, params: BatchPlanParams) => {
    try {
      const r = await this.ctx.rpc<BatchPlanResult>('planBatch', params);
      if (key === this.planKey) {
        this.plan = r;
      }
    } catch (e) {
      this.plan = { totalFrames: this.model.source.frames, frames: 0, files: [], fileCount: 0, totalBytes: 0, error: e instanceof Error ? e.message : String(e) };
    }
    if (key === this.planKey) {
      this.planLoading = false;
      if (batchActive(this.model)) {
        this.renderBatch();
      }
    }
  }, 300);

  private renderBatch(): void {
    const m = this.model;
    const p = this.plan;
    const opts = h('div.ib-batch-opts', null,
      h('label.field', null, h('span.field-label', { title: '0 = every frame' }, 'Frames (0 = all)'), numberInput(m.batch.maxFrames, v => { m.batch.maxFrames = Math.max(0, Math.round(v)); this.refresh(); }, { min: 0, step: 1 })),
      h('label.field', null, h('span.field-label', null, 'Directory prefix'), textInput(m.batch.dirPrefix, v => { m.batch.dirPrefix = v; this.refresh(); }, { mono: true, placeholder: 'e.g. geoms/' })),
      h('div.field.ib-toggle', null, toggle('Slurm array script', m.batch.slurm, v => { m.batch.slurm = v; this.refresh(); })));
    let content: Child;
    if (this.gen.errors.length > 0) {
      content = callout('info', 'The batch is planned once the input generates without errors.');
    } else if (!p) {
      content = skeleton(4);
    } else if (p.error) {
      content = callout('bad', h('b', null, 'Cannot plan the batch. '), p.error);
    } else {
      content = [
        h('div.ib-kpis', null,
          kpi('Jobs', p.frames.toLocaleString(), undefined, p.frames < p.totalFrames ? `of ${p.totalFrames.toLocaleString()} frames` : 'every frame'),
          kpi('Files', p.fileCount.toLocaleString(), undefined, m.program === 'orca' ? 'job.inp per frame' : 'run.py + geom.xyz per frame'),
          kpi('Size', formatBytes(p.totalBytes).split(' ')[0], formatBytes(p.totalBytes).split(' ')[1], 'on disk')),
        h('div.ib-batch-cols', null, this.fileTree(p), this.scriptPreview(p))
      ];
    }
    const target = p?.defaultTarget;
    const actions = [
      this.planLoading ? h('span.ib-spin', { title: 'Planning…' }) : null,
      button('Create batch…', e => void this.createBatch(e), { variant: 'primary', icon: 'folder', disabled: !p || !!p.error || this.gen.errors.length > 0, title: target ? `Pick the target folder (e.g. ${target})` : 'Pick the target folder' })
    ];
    const done = this.lastBatchFolder
      ? callout('ok', h('div', null, 'Batch written to ', h('span.mono', null, this.lastBatchFolder)),
          h('div.ib-callout-actions', null, button('Show in Calculations', () => this.ctx.navigate('calcs', { folder: this.lastBatchFolder }), { icon: 'calcs' })))
      : null;
    mount(this.batchEl, card({
      title: `Batch · ${m.source.frames.toLocaleString()} geometries`,
      subtitle: `${m.source.name}: one ${m.program === 'orca' ? 'ORCA job.inp' : 'PySCF run.py'} per frame, plus dirs.txt and run_all.sh${m.batch.slurm ? ' / submit_slurm.sh' : ''}`,
      actions, class: 'ib-batch'
    }, opts, content, done));
  }

  private fileTree(p: BatchPlanResult): HTMLElement {
    const rows: Child[] = [];
    let lastDir = '';
    const cut = p.files.length < p.fileCount ? p.files.length - 40 : -1;
    p.files.forEach((f, k) => {
      if (k === cut) {
        rows.push(h('div.ft-row.ft-gap', null, `… ${(p.fileCount - p.files.length).toLocaleString()} more files`));
      }
      const parts = f.relPath.split('/');
      const dir = parts.slice(0, -1).join('/');
      if (dir && dir !== lastDir) {
        rows.push(h('div.ft-row.ft-dir', null, icon('folder'), h('span', null, `${dir}/`)));
      }
      lastDir = dir;
      rows.push(h('div.ft-row', { class: dir ? 'ft-in' : '' }, icon(f.executable ? 'terminal' : 'file'), h('span.ft-name', null, parts[parts.length - 1]), h('span.ft-size', null, formatBytes(f.size))));
    });
    return h('div.ib-tree', null, h('div.ib-mini-title', null, 'Planned files'), h('div.ft', null, rows));
  }

  private scriptPreview(p: BatchPlanResult): HTMLElement {
    const items: { value: 'job' | 'run_all' | 'slurm'; label: string }[] = [
      { value: 'job', label: p.sampleJob ? basename(p.sampleJob.relPath) : 'job' },
      { value: 'run_all', label: 'run_all.sh' }
    ];
    if (p.slurm) {
      items.push({ value: 'slurm', label: 'submit_slurm.sh' });
    }
    if (!items.some(i => i.value === this.scriptTab)) {
      this.scriptTab = 'job';
    }
    const host = h('div.ib-script');
    const show = () => {
      const text = this.scriptTab === 'job' ? p.sampleJob?.content ?? '' : this.scriptTab === 'run_all' ? p.runAll ?? '' : p.slurm ?? '';
      const lang = this.scriptTab === 'job' ? (p.sampleJob?.relPath.endsWith('.py') ? 'python' : 'orca') : 'shell';
      mount(host, codeView(text, lang, { maxHeight: '340px' }));
    };
    show();
    return h('div.ib-scripts', null,
      h('div.ib-mini-title', null, this.scriptTab === 'job' && p.sampleJob ? p.sampleJob.relPath : 'Preview'),
      subTabs(items, this.scriptTab, v => { this.scriptTab = v; show(); }), host);
  }

  private async createBatch(e: MouseEvent): Promise<void> {
    const r = await busy(e.currentTarget as HTMLButtonElement, () => this.ctx.rpc<WriteBatchResult>('writeBatch', this.batchParams()));
    if (r?.status === 'written') {
      this.lastBatchFolder = r.folder;
      this.ctx.toast(`Wrote ${r.written.toLocaleString()} files to ${basename(r.folder)}`, 'success');
      this.renderBatch();
    }
  }

  // --- navigation -------------------------------------------------------------

  async onNavigate(raw: unknown): Promise<void> {
    const a = (raw && typeof raw === 'object' ? raw : {}) as InputsNavigateArgs;
    if (a.program === 'orca' || a.program === 'pyscf') {
      this.model.program = a.program;
      this.renderActions();
    }
    const wanted = a.view === 'nea' || a.neaInputs || a.neaScript ? 'nea' : a.view === 'input' || a.geometryFile || a.template ? 'input' : this.model.sub;
    if (a.neaScript === 'from_geometry.py' || a.neaScript === 'from_ensemble.py' || a.neaScript === 'compare_ensembles.py') {
      this.model.nea.script = a.neaScript;
    }
    if (Array.isArray(a.neaInputs)) {
      const paths = a.neaInputs.filter((p): p is string => typeof p === 'string');
      this.model.nea.inputs = this.model.nea.script === 'compare_ensembles.py' ? paths : paths.slice(0, 1);
    }
    if (wanted !== this.model.sub || wanted === 'nea') {
      this.model.sub = wanted;
      this.layout();
    }
    if (typeof a.geometryFile === 'string' && a.geometryFile) {
      this.model.activeFile = a.geometryFile;
      await this.loadFile(a.geometryFile);
    }
    if (typeof a.template === 'string' && a.template) {
      this.useTemplate(a.template);
    }
    if (a.spec && typeof a.spec === 'object') {
      const geometry = this.model.spec.geometry;
      this.model.spec = mergeSpec(this.model.spec, a.spec);
      this.model.spec.geometry = geometry;
    }
    {
      this.renderGallery();
      this.form.render(true);
      this.refresh();
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}

export const view: TabView = {
  mount(root, ctx): TabInstance {
    let app: InputsApp;
    try {
      app = new InputsApp(root, ctx);
    } catch (e) {
      root.append(emptyState('inputs', 'The Input Builder failed to load', e instanceof Error ? e.message : String(e)));
      return {};
    }
    return {
      onNavigate: args => void app.onNavigate(args),
      dispose: () => app.dispose()
    };
  }
};
