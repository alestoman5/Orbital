// Webview side of the "calcs" studio tab: overview KPIs, one row per
// calculation set (status bar, times, method/basis), and a detail panel with
// the run_config, a time histogram and the list of problems.

import './calcs.css';
import type { TabInstance, TabView, ViewContext } from '../../view';
import type { CalcStatusName, GroupDetail, GroupRow, ProblemItem, ProblemsResult, ProgressEvent, ScanResult, TimeStats } from '../../../../src/studio/tabs/calcs/types';
import {
  Tone, badge, busy, button, callout, card, codeBlock, dataTable, emptyState, grid, icon, iconButton, kpi, segmented, select, skeleton, stackedBar
} from '../../ui/components';
import { Child, h, mount } from '../../ui/dom';
import { ChartHandle, Figure, FigureSize, figureToolbar, Preset, render } from '../../charts';
import { durationUnit, fmtDuration, fmtInt, fmtTime, pct, spin } from './format';

const STATUSES: CalcStatusName[] = ['ok', 'not converged', 'error', 'running', 'unreadable', 'not started'];
export const STATUS_TONE: Record<CalcStatusName, Tone> = {
  ok: 'ok', 'not converged': 'warn', error: 'bad', running: 'info', unreadable: 'accent', 'not started': 'muted'
};
const KIND: Record<GroupRow['kind'], { label: string; tone: Tone; title: string }> = {
  'pyscf-result': { label: 'PySCF', tone: 'accent', title: 'geom_NNNN/result.json set' },
  'orca-out': { label: 'ORCA', tone: 'info', title: 'ORCA .out files' },
  json: { label: 'JSON', tone: 'muted', title: 'JSON files with a "converged" key' }
};
const CONFIG_KEYS = ['method', 'basis', 'nstates', 'charge', 'mult', 'sampling', 'nsamples', 'reference', 'written'];
const PROBLEM_LIMIT = 2000;

