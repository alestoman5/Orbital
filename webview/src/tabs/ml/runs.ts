// "Runs" view of the ML tab: the table of runs (polled every 2 s while one
// is running), the detail of the selected run (metrics, parity plot,
// learning curve, grid search, log) and the comparison of several runs.

import { figureToolbar, render, type ChartHandle, type Figure, type FigureSize, type Preset, type ToolbarHost } from '../../charts';
import type { CompareRow, RunDetail, RunState, RunSummary } from '../../../../src/studio/tabs/ml/types';
import {
  badge, button, busy, callout, card, codeBlock, dataTable, emptyState, iconButton, kpi, segmented, skeleton, type Column, type Tone
} from '../../ui/components';
import { fmt, h, mount } from '../../ui/dom';
import type { ViewContext } from '../../view';
import { compareBarsFigure, curveFigure, gridFigure, parityFigure, short } from './figures';

const POLL_MS = 2000;

export const STATE_TONE: Record<RunState, Tone> = {
  created: 'muted', starting: 'info', running: 'accent', done: 'ok', failed: 'bad', stopped: 'warn'
};

const active = (s: RunState) => s === 'running' || s === 'starting';

export interface RunsHost {
  ctx: ViewContext;
  duplicate(id: string): void;
  /** Selected run / compared runs changed (persist them). */
  selectionChanged(run: string | null, compare: string[]): void;
}

/** A chart card with the shared figure toolbar (export, Send to report). */
function chartCard(ctx: ViewContext, handles: ChartHandle[], o: { title: string; subtitle?: string; name: string; caption: string; figure: Figure; extra?: Node | null }): HTMLElement {
  const box = h('div.ml-chart');
  let layout: { preset: Preset; size?: FigureSize } = { preset: 'screen' };
  const fig = () => ({ ...o.figure, preset: layout.preset, size: layout.size ?? o.figure.size });
  let handle: ChartHandle | undefined;
  const toolbar = figureToolbar({
    figure: () => ({ ...o.figure, size: layout.size ?? o.figure.size }),
    name: o.name,
    host: ctx as unknown as ToolbarHost,
    initialSize: o.figure.size,
    caption: () => o.caption,
    onLayoutChange: (preset, size) => {
      layout = { preset, size };
      handle?.update(fig());
    }
  });
  requestAnimationFrame(() => {
    if (!box.isConnected) return;
    handle = render(box, fig());
    handles.push(handle);
  });
  return card({ title: o.title, subtitle: o.subtitle, class: 'ml-chart-card' }, toolbar, box, o.extra ?? null);
}

function progressBar(p: number | null, state: RunState): HTMLElement {
  const pct = Math.round(100 * Math.max(0, Math.min(1, p ?? 0)));
  return h('div.ml-progress', { title: `${pct} %`, class: state === 'starting' ? 'indeterminate' : '' }, h('span', { style: { width: `${state === 'starting' ? 30 : pct}%` } }));
}

function stateCell(r: { state: RunState; progress: number | null; step: string; error?: string | null }): HTMLElement {
  return h('div.ml-state', { title: r.error ?? r.step },
    badge(r.state, STATE_TONE[r.state]),
    active(r.state) ? progressBar(r.progress, r.state) : null);
}

const secs = (v: number | undefined) => (v === undefined ? '–' : v < 0.1 ? '<0.1' : fmt(v, v < 10 ? 1 : 0));
const num = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? '–' : short(Number(v.toPrecision(d))));

