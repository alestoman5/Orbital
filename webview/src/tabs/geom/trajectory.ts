// "Trajectory (.dat)" sub-tab: MD column files (ABIN energies.dat,
// temper.dat, est_energy.dat, …) as stacked panels on a shared time axis.
// Drag or wheel to zoom, double-click to reset; for the visible range every
// panel shows a dashed least-squares line, and the table lists the slope
// (per ps for fs time axes), end − start, mean ± sd and τ_int. Replaces the
// old .dat plot (src/features/mdPlot.ts).

import type { DatInfo, DatViewResult, GeomNavigateArgs, LibraryFile, ListResult } from '../../../../src/studio/tabs/geom/types';
import { PALETTE, figureToolbar, render, type ChartHandle, type Figure, type FigureSize, type Panel, type Preset, type ToolbarHost } from '../../charts';
import { badge, button, callout, card, dataTable, emptyState, iconButton, section, skeleton, split, toggle, type Column } from '../../ui/components';
import { debounce, h, mount } from '../../ui/dom';
import type { ViewContext } from '../../view';
import { samePath, type SubView } from './distributions';
import { count, decimalsFor, fixed, sig } from './format';

interface TrajState {
  path?: string;
  extra: string[];
  /** Hidden column indices per file path. */
  hidden: Record<string, number[]>;
  fit: boolean;
  preset: Preset;
  size?: FigureSize;
}

const DEFAULT_STATE: TrajState = { extra: [], hidden: {}, fit: true, preset: 'screen' };

const PANEL_PX = 150;

