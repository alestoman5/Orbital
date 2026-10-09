// ML tab: representations, models and their parameters (SPEC), parsing of the form values and the
// config JSON that python/ml_worker.py runs. Pure module: no vscode, no Node, no DOM, so the webview
// can import it too (to build the form from SPEC and validate before sending).
//
// Ported from uv-vis/webapp/v_ml.py (SPEC, parse_values, parse_params, build_config). Differences:
// errors are returned as { field, message }[] instead of raised; the QM7b data source is gone (any
// multi-XYZ + CSV); a 'precomputed' representation reads a feature matrix the user made elsewhere;
// a parameter missing from the form takes its SPEC default; n_mol must be >= 1 (blank = all);
// non-finite numbers (inf, nan) are rejected.
//
// CONFIG SCHEMA (version 1). Single source of truth, keep in sync with the header of
// python/ml_worker.py (validate_config):
//
//   {
//     schema: 1,
//     name: string,                       <= 60 chars
//     data: {
//       xyz: string | null,               multi-XYZ file (absolute path); null for rep 'precomputed'
//       csv: string,                      CSV with one target value per molecule
//       column: string,                   column name, or 0-based index written as digits
//                                         (a header name equal to the text wins over the index)
//       header: boolean,                  the CSV has a header row
//       n_mol: number | null              use only the first n molecules (null = all)
//     },
//     rep: { name: 'CM'|'SOAP'|'MBTR'|'precomputed', params: {key: scalar}, variance: boolean,
//            scale: boolean },            precomputed params: { path: string } (.npy/.npz/.csv/.txt)
//     model: { name: 'KRR'|'GPR'|'Ridge'|'Lasso'|'XGBoost', grid: boolean,
//              params: {key: scalar | scalar[]} },   lists only when grid = true (searched by KFold CV)
//     split: { test_size: number,         fraction in (0, 1) or an integer count >= 1
//              seed: number, cv: number (>= 2), curve: number[] },
//     n_jobs: number,                     1 .. MAX_JOBS (or the maxJobs option)
//     cache_dir: string | null            feature cache folder
//   }

export type ParamType = 'float' | 'int' | 'int?' | 'choice' | 'bool' | 'path';
export type Scalar = number | string | boolean | null;
export type ParamValue = Scalar | Scalar[];

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  /** Default as the form shows it: text for float/int/int?/path, the first choice, or a boolean. */
  default: string | boolean;
  /** Allowed values of a 'choice' parameter (the first is the default). */
  choices?: string[];
  /** Short help for a tooltip. */
  help?: string;
}

export interface MethodSpec {
  name: string;
  label: string;
  /** Optional Python packages this needs besides numpy/scipy/pandas/scikit-learn (names as in --check). */
  requires: string[];
  params: ParamSpec[];
  /** Representation only: it needs data.xyz (false for 'precomputed'). */
  needsXyz?: boolean;
}

export const REP_NAMES = ['CM', 'SOAP', 'MBTR', 'precomputed'] as const;
export const MODEL_NAMES = ['KRR', 'GPR', 'Ridge', 'Lasso', 'XGBoost'] as const;
export type RepName = (typeof REP_NAMES)[number];
export type ModelName = (typeof MODEL_NAMES)[number];

export const CONFIG_SCHEMA = 1;
export const MAX_JOBS = 16;
export const NAME_MAX = 60;
/** Python packages the worker cannot run without (keys of the --check `packages` object). */
export const REQUIRED_PACKAGES = ['numpy', 'scipy', 'pandas', 'sklearn', 'joblib', 'threadpoolctl'];

const f = (key: string, label: string, def: string, help?: string): ParamSpec => ({ key, label, type: 'float', default: def, help });
const i = (key: string, label: string, def: string, help?: string): ParamSpec => ({ key, label, type: 'int', default: def, help });
const c = (key: string, label: string, choices: string[], help?: string): ParamSpec =>
  ({ key, label, type: 'choice', default: choices[0], choices, help });

