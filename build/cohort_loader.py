"""Public-only cBioPortal cohort loader for the simulated-hospital case build.

Reads the JSON files written by build/fetch_cbioportal.py (public cBioPortal studies, ODbL 1.0; cite cBioPortal and the
study) and turns each patient into marker results (WHO CNS5 adult diffuse glioma class + 9 workup tests). It contains
no model, no training or RL logic and no non-public case source. Staged from the research build's workup_pools.py,
which also builds private pools and needs the GlioAgent training repo; none of that is carried over.

    RECAST_RAW_CBIOPORTAL=/path/to/raw/cbioportal   # default: ./raw/cbioportal (git-ignored)
"""
import json
import os
from collections import defaultdict
from pathlib import Path

import numpy as np

TESTS = ["ihc", "seq", "atrx", "tp53", "codel", "tert", "cnv", "egfr", "cdkn"]   # same order as web/js/clinic_engine.js
RAW = Path(os.environ.get("RECAST_RAW_CBIOPORTAL", "raw/cbioportal"))


def _attrs(rows):
    out = defaultdict(dict)
    for r in rows:
        out[r.get("sampleId") or r["patientId"]][r["clinicalAttributeId"]] = r["value"]
    return out


def load_cohort(study):
    d = RAW / study
    if not d.is_dir():
        raise SystemExit(f"cBioPortal data for {study} not found at {d}: run build/fetch_cbioportal.py --out {RAW} first")
    samp = json.loads((d / "clinical_sample.json").read_text()); pat = json.loads((d / "clinical_patient.json").read_text())
    S = _attrs(samp); Pt = _attrs(pat)
    pid = {r["sampleId"]: r["patientId"] for r in samp}
    seqd = set(json.loads((d / "mutations_samples.json").read_text())) if (d / "mutations_samples.json").exists() else set()
    cnad = set(json.loads((d / "cna_samples.json").read_text())) if (d / "cna_samples.json").exists() else set()
    mut = defaultdict(list)
    for m in json.loads((d / "mutations.json").read_text()) if (d / "mutations.json").exists() else []:
        mut[m["sampleId"]].append(m)
    cna = defaultdict(dict)
    for c in json.loads((d / "cna.json").read_text()) if (d / "cna.json").exists() else []:
        cna[c["sampleId"]][c["entrezGeneId"]] = c["alteration"]
    # one sample per patient: primary if labelled, else the first id
    by_p = defaultdict(list)
    for s in S:
        by_p[pid[s]].append(s)
    rows = []
    for p, ss in by_p.items():
        prim = [s for s in ss if "primary" in (S[s].get("SAMPLE_TYPE", "primary")).lower()]
        s = sorted(prim or ss)[0]; A = {**Pt.get(p, {}), **S[s]}
        rows.append(markers(study, s, A, mut.get(s, []), cna.get(s, {}), s in seqd, s in cnad))
    return [r for r in rows if r is not None]


NONSILENT = {"Missense_Mutation", "Nonsense_Mutation", "Frame_Shift_Del", "Frame_Shift_Ins", "Splice_Site", "In_Frame_Del", "In_Frame_Ins", "Nonstop_Mutation", "Translation_Start_Site"}


def markers(study, sid, A, muts, cn, sequenced, cna_done):
    nan = float("nan"); v = dict.fromkeys(TESTS, nan)
    g = lambda gene: [m for m in muts if m["entrezGeneId"] == gene]
    idh_muts = [m for m in g(3417) if (m.get("proteinChange") or "").startswith("R132")] + \
               [m for m in g(3418) if (m.get("proteinChange") or "")[:4] in ("R140", "R172")]
    st = A.get("IDH_STATUS")
    if st:
        v["seq"] = 1.0 if st.lower().startswith(("mut", "idhmut")) else 0.0
    elif sequenced:
        v["seq"] = 1.0 if idh_muts else 0.0
    if sequenced or st:
        r132h = any((m.get("proteinChange") or "") == "R132H" for m in g(3417))
        v["ihc"] = 1.0 if r132h else (0.0 if v["seq"] in (0.0, 1.0) else nan)
    if "ATRX_STATUS" in A:
        v["atrx"] = 1.0 if A["ATRX_STATUS"].lower().startswith("mut") else 0.0
    elif sequenced:
        v["atrx"] = 1.0 if any(m["mutationType"] in NONSILENT for m in g(546)) else 0.0
    if sequenced:
        v["tp53"] = 1.0 if any(m["mutationType"] in NONSILENT for m in g(7157)) else 0.0
    cod = A.get("IDH_1P19Q_SUBTYPE") or A.get("CODEL_STATUS") or A.get("1P19Q_STATUS")
    if cod:
        v["codel"] = 1.0 if cod.lower() in ("codel", "codeleted") else 0.0
    if "TERT_PROMOTER_STATUS" in A:
        v["tert"] = 1.0 if A["TERT_PROMOTER_STATUS"].lower().startswith("mut") else 0.0
    elif study.startswith(("glioma_mskcc", "difg_msk")) and sequenced:   # MSK-IMPACT covers the TERT promoter
        v["tert"] = 1.0 if any(m["mutationType"] == "5'Flank" for m in g(7015)) else 0.0
    if "CHR_7_GAIN_CHR_10_LOSS" in A:
        v["cnv"] = 1.0 if A["CHR_7_GAIN_CHR_10_LOSS"].lower().startswith("gain") else 0.0
    if cna_done:
        v["egfr"] = 1.0 if cn.get(1956) == 2 else 0.0
        v["cdkn"] = 1.0 if cn.get(1029) == -2 else 0.0
    grade = (A.get("GRADE") or A.get("WHO_GRADE") or A.get("TUMOR_GRADE") or "").upper().replace("G", "")
    grade = {"IV": "4", "III": "3", "II": "2", "I": "1"}.get(grade, grade)
    hist = (A.get("HISTOLOGICAL_DIAGNOSIS") or A.get("HISTOLOGY") or A.get("CANCER_TYPE_DETAILED") or "").lower()
    g4 = grade.startswith("4") or "3/4" in grade or "glioblastoma" in hist or "gliosarcoma" in hist
    try:
        age = float(A.get("AGE"))
    except (TypeError, ValueError):
        age = None
    if age is not None and age < 18:
        return None
    # WHO CNS5 class (adult diffuse glioma); out-of-scope cases are dropped, as in RECAST
    if v["seq"] == 1.0:
        if v["codel"] == 1.0:
            y, ybasis = 2, "IDH + 1p/19q"
        elif v["codel"] == 0.0:
            y, ybasis = 1, "IDH + 1p/19q"
        elif "oligodendroglioma" in hist and "astro" not in hist:
            y, ybasis = 2, "IDH + histology (1p/19q not reported)"
        elif "astrocytoma" in hist or "glioblastoma" in hist:
            y, ybasis = 1, "IDH + histology (1p/19q not reported)"
        else:
            return None
    elif v["seq"] == 0.0:
        if g4 or v["tert"] == 1.0 or v["egfr"] == 1.0 or v["cnv"] == 1.0:
            y, ybasis = 0, "IDH-wildtype + grade 4 or molecular criteria"
        else:
            return None
    else:
        return None
    return {"sid": sid, "y": y, "ybasis": ybasis, "g4": bool(g4), "grade": grade[:1] if grade[:1] in "234" else "?",
            "age": age, "R": np.array([v[t] for t in TESTS], dtype=float)}


def age_band(a):
    return "?" if a is None else ("<35" if a < 35 else "35-50" if a < 50 else "50-65" if a < 65 else "65+")
