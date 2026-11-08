/* Workup engine for the clinician tool: a line-for-line ES2015 port of RECAST scripts/policy.py (idh_state, support,
   relevant, update, dp_choose) and glioagent/env.py agent_cap (CAP pathway, marker tree). Default Cfg: atrx_tp53 = true,
   hist = true, grade_complete = false, eps = 0.01. Test yield is fixed at 1 (every ordered test returns a result).
   Parity with the Python engine: tests/test_clinic_engine.py. Runs in the browser (window.ClinicEngine) and in node.
   No network, no storage: everything a clinician enters stays in the page. */
(function (root) {
  "use strict";
  var TESTS = ["ihc", "seq", "atrx", "tp53", "codel", "tert", "cnv", "egfr", "cdkn"];
  var TI = {}; TESTS.forEach(function (t, i) { TI[t] = i; });
  var IHC_CLASS = {ihc: 1, atrx: 1, tp53: 1};
  var CLS = ["GBM-IDHwt", "Astro-IDHmut", "Oligo-IDHmut-codel"];
  var INF = Infinity;

  function cfgOf(c) {
    c = c || {};
    return {r: c.r == null ? 3.0 : +c.r, tests: (c.tests || TESTS).slice(), atrx_tp53: c.atrx_tp53 !== false, hist: c.hist !== false,
            grade_complete: !!c.grade_complete, eps: c.eps == null ? 0.01 : +c.eps};
  }
  function cost(cfg, t) { return IHC_CLASS[t] ? 1.0 : cfg.r; }
  function inPanel(cfg, t) { return cfg.tests.indexOf(t) >= 0; }

  function idhState(o) {
    var ihc = o[0], seq = o[1];
    if (seq === 1) return "mut";
    if (seq === 0) return "wt";
    return ihc === 1 ? "mut" : "unk";
  }

  function support(o, g4, cfg) {
    var atrx = o[2], tp53 = o[3], codel = o[4], tert = o[5], cnv = o[6], egfr = o[7], cdkn = o[8], s = idhState(o), c;
    if (s === "mut") {
      if (codel === 1) c = 2;
      else if (codel === 0) c = 1;
      else if (cfg.atrx_tp53 && (atrx === 1 || tp53 === 1)) c = 1;
      else return -1;
      if (cfg.grade_complete && c === 1 && cdkn !== 0 && cdkn !== 1) return -1;
      return c;
    }
    if (s === "wt") {
      if ((cfg.hist && g4) || tert === 1 || cnv === 1 || egfr === 1) return 0;
    }
    return -1;
  }

  function relevant(o, g4, w, cfg, eps) {
    eps = eps == null ? cfg.eps : eps;
    var ihc = o[0], seq = o[1], atrx = o[2], tp53 = o[3], codel = o[4], tert = o[5], cnv = o[6], egfr = o[7], cdkn = o[8];
    var out = [], s = idhState(o);
    if (s === "unk") {
      var cand = [];
      if (ihc === -1 && inPanel(cfg, "ihc")) cand.push(0);
      if (seq === -1 && inPanel(cfg, "seq")) cand.push(1);
      if (!cand.length) return [];
      out = out.concat(cand);
    }
    var massMut = w == null ? 1.0 : w[1] + w[2], massWt = w == null ? 1.0 : w[0];
    var mutOk = s === "mut" || (s === "unk" && (eps < 0 || massMut > eps));
    var wtOk = s === "wt" || (s === "unk" && seq === -1 && inPanel(cfg, "seq") && (eps < 0 || massWt > eps));
    if (mutOk && codel !== 0 && codel !== 1) {
      if (codel === -1 && inPanel(cfg, "codel")) out.push(4);
      if (cfg.atrx_tp53) {
        if (atrx === -1 && inPanel(cfg, "atrx")) out.push(2);
        if (tp53 === -1 && inPanel(cfg, "tp53")) out.push(3);
      }
    }
    if (mutOk && cfg.grade_complete && codel !== 1 && cdkn === -1 && inPanel(cfg, "cdkn")) out.push(8);
    if (wtOk && !(cfg.hist && g4) && !(tert === 1 || cnv === 1 || egfr === 1)) {
      [["tert", 5], ["cnv", 6], ["egfr", 7]].forEach(function (p) { if (o[p[1]] === -1 && inPanel(cfg, p[0])) out.push(p[1]); });
    }
    var seen = {}, u = [];
    out.forEach(function (j) { if (!seen[j]) { seen[j] = 1; u.push(j); } });
    return u.sort(function (a, b) { return a - b; });
  }

  function sum3(v) { return (v[0] + v[1]) + v[2]; }       // numpy's order for 3 elements

  function update(w, L, j, res) {
    if (res !== 0 && res !== 1) return w.slice();
    var wn = [0, 1, 2].map(function (c) { return w[c] * (res === 1 ? L[j][c] : 1 - L[j][c]); });
    var s = sum3(wn);
    return s > 0 ? wn.map(function (x) { return x / s; }) : w.slice();
  }

  function posterior(prior, L, o) {
    var w = prior.slice();
    for (var j = 0; j < TESTS.length; j++) w = update(w, L, j, o[j]);
    return w;
  }

  /* Exact DP (policy.dp_choose): memo keyed on the state only, candidates in relevant() order, the pr < 1e-9 skip, the
     early break once val >= best, strict < for ties. Yield = 1, so the planning cost of a test is its cost. */
  function makeV(g4, L, cfg) {
    var memo = {};
    function V(o, w) {
      var k = o.join(",");
      if (memo.hasOwnProperty(k)) return memo[k];
      if (support(o, g4, cfg) >= 0) return (memo[k] = [0.0, null]);
      var cand = relevant(o, g4, w, cfg);
      if (!cand.length) return (memo[k] = [0.0, null]);
      var best = INF, bj = null;
      for (var ci = 0; ci < cand.length; ci++) {
        var j = cand[ci], c = cost(cfg, TESTS[j]) / 1.0;
        var p1 = sum3([0, 1, 2].map(function (x) { return w[x] * L[j][x]; })), val = c;
        var branches = [[1, p1], [0, 1 - p1]];
        for (var bi = 0; bi < 2; bi++) {
          var res = branches[bi][0], pr = branches[bi][1];
          if (pr < 1e-9) continue;
          var wn = [0, 1, 2].map(function (x) { return w[x] * (res === 1 ? L[j][x] : 1 - L[j][x]); }), s = sum3(wn);
          wn = wn.map(function (x) { return x / s; });
          var on = o.slice(); on[j] = res;
          val += pr * V(on, wn)[0];
          if (val >= best) break;
        }
        if (val < best) { best = val; bj = j; }
      }
      return (memo[k] = [best, bj]);
    }
    return V;
  }

  function dpChoose(w0, o0, g4, L, cfg) {
    var r = makeV(g4, L, cfg)(o0.slice(), w0.slice());
    return {j: r[1], v: r[0]};
  }

  /* Expected cost to a supported diagnosis if test j is ordered now and the planner continues optimally afterwards,
     for every relevant test (no early break): the explanation table. */
  function qValues(w, o, g4, L, cfg) {
    var V = makeV(g4, L, cfg), out = [];
    relevant(o, g4, w, cfg).forEach(function (j) {
      var c = cost(cfg, TESTS[j]), p1 = sum3([0, 1, 2].map(function (x) { return w[x] * L[j][x]; })), q = c, br = {};
      [[1, p1], [0, 1 - p1]].forEach(function (b) {
        var res = b[0], pr = b[1], on = o.slice(); on[j] = res;
        var wn = [0, 1, 2].map(function (x) { return w[x] * (res === 1 ? L[j][x] : 1 - L[j][x]); }), s = sum3(wn);
        wn = s > 0 ? wn.map(function (x) { return x / s; }) : w.slice();
        var v = pr < 1e-9 ? [0, null] : V(on, wn);
        if (pr >= 1e-9) q += pr * v[0];
        br[res] = {p: pr, support: support(on, g4, cfg), post: wn, next: v[1]};
      });
      out.push({j: j, test: TESTS[j], cost: c, expected_total: q, pos: br[1], neg: br[0]});
    });
    return out.sort(function (a, b) { return a.expected_total - b.expected_total || a.j - b.j; });
  }

  /* glioagent/env.py agent_cap: CAP-style pathway (kind "cap") or marker tree ("tree"). Ignores the panel, like the
     original; the UI marks a step that is not available at the site. Returns a test name or null (refer). */
  function pathwayNext(o, g4, cfg, kind) {
    var nxt = function (t) { return o[TI[t]] === -1; };
    if (nxt("ihc")) return "ihc";
    if (o[TI.ihc] !== 1 && nxt("seq")) return "seq";
    var s = idhState(o);
    if (s === "mut") {
      if (kind === "cap" && cfg.atrx_tp53) {
        if (nxt("atrx")) return "atrx";
        if (o[TI.atrx] !== 1 && nxt("tp53")) return "tp53";
        if (o[TI.atrx] !== 1 && o[TI.tp53] !== 1 && nxt("codel")) return "codel";
      } else if (nxt("codel")) return "codel";
    } else if (s === "wt" && !(kind === "cap" && cfg.hist && g4)) {
      var ts = ["tert", "cnv", "egfr"];
      for (var i = 0; i < ts.length; i++) {
        if (o[TI[ts[i]]] === 1) break;
        if (nxt(ts[i])) return ts[i];
      }
    }
    if (cfg.grade_complete && idhState(o) === "mut" && o[TI.codel] !== 1 && nxt("cdkn") && inPanel(cfg, "cdkn")) return "cdkn";
    return null;
  }

  function ageBand(a) { return a == null || isNaN(a) ? "?" : (a < 35 ? "<35" : a < 50 ? "35-50" : a < 65 ? "50-65" : "65+"); }

  /* Clinical prior, the same naive Bayes as the game's pools (age band x grade, Laplace), fitted on the whole public
     cohort: counts = {prev: [3], age: {band: [3]}, grade: {g: [3]}} already include the +1 smoothing. */
  function clinicalPrior(counts, age, grade) {
    var prev = counts.prev, ps = sum3(prev), pn = prev.map(function (x) { return x / ps; });
    var a = counts.age[ageBand(age)] || [1, 1, 1], g = counts.grade[grade] || [1, 1, 1], as = sum3(a), gs = sum3(g);
    var w = [0, 1, 2].map(function (c) { return (a[c] / as / pn[c]) * (g[c] / gs / pn[c]) * pn[c]; }), s = sum3(w);
    return w.map(function (x) { return x / s; });
  }

  /* A user-supplied prior: floored so no class is impossible (a zero can never recover), then renormalised. */
  function safePrior(p, floor) {
    floor = floor == null ? 0.01 : floor;
    var q = [0, 1, 2].map(function (c) { var x = +p[c]; return isFinite(x) && x > floor ? x : floor; }), s = sum3(q);
    return q.map(function (x) { return x / s; });
  }

  var API = {TESTS: TESTS, TI: TI, CLS: CLS, cfgOf: cfgOf, cost: cost, idhState: idhState, support: support, relevant: relevant,
             update: update, posterior: posterior, dpChoose: dpChoose, qValues: qValues, pathwayNext: pathwayNext,
             ageBand: ageBand, clinicalPrior: clinicalPrior, safePrior: safePrior};
  if (typeof module !== "undefined" && module.exports) module.exports = API; else root.ClinicEngine = API;
})(this);
