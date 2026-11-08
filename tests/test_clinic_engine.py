"""Parity of web/js/clinic_engine.js (the clinician tool's planner) with the Python engine (node + GlioAgent venv):

    python tests/test_clinic_engine.py [--n 3000]

Python (scripts/policy.py via glioagent.env, unchanged) generates every vector on exactly the inputs the JS receives:
full-precision posterior w, partial result state o, histology flag, the public model L (and random perturbations of it),
a random available-test panel and a random molecular cost r. Compared: support, relevant, update, dp_choose (test index
exactly, value to 1e-9), the CAP and marker-tree next step, and the clinical prior.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.environ.get("GLIOAGENT_REPO", str(ROOT.parent / "recast_glioagent")))
from glioagent.env import P, TESTS, agent_cap  # noqa: E402

NODE = r"""
var E = require(process.argv[2]); var V = JSON.parse(require('fs').readFileSync(process.argv[3]));
var out = V.map(function (v) {
  var cfg = E.cfgOf({r: v.r, tests: v.tests});
  if (v.f === 'support') return E.support(v.o, v.g4, cfg);
  if (v.f === 'relevant') return E.relevant(v.o, v.g4, v.w, cfg);
  if (v.f === 'update') return E.update(v.w, v.L, v.j, v.res);
  if (v.f === 'dp') { var d = E.dpChoose(v.w, v.o, v.g4, v.L, cfg); return [d.j, d.v]; }
  if (v.f === 'cap' || v.f === 'tree') return E.pathwayNext(v.o, v.g4, cfg, v.f);
  if (v.f === 'prior') return E.clinicalPrior(v.counts, v.age, v.grade);
});
process.stdout.write(JSON.stringify(out));
"""


class _Env:
    def __init__(self, o, g4, cfg):
        self.o, self.cfg = o, cfg
        self.case = type("C", (), {"g4": g4})()


def py_prior(counts, age, grade):
    from workup_pools import age_band
    prev = np.array(counts["prev"]); pn = prev / prev.sum()
    a = np.array(counts["age"].get(age_band(age), [1, 1, 1])); g = np.array(counts["grade"].get(grade, [1, 1, 1]))
    w = (a / a.sum() / pn) * (g / g.sum() / pn) * pn
    return (w / w.sum()).tolist()


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=3000); ap.add_argument("--seed", type=int, default=11)
    a = ap.parse_args(); rng = random.Random(a.seed); nrng = np.random.default_rng(a.seed)
    sys.path.insert(0, str(ROOT / "build"))
    model = json.loads((ROOT / "web" / "clinic" / "model.json").read_text())
    assert model["yield"] == [1.0] * len(TESTS), "clinic model must have yield 1"
    L0 = np.array(model["L"]); V, want = [], []
    for i in range(a.n):
        L = L0 if i % 3 else np.clip(L0 + nrng.normal(0, 0.05, L0.shape), 0.001, 0.999)
        panel = [t for t in TESTS if rng.random() > 0.2] if rng.random() < 0.6 else list(TESTS)
        r = rng.choice([1.5, 3.0, 5.0, 10.0]); cfg = P.Cfg(r=r, tests=tuple(panel)); g4 = rng.random() < 0.4
        o = [-1] * 9
        for j in range(9):
            if rng.random() < 0.3:
                o[j] = rng.choice([0, 1])
        prior = nrng.dirichlet([1, 1, 1]); w = prior.copy()
        for j in range(9):
            w = P.update(w, P.Model(L, np.ones(9)), j, o[j])
        mdl = P.Model(L, np.ones(9)); base = {"o": o, "g4": g4, "w": [float(x) for x in w], "r": r, "tests": panel, "L": L.tolist()}
        V.append(dict(base, f="support")); want.append(P.support(tuple(o), g4, cfg))
        V.append(dict(base, f="relevant")); want.append(P.relevant(list(o), g4, w, cfg))
        j, res = rng.randrange(9), rng.choice([0, 1])
        V.append(dict(base, f="update", j=j, res=res)); want.append([float(x) for x in P.update(w, mdl, j, res)])
        jj, vv = P.dp_choose(w, tuple(o), g4, mdl, cfg); V.append(dict(base, f="dp")); want.append([jj, vv])
        for kind in ("cap", "tree"):
            act = agent_cap(_Env(o, g4, cfg), kind)
            V.append(dict(base, f=kind)); want.append(act[1] if act[0] == "order" else None)
    for age in (None, 25, 40, 55, 70):
        for grade in ("2", "3", "4", "?"):
            V.append({"f": "prior", "counts": model["prior_counts"], "age": age, "grade": grade}); want.append(py_prior(model["prior_counts"], age, grade))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(V, fh); vec = fh.name
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
        fh.write(NODE); js = fh.name
    got = json.loads(subprocess.run(["node", js, str(ROOT / "web" / "js" / "clinic_engine.js"), vec], capture_output=True, text=True, check=True).stdout)

    def same(x, y, tol):
        if isinstance(x, (list, tuple)) and isinstance(y, (list, tuple)):
            return len(x) == len(y) and all(same(p, q, tol) for p, q in zip(x, y))
        if isinstance(x, float) or isinstance(y, float):
            return x is not None and y is not None and abs(float(x) - float(y)) <= tol
        return x == y
    bad = {}
    for v, w_, g in zip(V, want, got):
        tol = 1e-9 if v["f"] == "dp" else 1e-12
        if not same(w_, g, tol):
            bad.setdefault(v["f"], []).append((w_, g))
    counts = {}
    for v in V:
        counts[v["f"]] = counts.get(v["f"], 0) + 1
    for f, n in sorted(counts.items()):
        print(f"{f:9s} {n:5d} vectors, {len(bad.get(f, []))} mismatches", *(bad.get(f, [])[:2]))
    nd = sum(1 for v, w_ in zip(V, want) if v["f"] == "dp" and w_[0] is not None)
    print(f"dp vectors with a test to order: {nd}")
    print("ALL PASS" if not bad else "FAIL")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
