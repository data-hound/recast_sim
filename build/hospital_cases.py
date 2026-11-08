"""Build the simulated-hospital cases (cases.json) from PUBLIC cBioPortal cohorts only.

    export RECAST_PRIVATE_ASSETS=/private/dir        # holds model.json (input) and receives cases.json (output); never inside this repo
    export RECAST_RAW_CBIOPORTAL=/path/raw/cbioportal  # written by build/fetch_cbioportal.py
    python build/hospital_cases.py                   # needs numpy

Five fictional hospitals, each drawn from one TCGA contributing (tissue-source) site of the public lgggbm_tcga_pub cohort
(the mapping to real sites is not shipped: the page only gets the fictional name and "public research cohort"). Markers the source did not report are
filled from the clinician tool's public model, L[test, true class], with a fixed seed, and flagged as simulated. Ages are
reduced to the model's age bands. Each case keeps its true class for the simulation debrief.
Daily Workup practice cases ("practice") come from external public cohorts only (MSK 2019, GLASS non-TCGA, MSK 2023).
"""
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cohort_loader import TESTS, age_band, load_cohort  # noqa: E402

PRIVATE = os.environ.get("RECAST_PRIVATE_ASSETS")
if not PRIVATE or not (Path(PRIVATE) / "model.json").is_file():
    raise SystemExit("Set RECAST_PRIVATE_ASSETS to a private directory that contains model.json (not shipped in this repo).")
OUT = Path(PRIVATE) / "cases.json"
MODEL = Path(PRIVATE) / "model.json"
SEED = 20261108
BAND_AGE = {"<35": 30, "35-50": 42, "50-65": 57, "65+": 72, "?": None}

# fictional hospital -> one TCGA contributing (tissue-source) site of the public lgggbm_tcga_pub cohort, plus site settings.
# The site codes stay in this build script; the page only gets the fictional name.
def _tss(code):
    return lambda s: s.split("-")[1] == code


HOSPITALS = [
    {"id": "lakeside", "name": "Lakeside General Hospital", "study": "lgggbm_tcga_pub", "site": _tss("06"), "max": 135,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 7}}},
    {"id": "riverbend", "name": "Riverbend University Hospital", "study": "lgggbm_tcga_pub", "site": _tss("HT"), "max": 94,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 7}}},
    {"id": "harbor", "name": "Harbor Point Cancer Institute", "study": "lgggbm_tcga_pub", "site": _tss("DU"), "max": 81,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 5}}},
    {"id": "northgate", "name": "Northgate Regional Medical Center", "study": "lgggbm_tcga_pub", "site": _tss("02"), "max": 60,
     "settings": {"r": 3, "unavailable": [], "tat": {"stain": 1, "molecular": 10}}},
    {"id": "valley", "name": "Valley Community Hospital (resource-limited)", "study": "lgggbm_tcga_pub", "site": _tss("S9"), "max": 46,
     "settings": {"r": 10, "unavailable": ["codel"], "tat": {"stain": 2, "molecular": 14}, "sendout": True}},
]
# Daily Workup practice: EXTERNAL public cohorts only (no TCGA ids), so practice never repeats a hospital's own cases.
# UCSF 2014 is left out (over half of its markers would be simulated). MSK 2019 and MSK 2023 use different sample-id
# schemes, so a patient in both cannot be removed by id; with a 400-case draw the chance of a repeat is small.
PRACTICE = {"studies": ["glioma_mskcc_2019", "difg_glass", "difg_msk_2023"], "max": 400}


def opaque(*parts):
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:10]


def main():
    L = np.array(json.loads(MODEL.read_text())["L"])
    rng = np.random.default_rng(SEED); cache = {}; out = []
    def to_case(tag, r):
        R = r["R"].copy(); sim = np.isnan(R)
        for j in np.nonzero(sim)[0]:
            R[j] = float(rng.random() < L[j, r["y"]])
        band = age_band(r["age"])
        return {"id": opaque(tag, r["sid"]), "age_band": band, "age": BAND_AGE[band], "grade": r["grade"], "g4": bool(r["g4"]),
                "results": [int(x) for x in R], "simulated": [t for t, s in zip(TESTS, sim) if s], "y": int(r["y"])}

    for h in HOSPITALS:
        rows = [r for r in cache.setdefault(h["study"], load_cohort(h["study"])) if h["site"](r["sid"])]
        rows = sorted(rows, key=lambda r: opaque(SEED, r["sid"]))[: h["max"]]          # stable shuffle
        cases = [to_case(h["id"], r) for r in rows]
        cls = np.bincount([c["y"] for c in cases], minlength=3).tolist()
        out.append({"id": h["id"], "name": h["name"], "settings": h["settings"], "n": len(cases), "classes": cls, "cases": cases})
        print(f"{h['id']:10s} {len(cases):4d} cases  classes {cls}  ({h['study']})")
    prows = []
    for st in PRACTICE["studies"]:
        prows += [r for r in cache.setdefault(st, load_cohort(st)) if not r["sid"].upper().startswith("TCGA-")]
    prows = sorted(prows, key=lambda r: opaque(SEED, "practice", r["sid"]))[: PRACTICE["max"]]
    practice = [to_case("practice", r) for r in prows]
    pcls = np.bincount([c["y"] for c in practice], minlength=3).tolist()
    print(f"practice   {len(practice):4d} cases  classes {pcls}  ({', '.join(PRACTICE['studies'])})")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"tests": TESTS, "source": "public cBioPortal research cohorts (ODbL); hospitals are fictional",
                               "hospitals": out,
                               "practice_source": "external public cohorts (MSK 2019, GLASS without TCGA ids, MSK 2023)",
                               "practice": practice}, separators=(",", ":")))
    print(OUT, OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
