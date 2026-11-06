// Webview side of the "accel" studio tab: Accelerated UV/Vis with the uv-vis driver
// scripts/accelerated.py. Three views:
//   Setup     the pipeline configuration (form.ts) -> accel.json
//   Pipeline  the seven stages with status, progress, run / redo buttons and the log
//   Results   dominant state + orbitals, sampling, MBTR histograms, KRR, spectrum
// Host methods: src/studio/tabs/accel/host.ts. onNavigate args: { geometry?: path, workdir?: path }

import './accel.css';
import { figureToolbar, render, type ChartHandle, type Figure, type FigureSize, type Preset, type ToolbarHost } from '../../charts';
import { STAGES, STAGE_INFO, SAMPLING_LABELS, defaultForm, type AccelForm, type FieldError, type Stage } from '../../../../src/accel/spec';
import type {
  AccelInit, GleEntry, MinimumStates, ProjectDetail, ProjectSummary, RunResult, SaveResult, StageState
} from '../../../../src/studio/tabs/accel/types';
import {
  badge, button, busy, callout, card, codeBlock, dataTable, emptyState, grid, kpi, select, skeleton, subTabs, type Tone
} from '../../ui/components';
import { fmt, h, mount, type Child } from '../../ui/dom';
import type { TabView, ViewContext } from '../../view';
import { createForm } from './form';
import {
  bandMaximum, greek, gridFigure, mbtrFigure, parityFigure, predictionHistFigure, short, spectrumFigure, statesFigure
} from './figures';

type View = 'setup' | 'pipeline' | 'results';
const POLL_MS = 3000;

const STATUS_TONE: Record<string, Tone> = { pending: 'muted', running: 'accent', done: 'ok', failed: 'bad', waiting: 'warn' };

interface NavArgs { geometry?: string; workdir?: string }

