// Webview side of the "runs" studio tab: machine load, running calculation
// processes (with stop / kill), the SLURM queue when there is one, and the
// newest log files with a live tail.

import './runs.css';
import type { TabInstance, TabView, ViewContext } from '../../view';
import type { LogFile, LogsResult, MachineInfo, ProcRow, ProcessesResult, QueueJob, QueueResult, TailResult } from '../../../../src/studio/tabs/runs/types';
import {
  Tone, badge, busy, button, callout, card, dataTable, emptyState, grid, iconButton, kpi, skeleton, subTabs, textInput, toggle
} from '../../ui/components';
import { Child, debounce, h, mount } from '../../ui/dom';
import { ChartHandle, Figure, render } from '../../charts';
import { fmtAge, fmtBytes, fmtDuration, fmtInt, fmtTime, spin } from '../calcs/format';

type Sub = 'procs' | 'logs';
const PROC_REFRESH_MS = 5000;
const LOG_POLL_MS = 2000;
const LOG_LIST_REFRESH_MS = 30000;
const HISTORY = 60;

const SLURM_TONE: Record<string, Tone> = { RUNNING: 'ok', PENDING: 'warn', COMPLETING: 'info', FAILED: 'bad', CANCELLED: 'muted', TIMEOUT: 'bad', SUSPENDED: 'muted' };

