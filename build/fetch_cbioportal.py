"""Download the marker data for optional Workup case sources from the public cBioPortal API (no login).

    python build/fetch_cbioportal.py --out ../arcade_data/raw/cbioportal [--studies lgggbm_tcga_pub,...]

Per study it caches clinical (sample + patient), mutations in the Workup genes, and GISTIC discrete copy number for
EGFR / CDKN2A / CDKN2B. Data are cBioPortal public studies (default licence ODbL unless the study says otherwise;
cite cBioPortal and the original publication). Responses are written as JSON and only parsed as JSON.
"""
import argparse
import json
import time
import urllib.request
from pathlib import Path

API = "https://www.cbioportal.org/api"
GENES = {"IDH1": 3417, "IDH2": 3418, "TP53": 7157, "ATRX": 546, "TERT": 7015, "EGFR": 1956, "CDKN2A": 1029, "CDKN2B": 1030}
STUDIES = ["lgggbm_tcga_pub", "glioma_mskcc_2019", "difg_glass", "difg_msk_2023", "lgg_ucsf_2014"]


def get(path):
    with urllib.request.urlopen(API + path, timeout=120) as r:
        return json.loads(r.read())


def post(path, body):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); ap.add_argument("--studies", default=",".join(STUDIES))
    a = ap.parse_args()
    for s in a.studies.split(","):
        d = Path(a.out) / s; d.mkdir(parents=True, exist_ok=True)
        meta = get(f"/studies/{s}")
        (d / "study.json").write_text(json.dumps({k: meta.get(k) for k in ("studyId", "name", "description", "citation", "pmid", "publicStudy", "allSampleCount")}, indent=1))
        for typ in ("SAMPLE", "PATIENT"):
            (d / f"clinical_{typ.lower()}.json").write_text(json.dumps(get(f"/studies/{s}/clinical-data?clinicalDataType={typ}&projection=SUMMARY&pageSize=10000000")))
        profiles = [p["molecularProfileId"] for p in get(f"/studies/{s}/molecular-profiles")]
        lists = [l["sampleListId"] for l in get(f"/studies/{s}/sample-lists")]
        mut = f"{s}_mutations"
        if mut in profiles:
            sl = f"{s}_sequenced" if f"{s}_sequenced" in lists else f"{s}_all"
            (d / "mutations.json").write_text(json.dumps(post(f"/molecular-profiles/{mut}/mutations/fetch?projection=DETAILED",
                                                              {"sampleListId": sl, "entrezGeneIds": list(GENES.values())})))
            (d / "mutations_samples.json").write_text(json.dumps(get(f"/sample-lists/{sl}/sample-ids")))
        cna = f"{s}_gistic" if f"{s}_gistic" in profiles else (f"{s}_cna" if f"{s}_cna" in profiles else None)
        if cna:
            sl = f"{s}_cna" if f"{s}_cna" in lists else f"{s}_all"
            (d / "cna.json").write_text(json.dumps(post(f"/molecular-profiles/{cna}/discrete-copy-number/fetch?discreteCopyNumberEventType=ALL",
                                                        {"sampleListId": sl, "entrezGeneIds": [GENES["EGFR"], GENES["CDKN2A"], GENES["CDKN2B"]]})))
            (d / "cna_samples.json").write_text(json.dumps(get(f"/sample-lists/{sl}/sample-ids")))
        print(s, {f.name: f.stat().st_size for f in d.iterdir()}, flush=True)
        time.sleep(1)


if __name__ == "__main__":
    main()
