// "New run" form of the ML tab, generated from SPEC (src/ml/spec.ts) so it
// stays in sync with the worker. Validates live with buildConfig (no file
// checks); the host validates again with the files when the run starts.

import {
  buildConfig, defaultParams, gridSize, MODEL_NAMES, parseParams, REP_NAMES, SPEC,
  type ConfigError, type MethodSpec, type MlForm, type ModelName, type ParamSpec, type RepName
} from '../../../../src/ml/spec';
import type { CsvHeader, EnvCheck, MlInit, StartResult } from '../../../../src/studio/tabs/ml/types';
import { badge, button, busy, callout, card, field, icon, iconButton, numberInput, select, textInput, toggle } from '../../ui/components';
import { debounce, h, mount } from '../../ui/dom';
import type { ViewContext } from '../../view';

export interface FormHost {
  ctx: ViewContext;
  init: () => MlInit | undefined;
  env: () => EnvCheck | undefined;
  /** Re-run the environment check (button). */
  checkEnv: (btn?: HTMLButtonElement) => Promise<void>;
  /** A run was started. */
  started: (id: string) => void;
}

const OPTIONAL = ['dscribe', 'ase', 'xgboost'];

/** One-line description on the method buttons (the SPEC label repeats the name for some). */
const BLURB: Record<string, string> = {
  CM: 'Coulomb matrix', SOAP: 'smooth overlap of atomic positions', MBTR: 'many-body tensor', precomputed: 'your own feature matrix',
  KRR: 'kernel ridge regression', GPR: 'Gaussian process', Ridge: 'linear, L2 penalty', Lasso: 'linear, L1 penalty', XGBoost: 'gradient-boosted trees'
};

/** Missing optional packages a method needs, per the environment check. */
export function missingFor(m: MethodSpec, env: EnvCheck | undefined): string[] {
  if (!env || env.error) return [];
  return m.requires.filter(p => !env.packages[p]);
}

/** "7 × 6 = 42 combinations × 5 folds" for the grid parameters of the form (or null). */
export function gridSummary(form: MlForm): string | null {
  if (!form.model.grid) return null;
  const spec = SPEC.model[form.model.name as ModelName];
  if (!spec) return null;
  const { params } = parseParams(spec.params, form.model.params, true, 'model.params');
  const dims = Object.values(params).filter(Array.isArray).map(v => (v as unknown[]).length);
  const n = gridSize(params);
  const folds = String(form.split.cv ?? '').trim() || '?';
  if (!dims.length) return `1 combination (give a parameter several values to search)`;
  return `${dims.length > 1 ? `${dims.join(' × ')} = ` : ''}${n} combination${n === 1 ? '' : 's'} × ${folds} folds`;
}

