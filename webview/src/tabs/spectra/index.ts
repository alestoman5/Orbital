// Webview side of the "spectra" studio tab: library (NEA spectra,
// experiments, computed sticks), plot options, KPI tiles, the figure and
// band statistics. All parsing, broadening and statistics run on the host
// (src/studio/tabs/spectra/host.ts); this file only renders.

import './spectra.css';
import type { TabView, ViewContext } from '../../view';
import { badge, button, callout, card, dataTable, emptyState, field, grid, icon, iconButton, kpi, numberInput, section, segmented, select, skeleton, split, toggle, type Column, type Tone } from '../../ui/components';
import { debounce, fmt, h, mount } from '../../ui/dom';
import { figureToolbar, render, type ChartHandle, type FigureSize, type Preset } from '../../charts';
import { buildFigure, seriesColors, X_UNIT, type Mode } from './figure';
import type {
  AddFilesResult,
  ItemKind,
  LibraryItem,
  LibraryResult,
  LoadParams,
  LoadResult,
  PlotParams,
  SpectraNavigateArgs,
  StatsResult,
  StatsRow,
  XAxis,
  YScale,
  ExperimentScaling,
  CsvResult
} from '../../../../src/studio/tabs/spectra/types';

interface Options {
  mode: Mode;
  axis: XAxis;
  ranges: Partial<Record<XAxis, [number, number]>>;
  secondary: boolean;
  ci: boolean;
  normalize: boolean;
  states: boolean;
  sticks: boolean;
  /** Gaussian width for every stick entry (eV); null = Silverman / single-geometry default. */
  h: number | null;
  yScale: YScale;
  expScale: ExperimentScaling;
  preset: Preset;
  size?: FigureSize;
}

const DEFAULTS: Options = {
  mode: 'overlay', axis: 'nm', ranges: {}, secondary: true, ci: true, normalize: false, states: false, sticks: true,
  h: null, yScale: 'sigma', expScale: 'none', preset: 'screen'
};

const KIND_LABEL: Record<ItemKind, string> = { nea: 'NEA', exp: 'exp', sticks: 'sticks' };
const KIND_TONE: Record<ItemKind, Tone> = { nea: 'accent', exp: 'muted', sticks: 'info' };
const DIGITS: Record<XAxis, number> = { nm: 1, eV: 3, 'cm-1': 0 };
const AXIS_NAME: Record<XAxis, string> = { nm: 'λ', eV: 'E', 'cm-1': 'ν̃' };

export const view: TabView = {
  mount(root, ctx) {
    return new SpectraTab(root, ctx);
  }
};

class SpectraTab {
  private opts: Options;
  private selected: Set<string>;
  private ref: string | null;
  private added: string[];
  private kindOverride: Record<string, ItemKind>;
  private lib?: LibraryResult;
  private loaded?: LoadResult;
  private stats?: StatsResult;
  private zoomWindow?: [number, number];
  private chart?: ChartHandle;
  private token = 0;
  private libReady: Promise<void>;
  private navQueue: Promise<void> = Promise.resolve();
  private disposers: (() => void)[] = [];

  // persistent DOM
  private sideEl = h('div.sp-side');
  private mainEl = h('div.sp-main');
  private kpiEl = h('div.sp-kpis');
  private messagesEl = h('div.sp-messages');
  private chartBox = h('div.sp-chart');
  private chartCard?: HTMLElement;
  private chartSubtitle = h('p.muted');
  private statsEl = h('div.sp-stats');
  private noteEl = h('p.sp-footnote.muted');
  private libraryCard?: HTMLElement;

  constructor(private root: HTMLElement, private ctx: ViewContext) {
    this.opts = { ...DEFAULTS, ...ctx.state<Partial<Options>>('opts', {}) };
    this.selected = new Set(ctx.state<string[]>('selected', []));
    this.ref = ctx.state<string | null>('ref', null);
    this.added = ctx.state<string[]>('added', []);
    this.kindOverride = ctx.state<Record<string, ItemKind>>('kindOverride', {});
    ctx.setActions(
      button('Add files…', () => void this.pickFiles(), { icon: 'plus', title: 'Add spectrum files, ORCA outputs or folders' }),
      iconButton('refresh', 'Reload the library', () => void this.reloadLibrary())
    );
    mount(root, h('div.sp-root', null, skeleton(6)));
    this.disposers.push(ctx.on('changed', () => void this.reloadLibrary()));
    this.disposers.push(ctx.onTheme(() => this.drawChart()));
    this.libReady = this.reloadLibrary(true);
  }

  onNavigate(args: unknown): void {
    this.navQueue = this.navQueue.then(() => this.navigate(args as SpectraNavigateArgs)).catch(e => this.ctx.toast(String(e), 'error'));
  }

  dispose(): void {
    this.disposers.forEach(d => d());
    this.chart?.dispose();
  }

  // --- state ---------------------------------------------------------------------------

  private save(): void {
    this.ctx.setState('opts', this.opts);
    this.ctx.setState('selected', [...this.selected]);
    this.ctx.setState('ref', this.ref);
    this.ctx.setState('added', this.added);
    this.ctx.setState('kindOverride', this.kindOverride);
  }