export const SPEC: { rep: Record<RepName, MethodSpec>; model: Record<ModelName, MethodSpec> } = {
  rep: {
    CM: {
      name: 'CM', label: 'Coulomb matrix', requires: ['dscribe', 'ase'], needsXyz: true,
      params: [
        c('permutation', 'permutation', ['sorted_l2', 'eigenspectrum']),
        { key: 'n_atoms_max', label: 'n_atoms_max (blank = largest molecule)', type: 'int?', default: '' }
      ]
    },
    SOAP: {
      name: 'SOAP', label: 'SOAP', requires: ['dscribe', 'ase'], needsXyz: true,
      params: [
        f('r_cut', 'r_cut', '5.0', 'cutoff radius / Å'), i('n_max', 'n_max', '4'), i('l_max', 'l_max', '4'),
        f('sigma', 'sigma', '1.0', 'Gaussian width / Å'),
        c('average', 'average (off = mean over atoms)', ['off', 'inner', 'outer'])
      ]
    },
    MBTR: {
      name: 'MBTR', label: 'MBTR', requires: ['dscribe', 'ase'], needsXyz: true,
      params: [
        c('function', 'geometry function', ['inverse_distance', 'distance']),
        f('min', 'grid min', '0.0'), f('max', 'grid max', '2.5'), i('n', 'grid n', '150'),
        f('sigma', 'grid sigma', '0.05'), f('scale', 'weighting scale', '0.5'),
        f('threshold', 'weighting threshold', '1e-3'),
        c('normalization', 'normalization', ['l2', 'none'])
      ]
    },
    precomputed: {
      name: 'precomputed', label: 'Precomputed features', requires: [], needsXyz: false,
      params: [{
        key: 'path', label: 'feature matrix (.npy, .npz, .csv, .txt)', type: 'path', default: '',
        help: 'one row per molecule, in the order of the target CSV'
      }]
    }
  },
  model: {
    KRR: {
      name: 'KRR', label: 'Kernel ridge regression', requires: [],
      params: [c('kernel', 'kernel', ['rbf', 'laplacian']), f('alpha', 'alpha', '1e-3'), f('gamma', 'gamma', '1e-4')]
    },
    GPR: {
      name: 'GPR', label: 'Gaussian process regression', requires: [],
      params: [
        c('kernel', 'kernel', ['RBF', 'Matern']), f('length_scale', 'length scale', '100'),
        f('alpha', 'alpha (noise)', '1e-4'),
        { key: 'optimize', label: 'optimize length scale (ignores grid values of it)', type: 'bool', default: false }
      ]
    },
    Ridge: { name: 'Ridge', label: 'Ridge regression', requires: [], params: [f('alpha', 'alpha', '1.0')] },
    Lasso: { name: 'Lasso', label: 'Lasso', requires: [], params: [f('alpha', 'alpha', '1e-3')] },
    XGBoost: {
      name: 'XGBoost', label: 'XGBoost', requires: ['xgboost'],
      params: [i('n_estimators', 'n_estimators', '300'), i('max_depth', 'max_depth', '6'),
        f('learning_rate', 'learning_rate', '0.1')]
    }
  }
};

// ------------------------------------------------------------------ the form (what the UI sends)

/** Raw form values. Text fields are strings exactly as typed; numbers are accepted too. */
export interface MlForm {
  name?: string;
  data: { xyz?: string; csv: string; column: string | number; header?: boolean; n_mol?: string | number | null };
  rep: { name: string; params?: Record<string, unknown>; variance?: boolean; scale?: boolean };
  model: { name: string; params?: Record<string, unknown>; grid?: boolean };
  split: { test_size: string | number; seed: string | number; cv: string | number; curve?: string };
  n_jobs: string | number;
}

