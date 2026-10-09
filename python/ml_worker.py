#!/usr/bin/env python3
"""Orbital Studio ML worker: one run = representation -> model (fixed or grid search) -> metrics.

    python ml_worker.py <runs>/<id>/config.json     run one job (started detached by src/ml/runs.ts)
    python ml_worker.py --check                     print the environment as JSON and exit 0

Generalized from uv-vis/webapp/ml_worker.py and uv-vis/04-ML/compare_models.py (read_xyz, pipeline,
gpr and predict_times are inlined below with the same behavior). Standalone: needs only the packages
listed in --check. Every third-party package is imported inside the function that needs it (numpy
only after the BLAS thread variables are set), so the pure parts (read_xyz, load_target,
validate_config, ...) are importable and testable with numpy + pandas alone, and dscribe/ase and
xgboost are optional (a clear error names the missing package).

CONFIG SCHEMA (version 1). Single source of truth, keep in sync with the header of src/ml/spec.ts,
which builds this JSON (buildConfig):

    {
      "schema": 1,
      "name": str,                         free text, <= 60 chars
      "data": {
        "xyz": str | null,                 multi-XYZ file (absolute path); not needed for rep "precomputed"
        "csv": str,                        CSV with the target values, one row per molecule
        "column": str,                     column name, or a 0-based column index written as digits
                                           (a header name that equals the text exactly wins over the index)
        "header": bool,                    the CSV has a header row (default true; false = index only)
        "n_mol": int | null                use only the first n molecules / rows (null = all)
      },
      "rep": {
        "name": "CM" | "SOAP" | "MBTR" | "precomputed",
        "params": {...},                   scalars only; keys as in SPEC (dscribe constructor arguments).
                                           precomputed: {"path": str} = .npy, .npz (array "X" or the only
                                           array) or .csv/.txt/.dat (numbers, n_mol rows x n_features)
        "variance": bool,                  drop constant features (VarianceThreshold(0))
        "scale": bool                      standardize features (StandardScaler)
      },
      "model": {
        "name": "KRR" | "GPR" | "Ridge" | "Lasso" | "XGBoost",
        "grid": bool,                      true: parameters given as lists are searched by KFold CV (MAE)
        "params": {key: scalar | [scalar, ...]}
      },
      "split": {
        "test_size": float in (0, 1) | int >= 1,   fraction or number of test molecules
        "seed": int,                       random_state of the split and of the CV folds
        "cv": int >= 2,                    CV folds of the grid search
        "curve": [int, ...]                learning-curve training sizes ([] = none)
      },
      "n_jobs": int >= 1,                  BLAS threads and parallel grid-search workers
      "cache_dir": str | null              feature cache folder (null = no cache)
    }

Files written next to config.json (the run folder):
    status.json   {state, step, pid, progress (0..1), started, updated, finished?, error?}
                  state: running | done | failed   (created/starting/stopped are written by runs.ts)
    result.json   {n_features, time_features_s, n_train, n_test, best_params, [grid, cv_mae,
                   time_search_s], time_fit_s, [fitted_kernel], train, test (each {mae, rmse, r2}),
                   time_predict_s, [curve: [{n, test_mae}]], warnings: [str]}
                  written once after the final fit and again after the learning curve
    pred.npz      y_train, y_train_pred, y_test, y_test_pred, idx_train, idx_test (numpy)
    pred.json     the same as lists (non-finite values -> null), for the TypeScript side
    log.txt       stdout + stderr, redirected by the caller
All JSON files are written atomically (temp file + os.replace).
"""
import hashlib
import json
import os
import sys
import time
from itertools import product
from pathlib import Path

SCHEMA = 1
REPS = ("CM", "SOAP", "MBTR", "precomputed")
MODELS = ("KRR", "GPR", "Ridge", "Lasso", "XGBoost")
GPR_BOUNDS = (1e-3, 1e4)   # length-scale bounds when GPR optimizes it
RANDOM_STATE = 42          # random_state of the GaussianProcessRegressor, as in compare_models.py