/** "[[dd-]hh:]mm:ss" like ps. */
function fmtElapsed(s: number | undefined): string {
  if (s === undefined) return '–';
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d ? `${d}-` : ''}${d || hh ? `${p(hh)}:` : ''}${p(mm)}:${p(ss)}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const view: TabView = {
  mount(root: HTMLElement, ctx: ViewContext): TabInstance {
    let sub = ctx.state<Sub>('sub', 'procs');
    let visible = true;
    let procs: ProcessesResult | undefined;
    let machine: MachineInfo | undefined;
    let queue: QueueResult | undefined;
    let logs: LogsResult | undefined;
    let logsError: string | undefined;
    let selectedLog = ctx.state<string | undefined>('log', undefined);
    let tailLines = 200;
    let tail: TailResult | undefined;
    let tailError: string | undefined;
    let follow = ctx.state<boolean>('follow', true);
    let search = '';
    let autoRefresh = ctx.state<boolean>('auto', true);
    const terminated = new Set<number>();
    const history: { t: number; cpu: number; mem: number }[] = [];
    let chart: ChartHandle | undefined;
    let procTimer: ReturnType<typeof setInterval> | undefined;
    let tailTimer: ReturnType<typeof setInterval> | undefined;
    let listTimer: ReturnType<typeof setInterval> | undefined;
    let procBusy = false;
    let tailBusy = false;
    let lastUpdate = 0;

    const tabs = h('div');
    const renderTabs = () => mount(tabs, subTabs<Sub>([{ value: 'procs', label: 'Processes' }, { value: 'logs', label: 'Logs' }], sub, v => {
      sub = v;
      ctx.setState('sub', v);
      showSub();
    }));
    renderTabs();
    const procView = h('div.runs-procs');
    const logView = h('div.runs-logs');
    root.append(tabs, procView, logView);

    const updated = h('span', { style: { fontSize: '11px', color: 'var(--muted)', whiteSpace: 'nowrap' } });
    const refreshBtn = iconButton('refresh', 'Refresh now', () => void (sub === 'procs' ? refreshProcs() : refreshLogs(true)));
    ctx.setActions(updated, refreshBtn);

    // --- processes ------------------------------------------------------------
    const machineBox = h('div.runs-machine');
    const queueBox = h('div');
    const procBox = h('div');
    procView.append(machineBox, queueBox, procBox);
    mount(machineBox, card({ title: 'Machine' }, skeleton(2)));
    mount(procBox, card({ title: 'Processes' }, skeleton(5)));

    async function refreshProcs(): Promise<void> {
      if (procBusy) return;
      procBusy = true;
      spin(refreshBtn, true);
      try {
        const [m, p, q] = await Promise.all([
          ctx.rpc<MachineInfo>('machine'),
          ctx.rpc<ProcessesResult>('processes'),
          queue && !queue.available ? Promise.resolve(queue) : ctx.rpc<QueueResult>('queue')
        ]);
        machine = m;
        procs = p;
        queue = q;
        history.push({ t: Date.now(), cpu: m.cpuPercent, mem: (100 * m.memUsed) / m.memTotal });
        if (history.length > HISTORY) history.shift();
        for (const pid of [...terminated]) if (!p.rows.some(r => r.pid === pid)) terminated.delete(pid);
        lastUpdate = Date.now();
        renderProcs();
      } catch (e) {
        mount(procBox, callout('bad', `Could not list processes: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        procBusy = false;
        spin(refreshBtn, false);
        renderUpdated();
      }
    }

    function renderUpdated(): void {
      updated.textContent = lastUpdate ? `updated ${fmtTime(lastUpdate).slice(11)}${autoRefresh && sub === 'procs' ? ' · every 5 s' : ''}` : '';
    }

    function renderProcs(): void {
      renderMachine();
      renderQueue();
      renderProcTable();
    }

    function historyFigure(): Figure {
      const now = Date.now();
      const x = history.map(s => (s.t - now) / 60000);
      return {
        panels: [{
          x: { label: 't / min', max: 0, min: Math.min(-1, x[0] ?? -1) },
          y: { label: 'use / %', min: 0, max: 100 },
          legend: 'top-left',
          series: [
            { type: 'line', x, y: history.map(s => s.cpu), label: 'CPU', markers: history.length < 3 },
            { type: 'line', x, y: history.map(s => s.mem), label: 'memory', dash: 'dashed' }
          ]
        }]
      };
    }

    function renderMachine(): void {
      const m = machine!;
      const memPct = (100 * m.memUsed) / m.memTotal;
      const load = m.loadavg;
      const loadTone: Tone | undefined = load ? (load[0] > m.cores ? 'bad' : load[0] > 0.8 * m.cores ? 'warn' : undefined) : undefined;
      const cpuTone: Tone | undefined = m.cpuPercent > 90 ? 'bad' : m.cpuPercent > 70 ? 'warn' : undefined;
      const kpis = grid(140,
        kpi('CPU', m.cpuPercent.toFixed(0), '%', `${m.cores} cores`, cpuTone),
        load ? kpi('Load average', load[0].toFixed(2), undefined, `${load[1].toFixed(2)} · ${load[2].toFixed(2)} (5 / 15 min)`, loadTone) : null,
        kpi('Memory', fmtBytes(m.memUsed).split(' ')[0], fmtBytes(m.memUsed).split(' ')[1], `${memPct.toFixed(0)} % of ${fmtBytes(m.memTotal)}`, memPct > 90 ? 'bad' : memPct > 75 ? 'warn' : undefined),
        kpi('Calculations', fmtInt(procs?.rows.length ?? 0), undefined, procs ? `matching of ${fmtInt(procs.scanned)} processes` : '', (procs?.rows.length ?? 0) > 0 ? 'info' : undefined));
      const chartBox = h('div.runs-history');
      mount(machineBox,
        card({ title: m.hostname, subtitle: `${m.platform} ${m.release} · ${m.cpuModel} · up ${fmtDuration(m.uptimeS)} · ${m.user}` }, kpis),
        card({ title: 'Load history', subtitle: 'last 5 min, while this tab is open' }, chartBox));
      chart?.dispose();
      requestAnimationFrame(() => {
        if (chartBox.isConnected) chart = render(chartBox, historyFigure(), { interactive: false });
      });
    }

    function renderQueue(): void {
      if (!queue?.available) {
        mount(queueBox);
        return;
      }
      const q = queue;
      const body: Child = q.error ? callout('warn', `squeue: ${q.error}`)
        : q.jobs.length === 0 ? h('p.muted', null, `No jobs of ${q.user} in the queue.`)
        : dataTable<QueueJob>({
          rows: q.jobs,
          rowKey: j => j.jobid,
          maxHeight: 280,
          columns: [
            { key: 'jobid', label: 'Job', numeric: true },
            { key: 'name', label: 'Name', render: j => h('span.mono', null, j.name) },
            { key: 'state', label: 'State', render: j => badge(j.state.toLowerCase(), SLURM_TONE[j.state] ?? 'muted') },
            { key: 'time', label: 'Time', numeric: true, render: j => h('span', { title: `limit ${j.timeLimit}` }, j.time) },
            { key: 'nodes', label: 'Nodes', numeric: true },
            { key: 'reason', label: 'Nodelist / reason', render: j => h('span.mono.muted', null, j.reason) }
          ]
        });
      mount(queueBox, card({ title: 'SLURM queue', subtitle: `squeue -u ${q.user} · ${q.jobs.length} job${q.jobs.length === 1 ? '' : 's'}` }, body));
    }

    function renderProcTable(): void {
      const p = procs!;
      const actions = [toggle('Auto-refresh', autoRefresh, v => {
        autoRefresh = v;
        ctx.setState('auto', v);
        schedule();
        renderUpdated();
      }, { hint: 'Refresh every 5 s while this tab is visible' })];
      const notes: Child[] = [
        p.error ? callout('bad', `Could not list processes: ${p.error}`) : null,
        p.patternError ? callout('warn', `orcaInp.studio.processPattern is not a valid regular expression (${p.patternError}); using the default.`) : null
      ];
      const showUser = p.rows.some(r => r.user);
      const showThreads = p.rows.some(r => r.threads !== undefined);
      const table = p.rows.length === 0
        ? emptyState('runs', 'No calculations running', `None of the ${fmtInt(p.scanned)} processes matches the process pattern (orcaInp.studio.processPattern).`)
        : dataTable<ProcRow>({
          rows: p.rows,
          rowKey: r => String(r.pid),
          filterText: r => `${r.pid} ${r.user ?? ''} ${r.command}`,
          filterPlaceholder: 'Filter by PID, user or command…',
          initialSort: { key: 'cpu', dir: -1 },
          columns: [
            { key: 'pid', label: 'PID', numeric: true },
            ...(showUser ? [{ key: 'user', label: 'User' }] : []),
            { key: 'cpu', label: '%CPU', numeric: true, title: p.cpuNote, render: r => h('span', { class: r.cpu >= 50 ? 'runs-hot' : '' }, r.cpu.toFixed(1)) },
            { key: 'mem', label: '%MEM', numeric: true, render: r => r.mem.toFixed(1) },
            { key: 'rssBytes', label: 'RSS', numeric: true, sortValue: r => r.rssBytes ?? 0, render: r => fmtBytes(r.rssBytes) },
            ...(showThreads ? [{ key: 'threads', label: 'Threads', numeric: true, sortValue: (r: ProcRow) => r.threads ?? 0, render: (r: ProcRow) => String(r.threads ?? '–') }] : []),
            { key: 'elapsedS', label: 'Elapsed', numeric: true, sortValue: r => r.elapsedS ?? 0, render: r => fmtElapsed(r.elapsedS) },
            { key: 'command', label: 'Command', width: '45%', render: r => h('div.runs-cmd', { title: r.command }, r.command) },
            {
              key: 'kill', label: '', align: 'right', sortValue: r => r.pid,
              render: r => terminated.has(r.pid)
                ? button('Force kill', e => { e.stopPropagation(); void kill(r, 'KILL'); }, { variant: 'danger', icon: 'close', title: 'SIGKILL (Windows: taskkill /T /F)' })
                : button('Stop', e => { e.stopPropagation(); void kill(r, 'TERM'); }, { variant: 'ghost', icon: 'stop', title: 'SIGTERM (Windows: taskkill /T)' })
            }
          ]
        });
      mount(procBox, card({ title: 'Processes', subtitle: `${p.rows.length} matching · %CPU ${p.cpuNote} · listed in ${p.durationMs} ms`, actions }, notes, table));
    }

    async function kill(r: ProcRow, signal: 'TERM' | 'KILL'): Promise<void> {
      const win = navigator.userAgent.includes('Windows') || procs?.platform === 'win32';
      const ok = await ctx.studio('confirm', {
        message: `${signal === 'KILL' ? 'Force kill' : 'Stop'} ${r.name} (PID ${r.pid})?`,
        action: signal === 'KILL' ? 'Force kill' : 'Stop',
        detail: `${r.command.slice(0, 400)}\n\n${signal === 'KILL'
          ? (win ? 'taskkill /T /F ends the process tree immediately.' : 'SIGKILL ends the process immediately; it cannot clean up.')
          : (win ? 'taskkill /T asks the process tree to close.' : 'SIGTERM asks the process to exit. If it keeps running, use Force kill.')}`
      });
      if (!ok) return;
      const res = await busy(undefined, () => ctx.rpc<{ ok: boolean; message: string }>('kill', { pid: r.pid, signal }));
      if (!res) return;
      ctx.toast(res.message, res.ok ? 'success' : 'error');
      // Offer Force kill next, also when a graceful stop was refused (Windows console programs).
      if (signal === 'TERM') terminated.add(r.pid);
      setTimeout(() => void refreshProcs(), 1200);
    }

    // --- logs -----------------------------------------------------------------
    const listBox = h('div.runs-loglist');
    const viewerBox = h('div.runs-viewer');
    logView.append(listBox, viewerBox);

    async function refreshLogs(manual = false): Promise<void> {
      if (!logs) mount(listBox, card({ title: 'Log files' }, skeleton(8)));
      if (manual) spin(refreshBtn, true);
      try {
        logs = await ctx.rpc<LogsResult>('logs');
        logsError = undefined;
        lastUpdate = Date.now();
      } catch (e) {
        logsError = e instanceof Error ? e.message : String(e);
      } finally {
        if (manual) spin(refreshBtn, false);
      }
      renderLogList();
      renderUpdated();
      if (selectedLog && !tail) void loadTail();
      else if (!selectedLog) renderViewer();
    }

    let logTable: HTMLElement | undefined;
    function markLog(): void {
      logTable?.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
      logTable?.querySelectorAll<HTMLElement>('[data-path]').forEach(el => {
        if (el.dataset.path === selectedLog) el.closest('tr')?.classList.add('selected');
      });
    }

    function renderLogList(): void {
      if (logsError) {
        mount(listBox, card({ title: 'Log files' }, callout('bad', logsError)));
        return;
      }
      const l = logs!;
      if (l.files.length === 0) {
        mount(listBox, card({ title: 'Log files' }, emptyState('file', 'No log files', `Nothing matches ${l.globs.join(', ')} (excluding ${l.exclude.join(', ') || 'nothing'}). See orcaInp.studio.logGlobs.`)));
        return;
      }
      const now = Date.now();
      logTable = dataTable<LogFile>({
        rows: l.files,
        rowKey: f => f.path,
        filterText: f => f.rel,
        filterPlaceholder: 'Filter log files…',
        onRowClick: f => selectLog(f.path),
        initialSort: { key: 'mtimeMs', dir: -1 },
        maxHeight: 640,
        columns: [
          {
            key: 'rel', label: 'File', render: f => {
              const i = f.rel.lastIndexOf('/');
              return h('div.runs-logname', { dataset: { path: f.path }, title: f.path },
                h('span.runs-logbase', null, f.rel.slice(i + 1)), i > 0 ? h('span.runs-logdir', null, h('span', null, f.rel.slice(0, i))) : null);
            }
          },
          { key: 'size', label: 'Size', numeric: true, render: f => fmtBytes(f.size) },
          { key: 'mtimeMs', label: 'Modified', numeric: true, render: f => h('span', { title: fmtTime(f.mtimeMs), class: now - f.mtimeMs < 120000 ? 'runs-fresh' : '' }, fmtAge(now - f.mtimeMs)) }
        ]
      });
      new MutationObserver(markLog).observe(logTable, { childList: true, subtree: true });
      mount(listBox, card({
        title: 'Log files',
        subtitle: l.total > l.files.length ? `${l.files.length} newest of ${fmtInt(l.total)}` : `${l.files.length} file${l.files.length === 1 ? '' : 's'}`
      }, logTable));
      markLog();
    }

    function selectLog(p: string): void {
      if (p !== selectedLog) {
        tailLines = 200;
        tail = undefined;
        search = '';
      }
      selectedLog = p;
      ctx.setState('log', p);
      markLog();
      void loadTail();
    }

    async function loadTail(poll = false): Promise<void> {
      if (!selectedLog || tailBusy) return;
      tailBusy = true;
      const asked = selectedLog;
      if (!poll && !tail) renderViewer(true);
      try {
        const since = poll && tail ? { size: tail.size, mtimeMs: tail.mtimeMs } : undefined;
        const res = await ctx.rpc<TailResult>('tail', { path: asked, lines: tailLines, since });
        if (asked !== selectedLog) return;
        tailError = undefined;
        if (res.unchanged) return;
        const grew = !!tail && res.size !== tail.size;
        tail = res;
        renderViewer(false, poll && grew);
      } catch (e) {
        if (asked !== selectedLog) return;
        tailError = e instanceof Error ? e.message : String(e);
        renderViewer();
      } finally {
        tailBusy = false;
      }
    }

    let pre: HTMLElement | undefined;
    let matchInfo: HTMLElement | undefined;
    function renderViewer(loading = false, appended = false): void {
      if (!selectedLog) {
        mount(viewerBox, card({ title: 'Tail' }, emptyState('file', 'Select a log file', 'Its last lines appear here and follow new output while the file grows.')));
        return;
      }
      if (tailError) {
        mount(viewerBox, card({ title: 'Tail' }, callout('bad', tailError)));
        return;
      }
      const name = selectedLog.split(/[\\/]/).pop() ?? selectedLog;
      if (loading || !tail) {
        mount(viewerBox, card({ title: name }, skeleton(10)));
        return;
      }
      const t = tail;
      const keepScroll = pre && !follow ? pre.scrollTop : undefined;
      const atBottom = pre ? pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40 : true;
      pre = h('pre.runs-log');
      matchInfo = h('span.runs-matches');
      paintText();
      const searchBox = textInput(search, debounce((v: string) => { search = v; paintText(true); }, 200), { placeholder: 'Highlight…' });
      searchBox.type = 'search';
      const actions = [
        h('div.runs-search', null, searchBox, matchInfo),
        toggle('Follow', follow, v => {
          follow = v;
          ctx.setState('follow', v);
          scheduleTail();
          if (v && pre) pre.scrollTop = pre.scrollHeight;
        }, { hint: `Poll the file every ${LOG_POLL_MS / 1000} s and scroll to new lines` }),
        button(t.more ? `More (${fmtInt(Math.min(50000, tailLines * 2))})` : 'All shown', () => {
          tailLines = Math.min(50000, tailLines * 2);
          void loadTail();
        }, { variant: 'ghost', disabled: !t.more || tailLines >= 50000, title: 'Double the number of lines' }),
        button('Open', () => void ctx.studio('openFile', { path: t.path, beside: true }), { variant: 'secondary', icon: 'external', title: 'Open in editor' })
      ];
      mount(viewerBox, card({
        title: name,
        subtitle: `${t.size === 0 ? 'empty file' : `last ${fmtInt(t.lines)} lines${t.more ? '' : ' (whole file)'}`} · ${fmtBytes(t.size)} · modified ${fmtAge(Date.now() - t.mtimeMs)}`,
        actions
      }, pre));
      if (keepScroll !== undefined) pre.scrollTop = keepScroll;
      else if (follow && (atBottom || !appended)) pre.scrollTop = pre.scrollHeight;
    }

    function paintText(jump = false): void {
      if (!pre || !tail) return;
      const text = tail.text || '(empty file)';
      const q = search.trim();
      if (!q) {
        pre.textContent = text;
        if (matchInfo) matchInfo.textContent = '';
        return;
      }
      const re = new RegExp(escapeRe(q), 'gi');
      const parts: Child[] = [];
      let last = 0;
      let count = 0;
      let first: HTMLElement | undefined;
      for (const m of text.matchAll(re)) {
        const i = m.index ?? 0;
        parts.push(text.slice(last, i));
        const mark = h('mark', null, m[0]);
        first ??= mark;
        parts.push(mark);
        last = i + m[0].length;
        if (++count > 5000) break;
      }
      parts.push(text.slice(last));
      mount(pre, parts);
      if (matchInfo) matchInfo.textContent = count ? `${count > 5000 ? '5000+' : count} match${count === 1 ? '' : 'es'}` : 'no match';
      if (jump && first) first.scrollIntoView({ block: 'center' });
    }

    // --- scheduling -----------------------------------------------------------
    function scheduleTail(): void {
      if (tailTimer) clearInterval(tailTimer);
      tailTimer = undefined;
      if (visible && sub === 'logs' && follow) tailTimer = setInterval(() => void loadTail(true), LOG_POLL_MS);
    }

    function schedule(): void {
      if (procTimer) clearInterval(procTimer);
      if (listTimer) clearInterval(listTimer);
      procTimer = listTimer = undefined;
      if (visible && sub === 'procs' && autoRefresh) procTimer = setInterval(() => void refreshProcs(), PROC_REFRESH_MS);
      if (visible && sub === 'logs') listTimer = setInterval(() => void refreshLogs(), LOG_LIST_REFRESH_MS);
      scheduleTail();
    }

    function showSub(): void {
      procView.hidden = sub !== 'procs';
      logView.hidden = sub !== 'logs';
      if (sub === 'procs') void refreshProcs();
      else if (!logs) void refreshLogs();
      else void loadTail(true);
      schedule();
      renderUpdated();
    }

    showSub();

    return {
      onShow() {
        visible = true;
        showSub();
      },
      onHide() {
        visible = false;
        schedule();
      },
      onNavigate(args: unknown) {
        const a = args as { log?: unknown; sub?: unknown } | undefined;
        if (typeof a?.log === 'string') {
          sub = 'logs';
          ctx.setState('sub', sub);
          renderTabs();
          selectLog(a.log);
          showSub();
        } else if (a?.sub === 'logs' || a?.sub === 'procs') {
          sub = a.sub;
          ctx.setState('sub', sub);
          renderTabs();
          showSub();
        }
      },
      dispose() {
        visible = false;
        schedule();
        chart?.dispose();
      }
    };
  }
};