  private setOpt<K extends keyof Options>(k: K, v: Options[K], what: 'plot' | 'sidebar' | 'chart' = 'plot'): void {
    this.opts[k] = v;
    this.save();
    if (what === 'chart') {
      this.drawChart();
    } else {
      if (what === 'sidebar') this.renderSide();
      void this.refresh();
    }
  }

  private items(): LibraryItem[] {
    return this.lib?.items ?? [];
  }

  private item(id: string): LibraryItem | undefined {
    return this.items().find(i => i.id === id);
  }

  private kindOf(it: LibraryItem): ItemKind {
    return it.source === 'file' ? this.kindOverride[it.id] ?? it.kind : it.kind;
  }

  /** Selected ids in library order, experiments last (only existing entries). */
  private selectedIds(): string[] {
    const sel = this.items().filter(i => this.selected.has(i.id));
    return [...sel.filter(i => this.kindOf(i) !== 'exp'), ...sel.filter(i => this.kindOf(i) === 'exp')].map(i => i.id);
  }

  private refId(): string | undefined {
    if (!this.ref || !this.selected.has(this.ref)) return undefined;
    const it = this.item(this.ref);
    return it && this.kindOf(it) !== 'exp' ? this.ref : undefined;
  }

  private plotParams(): PlotParams {
    const ids = this.selectedIds();
    return {
      ids,
      experiment: ids.filter(id => this.kindOf(this.item(id)!) === 'exp'),
      refId: this.refId(),
      axis: this.opts.axis,
      range: this.opts.ranges[this.opts.axis],
      h: this.opts.h ?? undefined,
      normalize: this.opts.normalize,
      yScale: this.opts.yScale,
      expScale: this.opts.expScale
    };
  }

  // --- library -------------------------------------------------------------------------

  private async reloadLibrary(first = false): Promise<void> {
    try {
      this.lib = await this.ctx.rpc<LibraryResult>('library', { extra: this.added });
    } catch (e) {
      mount(this.root, h('div.sp-root', null, callout('bad', `Could not read the library: ${e instanceof Error ? e.message : String(e)}`)));
      return;
    }
    const ids = new Set(this.items().map(i => i.id));
    if (!first || this.selected.size) {
      this.selected = new Set([...this.selected].filter(id => ids.has(id)));
    }
    if (first && this.selected.size === 0) {
      // first visit: show the first few NEA spectra and the experiments
      const names = this.lib?.fieldNames ?? [];
      const ok = this.items().filter(i => !i.error && this.kindOf(i) === 'nea');
      const matched = ok.filter(i => names.length > 0 && names.every(n => n in i.fields));
      const nea = (matched.length ? matched : ok).slice(0, 3);
      const exp = this.items().filter(i => !i.error && this.kindOf(i) === 'exp').slice(0, 1);
      [...nea, ...exp].forEach(i => this.selected.add(i.id));
      if (!this.ref && nea.length) this.ref = nea[0].id;
    }
    this.save();
    this.layout();
    await this.refresh();
  }

  private async pickFiles(): Promise<void> {
    const paths = await this.ctx.studio('pickFiles', {
      title: 'Add spectra, ORCA outputs or folders', canSelectMany: true, canSelectFiles: true, canSelectFolders: true,
      filters: { 'Spectra and outputs': ['dat', 'txt', 'csv', 'out'], 'All files': ['*'] }
    });
    if (paths.length) await this.addPaths(paths, false);
  }

  /** Adds paths to the library; `exclusive` replaces the selection (navigate from a command). */
  private async addPaths(paths: string[], exclusive: boolean): Promise<string[]> {
    const res = await this.ctx.rpc<AddFilesResult>('addFiles', { paths });
    res.errors.forEach(e => this.ctx.toast(e, 'warning'));
    for (const p of res.accepted) if (!this.added.includes(p)) this.added.push(p);
    if (res.ids.length) {
      if (exclusive) {
        const keepExp = [...this.selected].filter(id => {
          const it = this.item(id);
          return it && this.kindOf(it) === 'exp';
        });
        this.selected = new Set([...res.ids, ...keepExp]);
        this.ref = res.ids[0];
        if (res.ids.some(id => !id.startsWith('file:')) && this.opts.mode === 'diff' && res.ids.length === 1) this.opts.mode = 'overlay';
      } else {
        res.ids.forEach(id => this.selected.add(id));
      }
    }
    this.save();
    await this.reloadLibrary();
    return res.ids;
  }

  private async navigate(args: SpectraNavigateArgs | undefined): Promise<void> {
    await this.libReady;
    if (!args || typeof args !== 'object') return;
    const paths = [...(Array.isArray(args.files) ? args.files : []), ...(typeof args.folder === 'string' ? [args.folder] : [])].filter(p => typeof p === 'string');
    if (paths.length === 0) return;
    const ids = await this.addPaths(paths, true);
    if (ids.length) {
      const it = this.item(ids[0]);
      this.ctx.toast(`Showing ${ids.length === 1 ? (it?.name ?? 'the selection') : `${ids.length} entries`}`, 'info');
    }
  }

  // --- layout --------------------------------------------------------------------------