export function renderForm(root: HTMLElement, fh: FormHost, form: MlForm, onChange: (f: MlForm) => void): { refreshEnv(): void; setForm(f: MlForm): void } {
  const { ctx } = fh;
  const fields = new Map<string, { wrap: HTMLElement; msg: HTMLElement }>();
  let hostErrors: ConfigError[] = [];
  let header: CsvHeader | null = null;
  let headerError = '';

  const summary = h('div.ml-summary');
  const gridLine = h('div.ml-grid-line');
  const errorList = h('div.ml-errors');
  const envBox = h('div.ml-env');
  const repBox = h('div.stack');
  const modelBox = h('div.stack');
  const dataBox = h('div.stack');
  const splitBox = h('div.stack');

  /** A form field with an error slot under it, registered under its dotted path. */
  const f = (path: string, label: string, control: HTMLElement, hint?: string): HTMLElement => {
    const msg = h('span.ml-field-error');
    const wrap = field(label, control, hint);
    wrap.append(msg);
    wrap.dataset.field = path;
    fields.set(path, { wrap, msg });
    return wrap;
  };

  const changed = () => {
    hostErrors = [];
    renderSummary();
    onChange(form);
    validate();
  };

  const validate = debounce(() => {
    const r = buildConfig(form, { maxJobs: fh.init()?.maxJobs });
    const errs = [...r.errors, ...hostErrors];
    for (const { wrap, msg } of fields.values()) {
      wrap.classList.remove('invalid');
      msg.textContent = '';
    }
    const loose: ConfigError[] = [];
    for (const e of errs) {
      const slot = fields.get(e.field);
      if (slot) {
        slot.wrap.classList.add('invalid');
        slot.msg.textContent = slot.msg.textContent ? `${slot.msg.textContent}; ${e.message}` : e.message;
      } else {
        loose.push(e);
      }
    }
    const g = gridSummary(form);
    mount(gridLine, g ? [icon('filter'), h('span', null, 'Grid search: ', h('b', null, g))] : null);
    gridLine.hidden = !g;
    mount(errorList, errs.length
      ? callout('warn', h('b', null, `${errs.length} problem${errs.length === 1 ? '' : 's'} to fix`), h('ul', null, errs.slice(0, 8).map(e => h('li', null, e.message))))
      : null);
    startBtn.disabled = errs.length > 0 || !fh.init()?.hasStorage;
  }, 120);

  // --- data -----------------------------------------------------------------

  const pathInput = (value: string, onInput: (v: string) => void, kind: 'xyz' | 'csv' | 'features', placeholder: string) => {
    const input = textInput(value, onInput, { mono: true, placeholder });
    const browse = iconButton('folder', 'Browse…', () => void busy(undefined, async () => {
      const p = await ctx.rpc<string | null>('pick', { kind });
      if (p) {
        input.value = p;
        onInput(p);
      }
    }));
    return h('div.ml-path', null, input, browse);
  };

  const loadHeader = debounce(async () => {
    const csv = String(form.data.csv ?? '').trim();
    header = null;
    headerError = '';
    if (csv) {
      try {
        header = await ctx.rpc<CsvHeader>('csvHeader', { path: csv, header: form.data.header !== false });
      } catch (e) {
        headerError = e instanceof Error ? e.message : String(e);
      }
    }
    renderColumn();
  }, 300);

  const columnSlot = h('div');
  const renderColumn = () => {
    const col = String(form.data.column ?? '');
    let control: HTMLElement;
    if (header && header.columns.length) {
      const opts = header.columns.map((c, i) => ({
        value: form.data.header === false ? String(i) : c,
        label: `${form.data.header === false ? '' : `${i}: `}${c}${header!.numeric[i] ? '' : ' (not numeric)'}`
      }));
      if (!opts.some(o => o.value === col)) {
        // index typed by hand, or a stale choice: keep it selectable
        const byIndex = /^\d+$/.test(col) && header.columns[Number(col)] !== undefined;
        if (byIndex && form.data.header !== false) {
          form.data.column = header.columns[Number(col)];
          onChange(form);
        } else {
          opts.unshift({ value: col, label: col ? `${col} (not in the file)` : '— choose —' });
        }
      }
      control = select(opts, String(form.data.column), v => { form.data.column = v; changed(); });
    } else {
      control = textInput(col, v => { form.data.column = v; changed(); }, { placeholder: 'name or 0-based index', mono: true });
    }
    const hint = header ? `${header.rows} rows, ${header.columns.length} columns` : headerError || 'pick the targets CSV to list its columns';
    mount(columnSlot, f('data.column', 'Target column', control, hint));
    validate();
  };

  const renderData = () => {
    const rep = SPEC.rep[form.rep.name as RepName];
    fields.delete('data.xyz');
    mount(dataBox,
      rep?.needsXyz === false
        ? h('p.muted.ml-note', null, 'Molecules are not needed for precomputed features; the feature rows must follow the CSV rows.')
        : f('data.xyz', 'Molecules (multi-XYZ)', pathInput(String(form.data.xyz ?? ''), v => { form.data.xyz = v; changed(); }, 'xyz', 'path/to/molecules.xyz')),
      f('data.csv', 'Targets (CSV)', pathInput(String(form.data.csv ?? ''), v => { form.data.csv = v; changed(); loadHeader(); }, 'csv', 'path/to/targets.csv')),
      h('div.ml-row2', null,
        columnSlot,
        f('data.n_mol', 'First N molecules', textInput(String(form.data.n_mol ?? ''), v => { form.data.n_mol = v; changed(); }, { placeholder: 'all', mono: true }), 'blank = all')),
      toggle('CSV has a header row', form.data.header !== false, v => { form.data.header = v; changed(); loadHeader(); })
    );
    renderColumn();
  };

  // --- representation / model -------------------------------------------------

  const choiceGroup = <T extends string>(names: readonly T[], specs: Record<T, MethodSpec>, value: string, onPick: (v: T) => void) =>
    h('div.ml-choices', { role: 'radiogroup' }, names.map(n => {
      const m = specs[n];
      const missing = missingFor(m, fh.env());
      return h('button.ml-choice', {
        type: 'button', role: 'radio', 'aria-checked': String(n === value), class: [n === value ? 'on' : '', missing.length ? 'missing' : ''].join(' '),
        title: missing.length ? `${m.label}: needs ${missing.join(', ')} (not installed in ${fh.env()?.executable ?? 'the interpreter'})` : m.label,
        onclick: () => onPick(n)
      }, h('span.ml-choice-name', null, n === 'precomputed' ? 'Precomputed' : n), h('span.ml-choice-label', null, BLURB[n] ?? m.label),
      missing.length ? h('span.ml-choice-warn', null, icon('warning'), `needs ${missing.join(', ')}`) : null);
    }));

  const paramControl = (p: ParamSpec, params: Record<string, unknown>, prefix: string, gridOn: boolean): HTMLElement => {
    const path = `${prefix}.${p.key}`;
    const val = params[p.key] ?? p.default;
    const set = (v: unknown) => { params[p.key] = v; changed(); };
    if (p.type === 'choice') {
      return f(path, p.label, select(p.choices!.map(c => ({ value: c, label: c })), String(val), set), p.help);
    }
    if (p.type === 'bool') {
      const t = toggle(p.label, Boolean(val) && val !== 'false', set, { hint: p.help });
      const w = h('div.field', { dataset: { field: path } }, t, h('span.ml-field-error'));
      fields.set(path, { wrap: w, msg: w.lastElementChild as HTMLElement });
      return w;
    }
    if (p.type === 'path') {
      return f(path, p.label, pathInput(String(val), set, 'features', 'path/to/X.npy'), p.help);
    }
    const numeric = p.type !== 'int?';
    const hint = gridOn && numeric ? `${p.help ? `${p.help} · ` : ''}list: a,b,c or log:a,b,n` : p.help;
    return f(path, p.label, textInput(String(val), set, { mono: true, placeholder: p.default === '' ? 'auto' : String(p.default) }), hint);
  };

  const renderRep = () => {
    const name = form.rep.name as RepName;
    const spec = SPEC.rep[name];
    form.rep.params ??= {};
    for (const k of [...fields.keys()]) if (k.startsWith('rep.')) fields.delete(k);
    mount(repBox,
      choiceGroup(REP_NAMES, SPEC.rep, name, n => {
        if (n === form.rep.name) return;
        form.rep = { ...form.rep, name: n, params: defaultParams(SPEC.rep[n]) };
        renderRep();
        renderData();
        changed();
      }),
      h('div.ml-params', null, spec.params.map(p => paramControl(p, form.rep.params!, 'rep.params', false))),
      h('div.row', null,
        toggle('Drop constant features', form.rep.variance !== false, v => { form.rep.variance = v; changed(); }, { hint: 'VarianceThreshold(0)' }),
        toggle('Standardize', form.rep.scale !== false, v => { form.rep.scale = v; changed(); }, { hint: 'StandardScaler' }))
    );
  };

  const renderModel = () => {
    const name = form.model.name as ModelName;
    const spec = SPEC.model[name];
    form.model.params ??= {};
    for (const k of [...fields.keys()]) if (k.startsWith('model.')) fields.delete(k);
    mount(modelBox,
      choiceGroup(MODEL_NAMES, SPEC.model, name, n => {
        if (n === form.model.name) return;
        form.model = { ...form.model, name: n, params: defaultParams(SPEC.model[n]) };
        renderModel();
        changed();
      }),
      h('div.row.ml-grid-toggle', null,
        toggle('Grid search', Boolean(form.model.grid), v => { form.model.grid = v; renderModel(); changed(); },
          { hint: 'Search parameters given as lists by k-fold cross-validation (MAE)' }),
        form.model.grid ? h('span.muted', null, 'e.g. ', h('code', null, '1e-3,1e-2'), ' or ', h('code', null, 'log:-6,-1,6')) : null),
      h('div.ml-params', null, spec.params.map(p => paramControl(p, form.model.params!, 'model.params', Boolean(form.model.grid)))),
      gridLine
    );
  };

  const renderSplit = () => {
    const maxJobs = fh.init()?.maxJobs ?? 16;
    const t = (path: 'test_size' | 'seed' | 'cv' | 'curve', label: string, hint?: string, placeholder?: string) =>
      f(`split.${path}`, label, textInput(String(form.split[path] ?? ''), v => { (form.split as any)[path] = v; changed(); }, { mono: true, placeholder }), hint);
    mount(splitBox,
      h('div.ml-row2', null, t('test_size', 'Test size', 'fraction (0–1) or a count'), t('seed', 'Random seed')),
      h('div.ml-row2', null, t('cv', 'CV folds', 'for the grid search'),
        f('n_jobs', 'Cores', numberInput(Number(form.n_jobs) || 1, v => { form.n_jobs = String(Math.max(1, Math.min(maxJobs, Math.round(v)))); changed(); }, { min: 1, max: maxJobs, step: 1 }), `at most ${maxJobs}`)),
      t('curve', 'Learning curve sizes', 'training sizes, e.g. 100,200,400 (blank = none)', 'none')
    );
  };

  // --- environment ---------------------------------------------------------------

  const refreshEnv = () => {
    const env = fh.env();
    if (!env) {
      mount(envBox, h('p.muted', null, 'Checking the Python environment…'));
      return;
    }
    const pk = (name: string, label = name) => {
      const v = env.packages[name];
      const required = !OPTIONAL.includes(name);
      const tone = v ? 'ok' : required ? 'bad' : 'warn';
      return h('li', { class: `tone-${tone}` }, h('span.ml-dot'), h('span.ml-pkg', null, label), h('span.ml-ver', null, v ?? (required ? 'missing' : 'not installed')));
    };
    mount(envBox,
      env.error
        ? callout('bad', h('b', null, 'Python not usable'), h('div', null, env.error), h('div.muted', null, 'Set orcaInp.studio.pythonPath to an interpreter with numpy, scipy, pandas and scikit-learn.'))
        : h('div.ml-env-head', null,
            badge(env.ok ? 'ready' : 'incomplete', env.ok ? 'ok' : 'bad'),
            h('span', null, `Python ${env.python ?? '?'}`),
            env.executable ? h('code.ml-exe', { title: env.executable }, env.executable) : null),
      env.error ? null : h('ul.ml-pkgs', null,
        ['numpy', 'scipy', 'pandas', 'sklearn', 'joblib', 'threadpoolctl'].map(n => pk(n, n === 'sklearn' ? 'scikit-learn' : n)),
        OPTIONAL.map(n => pk(n))),
      env.error || !env.missing_required.length ? null : callout('bad', `Missing required packages: ${env.missing_required.join(', ')}`)
    );
    renderRep();
    renderModel();
    validate();
  };

  // --- layout ----------------------------------------------------------------------

  const startBtn = button('Start run', () => void busy(startBtn, async () => {
    const r = await ctx.rpc<StartResult>('start', { form });
    if (!r.ok) {
      hostErrors = r.errors;
      validate();
      ctx.toast(r.errors[0]?.message ?? 'Invalid form', 'error');
      return;
    }
    ctx.toast(`Run ${r.id} started`, 'success');
    fh.started(r.id);
  }), { variant: 'primary', icon: 'play' });
  startBtn.classList.add('ml-start');

  const nameInput = textInput(String(form.name ?? ''), v => { form.name = v; changed(); }, { placeholder: 'e.g. MBTR + KRR, grid' });
  nameInput.maxLength = 60;

  const sidebar = h('div.stack',
    null,
    card({ title: 'Run' },
      h('div.stack', null,
        f('name', 'Name', nameInput),
        summary,
        errorList,
        startBtn,
        fh.init() && !fh.init()!.hasStorage ? callout('warn', 'Open a workspace folder: runs are stored in <workspace>/.orbital/ml_runs.') : null)),
    card({
      title: 'Environment', subtitle: 'Python packages of the ML worker',
      actions: [iconButton('refresh', 'Check again', e => void fh.checkEnv(e.currentTarget as HTMLButtonElement))]
    }, envBox));

  const main = h('div.ml-form-grid', null,
    card({ title: 'Data', subtitle: 'Molecules and the target property' }, dataBox),
    card({ title: 'Representation', subtitle: 'Descriptor of each molecule' }, repBox),
    card({ title: 'Model', subtitle: 'Regressor and its hyperparameters', class: 'ml-model-card' }, modelBox),
    card({ title: 'Split and resources', subtitle: 'Train/test split, cross-validation, cores' }, splitBox));

  const renderSummary = () => {
    mount(summary,
      h('div.ml-summary-line', null, h('span.muted', null, 'Pipeline'),
        h('b', null, `${form.rep.name === 'precomputed' ? 'Precomputed' : form.rep.name} → ${form.model.name}${form.model.grid ? ' (grid)' : ''}`)));
  };

  mount(root, h('div.ml-form', null, h('div.ml-form-side', null, sidebar), h('div.ml-form-main', null, main)));
  renderData();
  renderRep();
  renderModel();
  renderSplit();
  renderSummary();
  refreshEnv();
  loadHeader();

  return {
    refreshEnv,
    setForm(nf: MlForm) {
      form = nf;
      header = null;
      nameInput.value = String(form.name ?? '');
      renderData();
      renderRep();
      renderModel();
      renderSplit();
      renderSummary();
      loadHeader();
      validate();
    }
  };
}