/** Form defaults, as in the original web form. */
export function defaultForm(rep: RepName = 'MBTR', model: ModelName = 'KRR'): MlForm {
  return {
    name: '',
    data: { xyz: '', csv: '', column: '0', header: true, n_mol: '' },
    rep: { name: rep, params: defaultParams(SPEC.rep[rep]), variance: true, scale: true },
    model: { name: model, params: defaultParams(SPEC.model[model]), grid: false },
    split: { test_size: '0.2', seed: '42', cv: '5', curve: '' },
    n_jobs: '8'
  };
}

export function defaultParams(m: MethodSpec): Record<string, string | boolean> {
  return Object.fromEntries(m.params.map(p => [p.key, p.default]));
}

export interface ConfigError {
  /** Dotted path of the form field, e.g. 'model.params.alpha', 'split.test_size', 'data.csv'. */
  field: string;
  message: string;
}

export interface MlConfig {
  schema: 1;
  name: string;
  data: { xyz: string | null; csv: string; column: string; header: boolean; n_mol: number | null };
  rep: { name: RepName; params: Record<string, Scalar>; variance: boolean; scale: boolean };
  model: { name: ModelName; grid: boolean; params: Record<string, ParamValue> };
  split: { test_size: number; seed: number; cv: number; curve: number[] };
  n_jobs: number;
  cache_dir: string | null;
}

export interface BuildOptions {
  /** Feature cache folder written into the config (null/undefined = no cache). */
  cacheDir?: string | null;
  /** Upper bound for n_jobs (default MAX_JOBS). */
  maxJobs?: number;
  /** When given, data files are checked with it ('file not found: ...'). */
  fileExists?: (path: string) => boolean;
}

// ------------------------------------------------------------------ number parsing (Python semantics)

const PY_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*|\d(?:_?\d)*\.)(?:[eE][+-]?\d(?:_?\d)*)?$/;

/** Python float(text) for finite values; throws on anything Python would reject (and on inf/nan). */
export function pyFloat(text: string): number {
  const t = text.trim();
  if (!PY_FLOAT.test(t)) {
    if (/^[+-]?(inf|infinity|nan)$/i.test(t)) throw new Error(`non-finite value '${t}'`);
    throw new Error(`could not convert string to float: '${text}'`);
  }
  const v = Number(t.replace(/_/g, ''));
  if (!Number.isFinite(v)) throw new Error(`value out of range: '${t}'`);
  return v;
}

/** Python int(text): optional sign, digits (underscores between digits allowed), surrounding blanks. */
export function pyInt(text: string): number {
  const t = text.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${text}'`);
  const v = Number(t.replace(/_/g, ''));
  if (!Number.isSafeInteger(v)) throw new Error(`integer out of range: '${t}'`);
  return v;
}

/** Python format(x, '.6g') then float(): 6 significant digits. */
function sig6(x: number): number {
  return Number(x.toPrecision(6));
}

/**
 * Value(s) of one numeric field, as v_ml.parse_values:
 *   '1e-3'        -> 0.001
 *   '1,2,3'       -> [1, 2, 3]            (a list only when there are several values)
 *   'log:-8,0,9'  -> 9 values 1e-8 ... 1 (log-spaced, rounded to 6 significant digits)
 *   type 'int' / 'int?' truncates toward zero; 'int?' with blank text -> null.
 * Throws Error with a Python-like message on bad input.
 */
export function parseValues(text: string, type: ParamType): number | number[] | null {
  text = text.trim();
  if (type === 'int?' && !text) return null;
  let vals: number[];
  if (text.startsWith('log:')) {
    const parts = text.slice(4).split(',');
    if (parts.length !== 3) throw new Error(`log:a,b,n needs exactly 3 numbers, got ${parts.length}`);
    const [a, b, nf] = parts.map(pyFloat);
    const n = Math.trunc(nf);
    if (n < 2) throw new Error('log:a,b,n needs n >= 2');
    vals = Array.from({ length: n }, (_, k) => sig6(10 ** (a + (b - a) * k / (n - 1))));
  } else {
    vals = text.split(',').map(pyFloat);
  }
  if (type === 'int' || type === 'int?') vals = vals.map(v => Math.trunc(v) || 0);   // || 0: no -0
  return vals.length > 1 ? vals : vals[0];
}