interface Settings {
  globs: string[];
  exclude: string;
  workspaceFolders: string[];
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

export const view: TabView = {
  mount(root: HTMLElement, ctx: ViewContext): TabInstance {
    let scope = ctx.state<string>('scope', 'all');
    let extraFolders = ctx.state<string[]>('extraFolders', []);
    let selectedId = ctx.state<string | undefined>('selected', undefined);
    let problemStatus = ctx.state<CalcStatusName | 'all'>('problemStatus', 'all');
    let settings: Settings | undefined;
    let result: ScanResult | undefined;
    let loading = false;
    let queued = false;
    let stale = false;
    let visible = true;
    let error: string | undefined;
    let chart: ChartHandle | undefined;
    let pendingSelect: string | undefined;

    const status = h('div.calcs-status');
    const kpis = h('div.calcs-kpis');
    const groupsBox = h('div.calcs-groups');
    const detailBox = h('div.calcs-detail');
    root.append(status, kpis, groupsBox, detailBox);

    // --- header actions -------------------------------------------------------
    const scopeBox = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--muted)' } });
    const refreshBtn = iconButton('refresh', 'Rescan (re-list files)', () => void load(true));
    const addBtn = button('Add folder…', () => void addFolder(), { icon: 'folder', variant: 'ghost', title: 'Scan another folder, also outside the workspace' });
    ctx.setActions(scopeBox, addBtn, refreshBtn);

    function renderScope(): void {
      const opts = [{ value: 'all', label: 'Whole workspace' }];
      const seen = new Set(['all']);
      const add = (value: string, label: string, group?: string) => {
        if (!seen.has(value)) {
          seen.add(value);
          opts.push({ value, label, ...(group ? { group } : {}) } as { value: string; label: string });
        }
      };
      if ((settings?.workspaceFolders.length ?? 0) > 1) settings!.workspaceFolders.forEach(w => add(w, baseName(w), 'Workspace folders'));
      extraFolders.forEach(f => add(f, baseName(f), 'Added folders'));
      if (scope !== 'all') add(scope, baseName(scope), 'Folder');
      const sel = select(opts, scope, v => setScope(v));
      sel.title = scope === 'all' ? 'Every workspace folder and the added folders' : scope;
      sel.setAttribute('aria-label', 'Folder to scan');
      Object.assign(sel.style, { maxWidth: '260px', minWidth: '150px' });
      mount(scopeBox, icon('folder'), sel);
    }

    function setScope(v: string): void {
      scope = v;
      ctx.setState('scope', v);
      renderScope();
      result = undefined;
      void load();
    }

    async function addFolder(): Promise<void> {
      const dirs = await busy(addBtn, () => ctx.rpc<string[]>('addFolder'));
      if (!dirs?.length) return;
      extraFolders = [...new Set([...extraFolders, ...dirs])];
      ctx.setState('extraFolders', extraFolders);
      if (dirs.length === 1) {
        setScope(dirs[0]);
      } else {
        renderScope();
        void load(true);
      }
    }

    // --- loading --------------------------------------------------------------
    async function load(refresh = false): Promise<void> {
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      stale = false;
      spin(refreshBtn, true);
      if (!result) renderLoading();
      else renderStatus();
      const asked = scope;
      try {
        const res = await ctx.rpc<ScanResult>('scan', { scope, extraFolders, refresh });
        if (asked !== scope) {
          queued = true;
          return;
        }
        result = res;
        error = undefined;
        if (pendingSelect) {
          selectFolder(pendingSelect);
          pendingSelect = undefined;
        }
        renderAll();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        if (!result) renderError();
        else ctx.toast(error, 'error');
      } finally {
        loading = false;
        spin(refreshBtn, false);
        renderStatus();
        if (queued) {
          queued = false;
          void load();
        }
      }
    }

    function renderLoading(progress?: ProgressEvent): void {
      renderStatus(progress);
      mount(kpis, grid(150, Array.from({ length: 6 }, () => h('div.kpi.calcs-kpi-skel', null, skeleton(2)))));
      mount(groupsBox, card({ title: 'Calculation sets' }, skeleton(6)));
      mount(detailBox);
    }

    function renderError(): void {
      mount(kpis);
      mount(detailBox);
      mount(groupsBox, callout('bad', h('b', null, 'Scan failed. '), error ?? '', ' ', button('Retry', () => void load(true), { variant: 'ghost', icon: 'refresh' })));
    }

    function renderStatus(progress?: ProgressEvent): void {
      if (loading) {
        const frac = progress && progress.total ? progress.done / progress.total : undefined;
        const text = !progress ? 'Starting scan…'
          : progress.phase === 'listing' ? `Listing files (${(settings?.globs ?? []).join(', ') || 'calc globs'})…`
          : `Reading ${fmtInt(progress.done)} of ${fmtInt(progress.total)} files…`;
        mount(status, h('div.calcs-progress', null,
          h('span.calcs-spinner'), h('span', null, text),
          h('div.calcs-progress-bar', { class: frac === undefined ? 'indeterminate' : '' }, h('span', { style: { width: `${Math.round((frac ?? 0.3) * 100)}%` } }))));
        return;
      }
      if (!result) {
        mount(status);
        return;
      }
      const r = result;
      const bits: Child[] = [
        h('span', null, `${fmtInt(r.fileCount)} files`),
        h('span', null, plural(r.groups.length, 'set')),
        h('span', { title: r.cached ? 'no file changed since the last scan' : `listing ${(r.listMs / 1000).toFixed(1)} s, parsed ${fmtInt(r.parsed)}, reused ${fmtInt(r.reused)}` },
          r.cached ? 'up to date' : `scanned in ${(r.durationMs / 1000).toFixed(1)} s`),
        h('span', null, `at ${fmtTime(r.scannedAt).slice(11)}`),
        h('span.mono', { title: `globs: ${r.globs.join(', ')}${settings ? `\nexcluded: ${settings.exclude}` : ''}` }, r.globs.join('  ')),
        stale ? badge('files changed', 'warn') : null
      ];
      mount(status, h('div.calcs-meta', null, bits),
        r.skipped.length ? callout('warn', `Skipped ${r.skipped.length} added folder(s) — re-add them with "Add folder…": ${r.skipped.join(', ')}`) : null);
    }

    // --- overview -------------------------------------------------------------
    function renderAll(): void {
      renderStatus();
      renderKpis();
      renderGroups();
      if (selectedId && result?.groups.some(g => g.id === selectedId)) void loadDetail(selectedId);
      else {
        selectedId = undefined;
        mount(detailBox);
      }
    }

    function renderKpis(): void {
      const t = result!.totals;
      const c = t.counts;
      const bad = c.error + c.unreadable;
      mount(kpis, grid(150,
        kpi('Calculations', fmtInt(t.total), undefined, plural(result!.groups.length, 'set')),
        kpi('Converged', pct(c.ok, t.total), '%', `${fmtInt(c.ok)} ok`, t.total && c.ok === t.total ? 'ok' : undefined),
        kpi('Not converged', fmtInt(c['not converged']), undefined, c['not started'] ? `${fmtInt(c['not started'])} not started` : 'SCF / optimization', c['not converged'] ? 'warn' : undefined),
        kpi('Errors / unreadable', fmtInt(bad), undefined, `${fmtInt(c.error)} errors · ${fmtInt(c.unreadable)} unreadable`, bad ? 'bad' : undefined),
        kpi('Running', fmtInt(c.running), undefined, 'no termination banner yet', c.running ? 'info' : undefined),
        kpi('Median time', fmtDuration(t.medianTimeS), undefined, t.maxTimeS !== undefined ? `max ${fmtDuration(t.maxTimeS)}` : 'no timed results')));
    }

    function statusCell(r: GroupRow): HTMLElement {
      const segs = STATUSES.map(s => ({ value: r.counts[s], tone: STATUS_TONE[s], label: s }));
      return h('div.calcs-statuscell', null, stackedBar(segs),
        h('div.calcs-counts', null, STATUSES.filter(s => r.counts[s] > 0).map(s =>
          h('span', { class: `tone-${STATUS_TONE[s]}`, title: s }, h('i'), `${fmtInt(r.counts[s])} ${s === 'ok' ? 'ok' : s}`))));
    }

    let tableHost: HTMLElement | undefined;
    function markSelected(): void {
      tableHost?.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
      if (!selectedId) return;
      tableHost?.querySelectorAll<HTMLElement>('[data-gid]').forEach(el => {
        if (el.dataset.gid === selectedId) el.closest('tr')?.classList.add('selected');
      });
    }

    function renderGroups(): void {
      const r = result!;
      if (r.groups.length === 0) {
        mount(groupsBox, card({ title: 'Calculation sets' }, emptyState('calcs', 'No calculations found',
          `Nothing matching ${r.globs.join(', ')} in ${r.scope === 'all' ? 'the workspace' : r.scope}. Change orcaInp.studio.calcGlobs or add a folder.`,
          button('Add folder…', () => void addFolder(), { icon: 'folder' }))));
        return;
      }
      const table = dataTable<GroupRow>({
        rows: r.groups,
        rowKey: g => g.id,
        filterText: g => `${g.label} ${KIND[g.kind].label} ${g.method ?? ''} ${g.basis ?? ''}`,
        filterPlaceholder: 'Filter sets by path, kind, method, basis…',
        onRowClick: g => select_(g.id, true),
        maxHeight: 460,
        columns: [
          {
            key: 'label', label: 'Set', render: g => h('div.calcs-setcell', { dataset: { gid: g.id }, title: g.dir },
              badge(KIND[g.kind].label, KIND[g.kind].tone), labelEl(g.label))
          },
          { key: 'status', label: 'Status', width: '30%', render: statusCell, sortValue: g => (g.total ? g.counts.ok / g.total : 0) },
          { key: 'ok', label: 'OK / total', numeric: true, sortValue: g => g.counts.ok, render: g => h('span', null, fmtInt(g.counts.ok), h('span.muted', null, ` / ${fmtInt(g.total)}`)) },
          { key: 'medianTimeS', label: 'Median', numeric: true, title: 'median wall time of the ok items', sortValue: g => g.medianTimeS ?? -1, render: g => fmtDuration(g.medianTimeS) },
          { key: 'maxTimeS', label: 'Max', numeric: true, sortValue: g => g.maxTimeS ?? -1, render: g => fmtDuration(g.maxTimeS) },
          ...(!r.groups.some(g => g.method || g.basis) ? [] : [{
            key: 'method', label: 'Method / basis', sortValue: (g: GroupRow) => `${g.method ?? '~'} ${g.basis ?? ''}`,
            render: (g: GroupRow) => (g.method || g.basis ? h('span.mono', null, [g.method, g.basis].filter(Boolean).join(' / ')) : h('span.muted', null, '–'))
          }])
        ]
      });
      tableHost = table;
      new MutationObserver(markSelected).observe(table, { childList: true, subtree: true });
      mount(groupsBox, card({ title: 'Calculation sets', subtitle: `${plural(r.groups.length, 'set')} · click a row for details`, flush: false }, table));
      markSelected();
    }

    // --- detail ---------------------------------------------------------------
    function select_(id: string, scroll: boolean): void {
      selectedId = id;
      ctx.setState('selected', id);
      markSelected();
      void loadDetail(id, scroll);
    }

    let detailSeq = 0;
    async function loadDetail(id: string, scroll = false): Promise<void> {
      const seq = ++detailSeq;
      if (!detailBox.firstChild || detailBox.dataset.id !== id) {
        mount(detailBox, card({ title: result?.groups.find(g => g.id === id)?.label ?? 'Loading…' }, skeleton(5)));
      }
      detailBox.dataset.id = id;
      if (scroll) requestAnimationFrame(() => detailBox.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      try {
        const d = await ctx.rpc<GroupDetail>('group', { id, status: problemStatus, limit: PROBLEM_LIMIT });
        if (seq === detailSeq) renderDetail(d);
      } catch (e) {
        if (seq === detailSeq) mount(detailBox, callout('bad', e instanceof Error ? e.message : String(e)));
      }
    }

    function renderDetail(d: GroupDetail): void {
      chart?.dispose();
      chart = undefined;
      const r = d.row;
      const nonOk = r.total - r.counts.ok;
      const copyBtn = button('Copy failed list', () => void copyFailed(r, copyBtn), {
        icon: 'copy', variant: 'secondary', disabled: nonOk === 0,
        title: 'Names of the non-ok items (current status filter), one per line — to rerun them'
      });
      const head = card({
        title: r.label,
        subtitle: `${KIND[r.kind].title} · ${r.dir}`,
        actions: [copyBtn, iconButton('close', 'Close details', () => { selectedId = undefined; ctx.setState('selected', undefined); markSelected(); mount(detailBox); })]
      }, h('div.calcs-detail-bar', null, statusCell(r)));
      const cols = h('div.calcs-detail-grid', null, configCard(d), timesCard(d.times, r));
      mount(detailBox, head, cols, problemsCard(d.row, d.problems));
    }

    function configCard(d: GroupDetail): HTMLElement {
      const cfg = d.config;
      if (!cfg) {
        return card({ title: 'run_config.json' }, emptyState('file', 'No run_config.json', 'Not found in this folder or its parent. NEA runs started from Orbital write one.'));
      }
      const fmtVal = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
      const main = CONFIG_KEYS.filter(k => cfg[k] !== undefined && cfg[k] !== null);
      const rest = Object.keys(cfg).filter(k => !CONFIG_KEYS.includes(k) && k !== 'command');
      const kv = (k: string) => [h('dt', null, k), h('dd.mono', null, fmtVal(cfg[k]))];
      return card({ title: 'run_config.json', subtitle: main.length ? undefined : 'no standard keys' },
        h('dl.calcs-kv', null, main.map(kv)),
        typeof cfg.command === 'string' ? h('div.calcs-cmd', null, h('div.field-label', null, 'command'), codeBlock(cfg.command, { maxHeight: 160 })) : null,
        rest.length ? h('details.calcs-more', null, h('summary', null, `${rest.length} more keys`), h('dl.calcs-kv', null, rest.map(kv))) : null);
    }

    function timesCard(t: TimeStats | undefined, r: GroupRow): HTMLElement {
      if (!t) {
        return card({ title: 'Wall time' }, emptyState('calcs', 'No timings', r.counts.ok ? 'The ok results carry no time_*_s / TOTAL RUN TIME.' : 'No calculation finished ok yet.'));
      }
      const { unit, scale } = durationUnit(t.median);
      let preset: Preset = 'screen';
      let size: FigureSize = { widthIn: 3.25, heightIn: 2.2 };
      const figure = (): Figure => ({
        preset,
        panels: [{
          x: { label: `t / ${unit}`, zero: false },
          y: { label: 'count', format: v => (Number.isInteger(v) ? String(v) : '') },
          legend: 'none',
          series: [
            { type: 'histogram', edges: t.edges.map(e => e / scale), values: t.values, style: 'filled', label: 'ok' },
            { type: 'vline', value: t.median / scale, dash: 'dashed', label: 'median' }
          ]
        }],
        size
      });
      const box = h('div.calcs-chart');
      const tb = figureToolbar({ figure, name: `times-${r.label.replace(/[^\w.-]+/g, '_')}`, host: ctx, caption: () => `Wall-time distribution of ${t.n} converged calculations (${r.label}).`,
        onLayoutChange: (p, sz) => {
          preset = p;
          size = sz;
          chart?.update(figure());
        }
      });
      requestAnimationFrame(() => {
        chart = render(box, figure(), { readout: (_p, x, y) => `${x.toPrecision(3)} ${unit}, ${Math.round(y)}` });
      });
      return card({ title: 'Wall time', subtitle: `${fmtInt(t.n)} ok · median ${fmtDuration(t.median)} · p10–p90 ${fmtDuration(t.p10)}–${fmtDuration(t.p90)} · max ${fmtDuration(t.max)}` }, tb, box);
    }

    function problemsCard(r: GroupRow, p: ProblemsResult): HTMLElement {
      const present = STATUSES.filter(s => s !== 'ok' && r.counts[s] > 0);
      const nonOk = r.total - r.counts.ok;
      if (nonOk === 0) {
        return card({ title: 'Problems' }, callout('ok', `All ${fmtInt(r.total)} calculations finished ok.`));
      }
      const filter = segmented(
        [{ value: 'all', label: `All (${fmtInt(nonOk)})` }, ...present.map(s => ({ value: s, label: `${s} (${fmtInt(r.counts[s])})` }))],
        problemStatus === 'all' || present.includes(problemStatus) ? problemStatus : 'all',
        v => {
          problemStatus = v as CalcStatusName | 'all';
          ctx.setState('problemStatus', problemStatus);
          void loadDetail(r.id);
        });
      const table = dataTable<ProblemItem>({
        rows: p.items,
        rowKey: i => i.path,
        filterText: i => `${i.name} ${i.status} ${i.detail ?? ''}`,
        filterPlaceholder: 'Filter by name, status or detail…',
        maxHeight: 420,
        columns: [
          { key: 'name', label: 'Name', render: i => h('span.mono', { title: i.path }, i.name) },
          { key: 'status', label: 'Status', render: i => badge(i.status, STATUS_TONE[i.status]) },
          { key: 'detail', label: 'Detail', render: i => (i.detail ? h('span.calcs-detailtext', { title: i.detail }, i.detail) : h('span.muted', null, defaultDetail(i.status))) },
          {
            key: 'open', label: '', align: 'right', sortValue: i => i.path,
            render: i => button(/run\.log$/i.test(i.path) ? 'run.log' : 'Open', () => void ctx.studio('openFile', { path: i.path, beside: true }), { variant: 'ghost', icon: 'external', title: i.path })
          }
        ]
      });
      const capped = p.total > p.items.length;
      return card({ title: 'Problems', subtitle: `${fmtInt(p.total)} item${p.total === 1 ? '' : 's'}`, actions: [filter] },
        capped ? callout('info', `Showing the first ${fmtInt(p.items.length)} of ${fmtInt(p.total)}. "Copy failed list" copies all of them.`) : null,
        table);
    }

    async function copyFailed(r: GroupRow, btn: HTMLButtonElement): Promise<void> {
      const text = await busy(btn, () => ctx.rpc<string>('failedList', { id: r.id, status: problemStatus }));
      if (text === undefined) return;
      await navigator.clipboard.writeText(text);
      const n = text ? text.split('\n').length : 0;
      ctx.toast(`Copied ${fmtInt(n)} name${n === 1 ? '' : 's'}`, 'success');
    }

    function selectFolder(folder: string): void {
      const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
      const f = norm(folder);
      const hits = result?.groups.filter(g => norm(g.dir) === f || norm(g.dir).startsWith(`${f}/`)) ?? [];
      if (hits.length) {
        selectedId = hits[0].id;
        ctx.setState('selected', selectedId);
      }
    }

    // --- events ---------------------------------------------------------------
    const offs = [
      ctx.on('progress', (p: ProgressEvent) => {
        if (loading) renderStatus(p);
      }),
      ctx.on('changed', () => {
        stale = true;
        if (visible && !loading) void load();
        else renderStatus();
      })
    ];

    renderScope();
    void ctx.rpc<Settings>('settings').then(s => {
      settings = s;
      renderScope();
    }).catch(() => undefined);
    void load();

    return {
      onNavigate(args: unknown) {
        const folder = (args as { folder?: unknown } | undefined)?.folder;
        if (typeof folder !== 'string' || !folder) return;
        pendingSelect = folder;
        if (scope !== folder) {
          scope = folder;
          ctx.setState('scope', folder);
          renderScope();
          result = undefined;
        }
        void load();
      },
      onShow() {
        visible = true;
        if (stale) void load();
      },
      onHide() {
        visible = false;
      },
      dispose() {
        offs.forEach(o => o());
        chart?.dispose();
      }
    };
  }
};

/** Path label: parent folders muted, last part strong. */
function labelEl(label: string): HTMLElement {
  const i = label.lastIndexOf('/');
  return h('span.calcs-label', null, i > 0 ? h('span.calcs-label-dir', null, label.slice(0, i + 1)) : null, label.slice(i + 1));
}

const plural = (n: number, w: string) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;

function defaultDetail(s: CalcStatusName): string {
  switch (s) {
    case 'unreadable': return 'empty or invalid file';
    case 'not started': return 'no result yet';
    case 'running': return 'no termination banner yet';
    case 'not converged': return 'not converged';
    default: return '–';
  }
}
