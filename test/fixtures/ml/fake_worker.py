"""Stand-in for python/ml_worker.py in test/ml/runs.test.ts (only the standard library).

    fake_worker.py --check          prints a --check JSON (FAKE_CHECK=garbage|slow|fail changes that)
    fake_worker.py <run>/config.json
        config "fake": "done"   writes status running, result.json + pred.json, then done
        config "fake": "sleep"  writes status running and sleeps (to be stopped)
        config "fake": "crash"  writes status running and exits 3 without a final status
"""
import json
import os
import sys
import time
from pathlib import Path


def write(path, obj):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj))
    os.replace(tmp, path)


if sys.argv[1] == "--check":
    mode = os.environ.get("FAKE_CHECK", "")
    if mode == "slow":
        time.sleep(30)
    if mode == "fail":
        print("Traceback: something broke", file=sys.stderr)
        sys.exit(1)
    print("some noise first")
    print("garbage{" if mode == "garbage" else json.dumps({
        "python": "3.99.0", "packages": {"numpy": "2.0", "sklearn": None, "dscribe": None, "xgboost": None,
                                         "pandas": "2.2", "scipy": "1.1"},
        "ok": False, "missing_required": ["sklearn"]}))
    sys.exit(0)

cfg_path = Path(sys.argv[1])
run = cfg_path.parent
cfg = json.loads(cfg_path.read_text())
status = json.loads((run / "status.json").read_text())
status.update(state="running", pid=os.getpid(), step="fake work", progress=0.5)
write(run / "status.json", status)
print("fake worker started", flush=True)
print("to stderr", file=sys.stderr, flush=True)
mode = cfg.get("fake", "done")
if mode == "sleep":
    time.sleep(120)
elif mode == "crash":
    sys.exit(3)
write(run / "result.json", {"n_train": 4, "n_test": 1, "n_features": 2, "test": {"mae": 0.5, "rmse": 0.6, "r2": 0.9},
                            "train": {"mae": 0.1, "rmse": 0.2, "r2": 0.99}, "best_params": {}})
write(run / "pred.json", {"y_train": [1, 2, 3, 4], "y_train_pred": [1, 2, 3, 4.5], "y_test": [5], "y_test_pred": [5.5]})
status.update(state="done", step="done", progress=1.0)
write(run / "status.json", status)