function truthy(v: unknown): boolean {
  if (typeof v === 'string') return !['', 'false', 'off', '0', 'no'].includes(v.trim().toLowerCase());
  return Boolean(v);
}

/**
 * Parameters of one representation or model, as v_ml.parse_params. Choice values must be one of the
 * choices; bool is truthiness (strings 'false', 'off', '0', 'no', '' are false); numeric fields go
 * through parseValues; a list is an error unless allowList. Missing keys take the SPEC default.
 */
export function parseParams(spec: ParamSpec[], given: Record<string, unknown> | undefined, allowList: boolean,
  fieldPrefix = 'params'): { params: Record<string, ParamValue>; errors: ConfigError[] } {
  const params: Record<string, ParamValue> = {};
  const errors: ConfigError[] = [];
  for (const p of spec) {
    const field = `${fieldPrefix}.${p.key}`;
    const v = given && Object.prototype.hasOwnProperty.call(given, p.key) && given[p.key] !== undefined
      ? given[p.key] : p.default;
    if (p.type === 'choice') {
      if (typeof v !== 'string' || !p.choices!.includes(v)) errors.push({ field, message: `${p.label}: invalid choice` });
      else params[p.key] = v;
    } else if (p.type === 'bool') {
      params[p.key] = truthy(v);
    } else if (p.type === 'path') {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s) errors.push({ field, message: `${p.label}: required` });
      else params[p.key] = s;
    } else {
      try {
        const val = parseValues(String(v), p.type);
        if (Array.isArray(val) && !allowList) {
          errors.push({ field, message: `${p.label}: a list of values is only allowed in grid search mode` });
        } else {
          params[p.key] = val;
        }
      } catch (e) {
        errors.push({ field, message: `${p.label}: ${(e as Error).message}` });
      }
    }
  }
  return { params, errors };
}

