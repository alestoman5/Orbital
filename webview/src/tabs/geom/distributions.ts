// "Distributions" sub-tab: a library of multi-XYZ trajectories / ensembles,
// watched internal coordinates (picked on a molecule sketch or typed), and
// per-coordinate histograms (common bins, KDE, means), traces, 2D
// histograms and a τ-corrected summary table.

import type {
  CoordInfo,
  DistMode,
  DistParams,
  DistResult,
  FileScanInfo,
  GeomNavigateArgs,
  LibraryFile,
  ListResult,
  MoleculeResult,
  ParseResult,
  ProgressEvent,
  SummaryRow,
  XyzInfo
} from '../../../../src/studio/tabs/geom/types';
import { figureToolbar, render, type ChartHandle, type Figure, type FigureSize, type Preset, type Series, type ToolbarHost } from '../../charts';
import { badge, button, callout, card, dataTable, emptyState, field, iconButton, numberInput, section, segmented, select, skeleton, split, textInput, toggle, type Column } from '../../ui/components';
import { debounce, h, mount } from '../../ui/dom';
import type { ViewContext } from '../../view';
import { bytes, count, fixed, legendLabels, sig } from './format';
import { atomTable, measurePicked, moleculeSketch, pickLabel } from './molecule';

interface DistState {
  selected: string[];
  extra: string[];
  specs: string[] | null;
  coord: number;
  coord2: number;
  file2d?: string;
  mode: DistMode;
  bins: number;
  bins2d: number;
  style: 'step' | 'filled';
  kde: boolean;
  means: boolean;
  stride: number;
  preset: Preset;
  size?: FigureSize;
}

const DEFAULT_STATE: DistState = {
  selected: [], extra: [], specs: null, coord: 0, coord2: 1, mode: 'histogram', bins: 60, bins2d: 30,
  style: 'step', kde: false, means: true, stride: 1, preset: 'screen'
};