export function trajectoryView(ctx: ViewContext): SubView {
  const st: TrajState = { ...DEFAULT_STATE, ...ctx.state<Partial<TrajState>>('traj', {}) };
  const save = () => ctx.setState('traj', st);

  let files: LibraryFile[] = [];
  let listing = true;
  const infos = new Map<string, DatInfo>();
  const cells = new Map<string, HTMLElement>();
  let data: DatViewResult | undefined;
  let error: string | undefined;
  let loading = false;
  let view: [number, number] | undefined;
  let handle: ChartHandle | undefined;
  let seq = 0;
  let suppressZoom = false;
  let disposed = false;

  const fileHost = h('div.geom-datfiles');
  const colHost = h('div.geom-cols');
  const headHost = h('div.geom-plot-head');
  const plotBox = h('div.geom-dat-plot');
  const statsHost = h('div.geom-summary');
  const hint = h('p.field-hint.geom-dat-hint', null, 'Drag or scroll to zoom time · double-click or Esc for the full range. Statistics use every row of the visible range.');

  const toolbar = figureToolbar({
    figure: () => figure() ?? { panels: [] },
    name: 'md-trajectory',
    host: ctx as unknown as ToolbarHost,
    initialPreset: st.preset,
    initialSize: st.size,
    caption: () => (data ? `${data.label}: ${data.series.map(s => s.name).join(', ')} vs ${data.columns[0]}; dashed: least-squares fit over the shown range.` : ''),
    onLayoutChange: (preset, size) => {
      st.preset = preset;
      st.size = size;
      save();
      draw();
    }
  });

  const plotCard = card({ title: 'Trajectory', class: 'geom-plot-card' }, headHost, plotBox, hint);
  const statsCard = card({ title: 'Visible range', subtitle: 'Least-squares drift and fluctuation of each column' }, statsHost);
  const sidebar = h('div.stack', null,
    section('Files', true,
      h('div.row', null,
        button('Add file…', () => void addFile(), { icon: 'plus', variant: 'ghost' }),
        iconButton('refresh', 'Rescan the workspace', () => void loadList())),
      fileHost),
    section('Columns', true, colHost));
  const el = h('div.geom-traj', null, split(sidebar, h('div.stack', null, plotCard, statsCard), { sidebarWidth: 330 }));

  // ---------------------------------------------------------------- files

  async function loadList(): Promise<void> {
    listing = true;
    renderFiles();
    try {
      const r = await ctx.rpc<ListResult>('listDat', { extra: [...new Set([...st.extra, ...(st.path ? [st.path] : [])])] });
      files = r.files;
    } catch (e) {
      ctx.toast(`Could not list .dat files: ${e instanceof Error ? e.message : e}`, 'error');
    }
    listing = false;
    renderFiles();
    void fetchInfos();
  }

  let infoRunning = false;
  async function fetchInfos(): Promise<void> {
    if (infoRunning) return;
    infoRunning = true;
    try {
      for (;;) {
        const todo = files.map(f => f.path).filter(p => !infos.has(p));
        if (!todo.length || disposed) break;
        const batch = todo.slice(0, 16);
        const res = await ctx.rpc<DatInfo[]>('datInfo', { paths: batch });
        res.forEach((r, i) => {
          infos.set(batch[i], r);
          updateCell(batch[i]);
        });
      }
    } catch {
      // keep placeholders
    } finally {
      infoRunning = false;
    }
  }

  function updateCell(p: string): void {
    const c = cells.get(p);
    if (!c) return;
    const i = infos.get(p);
    mount(c, !i ? h('span.geom-pending', null, '…')
      : i.ok ? h('span.muted', { title: i.partialTail ? 'The last line is incomplete and is ignored.' : undefined }, `${count(i.rows)} × ${i.columns.length}${i.partialTail ? ' ⚠' : ''}`)
      : badge(i.error ? 'unreadable' : 'not columns', 'muted'));
  }

  function renderFiles(): void {
    if (listing && !files.length) {
      mount(fileHost, skeleton(4));
      return;
    }
    if (!files.length) {
      mount(fileHost, h('p.muted.geom-hint', null, 'No .dat files found (setting orcaInp.studio.datGlobs).'));
      return;
    }
    const columns: Column<LibraryFile>[] = [
      { key: 'label', label: 'File', render: f => h('span.geom-file', { title: f.path }, h('b', null, f.label)) },
      {
        key: 'rows', label: 'Rows × cols', numeric: true, sortValue: f => infos.get(f.path)?.rows ?? -1,
        render: f => {
          const c = h('span');
          cells.set(f.path, c);
          updateCell(f.path);
          return c;
        }
      }
    ];
    const table = dataTable({
      columns,
      rows: files,
      rowKey: f => f.path,
      onRowClick: f => open(f.path),
      filterText: f => f.rel,
      filterPlaceholder: `Filter ${files.length} files…`,
      maxHeight: 300
    });
    mount(fileHost, table);
    markActive();
  }

  /** Highlight the open file's row (dataTable has no single-selection mode). */
  function markActive(): void {
    fileHost.querySelectorAll('tbody tr').forEach(tr => {
      const title = tr.querySelector('.geom-file')?.getAttribute('title');
      tr.classList.toggle('selected', !!st.path && !!title && samePath(title, st.path));
    });
  }

  async function addFile(): Promise<void> {
    const picked = await ctx.rpc<string[]>('pick', { kind: 'dat' }).catch(() => [] as string[]);
    if (!picked.length) return;
    st.extra = [...new Set([...st.extra, ...picked])];
    save();
    await loadList();
    open(picked[0]);
  }

  function open(p: string): void {
    if (st.path !== p) {
      st.path = p;
      view = undefined;
      data = undefined;
      handle?.dispose();
      handle = undefined;
      save();
    }
    markActive();
    void load();
  }

  // ---------------------------------------------------------------- data

  function visibleColumns(): number[] | undefined {
    if (!data || !st.path) return undefined;
    const hidden = new Set(st.hidden[st.path] ?? []);
    return data.columns.map((_, j) => j).filter(j => j > 0 && !hidden.has(j));
  }

  async function load(): Promise<void> {
    if (!st.path) {
      draw();
      return;
    }
    const my = ++seq;
    loading = true;
    if (!data) draw();
    const hidden = st.hidden[st.path] ?? [];
    try {
      // first load: all columns, so the column list is known
      const first = !data || data.path !== st.path;
      const cols = first ? undefined : visibleColumns();
      const r = await ctx.rpc<DatViewResult>('datView', {
        path: st.path,
        columns: cols && cols.length ? cols : undefined,
        xMin: view?.[0],
        xMax: view?.[1],
        maxPoints: 3000
      });
      if (my !== seq) return;
      if (first && hidden.length) {
        r.series = r.series.filter(s => !hidden.includes(s.index));
      }
      data = r;
      st.path = r.path;
      error = undefined;
    } catch (e) {
      if (my !== seq) return;
      error = e instanceof Error ? e.message : String(e);
      data = undefined;
    }
    loading = false;
    draw();
  }

  const reload = debounce(() => void load(), 60);

  function setView(a: number, b: number): void {
    if (!data) return;
    const [f0, f1] = data.xFull;
    const lo = Math.max(f0, Math.min(a, b));
    const hi = Math.min(f1, Math.max(a, b));
    if (!(hi > lo) || hi - lo < (f1 - f0) * 1e-6) return;
    view = lo <= f0 && hi >= f1 ? undefined : [lo, hi];
    reload();
  }

  function resetView(): void {
    view = undefined;
    reload();
  }

  // ---------------------------------------------------------------- figure

  function figure(): Figure | undefined {
    if (!data || !data.series.length) return undefined;
    const d = data;
    const [a, b] = view ?? d.xFull;
    const panels: Panel[] = d.series.map(s => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of s.y) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const fitY = [s.stats.slopeX * a + s.stats.intercept, s.stats.slopeX * b + s.stats.intercept];
      if (st.fit && fitY.every(Number.isFinite)) {
        lo = Math.min(lo, ...fitY);
        hi = Math.max(hi, ...fitY);
      }
      const pad = hi > lo ? (hi - lo) * 0.06 : Math.abs(hi) * 1e-6 + 1e-9;
      return {
        x: { label: d.xLabel, min: a, max: b },
        y: { label: s.axis, min: lo - pad, max: hi + pad, zero: false },
        legend: 'none',
        series: [
          { type: 'line', x: s.x, y: s.y, color: PALETTE[0], width: 1, label: s.name },
          ...(st.fit && fitY.every(Number.isFinite)
            ? [{ type: 'line' as const, x: [a, b], y: fitY, color: PALETTE[1], dash: 'dashed' as const, width: 1.25, label: 'linear fit' }]
            : [])
        ]
      };
    });
    return { layout: { kind: 'stack', sharedX: true }, panels, preset: st.preset, size: st.size ?? { widthIn: 7, heightIn: Math.min(9, 1.4 + 1.3 * panels.length) } };
  }

  function draw(): void {
    renderHead();
    renderColumns();
    renderStats();
    const fig = figure();
    if (!fig) {
      handle?.dispose();
      handle = undefined;
      plotBox.style.height = '';
      mount(plotBox,
        error ? callout('bad', error)
          : !st.path ? emptyState('runs', 'No file open', 'Choose an MD column file (energies.dat, temper.dat, …) on the left.')
          : loading ? skeleton(6)
          : emptyState('runs', 'No columns shown', 'Tick at least one column on the left.'));
      return;
    }
    plotBox.style.height = st.preset === 'screen' ? `${40 + PANEL_PX * fig.panels.length}px` : '';
    if (handle) {
      handle.update(fig);
    } else {
      plotBox.replaceChildren();
      handle = render(plotBox, fig, {
        onZoom: (panel, x0, x1) => {
          if (suppressZoom || panel !== 0) return;
          // the chart zoomed itself; hand the range to our own view state so the host recomputes stats and y limits
          const cur = view ?? data?.xFull;
          if (cur && Math.abs(cur[0] - x0) < 1e-12 && Math.abs(cur[1] - x1) < 1e-12) return;
          queueMicrotask(() => {
            suppressZoom = true;
            handle?.resetZoom();
            suppressZoom = false;
            setView(x0, x1);
          });
        },
        readout: (_p, x, y) => `${sig(x, 5)}, ${sig(y, 6)}`
      });
    }
  }

  // wheel zoom around the cursor (as the old .dat plot)
  plotBox.addEventListener('wheel', e => {
    if (!data || !handle) return;
    const svg = handle.element();
    const clip = svg.querySelector('clipPath rect');
    const vb = svg.viewBox.baseVal;
    const box = svg.getBoundingClientRect();
    const [a, b] = view ?? data.xFull;
    let c = (a + b) / 2;
    if (clip && vb && vb.width > 0 && box.width > 0) {
      const sx = box.width / vb.width;
      const left = box.left + Number(clip.getAttribute('x')) * sx;
      const w = Number(clip.getAttribute('width')) * sx;
      if (w > 0) {
        const t = (e.clientX - left) / w;
        if (t < 0 || t > 1) return;
        c = a + t * (b - a);
      }
    }
    e.preventDefault();
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    setView(c - (c - a) * k, c + (b - c) * k);
  }, { passive: false });
  plotBox.addEventListener('dblclick', () => {
    if (view) resetView();
  });
  plotBox.addEventListener('keydown', e => {
    if (e.key === 'Escape' && view) resetView();
  });

  // ---------------------------------------------------------------- side panels

  function renderHead(): void {
    const d = data;
    const sub = d
      ? `${count(d.totalRows)} rows · shown ${num(d.xRange[0])} – ${num(d.xRange[1])} ${unitOfX(d)} (${count(d.rows)} rows${d.full ? '' : ', decimated for drawing'})`
      : '';
    mount(headHost,
      h('div.geom-plot-controls', null,
        h('span.geom-dat-title', { title: d?.path ?? st.path }, d ? d.label : st.path ? st.path.split(/[\\/]/).pop() : ''),
        d?.partialTail ? badge('last line incomplete — ignored', 'warn') : null,
        d?.skipped ? badge(`${d.skipped} unreadable row${d.skipped === 1 ? '' : 's'} skipped`, 'warn') : null,
        view ? button('Full range', () => resetView(), { icon: 'zoomReset', variant: 'ghost' }) : null),
      h('div.geom-plot-meta', null, h('span.muted', null, sub), toolbar));
  }

  function renderColumns(): void {
    if (!data || !st.path) {
      mount(colHost, h('p.muted.geom-hint', null, 'Open a file to choose its columns.'));
      return;
    }
    const p = st.path;
    const hidden = new Set(st.hidden[p] ?? []);
    mount(colHost,
      h('div.geom-col-list', null, data.columns.slice(1).map((name, k) => {
        const j = k + 1;
        return h('label.geom-check', null,
          h('input', {
            type: 'checkbox', checked: !hidden.has(j),
            onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              const set = new Set(st.hidden[p] ?? []);
              if (on) set.delete(j); else set.add(j);
              st.hidden[p] = [...set];
              save();
              void load();
            }
          }),
          h('span', null, name));
      })),
      toggle('Least-squares line', st.fit, v => { st.fit = v; save(); draw(); }));
  }

  /** Plain number with up to 6 significant digits, no trailing zeros. */
  function num(v: number): string {
    return Number.isFinite(v) ? String(Number(v.toPrecision(6))).replace('-', '−') : '–';
  }

  function unitOfX(d: DatViewResult): string {
    return /\/\s*(.+)$/.exec(d.xLabel)?.[1] ?? '';
  }

  function renderStats(): void {
    if (!data || !data.series.length) {
      mount(statsHost, loading ? skeleton(3) : h('p.muted', null, 'Statistics of the visible range appear here.'));
      return;
    }
    const d = data;
    const xu = unitOfX(d);
    type Row = DatViewResult['series'][number];
    const columns: Column<Row>[] = [
      { key: 'name', label: 'Column' },
      { key: 'slope', label: `Slope per ${d.fs ? 'ps' : xu || 'x unit'}`, numeric: true, render: s => sig(s.stats.slope, 3), sortValue: s => s.stats.slope, title: d.fs ? 'Least-squares slope per ps (time column in fs)' : 'Least-squares slope per x unit' },
      { key: 'delta', label: 'End − start', numeric: true, render: s => sig(s.stats.delta, 3), sortValue: s => s.stats.delta },
      {
        key: 'mean', label: 'Mean ± sd', numeric: true, sortValue: s => s.stats.mean,
        render: s => {
          const dd = decimalsFor(s.stats.sd, 0, 10);
          return `${fixed(s.stats.mean, dd)} ± ${fixed(s.stats.sd, dd)}`;
        }
      },
      {
        key: 'range', label: 'Min … max', numeric: true, sortValue: s => s.stats.min,
        render: s => {
          const dd = decimalsFor(s.stats.sd, 0, 10);
          return `${fixed(s.stats.min, dd)} … ${fixed(s.stats.max, dd)}`;
        }
      },
      {
        key: 'tau', label: 'τ_int', numeric: true, sortValue: s => s.stats.tau, title: 'Integrated autocorrelation time (rows, and in x units)',
        render: s => h('span', null, sig(s.stats.tau, 3), d.dx > 0 && Number.isFinite(s.stats.tau) ? h('span.muted', null, ` (${sig(s.stats.tau * d.dx, 3)} ${xu})`) : null)
      },
      { key: 'sem', label: 'SEM (τ-corrected)', numeric: true, render: s => sig(s.stats.sem, 2), sortValue: s => s.stats.sem },
      {
        key: 'drift', label: '', sortValue: () => 0,
        render: s => {
          // drift vs noise: |slope · range| compared with the sd
          const span = (d.xRange[1] - d.xRange[0]) * s.stats.slopeX;
          const ratio = s.stats.sd > 0 ? Math.abs(span) / s.stats.sd : 0;
          return ratio > 1 ? badge('drifts', 'warn') : '';
        }
      }
    ];
    mount(statsHost, dataTable({ columns, rows: d.series, rowKey: s => String(s.index) }));
  }

  // ---------------------------------------------------------------- init

  async function init(): Promise<void> {
    draw();
    await loadList();
    if (st.path) void load();
  }
  const ready = init();

  return {
    el,
    navigate(args: GeomNavigateArgs) {
      if (!args.dat) return;
      const p = args.dat;
      void ready.then(async () => {
        if (!files.some(f => samePath(f.path, p))) {
          st.extra = [...new Set([...st.extra, p])];
          save();
          await loadList();
        }
        open(files.find(f => samePath(f.path, p))?.path ?? p);
      });
    },
    show() {
      if (handle) draw();
    },
    dispose() {
      disposed = true;
      handle?.dispose();
    }
  };
}
