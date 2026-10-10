// Webview side of the "report" studio tab: a Word-like editor of a LaTeX
// report (document model from src/report/texDoc.ts, serialized and saved by
// the host), compile with errors and log, live PDF preview (pdf.js), the
// figures panel, and "Send to report" from the other tabs.
//
// onNavigate args: { texFile?: string, panel?: 'pdf' | 'figures' | 'problems', compile?: boolean,
//                    incoming?: SendToReportPayload (dev harness: same as the incomingFigure event) }

import './report.css';
import type { SendToReportPayload } from '../../../../src/studio/protocol';
import type {
  AddFigureResponse, CompileResponse, FiguresResponse, ImportableFigure, PdfResponse, ReportDoc, SaveResponse, ThumbResponse
} from '../../../../src/studio/tabs/report/types';
import { figureBlock, insertFigure } from '../../../../src/report/texDoc';
import { badge, button, busy, callout, emptyState, icon, iconButton, segmented, skeleton } from '../../ui/components';
import { h, mount } from '../../ui/dom';
import type { TabView, ViewContext } from '../../view';
import { dialog } from './dialog';
import { sanitizeName } from './names';
import { createEditor } from './editor';
import { base64ToBytes, createPdfViewer, initPdfWorker, pdfThumb, workerMode } from './pdf';

type Panel = 'pdf' | 'figures' | 'problems';

interface NavArgs {
  texFile?: string;
  panel?: Panel;
  compile?: boolean;
  incoming?: SendToReportPayload;
}

const WIDTHS = ['0.5\\textwidth', '0.75\\textwidth', '0.85\\textwidth', '\\textwidth'];

export const view: TabView = {
  mount(root, ctx) {
    return new ReportTab(root, ctx);
  }
};

class ReportTab {
  private rep: ReportDoc | null = null;
  private dirty = false;
  private loading = false;
  private cursorSection = 0;
  private panel: Panel;
  private compileRes: CompileResponse | null = null;
  private compiling = false;
  private figures: FiguresResponse | null = null;
  private pdfMtime = 0;
  private pendingFigure: SendToReportPayload | null = null;
  private visible = true;
  private readonly offs: (() => void)[] = [];

  private readonly editor;
  private readonly viewer;
  private readonly editorBox = h('div.rp-editor');
  private readonly sideBody = h('div.rp-side-body');
  private readonly sideTabs = h('div.rp-side-tabs');
  private readonly pdfBar = h('div.rp-pdf-bar');
  private readonly pdfBox = h('div.rp-pdf');
  private readonly figBox = h('div.rp-figs');
  private readonly probBox = h('div.rp-problems');
  private readonly statusChip = h('span.rp-status');
  private readonly dirtyChip = h('span.rp-dirty');

  constructor(private readonly root: HTMLElement, private readonly ctx: ViewContext) {
    this.panel = ctx.state<Panel>('panel', 'pdf');
    this.editor = createEditor({
      dirty: () => this.markDirty(),
      focusSection: i => { this.cursorSection = i; },
      thumb: ref => this.rep ? ctx.rpc<ThumbResponse>('thumb', { texPath: this.rep.path, ref }) : Promise.reject(new Error('no report')),
      assetBase: ctx.assetBase,
      figureRefs: () => this.figures?.inFolder.map(f => f.ref) ?? [],
      confirm: (message, action) => ctx.studio('confirm', { message, action })
    });
    this.viewer = createPdfViewer(ctx.assetBase, ctx.state<number | 'fit'>('zoom', 'fit'));
    this.viewer.onPageChange((p, n) => this.renderPdfBar(p, n));
    this.pdfBox.append(this.viewer.el);
    void initPdfWorker(ctx.assetBase);

    mount(root, h('div.rp', null,
      h('div.rp-main', null, this.editorBox),
      h('aside.rp-side', null, this.sideTabs, this.sideBody)));
    this.renderSide();
    this.renderEmpty();

    this.offs.push(ctx.on('incomingFigure', (p: SendToReportPayload) => void this.incoming(p)));
    const onKey = (e: KeyboardEvent) => {
      if (!this.visible || !this.rep) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void (e.shiftKey ? this.saveAndCompile() : this.save());
      }
    };
    window.addEventListener('keydown', onKey);
    this.offs.push(() => window.removeEventListener('keydown', onKey));