/** Paths from commands / URLs may use other separators or drive-letter case than the host's resolved ones. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows paths compare case-insensitively
  return n(a) === n(b) || (/^[a-z]:/i.test(a) && n(a).toLowerCase() === n(b).toLowerCase());
}

export interface SubView {
  el: HTMLElement;
  navigate(args: GeomNavigateArgs): void;
  show(): void;
  dispose(): void;
}

export function distributionsView(ctx: ViewContext): SubView {
  const st: DistState = { ...DEFAULT_STATE, ...ctx.state<Partial<DistState>>('dist', {}) };
  const save = () => ctx.setState('dist', st);

  let library: LibraryFile[] = [];
  let libraryCapped = false;
  let libraryLoading = true;
  const infos = new Map<string, XyzInfo>();
  const cells = new Map<string, { frames: HTMLElement; atoms: HTMLElement; status: HTMLElement }>();
  let coords: CoordInfo[] = [];
  let coordErrors: string[] = [];
  let molecule: MoleculeResult | undefined;
  let moleculeError: string | undefined;
  let pick: number[] = [];
  let result: DistResult | undefined;
  let computeError: string | undefined;
  let busyNow = false;
  let progress: ProgressEvent | undefined;
  let seq = 0;
  let strideHint = 200_000;
  let handle: ChartHandle | undefined;
  let disposed = false;

  // ---------------------------------------------------------------- layout

  const libHost = h('div.geom-lib');
  const coordHost = h('div.geom-coords');
  const pickHost = h('div.geom-picker');
  const optsHost = h('div.geom-opts');
  const warnHost = h('div.geom-warn');
  const plotBox = h('div.geom-plot');
  const plotOverlay = h('div.geom-plot-overlay', { hidden: true });
  const plotHead = h('div.geom-plot-head');
  const plotSub = h('span.muted');
  const summaryHost = h('div.geom-summary');

  const toolbar = figureToolbar({
    figure: () => figure() ?? { panels: [] },
    name: 'geometry-distribution',
    host: ctx as unknown as ToolbarHost,
    initialPreset: st.preset,
    initialSize: st.size,
    caption: () => caption(),
    onLayoutChange: (preset, size) => {
      st.preset = preset;
      st.size = size;
      save();
      drawPlot();
    }
  });

  const libCard = card({ title: 'Library', subtitle: 'Multi-XYZ trajectories and ensembles in the workspace', actions: [
    button('Add files…', () => void addFiles(), { icon: 'plus', variant: 'ghost' }),
    iconButton('refresh', 'Rescan the workspace', () => void loadLibrary())
  ] }, libHost);
  const plotCard = card({ title: 'Distribution', class: 'geom-plot-card' }, plotHead, h('div.geom-plot-wrap', null, plotBox, plotOverlay));
  const summaryCard = card({ title: 'Summary', subtitle: 'Per file and coordinate over the sampled frames' }, summaryHost);

  const sidebar = h('div.stack', null,
    section('Coordinates', true, coordHost),
    section('Atom picker', true, pickHost),
    section('Options', true, optsHost));
  const el = h('div.geom-dist', null, split(sidebar, h('div.stack', null, libCard, warnHost, plotCard, summaryCard), { sidebarWidth: 330 }));

  // ---------------------------------------------------------------- library

  async function loadLibrary(): Promise<void> {
    libraryLoading = true;
    renderLibrary();
    try {
      const r = await ctx.rpc<ListResult>('listXyz', { extra: [...new Set([...st.extra, ...st.selected])] });
      library = r.files;
      libraryCapped = r.capped;
      // map to the host's spelling of each path (separators, drive letter case)
      st.selected = [...new Set(st.selected.map(p => library.find(f => samePath(f.path, p))?.path).filter((p): p is string => !!p))];
      st.extra = st.extra.map(p => library.find(f => samePath(f.path, p))?.path ?? p);
      save();
    } catch (e) {
      ctx.toast(`Could not list XYZ files: ${e instanceof Error ? e.message : e}`, 'error');
    }
    libraryLoading = false;
    renderLibrary();
    void fetchInfos();
  }

  /** Frame counts: selected files first, then the rest in small batches. */
  let infoRunning = false;
  async function fetchInfos(): Promise<void> {
    if (infoRunning) return;
    infoRunning = true;
    try {
      for (;;) {
        const todo = [...st.selected, ...library.map(f => f.path)].filter(p => !infos.has(p));
        if (!todo.length || disposed) break;
        const batch = [...new Set(todo)].slice(0, 6);
        const res = await ctx.rpc<XyzInfo[]>('xyzInfo', { paths: batch });
        res.forEach((r, i) => {
          infos.set(batch[i], r);
          updateCells(batch[i]);
        });
        renderOptions();
      }
    } catch {
      // the table keeps its placeholders
    } finally {
      infoRunning = false;
    }
  }

  function updateCells(p: string): void {
    const c = cells.get(p);
    if (!c) return;
    const i = infos.get(p);
    mount(c.frames, i ? (i.error && !i.frames ? '–' : count(i.frames)) : h('span.geom-pending', null, '…'));
    mount(c.atoms, i && i.atoms ? String(i.atoms) : i ? '–' : '');
    mount(c.status, statusBadges(i));
  }

  function statusBadges(i: XyzInfo | undefined): (HTMLElement | null)[] {
    if (!i) return [];
    return [
      i.error ? badge(i.error.length > 40 ? 'unreadable' : i.error, 'bad') : null,
      i.incompleteTail ? badge('truncated', 'warn') : null,
      i.stoppedAtLine ? badge(`stops at line ${i.stoppedAtLine}`, 'warn') : null,
      !i.error && i.frames === 1 ? badge('1 frame', 'muted') : null
    ];
  }

  function renderLibrary(): void {
    if (libraryLoading && !library.length) {
      mount(libHost, skeleton(4));
      return;
    }
    if (!library.length) {
      mount(libHost, emptyState('geom', 'No XYZ files found', 'Add trajectories with "Add files…" or change the orcaInp.studio.geometryGlobs setting.',
        button('Add files…', () => void addFiles(), { icon: 'plus', variant: 'primary' })));
      return;
    }
    const sel = new Set(st.selected);
    const cell = (p: string, k: 'frames' | 'atoms' | 'status') => {
      let c = cells.get(p);
      if (!c) {
        c = { frames: h('span'), atoms: h('span'), status: h('span.geom-badges') };
        cells.set(p, c);
      }
      const node = h('span', k === 'status' ? { class: 'geom-badges' } : null);
      c[k] = node;
      updateCells(p);
      return node;
    };
    const columns: Column<LibraryFile>[] = [
      { key: 'label', label: 'File', render: f => h('span.geom-file', { title: f.path }, h('b', null, f.label), f.rel !== f.label ? h('span.muted', null, f.rel.slice(0, Math.max(0, f.rel.length - f.label.length)).replace(/\/$/, '')) : null) },
      { key: 'frames', label: 'Frames', numeric: true, render: f => cell(f.path, 'frames'), sortValue: f => infos.get(f.path)?.frames ?? -1, width: '80px' },
      { key: 'atoms', label: 'Atoms', numeric: true, render: f => cell(f.path, 'atoms'), sortValue: f => infos.get(f.path)?.atoms ?? -1, width: '64px' },
      { key: 'size', label: 'Size', numeric: true, render: f => bytes(f.size), width: '80px' },
      { key: 'status', label: '', render: f => cell(f.path, 'status'), sortValue: () => 0 }
    ];
    mount(libHost,
      dataTable({
        columns,
        // selected files first, then the workspace order
        rows: [...library.filter(f => sel.has(f.path)), ...library.filter(f => !sel.has(f.path))],
        rowKey: f => f.path,
        selectable: { selected: sel, onChange: s => setSelection(s) },
        filterText: f => f.rel,
        filterPlaceholder: `Filter ${library.length} files…`,
        maxHeight: 210,
        initialSort: undefined
      }),
      libraryCapped ? h('p.field-hint', null, 'Only the first files are listed; narrow orcaInp.studio.geometryGlobs to see the rest.') : null);
  }

  function setSelection(s: Set<string>): void {
    const kept = st.selected.filter(p => s.has(p));
    const added = library.map(f => f.path).filter(p => s.has(p) && !kept.includes(p));
    const firstBefore = st.selected[0];
    st.selected = [...kept, ...added];
    if (st.file2d && !st.selected.includes(st.file2d)) st.file2d = undefined;
    save();
    if (st.selected[0] !== firstBefore) {
      void loadMolecule();
      void parseSpecs(st.specs ?? []);
    }
    void fetchInfos();
    renderOptions();
    scheduleCompute();
  }

  async function addFiles(): Promise<void> {
    const files = await ctx.rpc<string[]>('pick', { kind: 'xyz' }).catch(() => [] as string[]);
    if (!files.length) return;
    st.extra = [...new Set([...st.extra, ...files])];
    st.selected = [...new Set([...st.selected, ...files])];
    save();
    await loadLibrary();
    void loadMolecule();
    scheduleCompute();
  }

  // ---------------------------------------------------------------- coordinates

  async function parseSpecs(specs: string[], added?: string): Promise<boolean> {
    try {
      const r = await ctx.rpc<ParseResult>('parse', { specs, file: st.selected[0] });
      coords = r.coords;
      coordErrors = r.errors;
      st.specs = r.coords.map(c => c.spec);
      st.coord = Math.min(st.coord, Math.max(0, coords.length - 1));
      st.coord2 = Math.min(st.coord2, Math.max(0, coords.length - 1));
      save();
      renderCoords();
      renderOptions();
      return !added || r.coords.some(c => c.spec === added);
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    }
  }

  async function addSpec(spec: string): Promise<void> {
    let s = spec.trim();
    if (!s) return;
    if (!s.includes(':')) {
      const atoms = s.split(/[\s,-]+/).map(Number).filter(n => n >= 1);
      s = `${molecule ? pickLabel(molecule.atoms, atoms) : atoms.join('–')}: ${atoms.join('-')}`;
    }
    const atomsOf = (x: string) => x.split(':').pop()!.split(/[\s,-]+/).filter(Boolean).map(Number);
    const a = atomsOf(s).join('-');
    const dup = coords.find(c => c.atoms.join('-') === a || c.atoms.slice().reverse().join('-') === a);
    if (dup) {
      ctx.toast(`Already watched as "${dup.label}".`, 'info');
      st.coord = coords.indexOf(dup);
      save();
      renderCoords();
      scheduleCompute();
      return;
    }
    const before = coords.length;
    const ok = await parseSpecs([...(st.specs ?? []), s], s);
    if (ok && coords.length > before) {
      st.coord = coords.length - 1;
      save();
      renderCoords();
      scheduleCompute();
    }
  }

  function removeCoord(i: number): void {
    const specs = (st.specs ?? []).filter((_, k) => k !== i);
    if (st.coord >= i && st.coord > 0) st.coord--;
    if (st.coord2 >= i && st.coord2 > 0) st.coord2--;
    void parseSpecs(specs).then(() => scheduleCompute());
  }

  function renderCoords(): void {
    let draft = '';
    const input = textInput('', v => (draft = v), { placeholder: 'O-O: 2-3   or   1-2-3', mono: true });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void addSpec(draft);
      }
    });
    const chips = coords.map((c, i) => h('div.geom-chip', {
      class: [i === st.coord ? 'on' : '', st.mode === '2d' && i === st.coord2 ? 'on2' : ''].join(' '),
      role: 'button', tabindex: 0, title: `${c.spec} — click to plot`,
      onclick: () => { st.coord = i; save(); renderCoords(); renderOptions(); scheduleCompute(); }
    },
    h('span.geom-chip-kind', { class: c.kind }, c.kind === 'bond' ? 'r' : c.kind === 'angle' ? 'θ' : 'φ'),
    h('span.geom-chip-label', null, c.label),
    h('span.geom-chip-atoms', null, c.atoms.join('-')),
    h('span.geom-chip-unit', null, c.unit),
    st.mode === '2d' && (i === st.coord || i === st.coord2) ? h('span.geom-chip-axis', null, i === st.coord ? 'x' : 'y') : null,
    h('button.geom-chip-x', { type: 'button', title: `Remove ${c.label}`, 'aria-label': `Remove ${c.label}`, onclick: (e: Event) => { e.stopPropagation(); removeCoord(i); } }, '×')));
    mount(coordHost,
      chips.length ? h('div.geom-chips', null, chips) : h('p.muted.geom-hint', null, 'No coordinates yet. Pick atoms below or type a spec.'),
      h('div.geom-add', null, input, button('Add', () => void addSpec(draft), { icon: 'plus' })),
      h('p.field-hint', null, 'label: i-j[-k[-l]] with 1-based atom indices — 2 atoms = bond, 3 = angle, 4 = dihedral.'),
      coordErrors.length ? callout('warn', coordErrors.map(e => h('div', null, e))) : null);
  }

  // ---------------------------------------------------------------- picker

  async function loadMolecule(): Promise<void> {
    const file = st.selected[0];
    pick = [];
    if (!file) {
      molecule = undefined;
      moleculeError = undefined;
      renderPicker();
      return;
    }
    mount(pickHost, skeleton(3));
    try {
      molecule = await ctx.rpc<MoleculeResult>('molecule', { path: file });
      moleculeError = undefined;
    } catch (e) {
      molecule = undefined;
      moleculeError = e instanceof Error ? e.message : String(e);
    }
    renderPicker();
  }

  function togglePick(i: number): void {
    const k = pick.indexOf(i);
    if (k >= 0) {
      pick.splice(k, 1);
    } else if (pick.length >= 4) {
      ctx.toast('At most four atoms (dihedral).', 'info');
      return;
    } else {
      pick.push(i);
    }
    renderPicker();
  }

  function renderPicker(): void {
    if (!molecule) {
      mount(pickHost, moleculeError ? callout('bad', moleculeError) : h('p.muted.geom-hint', null, 'Select a file in the library to pick atoms on its first frame.'));
      return;
    }
    const m = molecule;
    const kind = pick.length === 2 ? 'bond' : pick.length === 3 ? 'angle' : pick.length === 4 ? 'dihedral' : undefined;
    const v = kind ? measurePicked(m.atoms, pick) : undefined;
    const name = kind ? `${kind === 'bond' ? 'r' : kind === 'angle' ? 'θ' : 'φ'}(${pickLabel(m.atoms, pick)})` : '';
    const preview = kind
      ? h('div.geom-pick-preview', null, h('span', null, name, ' = ', h('b', null, v === undefined ? '–' : kind === 'bond' ? `${fixed(v, 4)} Å` : `${fixed(v, 2)}°`)), h('span.muted', null, ' frame 1'))
      : h('div.geom-pick-preview.muted', null, pick.length ? `${pickLabel(m.atoms, pick)} — pick ${pick.length === 1 ? 'at least one more atom' : ''}` : 'Click 2–4 atoms: bond, angle, dihedral.');
    mount(pickHost,
      h('div.geom-sketch-wrap', null, moleculeSketch(m, pick, togglePick)),
      preview,
      h('div.row', null,
        button('Add coordinate', () => {
          void addSpec(`${pickLabel(m.atoms, pick)}: ${pick.join('-')}`).then(() => { pick = []; renderPicker(); });
        }, { variant: 'primary', icon: 'plus', disabled: !kind }),
        button('Clear', () => { pick = []; renderPicker(); }, { variant: 'ghost', disabled: !pick.length })),
      m.atoms.length <= 400 ? atomTable(m, pick, togglePick) : h('p.muted', null, `${m.atoms.length} atoms — type indices above.`));
  }

  // ---------------------------------------------------------------- options

  function maxFrames(): number {
    return Math.max(0, ...st.selected.map(p => infos.get(p)?.frames ?? 0));
  }

  function renderOptions(): void {
    const sel = st.selected;
    const labelOf = (p: string) => library.find(f => f.path === p)?.label ?? p;
    const coordOptions = coords.map((c, i) => ({ value: String(i), label: `${c.label} — ${c.name}` }));
    const big = maxFrames();
    const suggested = big > strideHint ? Math.ceil(big / 100_000) : 0;
    const is2d = st.mode === '2d';
    const binsNow = is2d ? st.bins2d : st.bins;
    const binsVal = h('span.geom-range-val', null, String(binsNow));
    const range = h('input.geom-range', {
      type: 'range', min: 5, max: is2d ? 100 : 200, step: 1, value: String(binsNow), 'aria-label': 'Number of bins',
      oninput: (e: Event) => { binsVal.textContent = (e.target as HTMLInputElement).value; },
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (is2d) st.bins2d = v; else st.bins = v;
        save();
        scheduleCompute();
      }
    });
    mount(optsHost,
      coords.length > 1 && st.mode === '2d' ? field('x coordinate', select(coordOptions, String(st.coord), v => { st.coord = Number(v); save(); renderCoords(); scheduleCompute(); })) : null,
      coords.length > 1 && st.mode === '2d' ? field('y coordinate', select(coordOptions, String(st.coord2), v => { st.coord2 = Number(v); save(); renderCoords(); scheduleCompute(); })) : null,
      st.mode === '2d' && sel.length > 1 ? field('File', select(sel.map(p => ({ value: p, label: labelOf(p) })), st.file2d ?? sel[0], v => { st.file2d = v; save(); scheduleCompute(); })) : null,
      st.mode !== 'trace' ? field('Bins', h('div.geom-range-row', null, range, binsVal), st.mode === 'histogram' ? 'Common edges across all files.' : 'Per axis.') : null,
      st.mode === 'histogram' ? field('Style', segmented([{ value: 'step', label: 'Step' }, { value: 'filled', label: 'Filled' }], st.style, v => { st.style = v; save(); drawPlot(); })) : null,
      st.mode === 'histogram' ? toggle('KDE overlay (Scott)', st.kde, v => { st.kde = v; save(); scheduleCompute(); }) : null,
      st.mode !== '2d' ? toggle('Mean lines', st.means, v => { st.means = v; save(); drawPlot(); }) : null,
      field('Stride', numberInput(st.stride, v => { st.stride = Math.max(1, Math.round(v)); save(); renderOptions(); scheduleCompute(); }, { min: 1, step: 1 }),
        big ? `Every n-th frame. Largest selected file: ${count(big)} frames.` : 'Every n-th frame.'),
      suggested > st.stride && st.stride === 1
        ? callout('warn', `${count(big)} frames — a stride of ${suggested} keeps ~10⁵ samples and is much faster.`, h('div', null, button(`Use stride ${suggested}`, () => { st.stride = suggested; save(); renderOptions(); scheduleCompute(); }, { variant: 'secondary' })))
        : null);
  }

  // ---------------------------------------------------------------- compute

  const scheduleCompute = debounce(() => void compute(), 120);

  async function compute(): Promise<void> {
    const my = ++seq;
    renderPlotHead();
    if (!st.selected.length || !coords.length) {
      result = undefined;
      computeError = undefined;
      drawPlot();
      renderSummary();
      renderWarnings();
      return;
    }
    busyNow = true;
    progress = undefined;
    renderOverlay();
    const params: DistParams = {
      files: st.selected,
      specs: coords.map(c => c.spec),
      stride: st.stride,
      mode: st.mode,
      coord: st.coord,
      coord2: st.coord2,
      file2d: st.file2d,
      bins: st.mode === '2d' ? st.bins2d : st.bins,
      kde: st.kde,
      maxPoints: 4000
    };
    try {
      const r = await ctx.rpc<DistResult>('distributions', params);
      if (my !== seq) return;
      // library labels are unique across the workspace ("PIGLE_PBEPBE/geoms.xyz", not "geoms.xyz")
      const lab = (p: string, fallback: string) => library.find(f => f.path === p)?.label ?? fallback;
      r.files.forEach(f => (f.label = lab(f.path, f.label)));
      r.summary.forEach(s => (s.label = lab(s.path, s.label)));
      if (r.plot?.kind === '2d') r.plot.label = lab(r.plot.path, r.plot.label);
      else r.plot?.series.forEach(s => (s.label = lab(s.path, s.label)));
      result = r;
      computeError = undefined;
    } catch (e) {
      if (my !== seq) return;
      computeError = e instanceof Error ? e.message : String(e);
    }
    busyNow = false;
    renderOverlay();
    renderPlotHead();
    drawPlot();
    renderSummary();
    renderWarnings();
  }

  function renderOverlay(): void {
    plotOverlay.hidden = !busyNow;
    if (!busyNow) return;
    const p = progress;
    const frac = p ? (p.index + p.fraction) / p.count : 0;
    mount(plotOverlay, h('div.geom-progress', null,
      h('div.geom-progress-label', null, p ? `Reading ${p.label} (${p.index + 1}/${p.count})` : 'Measuring coordinates…', h('span.muted', null, p ? ` ${Math.round(frac * 100)} %` : '')),
      h('div.geom-progress-bar', null, h('span', { style: { width: `${Math.round(frac * 100)}%` } }))));
  }

  function renderPlotHead(): void {
    const modes = segmented<DistMode>([{ value: 'histogram', label: 'Histogram' }, { value: 'trace', label: 'Trace' }, { value: '2d', label: '2D' }], st.mode, v => {
      st.mode = v;
      if (v === '2d' && coords.length > 1 && st.coord2 === st.coord) st.coord2 = st.coord === 0 ? 1 : 0;
      save();
      renderCoords();
      renderOptions();
      scheduleCompute();
    });
    const coordSel = coords.length && st.mode !== '2d'
      ? select(coords.map((c, i) => ({ value: String(i), label: `${c.label} — ${c.name}` })), String(st.coord), v => { st.coord = Number(v); save(); renderCoords(); scheduleCompute(); })
      : null;
    if (result && !busyNow) {
      const frames = result.files.reduce((a, f) => a + f.sampled, 0);
      plotSub.textContent = `${result.files.length} file${result.files.length === 1 ? '' : 's'} · ${count(frames)} sampled frames${st.stride > 1 ? ` (stride ${st.stride})` : ''} · ${result.ms} ms`;
    } else if (!busyNow) {
      plotSub.textContent = '';
    }
    mount(plotHead, h('div.geom-plot-controls', null, modes, coordSel), h('div.geom-plot-meta', null, plotSub, toolbar));
  }

  // ---------------------------------------------------------------- figure

  function caption(): string {
    const c = coords[st.coord];
    if (!result || !c) return '';
    const names = result.files.map(f => f.label).join(', ');
    if (st.mode === '2d') return `Joint distribution of ${c.name} and ${coords[st.coord2]?.name ?? ''} (${(result.plot as any)?.label ?? ''}).`;
    return `${st.mode === 'trace' ? 'Trace' : 'Distribution'} of ${c.name} — ${names}.`;
  }

  function figure(): Figure | undefined {
    const plot = result?.plot;
    const c = result?.coords[st.coord];
    if (!plot || !c) return undefined;
    const base = { preset: st.preset, size: st.size };
    if (plot.kind === 'histogram') {
      const series: Series[] = [];
      const names = legendLabels(plot.series.map(s => s.label));
      plot.series.forEach((s, k) => {
        series.push({ type: 'histogram', edges: plot.edges, values: s.values, style: st.style, label: names[k], group: s.label, opacity: st.style === 'filled' ? 0.28 : undefined });
        if (plot.kde) series.push({ type: 'line', x: plot.kde.grid, y: plot.kde.series[k], group: s.label, width: 1.5 });
        if (st.means && Number.isFinite(s.mean)) series.push({ type: 'vline', value: s.mean, dash: 'dashed', group: s.label, width: 1 });
      });
      return { ...base, panels: [{ x: { label: c.axis }, y: { label: `density / ${c.unit === 'Å' ? 'Å' : '°'}^{−1}` }, series, legend: 'auto' }] };
    }
    if (plot.kind === 'trace') {
      const series: Series[] = [];
      const names = legendLabels(plot.series.map(s => s.label));
      plot.series.forEach((s, k) => {
        series.push({ type: 'line', x: s.x, y: s.y, label: names[k], group: s.label, width: 0.9 });
        if (st.means && Number.isFinite(s.mean)) series.push({ type: 'hline', value: s.mean, dash: 'dashed', group: s.label, width: 1 });
      });
      return { ...base, panels: [{ x: { label: 'frame' }, y: { label: c.axis, zero: false }, series, legend: 'auto' }] };
    }
    const c2 = result!.coords[st.coord2] ?? c;
    return {
      ...base,
      panels: [{
        x: { label: c.axis }, y: { label: c2.axis, zero: false }, legend: 'none',
        title: `${plot.label} · n = ${count(plot.n)}`,
        series: [{ type: 'heatmap', xEdges: plot.xEdges, yEdges: plot.yEdges, z: plot.z, colormap: 'viridis', colorbarLabel: `density / ${c.unit}^{−1} ${c2.unit}^{−1}` }]
      }]
    };
  }

  function drawPlot(): void {
    const fig = figure();
    if (!fig) {
      handle?.dispose();
      handle = undefined;
      plotBox.classList.add('empty');
      mount(plotBox,
        computeError ? callout('bad', computeError)
          : !st.selected.length ? emptyState('geom', 'No trajectories selected', 'Tick one or more XYZ files in the library to compare their distributions.')
          : !coords.length ? emptyState('geom', 'No coordinates', 'Pick 2–4 atoms on the molecule sketch or type a spec such as "O-O: 2-3".')
          : busyNow || !result ? skeleton(5)
          : emptyState('geom', 'Nothing to plot', 'No finite values for this coordinate.'));
      return;
    }
    plotBox.classList.remove('empty');
    if (handle) {
      handle.update(fig);
    } else {
      plotBox.replaceChildren();
      handle = render(plotBox, fig);
    }
  }

  // ---------------------------------------------------------------- summary & warnings

  function fileInfo(p: string): FileScanInfo | undefined {
    return result?.files.find(f => f.path === p);
  }

  function renderSummary(): void {
    if (!result || !result.summary.length) {
      mount(summaryHost, busyNow ? skeleton(3) : h('p.muted', null, 'Statistics appear once files and coordinates are selected.'));
      return;
    }
    const r = result;
    const d = (row: SummaryRow) => (r.coords[row.coord]?.unit === 'Å' ? 4 : 2);
    const columns: Column<SummaryRow>[] = [
      { key: 'label', label: 'File', render: row => h('span', { title: row.path }, row.label) },
      { key: 'coord', label: 'Coordinate', render: row => h('span.geom-coordcell', { title: r.coords[row.coord]?.spec }, r.coords[row.coord]?.label ?? '', h('span.muted', null, ` / ${r.coords[row.coord]?.unit ?? ''}`)), sortValue: row => row.coord },
      { key: 'n', label: 'n', numeric: true, render: row => count(row.n) },
      { key: 'mean', label: 'Mean ± sd', numeric: true, render: row => `${fixed(row.mean, d(row))} ± ${fixed(row.sd, d(row))}` },
      { key: 'median', label: 'Median', numeric: true, render: row => fixed(row.median, d(row)) },
      { key: 'min', label: 'Min', numeric: true, render: row => fixed(row.min, d(row)) },
      { key: 'max', label: 'Max', numeric: true, render: row => fixed(row.max, d(row)) },
      { key: 'tau', label: 'τ_int', numeric: true, render: row => sig(row.tau, 3), title: 'Integrated autocorrelation time in sampled frames (0.5 = uncorrelated)' },
      { key: 'sem', label: 'SEM (τ-corrected)', numeric: true, render: row => fixed(row.sem, d(row) + 1), title: 'sd · sqrt(2 τ_int / n)' },
      {
        key: 'flags', label: 'Checks', sortValue: row => fileInfo(row.path)?.orderMismatches ?? 0,
        render: row => {
          const f = fileInfo(row.path);
          if (!f) return '';
          const out: HTMLElement[] = [];
          out.push(f.orderMismatches > 0 ? badge(`order ≠ ×${f.orderMismatches}`, 'warn') : badge('ok', 'ok'));
          if (f.incompleteTail) out.push(badge('truncated', 'warn'));
          if (f.malformedFrames) out.push(badge(`${f.malformedFrames} malformed`, 'bad'));
          if (f.outOfRange) out.push(badge('index > atoms', 'bad'));
          return h('span.geom-badges', null, out);
        }
      }
    ];
    mount(summaryHost, dataTable({ columns, rows: r.summary, rowKey: row => `${row.path}#${row.coord}`, maxHeight: 360 }));
  }

  function renderWarnings(): void {
    const items: HTMLElement[] = [];
    for (const f of result?.files ?? []) {
      if (f.orderMismatches > 0) {
        items.push(callout('warn', h('b', null, f.label), `: ${f.orderMismatches} of ${count(f.sampled)} frames have a different element order than frame 1 (first at frame ${(f.firstMismatchFrame ?? 0) + 1}). The indices may point at different atoms there.`));
      }
      if (f.incompleteTail) {
        items.push(callout('warn', h('b', null, f.label), ': the file ends inside a frame (truncated or still being written); the partial frame is ignored.'));
      }
      if (f.stoppedAtLine) {
        items.push(callout('warn', h('b', null, f.label), `: reading stopped at line ${f.stoppedAtLine} (not an atom count).`));
      }
      if (f.outOfRange) {
        items.push(callout('bad', h('b', null, f.label), `: has ${f.symbols.length} atoms, but a coordinate uses a larger index.`));
      }
    }
    if (result?.suggestedStride && st.stride === 1) {
      items.push(callout('info', `Large trajectory — consider stride ${result.suggestedStride}.`));
    }
    mount(warnHost, items);
    warnHost.hidden = !items.length;
  }

  // ---------------------------------------------------------------- wiring

  const offProgress = ctx.on('progress', (p: ProgressEvent) => {
    if (busyNow) {
      progress = p;
      renderOverlay();
    }
  });

  async function init(): Promise<void> {
    renderLibrary();
    renderCoords();
    renderPicker();
    renderOptions();
    renderPlotHead();
    drawPlot();
    renderSummary();
    renderWarnings();
    try {
      const d = await ctx.rpc<{ specs: string[]; strideHintFrames: number }>('defaults');
      strideHint = d.strideHintFrames;
      if (st.specs === null) st.specs = d.specs;
    } catch {
      st.specs ??= [];
    }
    await loadLibrary();
    await Promise.all([loadMolecule(), parseSpecs(st.specs ?? [])]);
    scheduleCompute();
  }
  const ready = init();

  return {
    el,
    navigate(args) {
      void ready.then(async () => {
        if (args.specs) {
          await parseSpecs(args.specs);
        }
        if (args.mode) st.mode = args.mode;
        if (typeof args.coord === 'number') st.coord = Math.max(0, Math.min(coords.length - 1, args.coord));
        if (typeof args.coord2 === 'number') st.coord2 = Math.max(0, Math.min(coords.length - 1, args.coord2));
        if (typeof args.kde === 'boolean') st.kde = args.kde;
        if (args.xyz?.length) {
          st.extra = [...new Set([...st.extra, ...args.xyz])];
          st.selected = [...new Set(args.xyz)];
          save();
          await loadLibrary();
          await Promise.all([loadMolecule(), parseSpecs(st.specs ?? [])]);
        }
        save();
        renderCoords();
        renderOptions();
        scheduleCompute();
      });
    },
    show() {
      // a chart created while hidden has zero width; redraw at the real size
      if (handle) drawPlot();
    },
    dispose() {
      disposed = true;
      offProgress();
      handle?.dispose();
    }
  };
}