function toText(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Number of parameter combinations a grid search over these params runs. */
export function gridSize(params: Record<string, ParamValue>): number {
  return Object.values(params).reduce<number>((n, v) => n * (Array.isArray(v) ? v.length : 1), 1);
}

/**
 * The worker config from the form (as v_ml.build_config), or the list of problems.
 * Paths are taken as given: the host resolves them (inside the workspace) before calling this.
 */
export function buildConfig(form: MlForm, opts: BuildOptions = {}):
  { config: MlConfig; errors: [] } | { config: null; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  const num = <T>(field: string, label: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      err(field, `${label}: ${(e as Error).message}`);
      return undefined;
    }
  };
  if (!form || typeof form !== 'object' || !form.data || !form.rep || !form.model || !form.split) {
    return { config: null, errors: [{ field: '', message: 'incomplete form' }] };
  }

  const repName = form.rep.name as RepName;
  const modelName = form.model.name as ModelName;
  const repSpec = (REP_NAMES as readonly string[]).includes(repName) ? SPEC.rep[repName] : undefined;
  const modelSpec = (MODEL_NAMES as readonly string[]).includes(modelName) ? SPEC.model[modelName] : undefined;
  if (!repSpec) err('rep.name', `unknown representation '${toText(form.rep.name)}'`);
  if (!modelSpec) err('model.name', `unknown model '${toText(form.model.name)}'`);

  // data
  const d = form.data;
  const xyz = toText(d.xyz).trim();
  const csv = toText(d.csv).trim();
  const column = toText(d.column).trim();
  const header = d.header === undefined ? true : Boolean(d.header);
  if (repSpec?.needsXyz !== false && !xyz) err('data.xyz', 'multi-XYZ file: required');
  if (!csv) err('data.csv', 'targets CSV: required');
  if (!column) err('data.column', 'column: required (name or 0-based index)');
  else if (!header && !/^\d+$/.test(column)) err('data.column', 'column: without a header row give a 0-based index');
  const files: [string, string][] = [['data.csv', csv]];
  if (repSpec?.needsXyz !== false) files.push(['data.xyz', xyz]);
  if (opts.fileExists) {
    for (const [field, p] of files) if (p && !opts.fileExists(p)) err(field, `file not found: ${p}`);
  }
  let n_mol: number | null = null;
  const nText = toText(d.n_mol).trim();
  if (nText) {
    const n = num('data.n_mol', 'first N molecules', () => pyInt(nText));
    if (n !== undefined && n < 1) err('data.n_mol', 'first N molecules: must be >= 1 (blank = all)');
    else if (n !== undefined) n_mol = n;
  }

  // representation and model parameters
  const rep = repSpec ? parseParams(repSpec.params, form.rep.params, false, 'rep.params') : { params: {}, errors: [] };
  const grid = Boolean(form.model.grid);
  const model = modelSpec ? parseParams(modelSpec.params, form.model.params, grid, 'model.params') : { params: {}, errors: [] };
  errors.push(...rep.errors, ...model.errors);
  if (repSpec?.name === 'precomputed' && opts.fileExists && typeof rep.params.path === 'string'
    && !opts.fileExists(rep.params.path)) {
    err('rep.params.path', `file not found: ${rep.params.path}`);
  }

  // split
  const s = form.split;
  let test_size = num('split.test_size', 'test size', () => pyFloat(toText(s.test_size)));
  if (test_size !== undefined) {
    if (test_size <= 0) err('split.test_size', 'test size: a fraction in (0, 1) or a count >= 1');
    else if (test_size >= 1) test_size = Math.trunc(test_size);
  }
  const seed = num('split.seed', 'random seed', () => pyInt(toText(s.seed)));
  const cv = num('split.cv', 'CV folds', () => pyInt(toText(s.cv)));
  if (cv !== undefined && cv < 2) err('split.cv', 'CV folds: at least 2');
  const curve: number[] = [];
  for (const part of toText(s.curve).split(',')) {
    if (!part.trim()) continue;
    const n = num('split.curve', 'learning curve sizes', () => pyInt(part));
    if (n !== undefined && n < 1) err('split.curve', 'learning curve sizes: must be >= 1');
    else if (n !== undefined) curve.push(n);
  }
  const maxJobs = Math.max(1, Math.trunc(opts.maxJobs ?? MAX_JOBS));
  const jobs = num('n_jobs', 'cores', () => pyInt(toText(form.n_jobs)));
  const n_jobs = jobs === undefined ? 1 : Math.max(1, Math.min(maxJobs, jobs));

  if (errors.length) return { config: null, errors };
  return {
    config: {
      schema: CONFIG_SCHEMA,
      name: toText(form.name).trim().slice(0, NAME_MAX),
      data: { xyz: repSpec!.needsXyz === false ? (xyz || null) : xyz, csv, column, header, n_mol },
      rep: {
        name: repSpec!.name as RepName, variance: form.rep.variance === undefined ? true : Boolean(form.rep.variance),
        scale: form.rep.scale === undefined ? true : Boolean(form.rep.scale), params: rep.params as Record<string, Scalar>
      },
      model: { name: modelSpec!.name as ModelName, grid, params: model.params },
      split: { test_size: test_size!, seed: seed!, cv: cv!, curve },
      n_jobs,
      cache_dir: opts.cacheDir ?? null
    },
    errors: []
  };
}

/** Short target description for tables: 'targets.csv:E'. */
export function targetLabel(cfg: Pick<MlConfig, 'data'>): string {
  const base = cfg.data.csv.split(/[\\/]/).pop() ?? cfg.data.csv;
  return `${base}:${cfg.data.column}`;
}
