#!/usr/bin/env python3
"""Writes stats_expected.json for test/chem/xyzTrajectory.test.ts.

  python test/fixtures/xyz/make_expected.py [path/to/uv-vis]

A seeded AR(1) series (an MD-like correlated trace) and its reference statistics: autocorr_time
and mean_with_error from uv-vis scripts/spectra.py, np.histogram (density), np.histogram2d and
scipy.stats.gaussian_kde (Scott and Silverman).
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from scipy.stats import gaussian_kde

HERE = Path(__file__).resolve().parent
UVVIS = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("UVVIS", HERE.parents[3] / ".." / "uv-vis")).resolve()
if not (UVVIS / "scripts" / "spectra.py").exists():
    UVVIS = Path(r"C:\Users\16bto\Desktop\uv-vis")
sys.path.insert(0, str(UVVIS / "scripts"))
from spectra import autocorr_time, mean_with_error  # noqa: E402

rng = np.random.default_rng(20261009)
n, phi = 3000, 0.9
x = np.empty(n)
x[0] = 0.0
for i in range(1, n):
    x[i] = phi * x[i - 1] + rng.normal()
x = 1.45 + 0.01 * x
white = rng.normal(size=500)
osc = np.sin(np.arange(2000) * 0.7) + 0.3 * rng.normal(size=2000)
grid = np.linspace(x.min() - 0.01, x.max() + 0.01, 50)
h, e = np.histogram(x, bins=20, density=True)
h2, ea, eb = np.histogram2d(x[:-1], x[1:], bins=[6, 4])
out = {
    "x": x.tolist(), "white": white.tolist(), "osc": osc.tolist(),
    "tau": autocorr_time(x), "tau_white": autocorr_time(white), "tau_osc": autocorr_time(osc),
    "mwe": {k: float(v) for k, v in mean_with_error(x).items()},
    "hist": {"edges": e.tolist(), "values": h.tolist()},
    "hist2d": {"edgesA": ea.tolist(), "edgesB": eb.tolist(), "counts": h2.tolist()},
    "grid": grid.tolist(),
    "kde_scott": gaussian_kde(x)(grid).tolist(),
    "kde_silverman": gaussian_kde(x, bw_method="silverman")(grid).tolist(),
    "mean": float(x.mean()), "std": float(x.std()), "median": float(np.median(x)),
}
(HERE / "stats_expected.json").write_text(json.dumps(out) + "\n")
print("wrote", HERE / "stats_expected.json")
