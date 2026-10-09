"""Unit tests of ml_worker.py:  python -m unittest python/test_ml_worker.py

The pure parts need only numpy and pandas. The end-to-end runs are skipped when scikit-learn
(precomputed features) or dscribe (Coulomb matrix) is not installed in this interpreter.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE / "ml_worker.py"
sys.path.insert(0, str(HERE))
import ml_worker as w  # noqa: E402

HAVE_SKLEARN = all(importlib.util.find_spec(m) for m in ("sklearn", "joblib", "threadpoolctl"))
HAVE_DSCRIBE = HAVE_SKLEARN and all(importlib.util.find_spec(m) for m in ("dscribe", "ase"))

XYZ = """3
water 1
O 0.0 0.0 0.0
H 0.0 0.757 0.587
H 0.0 -0.757 0.587

2
h2   extra columns are ignored
H 0 0 0 0.1 0.2
H 0 0 0.74 0.1 0.2
"""


def base_config(tmp, **over):
    cfg = {"schema": 1, "name": "t",
           "data": {"xyz": str(tmp / "m.xyz"), "csv": str(tmp / "y.csv"), "column": "E", "header": True,
                    "n_mol": None},
           "rep": {"name": "CM", "params": {"permutation": "sorted_l2", "n_atoms_max": None},
                   "variance": True, "scale": True},
           "model": {"name": "KRR", "grid": False, "params": {"kernel": "rbf", "alpha": 1e-3, "gamma": 1e-4}},
           "split": {"test_size": 0.2, "seed": 42, "cv": 5, "curve": []},
           "n_jobs": 1, "cache_dir": None}
    for k, v in over.items():
        cfg[k] = v
    return cfg


class Tmp(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)

    def tearDown(self):
        self._td.cleanup()


class ReadXyz(Tmp):
    def test_blocks_comments_and_extra_columns(self):
        (self.tmp / "m.xyz").write_text(XYZ)
        mols = w.read_xyz(self.tmp / "m.xyz")
        self.assertEqual(len(mols), 2)
        self.assertEqual(mols[0].get_chemical_symbols(), ["O", "H", "H"])
        self.assertEqual(mols[0].comment, "water 1")
        self.assertEqual(mols[1].positions.shape, (2, 3))
        self.assertAlmostEqual(mols[1].positions[1, 2], 0.74)
        self.assertEqual(len(mols[0]), 3)

    def test_crlf(self):
        (self.tmp / "m.xyz").write_bytes(XYZ.replace("\n", "\r\n").encode())
        self.assertEqual(len(w.read_xyz(self.tmp / "m.xyz")), 2)

    def test_errors_name_the_line(self):
        (self.tmp / "a.xyz").write_text("2\nc\nH 0 0 0\n")
        with self.assertRaisesRegex(ValueError, r"a\.xyz:4"):
            w.read_xyz(self.tmp / "a.xyz")
        (self.tmp / "b.xyz").write_text("x\n")
        with self.assertRaisesRegex(ValueError, "number of atoms"):
            w.read_xyz(self.tmp / "b.xyz")
        (self.tmp / "c.xyz").write_text("\n\n")
        with self.assertRaisesRegex(ValueError, "no molecules"):
            w.read_xyz(self.tmp / "c.xyz")


class LoadTarget(Tmp):
    def test_by_name_index_and_headerless(self):
        (self.tmp / "y.csv").write_text("id,E,gap\n0,1.5,3\n1,2.5,4\n")
        self.assertEqual(w.load_target(self.tmp / "y.csv", "E").tolist(), [1.5, 2.5])
        self.assertEqual(w.load_target(self.tmp / "y.csv", "2").tolist(), [3.0, 4.0])
        self.assertEqual(w.load_target(self.tmp / "y.csv", " gap ").tolist(), [3.0, 4.0])
        (self.tmp / "n.csv").write_text("1.0,7\n2.0,8\n")
        self.assertEqual(w.load_target(self.tmp / "n.csv", "1", header=False).tolist(), [7.0, 8.0])

    def test_header_name_wins_over_index(self):
        (self.tmp / "y.csv").write_text("a,0\n5,6\n")
        self.assertEqual(w.load_target(self.tmp / "y.csv", "0").tolist(), [6.0])

    def test_errors(self):
        (self.tmp / "y.csv").write_text("id,E,s\n0,1.5,x\n")
        with self.assertRaisesRegex(ValueError, "no column 'F'"):
            w.load_target(self.tmp / "y.csv", "F")
        with self.assertRaisesRegex(ValueError, "out of range"):
            w.load_target(self.tmp / "y.csv", "7")
        with self.assertRaisesRegex(ValueError, "not numeric"):
            w.load_target(self.tmp / "y.csv", "s")


class LoadFeatures(Tmp):
    def test_formats(self):
        import numpy as np
        X = np.arange(6.0).reshape(3, 2)
        np.save(self.tmp / "X.npy", X)
        np.savez(self.tmp / "X.npz", X=X, other=X[:1])
        np.savez(self.tmp / "one.npz", feats=X)
        (self.tmp / "X.csv").write_text("f1,f2\n0,1\n2,3\n4,5\n")
        (self.tmp / "X.txt").write_text("# comment\n0 1\n2 3\n4 5\n")
        for name in ("X.npy", "X.npz", "one.npz", "X.csv", "X.txt"):
            self.assertEqual(w.load_features(self.tmp / name).tolist(), X.tolist(), name)
        np.savez(self.tmp / "two.npz", a=X, b=X)
        with self.assertRaisesRegex(ValueError, "none is named 'X'"):
            w.load_features(self.tmp / "two.npz")


class Config(Tmp):
    def test_valid(self):
        self.assertEqual(w.validate_config(base_config(self.tmp)), [])

    def test_problems(self):
        cfg = base_config(self.tmp)
        cfg["rep"]["name"] = "XX"
        cfg["model"]["params"]["alpha"] = [1, 2]
        cfg["split"].update(test_size=0, cv=1, curve=[10, -1])
        cfg["data"]["n_mol"] = 0
        cfg["n_jobs"] = 0
        errs = "\n".join(w.validate_config(cfg))
        for frag in ("rep.name", "grid search mode", "test_size", "split.cv", "split.curve", "n_mol", "n_jobs"):
            self.assertIn(frag, errs)
        self.assertEqual(w.validate_config([]), ["config is not a JSON object"])
        self.assertIn("data: missing or not an object", w.validate_config({"rep": {}, "model": {}, "split": {}}))

    def test_precomputed_needs_path_not_xyz(self):
        cfg = base_config(self.tmp, rep={"name": "precomputed", "params": {}, "variance": True, "scale": True})
        cfg["data"]["xyz"] = None
        self.assertEqual(w.validate_config(cfg), ["rep.params.path: missing"])
        cfg["rep"]["params"]["path"] = "X.npy"
        self.assertEqual(w.validate_config(cfg), [])

    def test_combos(self):
        names, values, combos = w.combos_of({"a": [1, 2], "k": "rbf", "g": [3, 4, 5]})
        self.assertEqual(names, ["a", "k", "g"])
        self.assertEqual(len(combos), 6)
        self.assertEqual(combos[0], {"a": 1, "k": "rbf", "g": 3})

    def test_atomic_json_and_clean(self):
        w.write_json(self.tmp / "s.json", w.clean({"a": float("nan"), "b": [1.0, float("inf")]}))
        self.assertEqual(json.loads((self.tmp / "s.json").read_text()), {"a": None, "b": [1.0, None]})
        self.assertEqual([p.name for p in self.tmp.iterdir()], ["s.json"])


class Cli(Tmp):
    def test_check(self):
        r = subprocess.run([sys.executable, str(WORKER), "--check"], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        info = json.loads(r.stdout)
        self.assertRegex(info["python"], r"^3\.\d+\.\d+$")
        for k in ("numpy", "sklearn", "dscribe", "xgboost", "pandas", "scipy"):
            self.assertIn(k, info["packages"])
        self.assertIsNotNone(info["packages"]["numpy"])

    def test_invalid_config_fails_with_status(self):
        run = self.tmp / "run1"
        run.mkdir()
        (run / "config.json").write_text(json.dumps({"schema": 1}))
        r = subprocess.run([sys.executable, str(WORKER), str(run / "config.json")], capture_output=True,
                           text=True, timeout=60)
        self.assertEqual(r.returncode, 1)
        st = json.loads((run / "status.json").read_text())
        self.assertEqual(st["state"], "failed")
        self.assertIn("invalid config", st["error"])
        self.assertEqual(st["pid"] > 0, True)


def run_worker(cfg, run):
    run.mkdir()
    (run / "config.json").write_text(json.dumps(cfg))
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    return subprocess.run([sys.executable, str(WORKER), str(run / "config.json")], capture_output=True,
                          text=True, timeout=300, env=env)


@unittest.skipUnless(HAVE_SKLEARN, "scikit-learn/joblib/threadpoolctl not installed")
class EndToEndPrecomputed(Tmp):
    def test_krr_grid_and_curve(self):
        import numpy as np
        rng = np.random.default_rng(0)
        X = rng.normal(size=(60, 4))
        y = X @ np.array([1.0, -2.0, 0.5, 0.0]) + 0.01 * rng.normal(size=60)
        np.save(self.tmp / "X.npy", X)
        (self.tmp / "y.csv").write_text("E\n" + "\n".join(map(str, y)) + "\n")
        cfg = base_config(self.tmp, rep={"name": "precomputed", "params": {"path": str(self.tmp / "X.npy")},
                                         "variance": True, "scale": True})
        cfg["data"].update(xyz=None, n_mol=50)
        cfg["model"] = {"name": "Ridge", "grid": True, "params": {"alpha": [1e-4, 1e-2, 1.0]}}
        cfg["split"].update(test_size=10, cv=3, curve=[10, 20, 100])
        r = run_worker(cfg, self.tmp / "r")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        st = json.loads((self.tmp / "r" / "status.json").read_text())
        self.assertEqual((st["state"], st["progress"]), ("done", 1.0))
        res = json.loads((self.tmp / "r" / "result.json").read_text())
        self.assertEqual((res["n_train"], res["n_test"], res["n_features"]), (40, 10, 4))
        self.assertEqual(len(res["grid"]), 3)
        self.assertLess(res["test"]["mae"], 0.1)
        self.assertEqual([p["n"] for p in res["curve"]], [10, 20, 40])
        pred = json.loads((self.tmp / "r" / "pred.json").read_text())
        self.assertEqual(len(pred["y_test"]), 10)
        self.assertEqual(len(pred["y_train_pred"]), 40)
        self.assertEqual(sorted(pred["idx_train"] + pred["idx_test"]), list(range(50)))
        self.assertTrue((self.tmp / "r" / "pred.npz").exists())

    def test_krr_and_gpr(self):
        import numpy as np
        rng = np.random.default_rng(1)
        X = rng.uniform(size=(40, 3))
        np.save(self.tmp / "X.npy", X)
        (self.tmp / "y.csv").write_text("a,b\n" + "\n".join(f"0,{v}" for v in np.sin(X.sum(1))) + "\n")
        rep = {"name": "precomputed", "params": {"path": str(self.tmp / "X.npy")}, "variance": False, "scale": True}
        for i, model in enumerate([{"name": "KRR", "grid": False,
                                    "params": {"kernel": "rbf", "alpha": 1e-6, "gamma": 0.1}},
                                   {"name": "GPR", "grid": False,
                                    "params": {"kernel": "RBF", "length_scale": 1.0, "alpha": 1e-6,
                                               "optimize": True}}]):
            cfg = base_config(self.tmp, rep=rep, model=model)
            cfg["data"].update(xyz=None, column="1")
            r = run_worker(cfg, self.tmp / f"r{i}")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            res = json.loads((self.tmp / f"r{i}" / "result.json").read_text())
            self.assertGreater(res["test"]["r2"], 0.9, model["name"])
        self.assertIn("fitted_kernel", res)


@unittest.skipUnless(HAVE_DSCRIBE, "dscribe/ase not installed")
class EndToEndCoulombMatrix(Tmp):
    def test_cm_krr_with_cache(self):
        import numpy as np
        rng = np.random.default_rng(2)
        blocks, ys = [], []
        for i in range(30):   # stretched H2O: target = O-H distance
            d = 0.9 + 0.3 * rng.uniform()
            blocks.append(f"3\n\nO 0 0 0\nH 0 {d:.4f} 0.5\nH 0 -{d:.4f} 0.5\n")
            ys.append(d)
        (self.tmp / "m.xyz").write_text("".join(blocks))
        (self.tmp / "y.csv").write_text("E\n" + "\n".join(map(str, ys)) + "\n")
        cfg = base_config(self.tmp, cache_dir=str(self.tmp / "cache"))
        cfg["model"]["params"].update(alpha=1e-8, gamma=0.1)
        for run in ("a", "b"):
            r = run_worker(cfg, self.tmp / run)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("features from cache", r.stdout)
        res = json.loads((self.tmp / "b" / "result.json").read_text())
        self.assertEqual(res["n_features"], 9)
        self.assertGreater(res["test"]["r2"], 0.9)
        self.assertEqual(len(list((self.tmp / "cache").glob("*.npy"))), 1)
        self.assertTrue(np.isfinite(res["time_predict_s"]))


if __name__ == "__main__":
    unittest.main()
