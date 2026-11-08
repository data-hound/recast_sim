"""Build the simulated-hospital cases (web/hospital/cases.json) from PUBLIC cBioPortal cohorts only.

    python build/hospital_cases.py          # GlioAgent venv; raw data from fetch_cbioportal.py

Five fictional hospitals, each drawn from one contributing site of a public cohort (the mapping to real sites is not
shipped: the page only gets the fictional name and "public research cohort"). Markers the source did not report are
filled from the clinician tool's public model, L[test, true class], with a fixed seed, and flagged as simulated. Ages are
reduced to the model's age bands. Each case keeps its true class for the simulation debrief.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from workup_pools import TESTS, age_band, load_cohort  # noqa: E402

OUT = HERE.parent / "web" / "hospital" / "cases.json"
MODEL = HERE.parent / "web" / "clinic" / "model.json"
SEED = 20261108
BAND_AGE = {"<35": 30, "35-50": 42, "50-65": 57, "65+": 72, "?": None}

# fictional hospital -> (study, site selector, max cases, site settings)
HOSPITALS = [
    {"id": "lakeside", "name": "Lakeside General Hospital", "study": "lgggbm_tcga_pub", "site": lambda s: s.split("-")[1] == "06", "max": 135,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 7}}},
    {"id": "riverbend", "name": "Riverbend University Hospital", "study": "lgggbm_tcga_pub", "site": lambda s: s.split("-")[1] == "HT", "max": 94,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 7}}},
    {"id": "harbor", "name": "Harbor Point Cancer Institute", "study": "difg_glass", "site": lambda s: s.startswith("GLSS-MD"), "max": 52,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 5}}},
    {"id": "northgate", "name": "Northgate Regional Medical Center", "study": "glioma_mskcc_2019", "site": lambda s: True, "max": 120, "skip": 0,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 10}}},
    {"id": "valley", "name": "Valley Community Hospital (resource-limited)", "study": "glioma_mskcc_2019", "site": lambda s: True, "max": 60, "skip": 120,
     "settings": {"r": 10, "unavailable": ["codel"], "tat": {"stain": 2, "molecular": 14}, "sendout": True}},
]


def opaque(*parts):
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:10]


def main():
    L = np.array(json.loads(MODEL.read_text())["L"])
    rng = np.random.default_rng(SEED); cache = {}; out = []
    for h in HOSPITALS:
        rows = cache.setdefault(h["study"], load_cohort(h["study"]))
        rows = [r for r in rows if h["site"](r["sid"]) and not r["sid"].upper().startswith("TCGA-") or (h["study"] == "lgggbm_tcga_pub" and h["site"](r["sid"]))]
        rows = sorted(rows, key=lambda r: opaque(SEED, r["sid"]))         # stable shuffle
        rows = rows[h.get("skip", 0): h.get("skip", 0) + h["max"]]
        cases = []
        for r in rows:
            R = r["R"].copy(); sim = np.isnan(R)
            for j in np.nonzero(sim)[0]:
                R[j] = float(rng.random() < L[j, r["y"]])
            band = age_band(r["age"])
            cases.append({"id": opaque(h["id"], r["sid"]), "age_band": band, "age": BAND_AGE[band], "grade": r["grade"], "g4": bool(r["g4"]),
                          "results": [int(x) for x in R], "simulated": [t for t, s in zip(TESTS, sim) if s], "y": int(r["y"])})
        cls = np.bincount([c["y"] for c in cases], minlength=3).tolist()
        out.append({"id": h["id"], "name": h["name"], "settings": h["settings"], "n": len(cases), "classes": cls, "cases": cases})
        print(f"{h['id']:10s} {len(cases):4d} cases  classes {cls}  ({h['study']})")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"tests": TESTS, "source": "public cBioPortal research cohorts (ODbL); hospitals are fictional",
                               "hospitals": out}, separators=(",", ":")))
    print(OUT, OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
