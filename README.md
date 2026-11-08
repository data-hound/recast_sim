# recast_sim: GlioAgent Workup simulation (app code and Informer deploy code)

**Research prototype and simulation. Not for clinical use. Not medical advice. Not a medical device.**

GlioAgent Workup is a browser app for the WHO CNS5 adult diffuse glioma workup. It has:
- a **clinician tool** (`web/clinic/`): enter a case, see class probabilities, evidence status and the cost-optimal next test (a line-for-line JavaScript port of the research planner, `web/js/clinic_engine.js`);
- a **hospital simulation** (`web/hospital/`): five fictional hospitals with a compressed clock, a worklist with the assistant, a "Practice - Daily Workup" game and a steward dashboard;
- an **Informer App wrapper** (`deploy/informer/clinic_app/`): packages the same pages as an Entrinsik Informer App, with one optional server route (an opt-in team log without patient identifiers).

All planning runs in the browser. The only server code is the team log in `deploy/informer/clinic_app/server/caselog/`.

## What is NOT in this repository (by design)

This repository holds app code and Informer deploy code only.
- **No model weights or fitted parameters.** The fitted likelihood and prior tables (`model.json`) are not here.
- **No served data.** The simulated hospital cases (`cases.json`) are not here.
- **No training code.** Nothing from the RL or LLM training pipelines is included.
- **No credentials.** No API keys, tokens, `.env` files or share links.

`model.json` and `cases.json` live only in the deployed Informer App. This repository's code reads them from a private directory that you point to with `RECAST_PRIVATE_ASSETS`. Without them the pages show "Could not load the simulation data" and `sync.sh` stops with a clear message.

> Note: inside a deployed App, `model.json` and `cases.json` are ordinary static files in the App bundle. Anyone who is allowed to open the App (signed-in users, or holders of a share link) can download them. "Only in the App" means "behind Informer sign-in", not "secret". Share links and roles control who gets them.

## Run locally with your own assets

You need two files in a private directory outside this repository:
- `model.json`: the clinician tool's naive-Bayes model (`tests`, `classes`, `L`, `yield`, `prior_counts`, `source`);
- `cases.json`: the hospital cases (`tests`, `hospitals[]` with `cases[]`, `practice[]`).

```bash
export RECAST_PRIVATE_ASSETS=/path/to/private_dir      # holds model.json and cases.json
./run_local.sh                                         # copies them to git-ignored paths and serves web/ on 127.0.0.1:8770
# open http://127.0.0.1:8770/hospital/   (demo sign-in; the demo password is shown on the page)
# open http://127.0.0.1:8770/clinic/     (clinician tool alone)
```

If you have neither file, you can rebuild `cases.json` from public data (see "Building the cases"), but `model.json` (the fitted parameters) is not reproducible from this repository.

### Building the cases from public cBioPortal data

The simulated cases are drawn from public cBioPortal cohorts. The build needs Python 3 and numpy.
```bash
python build/fetch_cbioportal.py --out raw/cbioportal          # public API, no login; writes JSON (git-ignored)
export RECAST_RAW_CBIOPORTAL=$PWD/raw/cbioportal
export RECAST_PRIVATE_ASSETS=/path/to/private_dir              # must already contain model.json (used to fill unmeasured markers)
python build/hospital_cases.py                                 # writes $RECAST_PRIVATE_ASSETS/cases.json
```
`build/cohort_loader.py` is the public-only loader (cohort download parsing, WHO CNS5 labels, age bands). It has no model, training or RL logic.

### Tests
```bash
pip install websocket-client                                   # and Google Chrome on PATH
python tests/e2e_hospital.py --url http://127.0.0.1:8770/hospital/ --shots /tmp/shots
```
`tests/test_clinic_engine.py` checks the JavaScript engine against the private Python reference implementation. It needs `GLIOAGENT_REPO` (a private checkout, not in this repository) plus `RECAST_PRIVATE_ASSETS`, so it cannot run from a fresh public clone. `tests/live_link_check.py` drives a deployed App through a share link given in `LINK_URL` (environment variable only; never commit or log that URL).

## Deploy to Entrinsik Informer

Needs Node 20 or later, an Informer tenant with the Apps licence, and a sign-in.
```bash
cd deploy/informer/clinic_app
npm install
inf login https://<your-tenant>            # or a git-ignored .env with INFORMER_URL and INFORMER_API_KEY
export RECAST_PRIVATE_ASSETS=/path/to/private_dir
npm run dev                                # local page, /api proxied to the tenant
npm run workspace:init && npm run workspace:migrate   # first time only: the app's Postgres workspace
npm run deploy                             # sync.sh + vite build + upload + migrate + publish
```
- `sync.sh` copies `model.json` and `cases.json` from `RECAST_PRIVATE_ASSETS` into `public/`, so they are uploaded as part of `dist/` and live in the App only. It fails if the variable or either file is missing.
- The first deploy from a fresh clone creates a new App. `npm run deploy` writes `informer.id` into `package.json`; keep that change out of commits (it is tenant-specific).
- Roles (`informer.yaml`): one `site_*` role per simulated hospital, and `steward`. A hospital is a role: the publisher assigns one `site_*` role per demo user when sharing the App.

## Where secrets and weights live

| Item | Where it lives | How it gets there |
|---|---|---|
| `model.json`, `cases.json` | The deployed Informer App (static files in the App bundle) | `RECAST_PRIVATE_ASSETS` -> `sync.sh` -> `npm run deploy` |
| API keys (for example a future NVIDIA NIM key) | The Informer App's encrypted environment | Declare the key name in `informer.yaml` under `env:`; the installer enters the value in the App's Admin > Environment tab (or `PUT /apps/{id}/environment/{KEY}`); route code reads `env.KEY` |
| Informer sign-in | `inf login` (or a git-ignored `.env`) | Never committed |

Source for the environment mechanism: https://docs.entrinsik.com/developer/api/app/environment ("encrypted at rest", "never returned by the API", handlers receive `env`), and the server-route handler bag in https://docs.entrinsik.com/developer/api/app/server-routes. This app does not currently call any external model API, so `informer.yaml` declares no `env:` keys.

## Data licence and attribution

The simulated cases and the fitted model are derived from public research cohorts served by **cBioPortal** (default licence: **Open Database Licence, ODbL 1.0**). The main source is the TCGA pan-glioma cohort (`lgggbm_tcga_pub`; Ceccarelli M et al., Cell 2016;164:550-563); the Practice cases use MSK (Clin Cancer Res 2019 and 2024) and GLASS (Barthel FP et al., Nature 2019) cohorts. If you redistribute data derived from them, keep the ODbL attribution and cite cBioPortal (Cerami et al. 2012; Gao et al. 2013; de Bruijn et al. 2023) and the original studies. Hospitals in the app are fictional; the data shipped inside the app remain under cBioPortal/TCGA terms.

## Licence

Source-available under the **PolyForm Noncommercial License 1.0.0** (see `LICENSE`): non-commercial use only. This is **not an OSI-approved open source licence**.

Required Notice: Copyright (c) 2026 RECAST Team (Anshuman Sabath, Nura Brimo)

## Authors

Anshuman Sabath and Nura Brimo (RECAST Team).
