#!/usr/bin/env python3
"""Writes expected.json for test/chem/spectrumSets.test.ts from the real uv-vis code.

  python test/fixtures/spectra/make_fixtures.py [path/to/uv-vis]

Imports scripts/spectra.py from the uv-vis repository (default: ../../../../uv-vis next to the
Orbital checkout, or $UVVIS) and evaluates band_stats, compare and the draw_diff difference band
on the spectra copied into this folder, for the window 250-500 nm. The .dat files are full
copies of uv-vis/05-spectrum/spectra_txt/*.dat and 05-spectrum/CH2OO_Ting.dat.
"""
import json
import os
import sys
from pathlib import Path
from statistics import NormalDist

import numpy as np

HERE = Path(__file__).resolve().parent
UVVIS = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "UVVIS", HERE.parents[3] / ".." / "uv-vis")).resolve()
if not (UVVIS / "scripts" / "spectra.py").exists():
    UVVIS = Path(r"C:\Users\16bto\Desktop\uv-vis")
sys.path.insert(0, str(UVVIS / "scripts"))
from spectra import SAME_THRESHOLD, band_stats, compare, load_experiment, load_spectrum  # noqa: E402

WINDOW = (250.0, 500.0)
SPECTRA = ["gle-augccpVDZ_adc3-augccpVDZ_n1000", "classical-augccpVDZ_adc3-augccpVDZ_n1000",
           "pigle-augccpVDZ_adc3-augccpVDZ_n1000"]
PAIRS = [(0, 1), (0, 2), (1, 2), (0, 0)]


def plain(d):
    return {k: float(v) for k, v in d.items()}


def main():
    data = {s: load_spectrum(HERE / f"{s}.dat") for s in SPECTRA}
    out = {"window": WINDOW, "same_threshold": SAME_THRESHOLD,
           "z95": NormalDist().inv_cdf(0.975), "z90": NormalDist().inv_cdf(0.95),
           "z99": NormalDist().inv_cdf(0.995),
           "z_tail": NormalDist().inv_cdf(1e-10), "z_mid": NormalDist().inv_cdf(0.3),
           "spectra": {}, "compare": [], "diff": []}
    for s, d in data.items():
        out["spectra"][s] = {"n": int(len(d)), "x_first": float(d[0, 0]), "x_last": float(d[-1, 0]),
                             "ncols": int(d.shape[1]), "band": plain(band_stats(d, WINDOW))}
    for i, j in PAIRS:
        a, b = SPECTRA[i], SPECTRA[j]
        for conf, frac in ((0.95, 0.02), (0.90, 0.05)):
            out["compare"].append({"ref": a, "other": b, "confidence": conf, "signal_frac": frac,
                                   **plain(compare(data[a], data[b], WINDOW, conf, frac))})
    # draw_diff (webapp/v_spectra.py) on its 1000-point grid
    grid = np.linspace(*WINDOW, 1000)
    z = NormalDist().inv_cdf(0.975)
    ref = data[SPECTRA[0]]
    ta, loa, hia = (np.interp(grid, ref[:, 0], ref[:, i]) for i in (1, 2, 3))
    for s in SPECTRA[1:]:
        d = data[s]
        tb, lob, hib = (np.interp(grid, d[:, 0], d[:, i]) for i in (1, 2, 3))
        half = z * np.hypot((hia - loa) / (2 * z), (hib - lob) / (2 * z))
        idx = list(range(0, 1000, 37)) + [999]
        out["diff"].append({"ref": SPECTRA[0], "other": s, "idx": idx,
                            "diff": [float((tb - ta)[k]) for k in idx],
                            "lo": [float((tb - ta - half)[k]) for k in idx],
                            "hi": [float((tb - ta + half)[k]) for k in idx]})
    xe, ye = load_experiment(HERE / "CH2OO_Ting.dat")
    out["experiment"] = {"n": int(len(xe)), "n_raw": int(len(np.loadtxt(HERE / "CH2OO_Ting.dat"))),
                         "lmax": float(xe[np.argmax(ye)]), "peak": float(ye.max()),
                         "band": plain(band_stats(np.column_stack([xe, ye]), WINDOW))}
    (HERE / "expected.json").write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {HERE / 'expected.json'} using {UVVIS / 'scripts' / 'spectra.py'}")


if __name__ == "__main__":
    main()