export function createRunsView(rh: RunsHost) {
  const { ctx } = rh;
  let runs: RunSummary[] | null = null;
  let listError = '';
  let selected: string | null = null;
  let compareIds = new Set<string>();
  let compareMode = false;
  let compareKind: 'bars' | 'curves' = 'bars';
  let detail: RunDetail | null = null;
  let detailSig = '';
  let detailError = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = false;
  let disposed = false;
  const handles: ChartHandle[] = [];
  let listSig = '';
  let logEl: HTMLElement | null = null;

  const tableBox = h('div');
  const detailBox = h('div.ml-detail');
  const compareBtn = button('Compare', () => { compareMode = true; renderDetail(true); renderTable(true); }, { icon: 'spectra', title: 'Compare the checked runs' });
  const refreshBtn = iconButton('refresh', 'Refresh', () => void poll(true));
  const csvBtn = button('Export CSV', () => void busy(csvBtn, async () => {
    const p = await ctx.rpc<string | undefined>('exportCsv');
    if (p) ctx.toast(`Saved ${p}`, 'success');
  }), { icon: 'download', variant: 'ghost', title: 'All finished runs as CSV (metrics and parameters)' });

  const el = h('div.stack', null,
    card({ title: 'Runs', subtitle: 'Stored in .orbital/ml_runs of the workspace', actions: [compareBtn, csvBtn, refreshBtn], flush: true }, tableBox),
    detailBox);

  const disposeCharts = () => {
    handles.forEach(c => c.dispose());
    handles.length = 0;
  };

  // --- table -------------------------------------------------------------------

  const columns: Column<RunSummary>[] = [
    {
      key: 'name', label: 'Run', render: r => h('div.ml-run-name', null, h('b', null, r.name || r.id), h('span.muted', null, r.name ? r.id : r.target)),
      sortValue: r => (r.name || r.id).toLowerCase()
    },
    { key: 'state', label: 'State', render: stateCell, sortValue: r => r.state, width: '130px' },
    { key: 'rep', label: 'Rep.', render: r => r.rep === 'precomputed' ? 'precomp.' : r.rep },
    { key: 'model', label: 'Model', render: r => `${r.model}${r.grid ? ' ⊞' : ''}`, title: '⊞ = grid search' },
    { key: 'n', label: 'Train / test', numeric: true, render: r => (r.n_train === null ? '–' : `${r.n_train} / ${r.n_test}`), sortValue: r => r.n_train ?? -1 },
    { key: 'mae', label: 'MAE', numeric: true, render: r => num(r.test?.mae), sortValue: r => r.test?.mae ?? Infinity, title: 'test MAE' },
    { key: 'rmse', label: 'RMSE', numeric: true, render: r => num(r.test?.rmse), sortValue: r => r.test?.rmse ?? Infinity, title: 'test RMSE' },
    { key: 'r2', label: 'R²', numeric: true, render: r => (r.test ? r.test.r2.toFixed(3) : '–'), sortValue: r => r.test?.r2 ?? -Infinity, title: 'test R²' },
    { key: 'cv', label: 'CV MAE', numeric: true, render: r => num(r.cv_mae), sortValue: r => r.cv_mae ?? Infinity },
    { key: 'created', label: 'Created', render: r => (r.created ?? '').replace('T', ' ').slice(0, 16), sortValue: r => r.created ?? '' },
    {
      key: 'actions', label: '', align: 'right', render: r => h('div.ml-row-actions', { onclick: (e: Event) => e.stopPropagation() },
        active(r.state) ? iconButton('stop', 'Stop', () => void stop(r.id)) : null,
        iconButton('copy', 'Duplicate as new run', () => rh.duplicate(r.id)),
        iconButton('trash', 'Delete', () => void remove(r.id)))
    }
  ];

  function renderTable(force = false): void {
    compareBtn.disabled = compareIds.size < 2;
    compareBtn.textContent = '';
    compareBtn.append(`Compare${compareIds.size >= 2 ? ` (${compareIds.size})` : ''}`);
    if (runs === null) {
      mount(tableBox, listError ? h('div.card-body', null, callout('bad', listError)) : h('div.card-body', null, skeleton(4)));
      return;
    }
    const sig = JSON.stringify([runs, selected, [...compareIds]]);
    if (!force && sig === listSig) return;
    listSig = sig;
    if (!runs.length) {
      mount(tableBox, h('div.card-body', null, emptyState('ml', 'No runs yet', 'Start one from the New run tab. Runs keep going when the panel is closed.')));
      return;
    }
    const t = dataTable<RunSummary>({
      columns, rows: runs, rowKey: r => r.id, maxHeight: 340,
      selectable: { selected: compareIds, onChange: s => { compareIds = s; rh.selectionChanged(selected, [...compareIds]); renderTable(true); } },
      onRowClick: r => select(r.id)
    });
    t.querySelectorAll('tbody tr').forEach((tr, i) => {
      // dataTable keeps the given row order (no initial sort)
      if (runs![i]?.id === selected && !compareMode) tr.classList.add('ml-current');
    });
    mount(tableBox, t);
  }

  // --- actions -----------------------------------------------------------------

  async function stop(id: string): Promise<void> {
    if (!(await ctx.studio('confirm', { message: `Stop run ${id}?`, action: 'Stop' }))) return;
    await busy(undefined, () => ctx.rpc('stop', { id }));
    void poll(true);
  }

  async function remove(id: string): Promise<void> {
    const r = runs?.find(x => x.id === id);
    const ok = await ctx.studio('confirm', {
      message: `Delete run ${r?.name ? `"${r.name}" (${id})` : id}?`, action: 'Delete',
      detail: active(r?.state ?? 'done') ? 'It is still running and will be stopped first. ' : 'Its folder with results and log is removed.'
    });
    if (!ok) return;
    await busy(undefined, () => ctx.rpc('remove', { id }));
    compareIds.delete(id);
    if (selected === id) {
      selected = null;
      detail = null;
    }
    rh.selectionChanged(selected, [...compareIds]);
    void poll(true);
  }

  function select(id: string | null): void {
    compareMode = false;
    if (selected !== id) {
      selected = id;
      detail = null;
      detailSig = '';
      detailError = '';
    }
    rh.selectionChanged(selected, [...compareIds]);
    renderTable(true);
    renderDetail(true);
    if (id) void loadDetail();
  }

  // --- detail --------------------------------------------------------------------

  async function loadDetail(): Promise<void> {
    if (!selected) return;
    const id = selected;
    try {
      const d = await ctx.rpc<RunDetail>('read', { id, logLines: 200 });
      if (id !== selected) return;
      detail = d;
      detailError = '';
    } catch (e) {
      detailError = e instanceof Error ? e.message : String(e);
    }
    renderDetail();
  }

  function renderDetail(force = false): void {
    if (compareMode) {
      void renderCompare();
      return;
    }
    if (!selected) {
      disposeCharts();
      logEl = null;
      mount(detailBox, runs && runs.length ? card({}, emptyState('ml', 'Select a run', 'Click a row to see its metrics, parity plot, learning curve and grid search. Check several rows to compare them.')) : null);
      detailSig = '';
      return;
    }
    if (detailError) {
      disposeCharts();
      mount(detailBox, callout('bad', detailError));
      return;
    }
    if (!detail) {
      if (force) {
        disposeCharts();
        mount(detailBox, card({}, skeleton(6)));
      }
      return;
    }
    const d = detail;
    const sig = JSON.stringify([d.id, d.status.state, d.status.step, d.status.progress, d.result, d.pred?.y_test?.length]);
    if (!force && sig === detailSig) {
      if (logEl) logEl.textContent = d.log || '(empty)';
      return;
    }
    detailSig = sig;
    disposeCharts();
    mount(detailBox, detailView(d));
  }

  function detailView(d: RunDetail): HTMLElement {
    const c = d.config;
    const r = d.result;
    const st = d.status;
    const target = c.data.column;
    const name = c.name || d.id;
    const fileBase = (c.name || d.id).replace(/[^\w.-]+/g, '_');
    const paramText = (p: Record<string, unknown>) => Object.entries(p).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.map(short).join(', ')}]` : short(v)}`).join(', ');

    const head = card({
      title: name,
      subtitle: `${d.id} · ${c.data.csv.split(/[\\/]/).pop()}:${target}${c.data.n_mol ? ` · first ${c.data.n_mol}` : ''}`,
      actions: [
        active(st.state) ? button('Stop', () => void stop(d.id), { icon: 'stop', variant: 'danger' }) : null,
        button('Duplicate', () => rh.duplicate(d.id), { icon: 'copy', title: 'New run with this configuration' }),
        d.pred ? button('Predictions CSV', e => void busy(e.currentTarget as HTMLButtonElement, async () => {
          const p = await ctx.rpc<string | undefined>('exportPredictions', { id: d.id });
          if (p) ctx.toast(`Saved ${p}`, 'success');
        }), { icon: 'download', variant: 'ghost' }) : null,
        iconButton('trash', 'Delete run', () => void remove(d.id))
      ].filter(Boolean) as HTMLElement[]
    },
    h('div.ml-detail-meta', null,
      stateCell({ state: st.state, progress: st.progress ?? null, step: st.step, error: st.error }),
      h('span.ml-step', null, st.state === 'failed' ? (st.error || st.step) : st.step),
      h('span.ml-chip', null, h('b', null, c.rep.name), c.rep.name === 'precomputed' ? ` ${String(c.rep.params.path ?? '').split(/[\\/]/).pop()}` : (Object.keys(c.rep.params).length ? ` ${paramText(c.rep.params)}` : '')),
      h('span.ml-chip', null, h('b', null, c.model.name), c.model.grid ? ' grid' : '', ` ${paramText(c.model.params)}`),
      h('span.ml-chip', null, `test ${c.split.test_size}, seed ${c.split.seed}${c.model.grid ? `, ${c.split.cv}-fold CV` : ''}, ${c.n_jobs} cores`)));

    const parts: (HTMLElement | null)[] = [head];
    if (st.state === 'failed') {
      parts.push(callout('bad', h('b', null, 'The run failed. '), st.error || st.step || 'See the log below.'));
    }
    if (r) {
      const tone = (a: number, b: number) => (b > 1.5 * a ? 'warn' : undefined);
      parts.push(h('div.ml-kpis', null,
        kpi('MAE test', num(r.test.mae), undefined, `train ${num(r.train.mae)}`, tone(r.train.mae, r.test.mae)),
        kpi('RMSE test', num(r.test.rmse), undefined, `train ${num(r.train.rmse)}`),
        kpi('R² test', r.test.r2.toFixed(3), undefined, `train ${r.train.r2.toFixed(3)}`, r.test.r2 > 0.9 ? 'ok' : r.test.r2 < 0.5 ? 'bad' : undefined),
        r.cv_mae !== undefined ? kpi('CV MAE', num(r.cv_mae), undefined, `${r.grid?.length ?? 0} combinations`) : null,
        kpi('Train / test', `${r.n_train} / ${r.n_test}`, undefined, `${r.n_features} features`),
        kpi('Time', secs(r.time_features_s + (r.time_search_s ?? 0) + r.time_fit_s), 's',
          `features ${secs(r.time_features_s)} s${r.time_search_s ? ` · search ${secs(r.time_search_s)} s` : ''} · fit ${secs(r.time_fit_s)} s`)));
      for (const w of r.warnings ?? []) {
        parts.push(callout('warn', w, w.includes('grid edge') ? h('span.muted', null, ' — the optimum may lie outside the searched range; widen the grid.') : null));
      }
      const charts: HTMLElement[] = [];
      if (d.pred) {
        charts.push(chartCard(ctx, handles, {
          title: 'Parity', subtitle: 'predicted vs reference', name: `${fileBase}-parity`,
          caption: `Parity plot of ${c.rep.name} + ${c.model.name} (${target}); test MAE ${short(r.test.mae)}, R² ${r.test.r2.toFixed(3)}.`,
          figure: parityFigure(d.pred, r, target)
        }));
      }
      if (r.curve?.length) {
        charts.push(chartCard(ctx, handles, {
          title: 'Learning curve', subtitle: 'test MAE vs training-set size', name: `${fileBase}-learning-curve`,
          caption: `Learning curve of ${c.rep.name} + ${c.model.name} (${target}).`, figure: curveFigure([{ curve: r.curve }])
        }));
      }
      const g = gridFigure(r);
      if (g) {
        charts.push(chartCard(ctx, handles, {
          title: 'Grid search', subtitle: `CV MAE · ${g.note}`, name: `${fileBase}-grid`,
          caption: `Grid search of ${c.model.name} on ${c.rep.name} (${target}): ${c.split.cv}-fold CV MAE.`, figure: g.figure
        }));
      }
      parts.push(h('div.ml-charts', null, charts));
      parts.push(card({ title: 'Best parameters', subtitle: r.fitted_kernel ? `fitted kernel: ${r.fitted_kernel}` : undefined },
        h('div.ml-kv', null, Object.entries(r.best_params).map(([k, v]) => h('div', null, h('span.muted', null, k), h('code', null, short(v)))))));
    } else if (active(st.state)) {
      parts.push(card({}, h('div.ml-wait', null, progressBar(st.progress ?? null, st.state), h('span.muted', null, `${st.step || 'starting'}…`))));
    }
    const logCode = codeBlock(d.log || '(empty)', { maxHeight: 260 });
    logEl = logCode.querySelector('pre');
    parts.push(card({
      title: 'Log', subtitle: active(st.state) ? 'refreshes every 2 s' : 'last 200 lines',
      actions: [button('Open', () => void ctx.rpc('openLog', { id: d.id }), { variant: 'ghost', icon: 'external' })]
    }, logCode));
    requestAnimationFrame(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
    return h('div.stack', null, parts);
  }

  // --- comparison ----------------------------------------------------------------

  async function renderCompare(): Promise<void> {
    disposeCharts();
    logEl = null;
    const ids = [...compareIds];
    mount(detailBox, card({}, skeleton(5)));
    let rows: CompareRow[];
    try {
      rows = await ctx.rpc<CompareRow[]>('compare', { ids });
    } catch (e) {
      mount(detailBox, callout('bad', e instanceof Error ? e.message : String(e)));
      return;
    }
    if (!compareMode) return;
    const withCurves = rows.filter(r => r.curve.length);
    const kind = compareKind === 'curves' && withCurves.length ? 'curves' : 'bars';
    const fig = kind === 'bars' ? compareBarsFigure(rows) : curveFigure(withCurves.map(r => ({ label: r.name, curve: r.curve })));
    const chart = chartCard(ctx, handles, {
      title: `Comparison of ${rows.length} runs`, subtitle: kind === 'bars' ? 'test MAE per run' : 'learning curves', name: kind === 'bars' ? 'ml-compare-mae' : 'ml-compare-curves',
      caption: kind === 'bars' ? 'Test MAE of the compared models.' : 'Learning curves of the compared models.', figure: fig
    });
    const switcher = segmented([{ value: 'bars', label: 'Test MAE' }, { value: 'curves', label: `Learning curves (${withCurves.length})` }], kind, v => {
      compareKind = v as 'bars' | 'curves';
      void renderCompare();
    });
    const table = dataTable<CompareRow>({
      columns: [
        { key: 'name', label: 'Run' }, { key: 'rep', label: 'Rep.' }, { key: 'model', label: 'Model' },
        { key: 'mae', label: 'Test MAE', numeric: true, render: r => num(r.test?.mae), sortValue: r => r.test?.mae ?? Infinity },
        { key: 'r2', label: 'R²', numeric: true, render: r => (r.test ? r.test.r2.toFixed(3) : '–'), sortValue: r => r.test?.r2 ?? -Infinity },
        { key: 'cv', label: 'CV MAE', numeric: true, render: r => num(r.cv_mae), sortValue: r => r.cv_mae ?? Infinity }
      ],
      rows, rowKey: r => r.id, initialSort: { key: 'mae', dir: 1 }, onRowClick: r => select(r.id)
    });
    mount(detailBox, h('div.stack', null,
      h('div.row.ml-compare-bar', null, switcher, h('span.ml-spacer'), button('Back to run', () => { compareMode = false; renderTable(true); renderDetail(true); }, { variant: 'ghost' })),
      h('div.ml-charts.single', null, chart),
      card({ title: 'Metrics', flush: true }, table)));
  }

  // --- polling -------------------------------------------------------------------

  async function poll(force = false): Promise<void> {
    clearTimeout(timer);
    try {
      runs = await ctx.rpc<RunSummary[]>('list');
      listError = '';
    } catch (e) {
      listError = e instanceof Error ? e.message : String(e);
    }
    if (disposed) return;
    if (selected && runs && !runs.some(r => r.id === selected)) {
      selected = null;
      detail = null;
    }
    renderTable(force);
    const cur = runs?.find(r => r.id === selected);
    if (selected && !compareMode && (force || !detail || (cur && (active(cur.state) || cur.state !== detail.status.state)))) {
      await loadDetail();
    } else if (force) {
      renderDetail(true);
    }
    if (visible && runs?.some(r => active(r.state))) {
      timer = setTimeout(() => void poll(), POLL_MS);
    }
  }

  return {
    el,
    show(): void {
      visible = true;
      void poll(true);
    },
    hide(): void {
      visible = false;
      clearTimeout(timer);
    },
    select(id: string | null): void {
      select(id);
    },
    compare(ids: string[]): void {
      compareIds = new Set(ids);
      compareMode = ids.length >= 2;
      renderTable(true);
      renderDetail(true);
    },
    restore(run: string | null, compare: string[]): void {
      selected = run;
      compareIds = new Set(compare);
    },
    refresh(): void {
      void poll(true);
    },
    dispose(): void {
      disposed = true;
      clearTimeout(timer);
      disposeCharts();
    }
  };
}