function chartCard(ctx: ViewContext, handles: ChartHandle[], o: { title: string; subtitle?: string; name: string; caption: string; figure: Figure | null; extra?: Child }): HTMLElement | null {
  if (!o.figure) return null;
  const figure = o.figure;
  const box = h('div.accel-chart');
  let layout: { preset: Preset; size?: FigureSize } = { preset: 'screen' };
  const fig = () => ({ ...figure, preset: layout.preset, size: layout.size ?? figure.size });
  let handle: ChartHandle | undefined;
  const toolbar = figureToolbar({
    figure: () => ({ ...figure, size: layout.size ?? figure.size }), name: o.name, host: ctx as unknown as ToolbarHost,
    initialSize: figure.size, caption: () => o.caption,
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
  return card({ title: o.title, subtitle: o.subtitle, class: 'accel-chart-card' }, toolbar, box, o.extra ?? null);
}

export const view: TabView = {
  mount(root, ctx) {
    let current: View = ctx.state<View>('view', 'setup');
    let form: AccelForm = { ...defaultForm(), ...ctx.state<AccelForm | null>('form', null) };
    let workdir: string | null = ctx.state<string | null>('workdir', null);
    let init: AccelInit | undefined;
    let projects: ProjectSummary[] = [];
    let detail: ProjectDetail | null = null;
    let gle: GleEntry[] = [];
    let handles: ChartHandle[] = [];
    let poll: ReturnType<typeof setTimeout> | undefined;
    let shown = true;
    let loading = false;

    const tabsSlot = h('div.accel-subtabs');
    const banner = h('div');
    const setupBox = h('div');
    const pipeBox = h('div');
    const resBox = h('div');
    mount(root, h('div.accel', null, banner, tabsSlot, setupBox, pipeBox, resBox));

    const err = (e: unknown) => ctx.toast(e instanceof Error ? e.message : String(e), 'error');

    // ---------------------------------------------------------------- setup
    const formView = createForm({
      ctx,
      gle: () => gle,
      highestMode: () => (detail && detail.workdir === form.workdir ? detail.freqs?.omega_max_cm ?? null : null),
      reloadGle: () => void loadGle(),
      save: run => void save(run)
    }, form, f => {
      form = f;
      ctx.setState('form', f);
    });
    setupBox.append(formView.el);

    async function loadGle(): Promise<void> {
      try {
        gle = await ctx.rpc<GleEntry[]>('gle', { temperature: form.sampling.temperature });
      } catch {
        gle = [];
      }
      formView.refresh();
    }

    async function save(run: false | 'all' | 'minimum'): Promise<void> {
      const r = await ctx.rpc<SaveResult>('save', { form }).catch(e => { err(e); return null; });
      if (!r) return;
      formView.setErrors(r.errors);
      if (!r.ok) {
        ctx.toast(r.errors.map((e: FieldError) => `${e.field}: ${e.message}`).join('\n'), 'error');
        return;
      }
      workdir = r.workdir!;
      ctx.setState('workdir', workdir);
      ctx.toast(`${r.created ? 'Created' : 'Saved'} ${workdir}/accel.json`, 'success');
      await refreshProjects();
      if (run) await start(run === 'minimum' ? { until: 'minimum' } : {});
      else await load();
    }

    // ---------------------------------------------------------------- project list + header
    const projectSelect = h('div.accel-project');
    const renderHeader = () => {
      const opts = projects.map(p => ({ value: p.workdir, label: `${p.name} — ${p.sampling}, ${p.method}${p.running ? ' (running)' : ''}` }));
      if (workdir && !opts.some(o => o.value === workdir)) opts.unshift({ value: workdir, label: workdir });
      mount(projectSelect, opts.length
        ? select([{ value: '', label: 'New project…' }, ...opts], workdir ?? '', v => void openProject(v || null))
        : null);
      ctx.setActions(projectSelect,
        button('New', () => void openProject(null), { icon: 'plus', variant: 'ghost', title: 'Empty form for a new work directory' }),
        button('Refresh', e => void busy(e.currentTarget as HTMLButtonElement, async () => { await refreshProjects(); await load(); }), { icon: 'refresh', variant: 'ghost' }));
    };

    async function refreshProjects(): Promise<void> {
      try {
        projects = await ctx.rpc<ProjectSummary[]>('projects');
      } catch (e) {
        err(e);
      }
      renderHeader();
    }

    async function openProject(wd: string | null): Promise<void> {
      workdir = wd;
      ctx.setState('workdir', wd);
      detail = null;
      if (!wd) {
        form = { ...defaultForm(), geometry: form.geometry };
        ctx.setState('form', form);
        formView.setForm(form);
        show('setup');
      } else {
        await load(true);
      }
      renderHeader();
    }

    // ---------------------------------------------------------------- load / poll
    async function load(adoptForm = false): Promise<void> {
      if (!workdir || loading) {
        renderPipeline();
        renderResults();
        return;
      }
      loading = true;
      try {
        detail = await ctx.rpc<ProjectDetail>('load', { workdir });
        if (adoptForm) {
          form = detail.form;
          ctx.setState('form', form);
          formView.setForm(form);
          void loadGle();
        }
      } catch (e) {
        detail = null;
        err(e);
      } finally {
        loading = false;
      }
      renderPipeline();
      renderResults();
      schedulePoll();
    }

    function schedulePoll(): void {
      if (poll) clearTimeout(poll);
      if (shown && detail?.running) poll = setTimeout(() => void load(), POLL_MS);
    }

    async function start(o: { until?: Stage; only?: Stage; redo?: Stage; terminal?: boolean }): Promise<void> {
      if (!workdir) return;
      try {
        const r = await ctx.rpc<RunResult>('run', { workdir, ...o });
        ctx.toast(r.terminal ? 'Started in a terminal' : `Started (pid ${r.pid})`, 'success');
        show('pipeline');
        setTimeout(() => void load(), 800);
      } catch (e) {
        err(e);
      }
    }

    // ---------------------------------------------------------------- pipeline view
    function stageRow(s: Stage, st: StageState): HTMLElement {
      const d = detail!;
      const info = STAGE_INFO[s];
      const status = d.interrupted && st.status === 'running' ? 'interrupted' : st.status;
      const pct = st.status === 'running' && typeof st.progress === 'number' ? Math.round(100 * st.progress) : null;
      const details: Child[] = [];
      if (s === 'optfreq' && d.freqs) {
        details.push(`${d.freqs.method}/${d.freqs.basis} (${d.freqs.program}): ${d.freqs.freqs_cm.length} modes, ${Math.round(d.freqs.omega_min_cm)}–${Math.round(d.freqs.omega_max_cm)} cm⁻¹${d.freqs.n_imag ? `, ${d.freqs.n_imag} imaginary` : ''}`);
      }
      if (s === 'minimum' && d.minimum) {
        const t = d.minimum.states.find(x => x.state === d.minimum!.target_state);
        if (t) details.push(`follows S${t.state}: ${t.e_ev.toFixed(2)} eV (${t.nm?.toFixed(0)} nm), f = ${short(t.f)}, ${greek(t.character)}`);
      }
      if (s === 'sampling' && d.sampling) {
        details.push(`${SAMPLING_LABELS[d.sampling.kind as keyof typeof SAMPLING_LABELS] ?? d.sampling.kind}${d.sampling.n_frames ? `: ${d.sampling.n_frames.toLocaleString()} geometries` : ''}`);
        if (d.sampling.gle) details.push(`, GLE ${d.sampling.gle.name}${d.sampling.gle.omega_max_cm ? ` (ω_max ${Math.round(d.sampling.gle.omega_max_cm)} cm⁻¹)` : ''}`);
      }
      if (s === 'select' && d.selection) details.push(`${d.selection.n_train} of ${d.selection.n_all.toLocaleString()}, every ${d.selection.step}.`);
      if (s === 'excite' && d.excite) details.push(`${d.excite.done}/${d.excite.total} done${d.excite.failed ? `, ${d.excite.failed} not converged` : ''}${d.excite.nstates ? `, ${d.excite.nstates} roots` : ''}`);
      if (s === 'train' && d.krr) details.push(`nested CV MAE E ${short(d.krr.E.nested?.mae)} eV, f ${short(d.krr.f.nested?.mae)}`);
      if (s === 'spectrum' && d.spectrum.length) {
        const ml = d.spectrum.find(c => c.kind === 'ml');
        const b = ml ? bandMaximum(ml) : null;
        if (b) details.push(`band maximum ${b.lmax.toFixed(1)} nm, FWHM ${b.fwhm.toFixed(0)} nm`);
      }
      const msg = st.error ?? st.message;
      const idx = STAGES.indexOf(s);
      return h('div.accel-stage', { class: `st-${status}` },
        h('div.accel-stage-num', null, String(idx + 1)),
        h('div.accel-stage-body', null,
          h('div.accel-stage-head', null, h('strong', null, info.title), badge(status, STATUS_TONE[status] ?? 'bad'),
            pct !== null ? h('div.accel-progress', { title: `${pct} %` }, h('span', { style: { width: `${pct}%` } })) : null),
          h('div.accel-stage-text', null, details.length ? details : info.text),
          msg ? h('div.accel-stage-msg', { class: st.status === 'failed' ? 'bad' : '' }, msg) : null),
        h('div.accel-stage-actions', null,
          button('Run to here', () => void start({ until: s }), { variant: 'ghost', icon: 'play', disabled: d.running, title: `pending stages up to ${s}` }),
          st.status === 'done' || st.status === 'failed'
            ? button('Redo', async () => {
              const ok = await ctx.studio('confirm', { message: `Redo ${info.title}?`, action: 'Redo', detail: 'Its outputs and those of all later stages are dropped (per-geometry excitation results are kept).' });
              if (ok) await start({ until: s, redo: s });
            }, { variant: 'ghost', icon: 'refresh', disabled: d.running })
            : null,
          button('', () => void ctx.rpc('openFile', { workdir: d.workdir, file: stageFile(s) }).catch(err),
            { variant: 'ghost', icon: 'file', title: 'Open the stage output' })));
    }

    function stageFile(s: Stage): string {
      return ({ optfreq: '01-optfreq/freqs.json', minimum: '02-minimum/states.json', sampling: '03-sampling/sampling.json',
        select: '04-excite/train_indices.json', excite: '04-excite/excite.json', train: '05-ml/krr.json', spectrum: '06-spectrum/spectrum.json' } as Record<Stage, string>)[s];
    }

    function renderPipeline(): void {
      if (!workdir) {
        mount(pipeBox, emptyState('accel', 'No project yet', 'Fill in the setup and save: the pipeline lives in its work directory (accel.json).',
          button('Go to setup', () => show('setup'), { variant: 'primary' })));
        return;
      }
      if (!detail) {
        mount(pipeBox, skeleton(6));
        return;
      }
      const d = detail;
      const running = d.running;
      mount(pipeBox,
        d.interrupted ? callout('warn', 'A stage is marked running, but its process is gone (stopped or crashed). Run again to resume: finished work is reused.') : null,
        card({
          title: 'Pipeline', subtitle: d.workdir,
          actions: [
            running
              ? button('Stop', () => void ctx.rpc<boolean>('stop', { workdir: d.workdir }).then(ok => { if (ok) ctx.toast('Stopped', 'info'); void load(); }, err), { variant: 'danger', icon: 'stop' })
              : button('Run all pending', () => void start({}), { variant: 'primary', icon: 'play' }),
            button('In terminal', () => void start({ terminal: true }), { variant: 'ghost', icon: 'terminal', disabled: running, title: 'Run the driver in an integrated terminal (it keeps running when the studio closes)' }),
            button('Copy command', async () => {
              const c = await ctx.rpc<string>('command', { workdir: d.workdir }).catch(e => { err(e); return ''; });
              if (c) {
                await navigator.clipboard?.writeText(c).catch(() => undefined);
                ctx.toast(c, 'info');
              }
            }, { variant: 'ghost', icon: 'copy' })
          ]
        }, h('div.accel-stages', null, STAGES.map(s => stageRow(s, d.stages[s])))),
        card({ title: 'Log', subtitle: 'accel.log', actions: [button('Open', () => void ctx.rpc('openFile', { workdir: d.workdir, file: 'accel.log' }).catch(err), { variant: 'ghost', icon: 'external' })] },
          d.log ? codeBlock(d.log, { maxHeight: 320 }) : h('div.accel-note', null, 'Nothing logged yet.')));
      // newest lines at the bottom: show them
      pipeBox.querySelectorAll('pre, .code-block').forEach(el => { (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight; });
    }

    // ---------------------------------------------------------------- results view
    function statesCard(m: MinimumStates, wd: string): HTMLElement {
      const moName = (k: number) => m.orbitals[String(k)]?.name ?? `MO ${k}`;
      const moLabel = (k: number) => greek(m.orbitals[String(k)]?.label ?? '?');
      const cubeBtn = (k: number) => {
        const cube = m.orbitals[String(k)]?.cube;
        return cube ? h('button.accel-mo', { type: 'button', title: `Show ${moName(k)} (${moLabel(k)}) in the 3D viewer`, onclick: () => void ctx.rpc('show', { workdir: wd, file: cube }).catch(err) }, `${moName(k)} (${moLabel(k)})`)
          : h('span', null, `${moName(k)} (${moLabel(k)})`);
      };
      return card({ title: 'Excited states at the minimum', subtitle: `${m.method.toUpperCase()}${m.xc ? '/' + m.xc : ''}/${m.basis}; the followed state is highlighted${m.planar ? '' : ` — non-planar frame (RMS ${m.planar_rms} Å): π/σ labels approximate`}` },
        m.converged ? null : callout('warn', 'Not all roots converged at the minimum.'),
        dataTable({
          columns: [
            { key: 'state', label: 'State', render: r => `S${r.state}` },
            { key: 'e_ev', label: 'E / eV', numeric: true, align: 'right', render: r => r.e_ev.toFixed(3) },
            { key: 'nm', label: 'λ / nm', numeric: true, align: 'right', render: r => (r.nm ? r.nm.toFixed(1) : '–') },
            { key: 'f', label: 'f', numeric: true, align: 'right', render: r => short(r.f) },
            { key: 'character', label: 'Character', render: r => h('span', null, greek(r.character), h('span.accel-weight', null, ` ${Math.round(100 * r.character_weight)} %`)) },
            { key: 'singles', label: 'Singles', numeric: true, align: 'right', render: r => (r.singles === null ? '–' : `${Math.round(100 * r.singles)} %`), title: 'share of single excitations in the state vector (ADC)' },
            {
              key: 'tr', label: 'Main transitions (click an orbital)', sortValue: r => r.transitions[0]?.weight ?? 0,
              render: r => h('div.accel-trans', null, r.transitions.slice(0, 3).map(t => h('div', null, cubeBtn(t.from), ' → ', cubeBtn(t.to), h('span.accel-weight', null, ` ${Math.round(100 * t.weight)} %`))))
            }
          ],
          rows: m.states, rowKey: r => String(r.state), rowClass: r => (r.state === m.target_state ? 'accel-target' : '')
        }));
    }

    function renderResults(): void {
      handles.forEach(c => c.dispose());
      handles = [];
      if (!detail) {
        mount(resBox, workdir ? skeleton(6) : emptyState('accel', 'No results', 'Results appear here stage by stage.'));
        return;
      }
      const d = detail;
      const wd = d.workdir;
      const cards: Child[] = [];
      const label = d.form.name || wd.split(/[\\/]/).pop() || 'accel';

      const ml = d.spectrum.find(c => c.kind === 'ml');
      const direct = d.spectrum.find(c => c.kind === 'direct');
      if (d.spectrum.length) {
        const bm = ml ? bandMaximum(ml) : null;
        const bd = direct ? bandMaximum(direct) : null;
        cards.push(h('div.accel-kpis', null,
          bm ? kpi('Band maximum, ML', bm.lmax.toFixed(1), 'nm', `FWHM ${bm.fwhm.toFixed(0)} nm`) : null,
          bd ? kpi('Band maximum, direct', bd.lmax.toFixed(1), 'nm', `${direct!.n} geometries`) : null,
          bm ? kpi('Peak cross section, ML', bm.peak.toExponential(2), 'cm²') : null,
          d.krr ? kpi('Speed-up', `${Math.round(d.krr.n_all / Math.max(1, d.krr.n_train))}×`, '', `${d.krr.n_all.toLocaleString()} predicted from ${d.krr.n_train}`, 'accent') : null));
        cards.push(chartCard(ctx, handles, {
          title: 'Absorption spectrum', subtitle: `S${d.krr?.target_state ?? d.minimum?.target_state ?? '?'} band, ${Math.round(100 * d.form.spectrum.confidence)} % CI`,
          name: `${label}-accel-spectrum`, caption: `NEA absorption cross section of the S${d.krr?.target_state ?? ''} band: KRR prediction for the whole ensemble vs the training set alone.`,
          figure: spectrumFigure(d.spectrum),
          extra: h('div.accel-links', null, d.spectrum.filter(c => c.kind !== 'experiment').map(c =>
            button(`${c.kind === 'ml' ? 'ML' : 'direct'} in Spectra tab`, () => void ctx.rpc('show', { workdir: wd, file: c.file, tab: 'spectra' }).catch(err), { variant: 'ghost', icon: 'spectra' })))
        }));
      }

      if (d.minimum) {
        cards.push(chartCard(ctx, handles, { title: 'States at the minimum', name: `${label}-states`, caption: 'Vertical excitations at the ground-state minimum; the followed state highlighted.', figure: statesFigure(d.minimum) }));
        cards.push(statesCard(d.minimum, wd));
      }

      if (d.freqs || d.sampling) {
        const f = d.freqs;
        const s = d.sampling;
        cards.push(card({ title: 'Ground state & sampling', subtitle: f ? `${f.method}/${f.basis} (${f.program})` : undefined },
          h('div.accel-kpis', null,
            f ? kpi('Frequencies', `${Math.round(f.omega_min_cm)}–${Math.round(f.omega_max_cm)}`, 'cm⁻¹', `${f.freqs_cm.length} modes`, f.n_imag ? 'bad' : 'ok') : null,
            s ? kpi('Ensemble', s.n_frames ? s.n_frames.toLocaleString() : '–', 'geometries', `${SAMPLING_LABELS[s.kind as keyof typeof SAMPLING_LABELS] ?? s.kind}, ${s.temperature} K${s.beads > 1 ? `, ${s.beads} beads` : ''}`) : null,
            s?.gle ? kpi('GLE matrix', s.gle.name, '', s.gle.omega_max_cm ? `ω_max ${Math.round(s.gle.omega_max_cm)} cm⁻¹ ≥ ${Math.round(s.gle.highest_mode_cm)}` : 'ω_max unknown', s.gle.omega_max_cm ? 'ok' : 'warn') : null,
            d.selection ? kpi('Training set', String(d.selection.n_train), 'geometries', `every ${d.selection.step}. of ${d.selection.n_all.toLocaleString()}`) : null),
          s?.gle?.warnings?.length ? callout('warn', s.gle.warnings.join('; ')) : null,
          h('div.accel-links', null,
            button('Minimum in viewer', () => void ctx.rpc('show', { workdir: wd, file: '01-optfreq/opt.xyz' }).catch(err), { variant: 'ghost', icon: 'viewer' }),
            f ? button('Normal modes', () => void ctx.rpc('show', { workdir: wd, file: '01-optfreq/opt_freq.out' }).catch(() => ctx.rpc('openFile', { workdir: wd, file: '01-optfreq/modes.molden' }).catch(err)), { variant: 'ghost', icon: 'viewer', title: 'ORCA output in the viewer (mode animation)' }) : null,
            s?.n_frames ? button('Ensemble in Geometries', () => void ctx.rpc('show', { workdir: wd, file: '03-sampling/ensemble.xyz', tab: 'geom' }).catch(err), { variant: 'ghost', icon: 'geom' }) : null,
            d.selection ? button('Training set in Geometries', () => void ctx.rpc('show', { workdir: wd, file: '04-excite/train.xyz', tab: 'geom' }).catch(err), { variant: 'ghost', icon: 'geom' }) : null)));
      }

      if (d.mbtr) {
        const g = d.mbtr;
        cards.push(chartCard(ctx, handles, {
          title: 'MBTR grid from the histograms', subtitle: `${g.species.join(', ')}: ${g.n} points, σ ${g.sigma} Å⁻¹, range ${g.min.toFixed(3)}–${g.max.toFixed(3)} Å⁻¹ (${g.auto ? 'auto' : 'manual'})`,
          name: `${label}-mbtr-grid`, caption: 'Inverse interatomic distances in the ensemble per element pair; dashed: MBTR grid range.',
          figure: mbtrFigure(g),
          extra: g.outside_fraction > 0 ? callout('warn', `${(100 * g.outside_fraction).toFixed(2)} % of the distances fall outside the grid.`) : null
        }));
      }

      if (d.krr) {
        const k = d.krr;
        cards.push(card({ title: 'Kernel ridge regression', subtitle: `MBTR ${k.features.n_features} features (${k.features.backend}), ${k.n_train} training geometries${k.dropped ? `, ${k.dropped} dropped` : ''}` },
          h('div.accel-kpis', null,
            kpi('MAE E (nested CV)', short(k.E.nested?.mae), 'eV', `R² ${short(k.E.nested?.r2)}`, 'accent'),
            kpi('MAE f (nested CV)', short(k.f.nested?.mae), '', `R² ${short(k.f.nested?.r2)}`, 'accent'),
            kpi('Alpha / gamma (E)', `${short(k.E.best_params.alpha, 2)} / ${short(k.E.best_params.gamma, 2)}`, '', `fit ${fmt(k.E.time_fit_s, 1)} s`),
            kpi('Negative f predicted', String(k.f_negative), '', 'set to 0 in the spectrum', k.f_negative ? 'warn' : 'ok')),
          [...k.E.edge.map(p => `E: optimum of ${p} on the grid edge`), ...k.f.edge.map(p => `f: optimum of ${p} on the grid edge`)].length
            ? callout('warn', [...k.E.edge.map(p => `E: optimum of ${p} on the grid edge`), ...k.f.edge.map(p => `f: optimum of ${p} on the grid edge`)].join('; ') + ' — widen the grid in the setup and redo the training.')
            : null));
        const charts = [
          chartCard(ctx, handles, { title: 'Parity: excitation energy', name: `${label}-parity-E`, caption: 'Nested cross-validation of the KRR excitation energy.', figure: parityFigure(k.E, `E(S_{${k.target_state}})`, 'eV') }),
          chartCard(ctx, handles, { title: 'Parity: oscillator strength', name: `${label}-parity-f`, caption: 'Nested cross-validation of the KRR oscillator strength.', figure: parityFigure(k.f, `f(S_{${k.target_state}})`, '') }),
          chartCard(ctx, handles, { title: 'Distribution of E', name: `${label}-hist-E`, caption: 'Excitation energies: KRR for the ensemble vs computed for the training set.', figure: predictionHistFigure(k, 'E') }),
          chartCard(ctx, handles, { title: 'Distribution of f', name: `${label}-hist-f`, caption: 'Oscillator strengths: KRR for the ensemble vs computed for the training set.', figure: predictionHistFigure(k, 'f') }),
          chartCard(ctx, handles, { title: 'Grid search (E)', name: `${label}-grid-E`, caption: 'Cross-validated MAE of the excitation energy over the hyperparameter grid.', figure: gridFigure(k.E, 'eV') }),
          chartCard(ctx, handles, { title: 'Grid search (f)', name: `${label}-grid-f`, caption: 'Cross-validated MAE of the oscillator strength over the hyperparameter grid.', figure: gridFigure(k.f, 'f') })
        ];
        cards.push(grid(420, ...charts));
      }

      mount(resBox, cards.filter(Boolean).length ? cards : emptyState('accel', 'No results yet', 'Run the pipeline: the excited states at the minimum come first, the spectrum last.',
        button('Pipeline', () => show('pipeline'), { variant: 'primary' })));
    }

    // ---------------------------------------------------------------- shell
    function renderBanner(): void {
      mount(banner, init && !init.scriptsDir
        ? callout('warn', 'uv-vis scripts/accelerated.py not found. Open the uv-vis repository in the workspace or set ', h('code', null, 'orcaInp.nea.scriptsDir'), '. Saving accel.json works without it.')
        : null);
    }

    function show(v: View): void {
      current = v;
      ctx.setState('view', v);
      mount(tabsSlot, subTabs<View>([{ value: 'setup', label: 'Setup' }, { value: 'pipeline', label: 'Pipeline' }, { value: 'results', label: 'Results' }], v, show));
      setupBox.hidden = v !== 'setup';
      pipeBox.hidden = v !== 'pipeline';
      resBox.hidden = v !== 'results';
      if (v !== 'setup' && workdir && !detail) void load();
    }

    const off = ctx.on('changed', (p: { workdirs?: string[] }) => {
      if (workdir && (p?.workdirs ?? []).some(w => w === workdir || w.startsWith(workdir + '/') || w.startsWith(workdir + '\\'))) void load();
      else void refreshProjects();
    });

    void (async () => {
      try {
        init = await ctx.rpc<AccelInit>('init');
        projects = init.projects;
      } catch (e) {
        err(e);
      }
      renderBanner();
      renderHeader();
      await loadGle();
      if (workdir) await load(!ctx.state('form', null));
      else {
        renderPipeline();
        renderResults();
      }
    })();
    show(current);

    return {
      onNavigate(raw) {
        const a = (raw ?? {}) as NavArgs;
        if (typeof a.workdir === 'string') {
          void openProject(a.workdir).then(() => show(projects.some(p => p.workdir === a.workdir) ? 'pipeline' : 'setup'));
        } else if (typeof a.geometry === 'string') {
          workdir = null;
          detail = null;
          const stem = a.geometry.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
          const dir = a.geometry.replace(/[\\/][^\\/]*$/, '');
          form = { ...defaultForm(), geometry: a.geometry, workdir: `${dir}/accel_${stem}`, name: stem.replace(/[^\w.+-]/g, '_') };
          ctx.setState('form', form);
          formView.setForm(form);
          renderHeader();
          show('setup');
        }
      },
      onShow() {
        shown = true;
        if (workdir) void load();
      },
      onHide() {
        shown = false;
        if (poll) clearTimeout(poll);
      },
      dispose() {
        off();
        if (poll) clearTimeout(poll);
        handles.forEach(c => c.dispose());
      }
    };
  }
};