# distribution name -> import name, reported by --check
PACKAGES = {"numpy": "numpy", "scipy": "scipy", "pandas": "pandas", "scikit-learn": "sklearn",
            "joblib": "joblib", "threadpoolctl": "threadpoolctl", "dscribe": "dscribe", "ase": "ase",
            "xgboost": "xgboost"}
REQUIRED = ("numpy", "scipy", "pandas", "sklearn", "joblib", "threadpoolctl")


class ConfigError(ValueError):
    pass


# ---------------------------------------------------------------- small helpers

def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def write_json(path, obj, indent=None):
    """Atomic JSON write: temp file in the same folder, then os.replace."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, indent=indent, allow_nan=False, default=_json_default), encoding="utf-8")
    for attempt in range(20):   # Windows: the reader may hold the target open for a moment
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.05)


def _json_default(o):
    try:
        import numpy as np
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:
        pass
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def finite_list(a):
    """List of floats with NaN/inf replaced by None (valid JSON)."""
    import math
    return [float(v) if math.isfinite(v) else None for v in (float(x) for x in a)]


def clean(obj):
    """Replace non-finite floats by None, recursively (result.json must be strict JSON)."""
    import math
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if hasattr(obj, "item") and not isinstance(obj, (str, bytes)):
        return clean(obj.item())
    return obj


class Status:
    def __init__(self, run):
        self.file = Path(run) / "status.json"

    def set(self, **kw):
        s = read_json(self.file, {}) or {}
        s.update(kw, updated=now())
        write_json(self.file, s)


# ---------------------------------------------------------------- data (numpy/pandas only)

class Molecule:
    """Minimal stand-in for ase.Atoms: symbols (list of str) and positions (n x 3 array, Angstrom)."""

    def __init__(self, symbols, positions, comment=""):
        import numpy as np
        self.symbols = list(symbols)
        self.positions = np.asarray(positions, dtype=float).reshape(len(self.symbols), 3)
        self.comment = comment

    def __len__(self):
        return len(self.symbols)

    def get_chemical_symbols(self):
        return list(self.symbols)

    def to_ase(self):
        from ase import Atoms
        return Atoms(symbols=self.symbols, positions=self.positions)


def read_xyz(path):
    """Read a multi-molecule XYZ file into a list of Molecule.

    Each block: number of atoms, comment line, then one "symbol x y z" line per atom (extra columns
    are ignored). Blank lines between blocks are skipped. Same format as compare_models.read_xyz,
    with errors that name the line.
    """
    molecules = []
    with open(path, encoding="utf-8", errors="replace") as f:
        lineno = 0

        def nextline():
            nonlocal lineno
            lineno += 1
            return f.readline()

        while line := nextline():
            if not line.strip():
                continue
            try:
                n_atoms = int(line)
            except ValueError:
                raise ValueError(f"{path}:{lineno}: expected the number of atoms, got {line.strip()[:40]!r}")
            comment = nextline().rstrip("\r\n")
            symbols, positions = [], []
            for _ in range(n_atoms):
                row = nextline().split()
                if len(row) < 4:
                    raise ValueError(f"{path}:{lineno}: expected 'symbol x y z' "
                                     f"(molecule {len(molecules) + 1} has {n_atoms} atoms)")
                symbols.append(row[0])
                try:
                    positions.append([float(x) for x in row[1:4]])
                except ValueError:
                    raise ValueError(f"{path}:{lineno}: bad coordinate in {' '.join(row)[:60]!r}")
            molecules.append(Molecule(symbols, positions, comment))
    if not molecules:
        raise ValueError(f"{path}: no molecules found")
    return molecules


def load_target(csv, column, header=True):
    """Target values (float array) from one CSV column, chosen by name or by 0-based index."""
    import pandas as pd
    df = pd.read_csv(csv, header=0 if header else None)
    column = str(column).strip()
    names = [str(c) for c in df.columns]
    if header and column in names:
        col = df.iloc[:, names.index(column)]
    elif column.isdigit():
        i = int(column)
        if i >= df.shape[1]:
            raise ValueError(f"{csv}: column index {i} out of range ({df.shape[1]} columns)")
        col = df.iloc[:, i]
    else:
        raise ValueError(f"{csv}: no column {column!r} (columns: {', '.join(names[:20])})")
    try:
        return col.to_numpy(float)
    except (TypeError, ValueError):
        raise ValueError(f"{csv}: column {column!r} is not numeric")


def load_features(path):
    """Precomputed feature matrix: .npy, .npz (array 'X' or the only array) or a text table."""
    import numpy as np
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".npy":
        X = np.load(p)
    elif ext == ".npz":
        with np.load(p) as z:
            keys = list(z.keys())
            if "X" in keys:
                X = z["X"]
            elif len(keys) == 1:
                X = z[keys[0]]
            else:
                raise ValueError(f"{path}: several arrays ({', '.join(keys)}) and none is named 'X'")
    else:
        import pandas as pd
        sep = "," if ext == ".csv" else r"\s+"
        df = pd.read_csv(p, sep=sep, header=None, comment="#", engine="python")
        if df.shape[0] and not all(_is_number(v) for v in df.iloc[0]):   # header row
            df = df.iloc[1:]
        X = df.to_numpy(float)
    X = np.asarray(X, dtype=float)
    if X.ndim == 1:
        X = X[:, None]
    if X.ndim != 2:
        raise ValueError(f"{path}: expected a 2-D feature matrix, got shape {X.shape}")
    return X


def _is_number(v):
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def load_data(cfg):
    """(molecules or None, X or None, y) with the n_mol cap applied."""
    d, rep = cfg["data"], cfg["rep"]
    y = load_target(d["csv"], d["column"], d.get("header", True))
    n = d.get("n_mol")
    if rep["name"] == "precomputed":
        X = load_features(rep_path(rep))
        if len(X) != len(y):
            raise ValueError(f"{len(X)} feature rows but {len(y)} target values")
        return None, ((X[:n], y[:n]) if n else (X, y))
    mols = read_xyz(d["xyz"])
    if len(mols) != len(y):
        raise ValueError(f"{len(mols)} molecules but {len(y)} target values")
    return ((mols[:n], y[:n]) if n else (mols, y)), None


def rep_path(rep):
    return (rep.get("params") or {}).get("path") or rep.get("path")


# ---------------------------------------------------------------- config validation

def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def validate_config(cfg):
    """List of problems (empty = fine). Checks structure and types, not that files exist."""
    errs = []
    if not isinstance(cfg, dict):
        return ["config is not a JSON object"]
    if cfg.get("schema", SCHEMA) != SCHEMA:
        errs.append(f"schema {cfg.get('schema')!r} is not supported (expected {SCHEMA})")
    for k in ("data", "rep", "model", "split"):
        if not isinstance(cfg.get(k), dict):
            errs.append(f"{k}: missing or not an object")
    if errs:
        return errs
    d, rep, mod, sp = cfg["data"], cfg["rep"], cfg["model"], cfg["split"]
    if rep.get("name") not in REPS:
        errs.append(f"rep.name: unknown representation {rep.get('name')!r}")
    if mod.get("name") not in MODELS:
        errs.append(f"model.name: unknown model {mod.get('name')!r}")
    if not isinstance(d.get("csv"), str) or not d["csv"]:
        errs.append("data.csv: missing")
    if not isinstance(d.get("column"), (str, int)) or str(d.get("column")).strip() == "":
        errs.append("data.column: missing")
    if rep.get("name") == "precomputed":
        if not isinstance(rep_path(rep), str) or not rep_path(rep):
            errs.append("rep.params.path: missing")
    elif not isinstance(d.get("xyz"), str) or not d["xyz"]:
        errs.append("data.xyz: missing")
    n = d.get("n_mol")
    if n is not None and not (_int(n) and n >= 1):
        errs.append("data.n_mol: must be null or an integer >= 1")
    if not isinstance(rep.get("params", {}), dict):
        errs.append("rep.params: not an object")
    else:
        for k, v in rep.get("params", {}).items():
            if isinstance(v, list):
                errs.append(f"rep.params.{k}: lists are not allowed for representation parameters")
    params = mod.get("params")
    if not isinstance(params, dict):
        errs.append("model.params: not an object")
    else:
        for k, v in params.items():
            vals = v if isinstance(v, list) else [v]
            if not vals:
                errs.append(f"model.params.{k}: empty list")
            elif isinstance(v, list) and not mod.get("grid"):
                errs.append(f"model.params.{k}: a list of values is only allowed in grid search mode")
            elif any(not (_num(x) or isinstance(x, (str, bool)) or x is None) for x in vals):
                errs.append(f"model.params.{k}: values must be numbers, strings or booleans")
    t = sp.get("test_size")
    if not (_num(t) and (0 < t < 1 or (_int(t) and t >= 1))):
        errs.append("split.test_size: a fraction in (0, 1) or a count >= 1")
    if not _int(sp.get("seed")):
        errs.append("split.seed: integer")
    if not (_int(sp.get("cv")) and sp["cv"] >= 2):
        errs.append("split.cv: integer >= 2")
    curve = sp.get("curve", [])
    if not isinstance(curve, list) or any(not (_int(c) and c >= 1) for c in curve):
        errs.append("split.curve: list of integers >= 1")
    if not (_int(cfg.get("n_jobs")) and cfg["n_jobs"] >= 1):
        errs.append("n_jobs: integer >= 1")
    if cfg.get("cache_dir") is not None and not isinstance(cfg.get("cache_dir"), str):
        errs.append("cache_dir: string or null")
    return errs


def combos_of(params):
    """All parameter combinations (dicts) of {key: scalar | list}."""
    names = list(params)
    values = [v if isinstance(v, list) else [v] for v in params.values()]
    return names, values, [dict(zip(names, c)) for c in product(*values)]


# ---------------------------------------------------------------- environment check

def check_environment():
    from importlib import metadata
    packages = {}
    for dist, mod in PACKAGES.items():
        try:
            packages[mod] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            packages[mod] = None
    missing = [m for m in REQUIRED if packages.get(m) is None]
    return {"python": ".".join(map(str, sys.version_info[:3])), "executable": sys.executable,
            "packages": packages, "ok": not missing, "missing_required": missing,
            "optional": {"dscribe": "representations CM, SOAP, MBTR (with ase)", "xgboost": "model XGBoost"}}


# ---------------------------------------------------------------- representations (dscribe)

def make_descriptor(rep, mols):
    try:
        from dscribe.descriptors import MBTR, SOAP, CoulombMatrix
    except ImportError as e:
        raise RuntimeError(f"representation {rep['name']} needs the Python package dscribe "
                           f"(pip install dscribe) in the selected interpreter: {e}") from None
    p = dict(rep["params"])
    species = sorted({s for m in mols for s in m.get_chemical_symbols()})
    if rep["name"] == "CM":
        return CoulombMatrix(n_atoms_max=p.get("n_atoms_max") or max(len(m) for m in mols),
                             permutation=p["permutation"])
    if rep["name"] == "SOAP":
        return SOAP(species=species, r_cut=p["r_cut"], n_max=p["n_max"], l_max=p["l_max"],
                    sigma=p["sigma"], average=p["average"], periodic=False)
    return MBTR(species=species, geometry={"function": p["function"]},
                grid={"min": p["min"], "max": p["max"], "n": p["n"], "sigma": p["sigma"]},
                weighting={"function": "exp", "scale": p["scale"], "threshold": p["threshold"]},
                periodic=False, normalization=p["normalization"], dtype="float32")


def cache_key(cfg):
    d, rep = cfg["data"], cfg["rep"]
    try:
        st = os.stat(d["xyz"])
        stamp = [st.st_size, int(st.st_mtime)]
    except OSError:
        stamp = None
    blob = json.dumps([os.path.abspath(d["xyz"]), stamp, d.get("n_mol"), rep["name"], rep["params"]],
                      sort_keys=True)
    return hashlib.md5(blob.encode()).hexdigest()[:16]


def features(cfg, mols):
    import numpy as np
    cache = cfg.get("cache_dir")
    f = Path(cache) / f"{cache_key(cfg)}.npy" if cache else None
    if f is not None and f.exists():
        print(f"features from cache {f}", flush=True)
        return np.load(f)
    atoms = [m.to_ase() for m in mols]
    X = make_descriptor(cfg["rep"], mols).create(atoms, n_jobs=cfg["n_jobs"])
    X = np.array([x.mean(axis=0) if getattr(x, "ndim", 1) == 2 else x for x in X])   # SOAP average=off
    if f is not None:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f".{f.stem}.{os.getpid()}.npy")
        np.save(tmp, X)
        os.replace(tmp, f)
    return X


# ---------------------------------------------------------------- models (scikit-learn)

def pipeline(model):
    """Drop constant features, standardize the rest, then fit the model (compare_models.pipeline)."""
    from sklearn.feature_selection import VarianceThreshold
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    return Pipeline([("filter", VarianceThreshold(0.0)), ("scaler", StandardScaler()), ("model", model)])


def gpr(**kwargs):
    """GaussianProcessRegressor fitted on standardized y (compare_models.gpr)."""
    from sklearn.compose import TransformedTargetRegressor
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.preprocessing import StandardScaler
    return TransformedTargetRegressor(regressor=GaussianProcessRegressor(random_state=RANDOM_STATE, **kwargs),
                                      transformer=StandardScaler())


def predict_times(pipe, X_test):
    """(time of plain predict, time of predict with return_std on the inner GPR or NaN), as in
    compare_models.predict_times."""
    from time import perf_counter
    from sklearn.compose import TransformedTargetRegressor
    if not isinstance(pipe[-1], TransformedTargetRegressor):
        start = perf_counter()
        pipe.predict(X_test)
        return perf_counter() - start, float("nan")
    Xt = pipe[:-1].transform(X_test)
    model = pipe[-1].regressor_
    start = perf_counter()
    model.predict(Xt)
    t1 = perf_counter() - start
    start = perf_counter()
    model.predict(Xt, return_std=True)
    return t1, perf_counter() - start


def estimator(name, p, rep):
    """Pipeline (variance filter, scaler, model) for one set of scalar parameters."""
    from sklearn.pipeline import Pipeline
    if name == "KRR":
        from sklearn.kernel_ridge import KernelRidge
        model = KernelRidge(kernel=p["kernel"], alpha=p["alpha"], gamma=p["gamma"])
    elif name == "Ridge":
        from sklearn.linear_model import Ridge
        model = Ridge(alpha=p["alpha"])
    elif name == "Lasso":
        from sklearn.linear_model import Lasso
        model = Lasso(alpha=p["alpha"], max_iter=10000)
    elif name == "XGBoost":
        try:
            from xgboost import XGBRegressor
        except ImportError as e:
            raise RuntimeError(f"model XGBoost needs the Python package xgboost (pip install xgboost): {e}") \
                from None
        model = XGBRegressor(n_estimators=p["n_estimators"], max_depth=p["max_depth"],
                             learning_rate=p["learning_rate"], n_jobs=1)
    elif name == "GPR":
        from sklearn.gaussian_process.kernels import RBF, Matern
        cls = RBF if p["kernel"] == "RBF" else Matern
        bounds = GPR_BOUNDS if p.get("optimize") else "fixed"
        model = gpr(kernel=cls(p["length_scale"], length_scale_bounds=bounds), alpha=p["alpha"],
                    optimizer="fmin_l_bfgs_b" if p.get("optimize") else None)
    else:
        raise ValueError(f"unknown model {name!r}")
    steps = pipeline(model).steps
    if not rep.get("variance", True):
        steps = [s for s in steps if s[0] != "filter"]
    if not rep.get("scale", True):
        steps = [s for s in steps if s[0] != "scaler"]
    return Pipeline(steps)


def cv_mae(name, p, rep, X, y, folds):
    import numpy as np
    from sklearn.metrics import mean_absolute_error
    errs = []
    for tr, va in folds:
        e = estimator(name, p, rep).fit(X[tr], y[tr])
        errs.append(mean_absolute_error(y[va], e.predict(X[va])))
    return float(np.mean(errs))


def metrics(y, yp):
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    return {"mae": float(mean_absolute_error(y, yp)), "rmse": float(mean_squared_error(y, yp) ** 0.5),
            "r2": float(r2_score(y, yp))}


def grid_search(cfg, combos, X_tr, y_tr, status):
    """CV MAE of every combination, in order; updates the progress while the jobs finish."""
    from joblib import Parallel, delayed
    from sklearn.model_selection import KFold
    mod, rep, sp = cfg["model"], cfg["rep"], cfg["split"]
    folds = list(KFold(sp["cv"], shuffle=True, random_state=sp["seed"]).split(X_tr))
    jobs = (delayed(cv_mae)(mod["name"], c, rep, X_tr, y_tr, folds) for c in combos)
    try:
        gen = Parallel(n_jobs=cfg["n_jobs"], return_as="generator")(jobs)
    except TypeError:   # joblib < 1.3
        return Parallel(n_jobs=cfg["n_jobs"])(jobs)
    scores = []
    for s in gen:
        scores.append(s)
        status.set(progress=round(0.4 + 0.4 * len(scores) / len(combos), 3),
                   step=f"grid search {len(scores)}/{len(combos)} ({sp['cv']}-fold CV)")
    return scores


# ---------------------------------------------------------------- one run

def run(run_dir, cfg, status):
    import numpy as np
    from time import perf_counter
    from joblib import parallel_config
    from sklearn.metrics import mean_absolute_error
    from sklearn.model_selection import train_test_split

    rep, mod, sp = cfg["rep"], cfg["model"], cfg["split"]
    res = {"warnings": []}
    status.set(step="loading data", progress=0.02)
    mol_data, feat_data = load_data(cfg)

    t = perf_counter()
    if feat_data is not None:
        X, y = feat_data
        print(f"precomputed features {X.shape} from {rep_path(rep)}", flush=True)
    else:
        mols, y = mol_data
        print(f"{len(mols)} molecules", flush=True)
        status.set(step=f"features {rep['name']}", progress=0.1)
        X = features(cfg, mols)
    res["time_features_s"] = perf_counter() - t
    res["n_features"] = int(X.shape[1])
    print(f"X {X.shape}, {res['time_features_s']:.1f} s", flush=True)

    idx_tr, idx_te = train_test_split(np.arange(len(y)), test_size=sp["test_size"], shuffle=True,
                                      random_state=sp["seed"])
    X_tr, X_te, y_tr, y_te = X[idx_tr], X[idx_te], y[idx_tr], y[idx_te]
    res["n_train"], res["n_test"] = len(idx_tr), len(idx_te)

    names, values, combos = combos_of(mod["params"])
    best = combos[0]
    if mod["grid"] and len(combos) > 1:
        status.set(step=f"grid search, {len(combos)} combinations x {sp['cv']} folds", progress=0.4)
        t = perf_counter()
        scores = grid_search(cfg, combos, X_tr, y_tr, status)
        res["time_search_s"] = perf_counter() - t
        res["grid"] = [{**c, "cv_mae": s} for c, s in zip(combos, scores)]
        i = int(np.argmin(scores))
        best, res["cv_mae"] = combos[i], scores[i]
        for k, v in zip(names, values):   # optimum at the edge of a numeric grid -> grid may be too narrow
            if len(v) > 1 and not isinstance(v[0], (str, bool)) and best[k] in (min(v), max(v)):
                msg = f"optimum at grid edge: {k}={best[k]}"
                res["warnings"].append(msg)
                print(f"warning: {msg}", flush=True)
        print(f"best {best}, CV MAE {res['cv_mae']:.4g}", flush=True)
    res["best_params"] = best

    status.set(step="final fit", progress=0.82)
    t = perf_counter()
    with parallel_config("loky", inner_max_num_threads=1):
        pipe = estimator(mod["name"], best, rep).fit(X_tr, y_tr)
    res["time_fit_s"] = perf_counter() - t
    if mod["name"] == "GPR":
        res["fitted_kernel"] = str(pipe[-1].regressor_.kernel_)   # differs from the start when optimized
    yp_tr, yp_te = pipe.predict(X_tr), pipe.predict(X_te)
    res["train"], res["test"] = metrics(y_tr, yp_tr), metrics(y_te, yp_te)
    res["time_predict_s"] = predict_times(pipe, X_te)[0]
    print(f"test MAE {res['test']['mae']:.4g}, R2 {res['test']['r2']:.4f}", flush=True)
    np.savez(run_dir / "pred.npz", y_train=y_tr, y_train_pred=yp_tr, y_test=y_te, y_test_pred=yp_te,
             idx_train=idx_tr, idx_test=idx_te)
    write_json(run_dir / "pred.json", {"y_train": finite_list(y_tr), "y_train_pred": finite_list(yp_tr),
                                       "y_test": finite_list(y_te), "y_test_pred": finite_list(yp_te),
                                       "idx_train": [int(i) for i in idx_tr], "idx_test": [int(i) for i in idx_te]})
    write_json(run_dir / "result.json", clean(res), indent=1)   # already usable without the curve

    curve = [n for n in sp.get("curve") or [] if n < len(idx_tr)]
    if sp.get("curve"):
        res["curve"] = []
        for k, n in enumerate(curve):
            status.set(step=f"learning curve n={n}", progress=round(0.9 + 0.1 * k / max(len(curve), 1), 3))
            e = estimator(mod["name"], best, rep).fit(X_tr[:n], y_tr[:n])
            res["curve"].append({"n": int(n), "test_mae": float(mean_absolute_error(y_te, e.predict(X_te)))})
        res["curve"].append({"n": len(idx_tr), "test_mae": res["test"]["mae"]})
        write_json(run_dir / "result.json", clean(res), indent=1)
    return res


def main(argv):
    if len(argv) >= 2 and argv[1] == "--check":
        print(json.dumps(check_environment()), flush=True)
        return 0
    if len(argv) != 2:
        print("usage: ml_worker.py <run>/config.json | --check", file=sys.stderr)
        return 2
    cfg_path = Path(argv[1]).resolve()
    run_dir = cfg_path.parent
    status = Status(run_dir)
    status.set(state="running", pid=os.getpid(), step="start", progress=0.0, started=now())
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        errs = validate_config(cfg)
        if errs:
            raise ConfigError("invalid config: " + "; ".join(errs))
        n_jobs = int(cfg["n_jobs"])
        for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
            os.environ[var] = str(n_jobs)   # before numpy/scipy load their BLAS
        try:
            from threadpoolctl import threadpool_limits
        except ImportError as e:
            raise RuntimeError(f"missing Python package: {e.name} (run 'Check environment')") from None
        with threadpool_limits(n_jobs):
            run(run_dir, cfg, status)
        status.set(state="done", step="done", progress=1.0, finished=now())
        return 0
    except BaseException as e:   # noqa: B902 - also KeyboardInterrupt / SystemExit
        import traceback
        traceback.print_exc()
        if isinstance(e, ImportError):
            msg = f"missing Python package {e.name or e} (run 'Check environment')"
        elif isinstance(e, (RuntimeError, ValueError, OSError)):
            msg = str(e)
        else:
            msg = repr(e)
        status.set(state="failed", step=msg[:300], error=msg[:2000], finished=now())
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
