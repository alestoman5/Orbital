"""Records expected outputs of uv-vis/webapp/v_ml.py for test/ml/spec.test.ts.

    python test/fixtures/ml/v_ml_parity.py      -> writes v_ml_parity.json next to this file

SPEC, parse_values, parse_params and build_config below are copied VERBATIM from v_ml.py
(v_ml imports matplotlib and the web app's common module, so it is not imported). Only the
QM7B_TARGETS / MAX_JOBS constants and the file existence check are as in the original too; the
script creates the two data files it needs in a temp folder.
"""
import json
import tempfile
from pathlib import Path

MAX_JOBS = 16
QM7B_TARGETS = ["atomization_energy", "first_excitation_energy"]
# (key, label, default, type); type: float | int | int? (blank = automatic) | list of choices | bool
SPEC = {
    "rep": {
        "CM": [("permutation", "permutation", ["sorted_l2", "eigenspectrum"], "choice"),
               ("n_atoms_max", "n_atoms_max (blank = largest molecule)", "", "int?")],
        "SOAP": [("r_cut", "r_cut", "5.0", "float"), ("n_max", "n_max", "4", "int"),
                 ("l_max", "l_max", "4", "int"), ("sigma", "sigma", "1.0", "float"),
                 ("average", "average (off = mean over atoms)", ["off", "inner", "outer"], "choice")],
        "MBTR": [("function", "geometry function", ["inverse_distance", "distance"], "choice"),
                 ("min", "grid min", "0.0", "float"), ("max", "grid max", "2.5", "float"),
                 ("n", "grid n", "150", "int"), ("sigma", "grid sigma", "0.05", "float"),
                 ("scale", "weighting scale", "0.5", "float"), ("threshold", "weighting threshold", "1e-3", "float"),
                 ("normalization", "normalization", ["l2", "none"], "choice")],
    },
    "model": {
        "KRR": [("kernel", "kernel", ["rbf", "laplacian"], "choice"), ("alpha", "alpha", "1e-3", "float"),
                ("gamma", "gamma", "1e-4", "float")],
        "GPR": [("kernel", "kernel", ["RBF", "Matern"], "choice"), ("length_scale", "length scale", "100", "float"),
                ("alpha", "alpha (noise)", "1e-4", "float"),
                ("optimize", "optimize length scale (ignores grid values of it)", False, "bool")],
        "Ridge": [("alpha", "alpha", "1.0", "float")],
        "Lasso": [("alpha", "alpha", "1e-3", "float")],
        "XGBoost": [("n_estimators", "n_estimators", "300", "int"), ("max_depth", "max_depth", "6", "int"),
                    ("learning_rate", "learning_rate", "0.1", "float")],
    },
}


def parse_values(text, typ):
    """'1e-3' -> scalar, '1,2,3' -> list, 'log:-8,0,9' -> 9 values 1e-8 ... 1."""
    text = text.strip()
    if typ == "int?" and not text:
        return None
    if text.startswith("log:"):
        a, b, n = (float(x) for x in text[4:].split(","))
        vals = [float(f"{10 ** (a + (b - a) * i / (int(n) - 1)):.6g}") for i in range(int(n))]
    else:
        vals = [float(x) for x in text.split(",")]
    if typ.startswith("int"):
        vals = [int(v) for v in vals]
    return vals if len(vals) > 1 else vals[0]


def parse_params(spec, given, allow_list):
    out = {}
    for key, label, default, typ in spec:
        v = given.get(key)
        if typ == "choice":
            if v not in default:
                raise ValueError(f"{label}: invalid choice")
            out[key] = v
        elif typ == "bool":
            out[key] = bool(v)
        else:
            out[key] = parse_values(str(v), typ)
            if isinstance(out[key], list) and not allow_list:
                raise ValueError(f"{label}: a list of values is only allowed in grid search mode")
    return out


def build_config(f):
    d = f["data"]
    data = {"source": d["source"], "n_mol": int(d["n_mol"]) if d["n_mol"].strip() else None}
    if d["source"] == "qm7b":
        if d["qm7b_target"] not in QM7B_TARGETS:
            raise ValueError("unknown QM7b target")
        data["qm7b_target"] = d["qm7b_target"]
    else:
        for k in ("xyz", "csv"):
            if not Path(d[k]).is_file():
                raise ValueError(f"file not found: {d[k]}")
        data.update(xyz=d["xyz"], csv=d["csv"], column=d["column"].strip())
    r, m = f["rep"], f["model"]
    if r["name"] not in SPEC["rep"] or m["name"] not in SPEC["model"]:
        raise ValueError("unknown representation or model")
    s = f["split"]
    test = float(s["test_size"])
    curve = [int(x) for x in s["curve"].split(",") if x.strip()]
    jobs = max(1, min(MAX_JOBS, int(f["n_jobs"])))
    return {"name": f["name"].strip()[:60], "data": data,
            "rep": {"name": r["name"], "variance": bool(r["variance"]), "scale": bool(r["scale"]),
                    "params": parse_params(SPEC["rep"][r["name"]], r["params"], False)},
            "model": {"name": m["name"], "grid": bool(m["grid"]),
                      "params": parse_params(SPEC["model"][m["name"]], m["params"], bool(m["grid"]))},
            "split": {"test_size": test if test < 1 else int(test), "seed": int(s["seed"]),
                      "cv": int(s["cv"]), "curve": curve},
            "n_jobs": jobs}