    void this.start();
  }

  // --- lifecycle ------------------------------------------------------------------

  private async start(): Promise<void> {
    const remembered = this.ctx.state<string | null>('texFile', null);
    let file = remembered;
    if (!file) {
      try {
        file = (await this.ctx.rpc<{ path: string | null }>('defaultFile')).path;
      } catch { /* none */ }
    }
    if (file && !this.rep && !this.loading) await this.open(file);
  }

  onNavigate(raw: unknown): void {
    const a = (raw ?? {}) as NavArgs;
    if (a.panel) this.setPanel(a.panel);
    void (async () => {
      if (a.texFile && a.texFile !== this.rep?.path) await this.open(a.texFile);
      if (a.compile && this.rep) await this.compile();
      if (a.incoming) await this.incoming(a.incoming);
    })();
  }

  onShow(): void {
    this.visible = true;
    this.updateActions();
  }

  onHide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.offs.forEach(f => f());
    this.viewer.dispose();
  }

  // --- open / load ---------------------------------------------------------------------

  private renderEmpty(): void {
    if (this.rep) return;
    const list = h('div.rp-texlist', null, skeleton(2));
    mount(this.editorBox, h('div.rp-empty', null,
      emptyState('report', 'Open a LaTeX report', 'Edit sections, bullet lists, figures and captions like in a word processor; compile and preview the PDF next to it.',
        button('Open .tex…', () => void this.pick(), { variant: 'primary', icon: 'folder' })),
      list));
    void this.ctx.rpc<string[]>('texFiles').then(files => {
      mount(list, files.length
        ? [h('div.rp-texlist-head', null, 'In this workspace'), files.slice(0, 30).map(f =>
            h('button.rp-texfile', { type: 'button', onclick: () => void this.open(f) }, icon('file'), h('span', null, f)))]
        : null);
    }, () => mount(list));
    this.updateActions();
  }

  private async pick(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const p = await this.ctx.rpc<string | null>('pickTex');
    if (p) await this.open(p, true);
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    return this.ctx.studio('confirm', { message: 'Discard the unsaved changes of the report?', action: 'Discard' });
  }

  private async open(file: string, force = false): Promise<void> {
    if (!force && this.dirty && !(await this.confirmDiscard())) return;
    this.loading = true;
    if (!this.rep) mount(this.editorBox, h('div.rp-paper', null, skeleton(10)));
    try {
      const r = await this.ctx.rpc<ReportDoc>('load', { path: file });
      const changedFile = this.rep?.path !== r.path;
      this.rep = r;
      this.dirty = false;
      this.ctx.setState('texFile', r.path);
      if (changedFile) {
        this.compileRes = null;
        this.viewer.clear();
        this.pdfMtime = 0;
        this.editor.clearThumbs();
      }
      this.cursorSection = Math.min(this.cursorSection, Math.max(0, r.doc.sections.length - 1));
      mount(this.editorBox, this.editor.el);
      await this.loadFigures();
      this.editor.setDoc(r.doc);
      this.updateActions();
      this.renderSide();
      if (r.hasPdf) void this.loadPdf(!changedFile);
      if (this.pendingFigure) {
        const p = this.pendingFigure;
        this.pendingFigure = null;
        void this.incoming(p);
      }
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
      if (!this.rep) {
        this.ctx.setState('texFile', null);
        this.renderEmpty();
      }
    } finally {
      this.loading = false;
    }
  }

  private async reload(): Promise<void> {
    if (!this.rep) return;
    if (this.dirty && !(await this.ctx.studio('confirm', { message: 'Reload the .tex from disk and discard the unsaved changes?', action: 'Reload' }))) return;
    await this.open(this.rep.path, true);
    this.ctx.toast('Reloaded from disk', 'info');
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.updateActions();
    }
  }

  // --- save / compile ---------------------------------------------------------------------

  private async save(force = false): Promise<boolean> {
    if (!this.rep) return false;
    const rep = this.rep;
    let r: SaveResponse;
    try {
      r = await this.ctx.rpc<SaveResponse>('save', { path: rep.path, doc: rep.doc, mtimeMs: rep.mtimeMs, force });
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    }
    if (r.status === 'conflict') {
      const choice = await dialog<'reload' | 'overwrite' | 'cancel'>(this.root, {
        title: 'The file changed on disk',
        body: h('div.stack', null,
          h('p', null, h('code', null, rep.name), ' was modified outside the editor since it was loaded', r.mtimeMs === null ? ' (it was deleted).' : '.'),
          h('p.muted', null, 'Reload discards your unsaved edits and shows the version on disk. Overwrite replaces the disk version with yours (it is backed up to .orbital/report-backups first).')),
        actions: [
          { label: 'Cancel', value: 'cancel', variant: 'ghost' },
          { label: 'Reload from disk', value: 'reload' },
          { label: 'Overwrite', value: 'overwrite', variant: 'danger' }
        ],
        cancel: 'cancel'
      });
      if (choice === 'reload') {
        await this.open(rep.path, true);
        return false;
      }
      if (choice === 'overwrite') return this.save(true);
      return false;
    }
    rep.mtimeMs = r.mtimeMs;
    this.dirty = false;
    this.updateActions();
    this.ctx.toast(r.status === 'unchanged' ? 'No changes to save' : 'Saved', r.status === 'unchanged' ? 'info' : 'success');
    return true;
  }

  private async saveAndCompile(): Promise<void> {
    if (this.dirty && !(await this.save())) return;
    await this.compile();
  }

  private async compile(): Promise<void> {
    if (!this.rep || this.compiling) return;
    this.compiling = true;
    this.updateActions();
    this.renderStatus();
    try {
      this.compileRes = await this.ctx.rpc<CompileResponse>('compile', { path: this.rep.path });
      if (this.compileRes.ok) {
        await this.loadPdf(true);
        this.ctx.toast(`Compiled in ${(this.compileRes.durationMs / 1000).toFixed(1)} s`, 'success');
      } else {
        this.setPanel('problems');
        this.ctx.toast(`Compilation failed: ${this.compileRes.errors[0]?.message ?? 'see the log'}`, 'error');
      }
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      this.compiling = false;
      this.updateActions();
      this.renderSide();
    }
  }

  private async loadPdf(keepScroll: boolean): Promise<void> {
    if (!this.rep) return;
    try {
      this.root.dataset.pdf = 'fetching';
      const p = await this.ctx.rpc<PdfResponse>('pdf', { path: this.rep.path });
      if (!p) return;
      this.pdfMtime = p.mtimeMs;
      this.root.dataset.pdf = 'parsing';
      const n = await this.viewer.load(base64ToBytes(p.data), keepScroll);
      this.root.dataset.pdf = `loaded:${n}:${workerMode}`;
      this.renderSide();
    } catch (e) {
      this.root.dataset.pdf = `error:${e instanceof Error ? e.message : String(e)}`;
      mount(this.pdfBox, callout('bad', `PDF preview failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // --- header actions -------------------------------------------------------------------------

  private updateActions(): void {
    const rep = this.rep;
    mount(this.dirtyChip, rep ? (this.dirty ? [h('span.rp-dot'), 'Unsaved changes'] : [icon('check'), 'Saved']) : null);
    this.dirtyChip.className = `rp-dirty${this.dirty ? ' on' : ''}`;
    if (!rep) {
      this.ctx.setActions(button('Open .tex…', () => void this.pick(), { icon: 'folder', variant: 'ghost' }));
      return;
    }
    const saveBtn = button('Save', () => void busy(saveBtn, () => this.save()), { icon: 'download', variant: 'secondary', title: 'Save (Ctrl+S)' });
    const compileBtn = button(this.compiling ? 'Compiling…' : 'Save & compile', () => void this.saveAndCompile(), { icon: 'play', variant: 'primary', title: `Save and compile with ${rep.engine} (Ctrl+Shift+S)`, disabled: this.compiling });
    if (this.compiling) compileBtn.classList.add('busy');
    this.ctx.setActions(
      h('span.rp-file', { title: rep.path }, icon('file'), rep.name),
      this.dirtyChip,
      badge(rep.engine, 'muted'),
      iconButton('refresh', 'Reload from disk', () => void this.reload()),
      iconButton('folder', 'Open another .tex…', () => void this.pick()),
      saveBtn,
      compileBtn);
  }

  // --- side panel ----------------------------------------------------------------------------------

  private setPanel(p: Panel): void {
    this.panel = p;
    this.ctx.setState('panel', p);
    this.renderSide();
  }

  private renderSide(): void {
    const n = this.compileRes?.errors.length ?? 0;
    mount(this.sideTabs, segmented<Panel>([
      { value: 'pdf', label: 'PDF' },
      { value: 'figures', label: `Figures${this.figures ? ` (${this.figures.inFolder.length})` : ''}` },
      { value: 'problems', label: n ? `Problems (${n})` : 'Compile log' }
    ], this.panel, v => this.setPanel(v)), this.statusChip);
    this.renderStatus();
    if (this.panel === 'pdf') {
      mount(this.sideBody, this.pdfBar, this.pdfBox);
      this.renderPdfBar(this.viewer.pageInfo().page, this.viewer.pageInfo().pages);
      if (!this.viewer.pageInfo().pages) {
        this.pdfBox.querySelector('.rp-pdf-empty')?.remove();
        this.pdfBox.append(h('div.rp-pdf-empty', null, emptyState('report', this.rep ? 'No PDF yet' : 'No report open',
          this.rep ? 'Save & compile to see the PDF here. It stays in place while you edit.' : 'Open a .tex to edit and preview it.',
          this.rep ? button('Compile', () => void this.compile(), { icon: 'play', variant: 'primary' }) : null)));
      } else {
        this.pdfBox.querySelector('.rp-pdf-empty')?.remove();
      }
    } else if (this.panel === 'figures') {
      mount(this.sideBody, this.figBox);
      this.renderFigures();
    } else {
      mount(this.sideBody, this.probBox);
      this.renderProblems();
    }
  }

  private renderStatus(): void {
    const r = this.compileRes;
    this.statusChip.className = 'rp-status';
    if (this.compiling) {
      this.statusChip.classList.add('tone-info');
      mount(this.statusChip, h('span.rp-spin'), 'compiling…');
    } else if (r) {
      this.statusChip.classList.add(r.ok ? 'tone-ok' : 'tone-bad');
      mount(this.statusChip, icon(r.ok ? 'check' : 'error'), r.ok ? `compiled · ${(r.durationMs / 1000).toFixed(1)} s` : r.timedOut ? 'timed out' : `${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`);
    } else {
      mount(this.statusChip);
    }
  }

  private renderPdfBar(page: number, pages: number): void {
    const z = this.viewer.zoom();
    const setZoom = (v: number | 'fit') => {
      this.viewer.setZoom(v);
      this.ctx.setState('zoom', v);
      this.renderPdfBar(this.viewer.pageInfo().page, this.viewer.pageInfo().pages);
    };
    const cur = z === 'fit' ? null : z;
    mount(this.pdfBar,
      iconButton('chevronDown', 'Previous page', () => this.viewer.goTo(page - 1)),
      h('span.rp-page', null, pages ? `${page} / ${pages}` : '– / –'),
      iconButton('chevronDown', 'Next page', () => this.viewer.goTo(page + 1)),
      h('span.rp-spacer'),
      iconButton('zoomReset', 'Fit width', () => setZoom('fit')),
      h('button.btn.ghost.rp-zoom', { type: 'button', title: 'Zoom out', onclick: () => setZoom(Math.max(0.4, (cur ?? 1) / 1.2)) }, '−'),
      h('span.rp-zoom-val', null, z === 'fit' ? 'fit' : `${Math.round(z * 100)} %`),
      h('button.btn.ghost.rp-zoom', { type: 'button', title: 'Zoom in', onclick: () => setZoom(Math.min(4, (cur ?? 1) * 1.2)) }, '+'),
      workerMode === 'src' ? h('span.rp-worker-note', { title: 'pdf.js could not start its worker from a blob: URL and runs in the page' }, icon('info')) : null);
    this.pdfBar.firstElementChild?.classList.add('rp-prev');
  }

  private renderProblems(): void {
    const r = this.compileRes;
    if (!r) {
      mount(this.probBox, emptyState('report', 'Not compiled yet', `Save & compile runs ${this.rep?.engine ?? 'LaTeX'}; errors and the log appear here.`));
      return;
    }
    const errors = r.errors.map(e => h('button.rp-error', {
      type: 'button', disabled: !e.absPath, title: e.absPath ? `Open ${e.absPath}:${e.line}` : undefined,
      onclick: () => { if (e.absPath && this.rep) void this.ctx.rpc('open', { path: e.absPath, line: (e.line ?? 1) - 1, texPath: this.rep.path }).catch(err => this.ctx.toast(String(err), 'error')); }
    },
    icon('error'),
    h('span.rp-error-text', null, h('b', null, e.message), e.context ? h('code', null, e.context) : null),
    e.line !== undefined ? h('span.rp-error-loc', null, `${e.file ? `${e.file}:` : 'line '}${e.line}`) : null));
    const log = h('details.rp-log', { open: !r.ok }, h('summary', null, icon('chevronRight', 'icon chevron'), 'Log', h('span.muted', null, ' · last lines')), h('pre.code', null, r.log || '(no output)'));
    mount(this.probBox,
      r.ok ? callout('ok', `Compiled with ${r.engine} in ${(r.durationMs / 1000).toFixed(1)} s.`) : callout('bad', h('b', null, `${r.engine} failed`), r.timedOut ? ' (timed out)' : r.exitCode !== null ? ` (exit code ${r.exitCode})` : ''),
      errors.length ? h('div.rp-errors', null, errors) : null,
      log,
      r.logPath && this.rep ? button('Open full log', () => void this.ctx.rpc('open', { path: r.logPath, texPath: this.rep!.path }), { variant: 'ghost', icon: 'external' }) : null);
    requestAnimationFrame(() => { const pre = log.querySelector('pre'); if (pre) pre.scrollTop = pre.scrollHeight; });
  }

  // --- figures ---------------------------------------------------------------------------------------

  private async loadFigures(): Promise<void> {
    if (!this.rep) return;
    try {
      this.figures = await this.ctx.rpc<FiguresResponse>('figures', { path: this.rep.path });
    } catch (e) {
      this.figures = null;
      this.ctx.toast(`Figures: ${e instanceof Error ? e.message : String(e)}`, 'warning');
    }
  }

  private insertRef(ref: string): void {
    if (!this.rep) return;
    const doc = this.rep.doc;
    if (!doc.sections.length) return;
    const si = Math.min(this.cursorSection, doc.sections.length - 1);
    const base = ref.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    insertFigure(doc, si, figureBlock(ref, '', `fig:${sanitizeName(base)}`, '0.85\\textwidth'));
    this.markDirty();
    this.editor.render(`${si}.${doc.sections[si].blocks.length - 1}`);
    this.ctx.toast(`Figure inserted in "${doc.sections[si].title || 'section ' + (si + 1)}"`, 'success');
  }

  private renderFigures(): void {
    const f = this.figures;
    if (!this.rep) {
      mount(this.figBox, emptyState('report', 'No report open', 'Open a .tex first.'));
      return;
    }
    if (!f) {
      mount(this.figBox, skeleton(4));
      return;
    }
    const sectionName = () => this.rep?.doc.sections[this.cursorSection]?.title ?? '';
    const thumb = (file: string) => {
      const box = h('div.rp-ft-img', null, h('div.rp-fig-loading'));
      const io = new IntersectionObserver(es => {
        if (!es.some(e => e.isIntersecting)) return;
        io.disconnect();
        void this.ctx.rpc<ThumbResponse>('thumb', { texPath: this.rep!.path, file }).then(async t => {
          if (t.kind === 'image') mount(box, h('img', { src: t.dataUrl, alt: '', loading: 'lazy' }));
          else if (t.kind === 'pdf') {
            const c = await pdfThumb(this.ctx.assetBase, t.data, 220);
            mount(box, c, h('span.rp-fig-badge', null, 'PDF'));
          } else mount(box, icon('file'));
        }).catch(() => mount(box, icon('warning')));
      });
      requestAnimationFrame(() => io.observe(box));
      return box;
    };
    const tone = { new: 'info', same: 'ok', differs: 'warn' } as const;
    const importOne = async (x: ImportableFigure, btn: HTMLButtonElement, insert: boolean) => {
      let overwrite = false;
      if (x.state === 'differs') {
        overwrite = await this.ctx.studio('confirm', { message: `figures/${x.name} already exists and differs. Overwrite it with ${x.rel}?`, action: 'Overwrite' });
        if (!overwrite && !insert) return;
      }
      await busy(btn, async () => {
        const r = await this.ctx.rpc<{ ref: string; copied: boolean }>('import', { texPath: this.rep!.path, src: x.path, overwrite });
        await this.loadFigures();
        this.editor.clearThumbs();
        if (insert) this.insertRef(r.ref);
        else this.ctx.toast(r.copied ? `Imported ${x.name}` : `${x.name} is already in figures/`, 'success');
        this.renderSide();
      });
    };
    mount(this.figBox,
      h('p.rp-fig-target', null, icon('info'), 'Insert goes to the end of ', h('b', null, sectionName() || 'the current section'), ' (click into a section to change).'),
      h('h3.rp-h3', null, 'In figures/', h('span.muted', null, ` ${f.inFolder.length}`)),
      f.inFolder.length
        ? h('div.rp-ft-grid', null, f.inFolder.map(x => h('div.rp-ft', null, thumb(x.path),
            h('div.rp-ft-name', { title: x.path }, x.name),
            h('div.rp-ft-actions', null, button('Insert', () => this.insertRef(x.ref), { variant: 'secondary', icon: 'plus' })))))
        : h('p.muted', null, 'The figures folder next to the .tex is empty.'),
      h('h3.rp-h3', null, 'Project images', h('span.muted', null, ` ${f.importable.length}`)),
      f.importable.length
        ? h('div.rp-imp-list', null, f.importable.map(x => {
            const ib: HTMLButtonElement = button(x.state === 'same' ? 'Insert' : 'Import & insert', () => void importOne(x, ib, true), { variant: 'secondary' });
            const imp: HTMLButtonElement = button('Import', () => void importOne(x, imp, false), { variant: 'ghost', disabled: x.state === 'same' });
            return h('div.rp-imp', null, thumb(x.path),
              h('div.rp-imp-info', null, h('div.rp-ft-name', { title: x.path }, x.rel), badge(x.state === 'same' ? 'in figures/' : x.state, tone[x.state])),
              h('div.rp-ft-actions', null, imp, ib));
          }))
        : h('p.muted', null, 'No images match orcaInp.studio.figureGlobs.'),
      button('Rescan', e => void busy(e.currentTarget as HTMLButtonElement, async () => { await this.loadFigures(); this.renderSide(); }), { variant: 'ghost', icon: 'refresh' }));
  }

  // --- Send to report ----------------------------------------------------------------------------------

  private async incoming(p: SendToReportPayload): Promise<void> {
    if (!p || (!p.pdf && !p.png)) return;
    if (!this.rep) {
      this.pendingFigure = p;
      this.ctx.toast('Open a report first: the figure is inserted once a .tex is open', 'warning');
      const go = await dialog<'open' | 'cancel'>(this.root, {
        title: 'No report open',
        body: h('p', null, 'A figure was sent to the report, but no .tex is open. Open one and the figure dialog continues.'),
        actions: [{ label: 'Cancel', value: 'cancel', variant: 'ghost' }, { label: 'Open .tex…', value: 'open', variant: 'primary' }],
        cancel: 'cancel'
      });
      if (go === 'open') await this.pick();
      else this.pendingFigure = null;
      return;
    }
    const rep = this.rep;
    const doc = rep.doc;
    let name = sanitizeName(p.name || 'figure');
    let caption = p.caption ?? '';
    let section = Math.min(this.cursorSection, Math.max(0, doc.sections.length - 1));
    let width = '0.85\\textwidth';
    const fileNote = h('span.rp-hint');
    const updateNote = () => {
      const exists = this.figures?.inFolder.some(f => f.name.replace(/\.[^.]+$/, '').toLowerCase() === name.toLowerCase());
      mount(fileNote, `figures/${name}${p.pdf ? '.pdf' : '.png'}${p.pdf && p.png ? ' (+ .png)' : ''}`, exists ? h('b.rp-warn', null, ' — replaces the existing file (a copy goes to .orbital/report-backups)') : null);
    };
    updateNote();
    const nameIn = h('input.input.mono', { value: name, oninput: (e: Event) => { name = sanitizeName((e.target as HTMLInputElement).value); updateNote(); } });
    const capIn = h('textarea.input', { rows: 3, value: caption, placeholder: 'Plain text, or LaTeX when it contains \\ or $', oninput: (e: Event) => { caption = (e.target as HTMLTextAreaElement).value; } });
    const secSel = h('select.input', { onchange: (e: Event) => { section = Number((e.target as HTMLSelectElement).value); } },
      doc.sections.map((s, i) => h('option', { value: String(i), selected: i === section }, s.heading === false ? '(document body)' : s.title || `Section ${i + 1}`)));
    const widthSel = h('select.input', { onchange: (e: Event) => { width = (e.target as HTMLSelectElement).value; } },
      WIDTHS.map(w => h('option', { value: w, selected: w === width }, w.replace('\\textwidth', ' × text width').replace(/^ × /, '1 × '))));
    const preview = p.png ? h('img.rp-send-preview', { src: `data:image/png;base64,${p.png}`, alt: 'figure preview' }) : h('div.rp-send-preview.pdf', null, icon('file'), 'PDF');
    const go = await dialog<'insert' | 'cancel'>(this.root, {
      title: 'Add figure to the report',
      wide: true,
      body: h('div.rp-send', null, preview,
        h('div.stack', null,
          h('label.field', null, h('span.field-label', null, 'File name'), nameIn, fileNote),
          h('label.field', null, h('span.field-label', null, 'Caption'), capIn),
          h('div.rp-send-row', null,
            h('label.field', null, h('span.field-label', null, 'Section'), secSel),
            h('label.field', null, h('span.field-label', null, 'Width'), widthSel)),
          h('p.muted.rp-hint', null, 'The files are written next to the .tex now; the figure block is added to the document, which you then save.'))),
      actions: [{ label: 'Cancel', value: 'cancel', variant: 'ghost' }, { label: 'Insert figure', value: 'insert', variant: 'primary' }],
      cancel: 'cancel'
    });
    if (go !== 'insert' || this.rep !== rep) return;
    try {
      const r = await this.ctx.rpc<AddFigureResponse>('addFigure', { texPath: rep.path, doc: rep.doc, section, name, caption, width, pdf: p.pdf, png: p.png });
      rep.doc = r.doc;
      this.cursorSection = section;
      this.editor.clearThumbs();
      await this.loadFigures();
      this.editor.setDoc(rep.doc);
      this.markDirty();
      this.renderSide();
      this.editor.render(`${section}.${r.block}`);
      this.ctx.toast(`Inserted ${r.includePath} — save to keep it`, 'success');
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }
}