  private layout(): void {
    if (this.items().length === 0) {
      this.chart?.dispose();
      this.chart = undefined;
      mount(this.root, h('div.sp-root', null, this.emptyLibrary()));
      return;
    }
    if (!this.sideEl.isConnected) {
      this.chart?.dispose();
      this.chart = undefined;
      mount(this.root, h('div.sp-root', null, split(this.sideEl, this.mainEl, { sidebarWidth: 440 })));
      this.buildMain();
    }
    this.renderSide();
  }

  private emptyLibrary(): HTMLElement {
    const lib = this.lib;
    const globs = h('div.sp-globs', null,
      h('p.sp-glob-title', null, 'Spectrum files ', h('code', null, 'orcaInp.studio.spectraGlobs')),
      h('ul', null, (lib?.spectraGlobs ?? []).map(g => h('li', null, h('code', null, g)))),
      h('p.sp-glob-title', null, 'Experiments ', h('code', null, 'orcaInp.studio.experimentGlobs')),
      h('ul', null, (lib?.experimentGlobs ?? []).map(g => h('li', null, h('code', null, g)))));
    return card({ class: 'sp-empty-card' },
      emptyState('spectra', 'No spectra found',
        'Nothing in the workspace matches the spectrum globs. Add PyNEAppLES .dat files, experimental two-column spectra, an ORCA .out with an ABSORPTION SPECTRUM table, or a folder of geometries.',
        h('div.sp-empty-actions', null, button('Add files…', () => void this.pickFiles(), { variant: 'primary', icon: 'plus' }))),
      globs,
      ...(lib?.warnings.length ? [callout('warn', lib.warnings.join(' · '))] : []));
  }

  // --- sidebar -------------------------------------------------------------------------

  private renderSide(): void {
    const lib = this.lib!;
    const sticksSel = this.selectedIds().map(id => this.item(id)!).filter(i => i.kind === 'sticks');
    const anyExpSel = this.selectedIds().some(id => this.kindOf(this.item(id)!) === 'exp');
    mount(this.sideEl,
      this.libraryCardEl(lib),
      section('Plot', true, ...this.plotControls()),
      section('Computed sticks', sticksSel.length > 0, ...this.stickControls(sticksSel)),
      section('Experiment', anyExpSel, ...this.expControls())
    );
  }

  /** Name-field columns: fields of the pattern that vary between entries; constant ones go to the subtitle. */
  private fieldColumns(lib: LibraryResult): { shown: string[]; constant: [string, string][] } {
    const names = lib.fieldNames.length ? lib.fieldNames : [];
    const matched = lib.items.filter(i => names.some(n => n in i.fields));
    const shown: string[] = [];
    const constant: [string, string][] = [];
    for (const n of names) {
      const vals = new Set(matched.map(i => i.fields[n] ?? ''));
      if (vals.size === 1 && matched.length > 1) constant.push([n, [...vals][0]]);
      else shown.push(n);
    }
    return { shown, constant };
  }