# ------------------------------------------------------------------ cases (not from v_ml.py)

VALUE_CASES = [
    ("1e-3", "float"), (" 2.5 ", "float"), ("1,2,3", "float"), ("1, 2 ,3", "int"), ("log:-8,0,9", "float"),
    ("log:-10,0,11", "float"), ("log:0,3,4", "int"), ("log:-2,2,5", "float"), ("log:1,2,3.7", "float"),
    ("log: -3, -1, 7", "float"), ("", "int?"), ("  ", "int?"), ("23", "int?"), ("2.7", "int"), ("-2.7", "int"),
    ("1e3", "int"), ("1_000", "float"), (".5", "float"), ("5.", "float"), ("+3", "float"), ("-0.5", "int"),
    ("0.1,0.2,0.30000000000000004", "float"), ("log:-5,-1,13", "float"), ("log:-7,3,21", "float"),
    ("x", "float"), ("", "float"), ("1,,2", "float"), ("log:1,2", "float"), ("log:0,1,1", "float"),
]


def outcome(fn):
    try:
        return {"ok": fn()}
    except Exception as e:   # noqa: BLE001
        return {"error": type(e).__name__}


def form(**over):
    f = {"name": "  my run  ",
         "data": {"source": "custom", "xyz": XYZ, "csv": CSV, "column": " E ", "n_mol": "100",
                  "qm7b_target": ""},
         "rep": {"name": "MBTR", "variance": True, "scale": False,
                 "params": {"function": "inverse_distance", "min": "0.0", "max": "2.5", "n": "150",
                            "sigma": "0.05", "scale": "0.5", "threshold": "1e-3", "normalization": "l2"}},
         "model": {"name": "KRR", "grid": True,
                   "params": {"kernel": "rbf", "alpha": "log:-8,0,9", "gamma": "1e-4,1e-3"}},
         "split": {"test_size": "0.2", "seed": "42", "cv": "5", "curve": "100, 300,,1000"},
         "n_jobs": "8"}
    for path, v in over.items():
        node = f
        keys = path.split(".")
        for k in keys[:-1]:
            node = node[k]
        node[keys[-1]] = v
    return f


tmp = Path(tempfile.mkdtemp())
XYZ, CSV = str(tmp / "m.xyz"), str(tmp / "y.csv")
Path(XYZ).write_text("1\n\nH 0 0 0\n")
Path(CSV).write_text("E\n1\n")

CONFIG_CASES = {
    "mbtr_krr_grid": {},
    "test_count": {"split.test_size": "2211.7"},
    "n_mol_blank_jobs_clamped": {"data.n_mol": "", "n_jobs": "99"},
    "jobs_low": {"n_jobs": "0"},
    "cm_auto_atoms": {"rep.name": "CM", "rep.params": {"permutation": "eigenspectrum", "n_atoms_max": ""}},
    "soap": {"rep.name": "SOAP", "rep.params": {"r_cut": "4.5", "n_max": "6", "l_max": "3", "sigma": "0.5",
                                                "average": "inner"}},
    "gpr_optimize": {"model.name": "GPR", "model.grid": False,
                     "model.params": {"kernel": "Matern", "length_scale": "10", "alpha": "1e-6", "optimize": True}},
    "xgb": {"model.name": "XGBoost", "model.grid": False,
            "model.params": {"n_estimators": "100", "max_depth": "4.9", "learning_rate": "0.05"}},
    "list_without_grid": {"model.grid": False},
    "bad_choice": {"model.params": {"kernel": "poly", "alpha": "1", "gamma": "1"}},
    "rep_list": {"rep.params": {"function": "distance", "min": "0,1", "max": "2.5", "n": "150", "sigma": "0.05",
                                "scale": "0.5", "threshold": "1e-3", "normalization": "none"}},
    "bad_float": {"model.params": {"kernel": "rbf", "alpha": "abc", "gamma": "1"}},
    "unknown_model": {"model.name": "SVR"},
}

out = {"values": [{"text": t, "type": ty, **outcome(lambda: parse_values(t, ty))} for t, ty in VALUE_CASES],
       "configs": {}}
for name, over in CONFIG_CASES.items():
    f = form(**over)
    res = outcome(lambda: build_config(f))
    if "ok" in res:   # paths of this script's temp folder are not part of the comparison
        res["ok"]["data"] = {k: v for k, v in res["ok"]["data"].items() if k not in ("xyz", "csv")}
    out["configs"][name] = {"form": json.loads(json.dumps(f).replace(XYZ.replace("\\", "\\\\"), "XYZ")
                                               .replace(CSV.replace("\\", "\\\\"), "CSV")), **res}
Path(__file__).with_name("v_ml_parity.json").write_text(json.dumps(out, indent=1) + "\n")
print(f"{len(out['values'])} value cases, {len(out['configs'])} config cases")