  private libraryCardEl(lib: LibraryResult): HTMLElement {
    const { shown, constant } = this.fieldColumns(lib);
    const nameOnly = (i: LibraryItem) => !shown.length || !(shown[0] in i.fields);
    const refBtn = (it: LibraryItem) => {
      const exp = this.kindOf(it) === 'exp';
      return h('button.sp-ref', {
        type: 'button', class: this.ref === it.id ? 'on' : '', disabled: exp || !!it.error,
        title: exp ? 'An experiment cannot be the reference' : 'Use as reference (difference, consistency test)',
        'aria-pressed': String(this.ref === it.id), dataset: { id: it.id },
        onclick: (e: Event) => {
          e.stopPropagation();
          this.ref = this.ref === it.id ? null : it.id;
          if (this.ref) this.selected.add(it.id);
          this.save();
          this.renderSide();
          void this.refresh();
        }
      }, h('span.sp-ref-dot'));
    };
    const kindCell = (it: LibraryItem) => {
      const k = this.kindOf(it);
      const b = badge(KIND_LABEL[k], KIND_TONE[k]);
      if (it.source !== 'file') return b;
      return h('button.sp-kind', {
        type: 'button', title: k === 'exp' ? 'Plotted as experiment (dashed). Click to treat as a computed spectrum.' : 'Click to mark as experiment (dashed, scalable)',
        onclick: (e: Event) => {
          e.stopPropagation();
          this.kindOverride[it.id] = k === 'exp' ? 'nea' : 'exp';
          if (this.kindOverride[it.id] === it.kind) delete this.kindOverride[it.id];
          if (this.ref === it.id) this.ref = null;
          this.save();
          this.renderSide();
          void this.refresh();
        }
      }, b);
    };
    const nameCell = (it: LibraryItem) => h('span.sp-name', { title: `${it.path}${it.error ? `\n${it.error}` : ''}`, class: it.error ? 'error' : '' },
      it.error ? icon('warning', 'icon sp-warn') : null, h('span.sp-name-text', null, it.name));
    const columns: Column<LibraryItem>[] = [
      { key: 'ref', label: 'ref', render: refBtn, sortValue: i => (this.ref === i.id ? 0 : 1), align: 'center', width: '34px', title: 'Reference' },
      { key: 'kind', label: 'kind', render: kindCell, sortValue: i => this.kindOf(i), width: '52px' }
    ];
    if (shown.length) {
      shown.forEach((n, k) => columns.push({
        key: `f:${n}`, label: n, numeric: n === 'n',
        render: i => (k === 0 && nameOnly(i) ? nameCell(i) : i.error && k === 0 ? nameCell(i) : h('span', { title: i.path }, i.fields[n] ?? '')),
        sortValue: i => (n === 'n' ? Number(i.fields[n] ?? 0) : (i.fields[n] ?? (k === 0 ? i.name : '')))
      }));
    } else {
      columns.push({ key: 'name', label: 'name', render: nameCell, sortValue: i => i.name });
    }
    const full = (i: LibraryItem) => lib.fieldNames.length > 0 && lib.fieldNames.every(n => n in i.fields);
    const rows = lib.items.slice().sort((a, b) =>
      Number(this.selected.has(b.id)) - Number(this.selected.has(a.id))
      || Number(b.kind === 'sticks') - Number(a.kind === 'sticks')
      || Number(full(b)) - Number(full(a)));
    const table = dataTable<LibraryItem>({
      columns,
      rows,
      rowKey: i => i.id,
      selectable: {
        selected: new Set(this.selected),
        onChange: sel => {
          this.selected = sel;
          if (this.ref && !sel.has(this.ref)) this.ref = null;
          this.save();
          this.syncRefButtons();
          void this.refresh();
        }
      },
      filterText: i => `${i.name} ${Object.values(i.fields).join(' ')} ${KIND_LABEL[this.kindOf(i)]}`,
      filterPlaceholder: 'Filter (e.g. wigner n1000)…',
      maxHeight: 330,
      empty: 'No entries'
    });
    const counts = (['nea', 'exp', 'sticks'] as ItemKind[]).map(k => [k, lib.items.filter(i => this.kindOf(i) === k).length] as const).filter(([, n]) => n);
    const subtitle = [
      counts.map(([k, n]) => `${n} ${KIND_LABEL[k]}`).join(' · '),
      constant.length ? constant.map(([k, v]) => `${k} = ${v}`).join(', ') : ''
    ].filter(Boolean).join(' — ');
    this.libraryCard = card({
      title: 'Library', subtitle,
      class: 'sp-library',
      actions: [button('Add…', () => void this.pickFiles(), { variant: 'ghost', icon: 'plus', title: 'Add files or folders' })]
    }, table, lib.warnings.length ? callout('warn', lib.warnings.join(' · ')) : null);
    return this.libraryCard;
  }

  private syncRefButtons(): void {
    this.libraryCard?.querySelectorAll<HTMLButtonElement>('.sp-ref').forEach(b => {
      const on = b.dataset.id === this.ref;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  private plotControls(): HTMLElement[] {
    const o = this.opts;
    const range = o.ranges[o.axis] ?? this.loaded?.range;
    const lo = numberInput(range?.[0] ?? 0, v => this.setRange(0, v), { step: o.axis === 'eV' ? 0.1 : o.axis === 'nm' ? 10 : 1000 });
    const hi = numberInput(range?.[1] ?? 0, v => this.setRange(1, v), { step: o.axis === 'eV' ? 0.1 : o.axis === 'nm' ? 10 : 1000 });
    lo.classList.add('sp-range-input');
    hi.classList.add('sp-range-input');
    lo.dataset.role = 'range-lo';
    hi.dataset.role = 'range-hi';
    const auto = !o.ranges[o.axis];
    return [
      field('Mode', segmented<Mode>([
        { value: 'overlay', label: 'Overlay' }, { value: 'diff', label: '+ Difference' }, { value: 'multiples', label: 'Small multiples' }
      ], o.mode, v => this.setOpt('mode', v)), o.mode !== 'overlay' && !this.refId() ? 'Pick a reference (ref column) to compare against.' : undefined),
      field('x axis', segmented<XAxis>([
        { value: 'nm', label: 'λ / nm' }, { value: 'eV', label: 'E / eV' }, { value: 'cm-1', label: 'ν̃ / cm⁻¹' }
      ], o.axis, v => this.setOpt('axis', v, 'sidebar'))),
      field(`x range / ${X_UNIT[o.axis]}`, h('div.sp-range', null, lo, h('span.muted', null, '–'), hi,
        button('Auto', () => {
          delete this.opts.ranges[this.opts.axis];
          this.setOpt('ranges', { ...this.opts.ranges }, 'sidebar');
        }, { variant: 'ghost', disabled: auto, title: 'Window from the signal of the selection' })),
      auto ? 'Automatic: where the selected spectra exceed 1 % of their peak.' : 'Statistics and CSV use this window.'),
      field('y axis', segmented<YScale>([
        { value: 'sigma', label: 'σ (absolute)' }, { value: 'relative', label: 'relative (f / eV)' }
      ], o.yScale, v => this.setOpt('yScale', v)), o.yScale === 'relative' ? 'σ divided by πe²ħ/(2mₑcε₀): oscillator-strength density.' : undefined),
      h('div.sp-toggles', null,
        toggle('Secondary top axis', o.secondary, v => this.setOpt('secondary', v, 'chart'), { hint: 'E / eV above λ / nm (λ / nm above E or ν̃)' }),
        toggle('95 % CI bands', o.ci, v => this.setOpt('ci', v, 'chart')),
        toggle('Normalize to maximum', o.normalize, v => this.setOpt('normalize', v)),
        toggle('Show states (S₁…Sₙ)', o.states, v => this.setOpt('states', v), { hint: 'Per-state contributions, thin dotted' }))
    ];
  }

  private setRange(i: 0 | 1, v: number): void {
    const cur = this.opts.ranges[this.opts.axis] ?? this.loaded?.range ?? [0, 1];
    const next: [number, number] = [cur[0], cur[1]];
    next[i] = v;
    if (!(next[0] < next[1])) {
      this.ctx.toast('The x range needs min < max', 'warning');
      return;
    }
    this.opts.ranges = { ...this.opts.ranges, [this.opts.axis]: next };
    this.setOpt('ranges', this.opts.ranges, 'sidebar');
  }

  private stickControls(sel: LibraryItem[]): HTMLElement[] {
    const o = this.opts;
    const first = sel[0];
    const auto = first?.defaultH ?? 0.2;
    const value = o.h ?? auto;
    const num = numberInput(Number(value.toFixed(4)), v => {
      if (v >= 0.005 && v <= 2) this.setOpt('h', v, 'sidebar');
    }, { min: 0.005, max: 2, step: 0.005 });
    num.classList.add('sp-h-input');
    const slider = h('input.sp-slider', {
      type: 'range', min: '0.01', max: '0.6', step: '0.005', value: String(Math.min(0.6, value)), 'aria-label': 'Gaussian width h / eV',
      oninput: (e: Event) => {
        num.value = (e.target as HTMLInputElement).value;
      },
      onchange: (e: Event) => this.setOpt('h', parseFloat((e.target as HTMLInputElement).value), 'sidebar')
    });
    const ensembles = sel.filter(i => (i.nGeometries ?? 1) > 1);
    const hint = sel.length === 0
      ? 'Add an ORCA .out, a folder of .out files or a geom_NNNN/result.json set to broaden sticks here.'
      : o.h === null
        ? `Automatic: ${ensembles.length ? `Silverman (${ensembles.map(i => `${i.name} ${i.silverman!.toFixed(3)} eV`).join(', ')})` : ''}${ensembles.length && ensembles.length < sel.length ? '; ' : ''}${ensembles.length < sel.length ? 'single geometry: orcaInp.spectrum.singleGeometryBandwidth' : ''}.`
        : `Fixed h = ${o.h.toFixed(3)} eV for every stick entry.`;
    return [
      field('Gaussian width h / eV', h('div.sp-h', null, slider, num,
        button('Silverman', () => this.setOpt('h', null, 'sidebar'), { variant: 'ghost', disabled: o.h === null, title: 'Back to the automatic width (Silverman for ensembles)' })), hint),
      toggle('Show sticks (f, right axis)', o.sticks, v => this.setOpt('sticks', v), { hint: 'Ensembles (> 200 sticks) are drawn scaled to 30 % of the panel height, without an f axis' }),
      h('p.sp-hint.muted', null, 'σ(E) = (πe²ħ / 2mₑcε₀) · (1/N) Σ fᵢ g(E − Eᵢ), g a normalized Gaussian of width h; πe²ħ/2mₑcε₀ = 1.0976 × 10⁻¹⁶ eV cm². No confidence band: sticks give no bootstrap interval.')
    ];
  }

  private expControls(): HTMLElement[] {
    return [
      field('Scaling', select<ExperimentScaling>([
        { value: 'none', label: 'None (as measured)' }, { value: 'ref', label: 'Scale to the reference peak' }
      ], this.opts.expScale, v => this.setOpt('expScale', v)),
      this.opts.normalize ? 'Normalized: every curve is divided by its own maximum.' : 'Peak in the plotted window matched to the reference (or the first series).'),
      h('p.sp-hint.muted', null, 'Click a file\'s kind badge in the library to toggle it between computed and experiment.')
    ];
  }

  // --- main ----------------------------------------------------------------------------

  private buildMain(): void {
    const toolbar = figureToolbar({
      figure: () => this.figure(),
      name: 'spectra',
      host: this.ctx,
      initialPreset: this.opts.preset,
      initialSize: this.opts.size,
      caption: () => this.caption(),
      onLayoutChange: (preset, size) => {
        this.opts.preset = preset;
        this.opts.size = size;
        this.save();
        this.drawChart();
      }
    });
    this.chartCard = card({ title: 'Absorption spectra', class: 'sp-chart-card' }, toolbar, this.chartBox);
    this.chartCard.querySelector('.card-head > div')?.appendChild(this.chartSubtitle);
    const csvBtn = button('Export CSV', () => void this.exportCsv(csvBtn), { icon: 'download', title: 'Selected curves resampled on a regular grid over the window' });
    const statsCard = card({ title: 'Band statistics', class: 'sp-stats-card', actions: [csvBtn] }, this.statsEl, this.noteEl);
    mount(this.mainEl, this.messagesEl, this.kpiEl, this.chartCard, statsCard);
  }

  /**
   * Short series labels: the name-pattern fields that differ between the
   * selected entries ("classical n1000", "gle n5000"); the full stem when the
   * entry does not match the pattern or nothing differs.
   */
  private shortLabels(): Map<string, string> {
    const names = this.lib?.fieldNames ?? [];
    const sel = this.selectedIds().map(id => this.item(id)!).filter(Boolean);
    const matched = sel.filter(i => names.length > 0 && names.every(n => n in i.fields));
    const varying = names.filter(n => new Set(matched.map(i => i.fields[n])).size > 1);
    const out = new Map<string, string>();
    for (const i of this.items()) {
      const short = matched.includes(i) && varying.length && matched.length > 1
        ? varying.map(n => (n === 'n' ? `n${i.fields[n]}` : i.fields[n])).join(' ')
        : i.name;
      out.set(i.id, short);
    }
    return out;
  }

  private figure() {
    const labels = this.shortLabels();
    const empty: LoadResult = { axis: this.opts.axis, range: this.opts.ranges[this.opts.axis] ?? [250, 500], yScale: this.opts.yScale, normalized: this.opts.normalize, series: [], errors: [] };
    return buildFigure(this.loaded ?? empty, {
      mode: this.opts.mode, refId: this.refId(), ci: this.opts.ci, states: this.opts.states, sticks: this.opts.sticks,
      secondary: this.opts.secondary, preset: this.opts.preset, size: this.opts.size, labels
    });
  }

  private caption(): string {
    const l = this.loaded;
    if (!l) return '';
    const names = l.series.map(s => this.item(s.id)?.name ?? s.label);
    const ci = this.opts.ci && l.series.some(s => s.lo) ? ' Shaded: 95 % confidence intervals.' : '';
    const sticks = l.series.filter(s => s.kind === 'sticks').map(s => `${this.item(s.id)?.name}: Gaussian h = ${s.h?.toFixed(3)} eV, N = ${s.nGeometries}`);
    return `Absorption ${this.opts.normalize ? 'spectra (normalized)' : 'cross sections'} of ${names.join(', ')}.${ci}${sticks.length ? ` Broadened sticks (${sticks.join('; ')}).` : ''}`;
  }

  private async refresh(): Promise<void> {
    if (!this.lib || this.items().length === 0 || !this.sideEl.isConnected) return;
    const my = ++this.token;
    const p = this.plotParams();
    this.zoomWindow = undefined;
    if (p.ids.length === 0) {
      this.loaded = undefined;
      this.stats = undefined;
      this.chart?.dispose();
      this.chart = undefined;
      mount(this.kpiEl);
      mount(this.messagesEl);
      mount(this.chartBox, emptyState('spectra', 'Nothing selected', 'Tick spectra in the library to plot them. Mark one as the reference (ref column) to compare against it.'));
      this.chartSubtitle.textContent = '';
      mount(this.statsEl);
      mount(this.noteEl);
      return;
    }
    this.chartCard?.classList.add('loading');
    if (!this.loaded) mount(this.chartBox, skeleton(5));
    try {
      const lp: LoadParams = { ...p, difference: this.opts.mode === 'diff', states: this.opts.states, sticks: this.opts.sticks };
      const [loaded, stats] = await Promise.all([
        this.ctx.rpc<LoadResult>('load', lp),
        this.ctx.rpc<StatsResult>('stats', p)
      ]);
      if (my !== this.token) return;
      this.loaded = loaded;
      this.stats = stats;
      this.renderMessages();
      this.drawChart();
      this.renderStats();
      this.updateRangeInputs();
    } catch (e) {
      if (my !== this.token) return;
      mount(this.messagesEl, callout('bad', e instanceof Error ? e.message : String(e)));
    } finally {
      if (my === this.token) this.chartCard?.classList.remove('loading');
    }
  }

  private updateRangeInputs(): void {
    const r = this.loaded?.range;
    if (!r) return;
    const lo = this.sideEl.querySelector<HTMLInputElement>('[data-role="range-lo"]');
    const hi = this.sideEl.querySelector<HTMLInputElement>('[data-role="range-hi"]');
    if (lo && document.activeElement !== lo) lo.value = String(r[0]);
    if (hi && document.activeElement !== hi) hi.value = String(r[1]);
  }

  private renderMessages(): void {
    const errs = [...(this.loaded?.errors ?? [])];
    for (const e of this.stats?.errors ?? []) if (!errs.some(x => x.id === e.id)) errs.push(e);
    const notes: HTMLElement[] = [];
    if (errs.length) {
      notes.push(callout('bad', h('b', null, `${errs.length} ${errs.length === 1 ? 'entry' : 'entries'} could not be plotted`),
        h('ul.sp-errors', null, errs.map(e => h('li', null, h('b', null, this.item(e.id)?.name ?? e.id), `: ${e.message}`)))));
    }
    if (this.opts.mode !== 'overlay' && !this.refId()) {
      notes.push(callout('info', `${this.opts.mode === 'diff' ? 'Difference' : 'Small multiples'} need a reference: click the dot in the "ref" column of the library.`));
    }
    mount(this.messagesEl, notes);
  }

  private drawChart(): void {
    if (!this.loaded || !this.chartCard) return;
    if (this.loaded.series.length === 0) {
      this.chart?.dispose();
      this.chart = undefined;
      mount(this.chartBox, emptyState('warning', 'Nothing to plot', 'None of the selected entries could be read; see the messages above.'));
      return;
    }
    const fig = this.figure();
    const multi = fig.panels.length > 1;
    this.chartBox.classList.toggle('tall', multi);
    const n = this.loaded.series.length;
    const r = this.loaded.range;
    this.chartSubtitle.textContent = `${n} series · ${fmt(r[0], DIGITS[this.loaded.axis])}–${fmt(r[1], DIGITS[this.loaded.axis])} ${X_UNIT[this.loaded.axis]}${this.loaded.normalized ? ' · normalized' : ''} · drag to zoom, double-click to reset`;
    if (this.chart && this.chartBox.querySelector('.chart')) {
      this.chart.update(fig);
      return;
    }
    mount(this.chartBox);
    const axis = this.loaded.axis;
    this.chart = render(this.chartBox, fig, {
      readout: (_p, x, y) => `${AXIS_NAME[axis]} = ${fmt(x, DIGITS[axis])} ${X_UNIT[axis]}, ${this.loaded?.normalized ? fmt(y, 3) : fmt(y, 3)}`,
      onZoom: (_panel, a, b) => this.onZoom(a, b)
    });
  }

  private onZoom = debounce((a: number, b: number) => {
    const r = this.loaded?.range;
    if (!r) return;
    const tol = (r[1] - r[0]) * 1e-3;
    const full = Math.abs(a - r[0]) < tol && Math.abs(b - r[1]) < tol;
    const next = full ? undefined : ([a, b] as [number, number]);
    if (JSON.stringify(next) === JSON.stringify(this.zoomWindow)) return;
    this.zoomWindow = next;
    void this.refreshStats();
  }, 250);

  private async refreshStats(): Promise<void> {
    const my = this.token;
    const p = { ...this.plotParams(), range: this.zoomWindow ?? this.loaded?.range };
    try {
      const st = await this.ctx.rpc<StatsResult>('stats', p);
      if (my !== this.token) return;
      this.stats = st;
      this.renderStats();
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  // --- KPIs and statistics -------------------------------------------------------------

  private renderStats(): void {
    const st = this.stats;
    if (!st || !this.loaded) return;
    const axis = st.axis;
    const d = DIGITS[axis];
    const u = X_UNIT[axis];
    const yUnit = this.loaded.normalized ? '' : this.loaded.yScale === 'relative' ? 'eV⁻¹' : 'cm²';
    const colors = seriesColors(this.loaded, this.opts.mode, this.refId());
    const short = this.shortLabels();
    const name = (r: StatsRow) => short.get(r.id) ?? this.item(r.id)?.name ?? r.label;

    // KPI tiles: the reference, else the first computed series
    const focus = st.rows.find(r => r.isRef) ?? st.rows.find(r => r.kind !== 'exp') ?? st.rows[0];
    const tiles: HTMLElement[] = [];
    let caption: HTMLElement | null = null;
    if (focus) {
      caption = h('div.sp-kpi-caption', null,
        h('span.sp-swatch', { style: { borderColor: colors.get(focus.id) ?? 'currentColor', background: colors.get(focus.id) ?? 'currentColor' } }),
        h('span', null, focus.isRef ? 'Reference ' : 'First series ', h('b', null, name(focus)), focus.isRef ? '' : ' (mark a reference to compare)'));
      tiles.push(kpi('Band maximum', fmt(focus.xmax, d), u, `${AXIS_NAME[axis]}max in the window`, 'accent'));
      tiles.push(kpi(this.loaded.normalized ? 'Peak (normalized)' : this.loaded.yScale === 'relative' ? 'Peak f density' : 'Peak cross section', fmtSci(focus.peak), undefined,
        this.loaded.normalized ? 'σ / σmax' : this.loaded.yScale === 'relative' ? 'eV⁻¹' : 'cm² molecule⁻¹'));
      tiles.push(kpi('FWHM', fmt(focus.fwhm, d), u, 'interpolated crossings'));
      tiles.push(kpi('Centroid', fmt(focus.centroid, d), u, '∫x σ dx / ∫σ dx'));
      const compared = st.rows.filter(r => !r.isRef && r.consistentPct !== undefined);
      if (st.refId && compared.length) {
        const best = compared.reduce((a, b) => ((b.consistentPct ?? 0) > (a.consistentPct ?? 0) ? b : a));
        const same = compared.filter(r => r.verdict === 'same within noise').length;
        tiles.push(kpi('Consistent with ref', fmt(best.consistentPct, 0), '%',
          compared.length > 1 ? `best of ${compared.length} · ${same} same within noise` : best.verdict,
          same > 0 ? 'ok' : 'warn'));
      } else if (st.refId) {
        tiles.push(kpi('Consistent with ref', '–', undefined, 'needs a second series with CI', 'muted'));
      }
    }
    mount(this.kpiEl, caption, grid(132, ...tiles));

    const columns: Column<StatsRow>[] = [
      {
        key: 'label', label: 'Series', sortValue: r => name(r),
        render: r => h('span.sp-series', null,
          h('span.sp-swatch', { class: r.kind === 'exp' ? 'dashed' : '', style: { borderColor: colors.get(r.id) ?? 'currentColor', background: r.kind === 'exp' ? 'transparent' : colors.get(r.id) ?? 'currentColor' } }),
          h('span.sp-series-name', { title: `${name(r)}
${this.item(r.id)?.path ?? ''}` }, name(r)),
          r.isRef ? badge('ref', 'accent') : null)
      },
      { key: 'xmax', label: `${AXIS_NAME[axis]}max / ${u}`, numeric: true, render: r => fmt(r.xmax, d) },
      { key: 'peak', label: this.loaded.normalized ? 'peak' : `peak / ${yUnit}`, numeric: true, render: r => fmtSci(r.peak) }
    ];
    if (st.refId) {
      columns.push(
        { key: 'shift', label: `shift / ${u}`, numeric: true, render: r => (r.isRef ? h('span.muted', null, 'ref') : r.shift === undefined ? '' : signed(r.shift, d)), sortValue: r => r.shift ?? 0, title: 'position of the maximum minus that of the reference' },
        { key: 'consistentPct', label: '% cons.', numeric: true, render: r => (r.consistentPct === undefined ? h('span.muted', { title: r.note ?? '' }, r.isRef ? '' : '–') : fmt(r.consistentPct, 0)), sortValue: r => r.consistentPct ?? -1, title: 'share of the signal grid where the 95 % CI of the difference contains 0' },
        { key: 'verdict', label: 'verdict', render: r => (r.verdict ? h('span', { title: r.verdict === 'same within noise' ? 'same spectrum within the bootstrap noise' : 'different beyond the bootstrap noise' }, badge(r.verdict === 'same within noise' ? 'same' : 'different', r.verdict === 'same within noise' ? 'ok' : 'bad')) : r.note ? h('span.muted.sp-note', null, r.note) : ''), sortValue: r => r.verdict ?? '' }
      );
    }
    columns.push(
      { key: 'fwhm', label: `FWHM / ${u}`, numeric: true, render: r => fmt(r.fwhm, d) },
      { key: 'centroid', label: `centroid / ${u}`, numeric: true, render: r => fmt(r.centroid, d) }
    );
    if (st.experimentLabel) {
      columns.push({ key: 'maxOverExp', label: 'max/exp', numeric: true, render: r => (r.maxOverExp === undefined ? '' : fmt(r.maxOverExp, 2)), sortValue: r => r.maxOverExp ?? -1, title: `peak / peak of ${st.experimentLabel} in the window` });
    }
    columns.push(
      { key: 'integral', label: 'integral', numeric: true, render: r => fmtSci(r.integral), title: `∫σ d${AXIS_NAME[axis]} in the window (${yUnit || '1'} × ${u})` }
    );
    mount(this.statsEl, dataTable<StatsRow>({ columns, rows: st.rows, rowKey: r => r.id, empty: 'No statistics' }));
    const w = st.window;
    mount(this.noteEl,
      `Statistics in the window ${fmt(w[0], d)}–${fmt(w[1], d)} ${u} (${this.zoomWindow ? 'the zoomed view' : 'the plotted x range'}). `,
      `${AXIS_NAME[axis]}max and peak at the first maximum; centroid ∫x σ dx / ∫σ dx and integral by the trapezoid rule; FWHM between linearly interpolated half-maximum crossings. `,
      st.refId
        ? `Shift and % consistent as in uv-vis scripts/spectra.compare: both curves on a 2000-point grid over the common window, the pointwise sd recovered from each ${Math.round(st.confidence * 100)} % CI as (hi − lo)/2z, a point counts as consistent when |A − B| ≤ z·√(sd_A² + sd_B²); only points above 2 % of the larger peak are tested. "Same within noise" when at least ${st.thresholdPct.toFixed(0)} % of them are consistent (calibrated on 500/500 splits of one ensemble, 89–100 %; ~5 % of a correlated grid falls outside by construction).`
        : 'Mark a reference to get the shift and the consistency test.',
      st.experimentLabel ? ` max/exp: peak divided by the peak of ${st.experimentLabel} in the window.` : '');
  }

  private async exportCsv(btn: HTMLButtonElement): Promise<void> {
    const p = this.plotParams();
    if (!p.ids.length) {
      this.ctx.toast('Select spectra first', 'warning');
      return;
    }
    btn.classList.add('busy');
    btn.disabled = true;
    try {
      const r = await this.ctx.rpc<CsvResult>('csv', { ...p, range: this.zoomWindow ?? this.loaded?.range });
      if (r.path) this.ctx.toast(`Saved ${r.path.split(/[\\/]/).pop()} (${r.rows} rows × ${r.columns} columns)`, 'success');
    } catch (e) {
      this.ctx.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      btn.classList.remove('busy');
      btn.disabled = false;
    }
  }
}

function fmtSci(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-2 || a >= 1e4)) {
    const [m, e] = v.toExponential(2).split('e');
    return `${m}×10${sup(e.replace('+', ''))}`;
  }
  return v.toFixed(a >= 100 ? 1 : 3);
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function sup(s: string): string {
  return s.split('').map(c => SUP[c] ?? c).join('');
}

function signed(v: number, d: number): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;
}
