/* Clinician tool UI. Everything is computed in this page by clinic_engine.js (exact port of the RECAST planner and the
   WHO CNS5 / CAP evidence rule). The only network request is the public model file, loaded once. No storage. */
(function () {
  "use strict";
  var E = window.ClinicEngine, T = E.TESTS, M = null;
  var INFO = {
    ihc: ["IDH1 R132H IHC", "negative", "positive"], seq: ["IDH1/2 sequencing", "wild-type", "mutant"],
    atrx: ["ATRX IHC", "retained", "lost"], tp53: ["p53 IHC", "wild-type pattern", "mutant pattern"],
    codel: ["1p/19q", "intact", "codeleted"], tert: ["TERT promoter", "wild-type", "mutant"],
    cnv: ["Chr +7/−10", "absent", "present"], egfr: ["EGFR amplification", "not amplified", "amplified"],
    cdkn: ["CDKN2A/B homozygous deletion", "not deleted", "deleted"]};
  var SHORT = ["GBM", "Astro", "Oligo"];
  var FULL = ["Glioblastoma, IDH-wildtype", "Astrocytoma, IDH-mutant", "Oligodendroglioma, IDH-mutant and 1p/19q-codeleted"];
  var FDA_URL = "https://www.fda.gov/drugs/resources-information-approved-drugs/fda-approves-vorasidenib-grade-2-astrocytoma-or-oligodendroglioma-susceptible-idh1-or-idh2-mutation";
  var EXAMPLES = [
    {name: "Older adult, glioblastoma histology", age: 67, grade: "4", g4: true, res: {}},
    {name: "Grade 2, IDH1 R132H positive, ATRX lost", age: 34, grade: "2", g4: false, res: {ihc: 1, atrx: 1}},
    {name: "Grade 3, R132H negative, sequencing pending", age: 45, grade: "3", g4: false, res: {ihc: 0, seq: "p"}},
    {name: "No 1p/19q at this site, send-out 10×", age: 39, grade: "2", g4: false, res: {ihc: 1, atrx: 0}, r: "10", na: ["codel"]},
    {name: "IDH-wildtype, grade 3 histology", age: 58, grade: "3", g4: false, res: {ihc: 0, seq: 0}}];

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c]; }); }
  function pct(x) { return x >= 0.995 ? ">99%" : x < 0.005 ? "<1%" : Math.round(x * 100) + "%"; }
  function num(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  var priorMode = "clinical", last = null;
  /* Optional team log, only in builds that set window.CLINIC_TEAM_LOG (the Informer app; deploy/informer/clinic_app).
     Opt-in per case; stores no patient identifiers (no age, names, birth dates or record numbers), only the user name and save time. The standalone page never shows it. */
  var TEAM_LOG = !!window.CLINIC_TEAM_LOG, LOG_URL = window.CLINIC_LOG_URL || "/api/_server/caselog";
  if (TEAM_LOG && document.body) document.body.classList.add("teamlog");

  /* ---------------------------------------------------------------- inputs */
  function buildInputs() {
    var tb = $("results"), av = $("avail");
    T.forEach(function (t) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(INFO[t][0]) + " <span class=\"na\" id=\"na_" + t + "\"></span></td><td><select id=\"res_" + t + "\">" +
        "<option value=\"\">not done</option><option value=\"p\">pending</option><option value=\"0\">" + esc(INFO[t][1]) + "</option>" +
        "<option value=\"1\">" + esc(INFO[t][2]) + "</option></select></td>";
      tb.appendChild(tr);
      var l = document.createElement("label");
      l.innerHTML = "<input type=\"checkbox\" id=\"av_" + t + "\" checked> " + esc(INFO[t][0]) + " <span class=\"pill\">" + (E.cost(E.cfgOf(), t) === 1 ? "stain" : "molecular") + "</span>";
      av.appendChild(l);
    });
    EXAMPLES.forEach(function (ex, i) {
      var b = document.createElement("button"); b.className = "g"; b.textContent = ex.name; b.id = "ex" + i;
      b.addEventListener("click", function () { load(ex); }); $("examples").appendChild(b);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#priorMode button"), function (b) {
      b.addEventListener("click", function () {
        priorMode = b.getAttribute("data-m");
        Array.prototype.forEach.call(document.querySelectorAll("#priorMode button"), function (x) { x.classList.toggle("sel", x === b); });
        $("customPrior").hidden = priorMode !== "custom"; render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("#inputs input, #inputs select"), function (x) {
      x.addEventListener("change", render); x.addEventListener("input", render);
    });
    $("g4").addEventListener("change", function () { if ($("g4").checked) $("grade").value = "4"; render(); });
  }

  function load(ex) {
    $("age").value = ex.age; $("grade").value = ex.grade; $("g4").checked = ex.g4; $("r").value = ex.r || "3";
    T.forEach(function (t) {
      var v = ex.res[t]; $("res_" + t).value = v == null ? "" : String(v);
      $("av_" + t).checked = !(ex.na && ex.na.indexOf(t) >= 0);
    });
    render();
  }

  function read() {
    var age = parseFloat($("age").value), grade = $("grade").value, g4 = $("g4").checked, r = parseFloat($("r").value);
    var o = [], pending = [], avail = [];
    T.forEach(function (t, j) {
      var v = $("res_" + t).value;
      o.push(v === "0" ? 0 : v === "1" ? 1 : -1);
      if (v === "p") pending.push(t);
      if ($("av_" + t).checked) avail.push(t);
      $("na_" + t).textContent = $("av_" + t).checked ? "" : "(not available here)";
    });
    var prior, priorLabel;
    if (priorMode === "custom") {
      prior = E.safePrior([$("pg").value / 100, $("pa").value / 100, $("po").value / 100]); priorLabel = "your own estimate";
    } else {
      prior = E.clinicalPrior(M.prior_counts, isNaN(age) ? null : age, grade);
      priorLabel = "clinical model (age " + (isNaN(age) ? "unknown" : E.ageBand(age)) + ", grade " + (grade === "?" ? "unknown" : grade) + ")";
    }
    var panel = avail.filter(function (t) { return pending.indexOf(t) < 0; });
    var cfg = E.cfgOf({r: r, tests: panel}), w = E.posterior(prior, M.L, o);
    return {age: age, grade: grade, g4: g4, r: r, o: o, pending: pending, avail: avail, cfg: cfg, prior: prior, priorLabel: priorLabel, w: w};
  }

  /* ---------------------------------------------------------------- explanations */
  function resText(t, v) { return INFO[t][0] + " " + INFO[t][v === 1 ? 2 : 1]; }
  function done(o) { return T.filter(function (t, j) { return o[j] === 0 || o[j] === 1; }).map(function (t) { return resText(t, o[E.TI[t]]); }); }

  function idhBasis(o) {
    if (o[1] === 1) return "IDH-mutant by sequencing"; if (o[1] === 0) return "IDH-wildtype by sequencing";
    if (o[0] === 1) return "IDH-mutant by IDH1 R132H IHC"; return null;
  }
  function reason(o, g4, c) {
    var b = idhBasis(o);
    if (c === 2) return b + " + 1p/19q codeleted";
    if (c === 1) return o[4] === 0 ? b + " + 1p/19q intact" : b + " + " + [o[2] === 1 ? "ATRX loss" : null, o[3] === 1 ? "p53 mutant pattern" : null].filter(Boolean).join(" and ") + " (CAP surrogate; 1p/19q not tested)";
    var m = [g4 ? "glioblastoma histology" : null, o[5] === 1 ? "TERT promoter mutation" : null, o[6] === 1 ? "+7/−10" : null, o[7] === 1 ? "EGFR amplification" : null].filter(Boolean);
    return b + " + " + m.join(", ");
  }
  function checklist(o, g4) {
    var s = E.idhState(o), mut = s === "mut", wt = s === "wt";
    var row = function (ok, txt) { return "<div class=\"chk3\"><span class=\"" + (ok ? "ok" : "no") + "\">" + (ok ? "✓" : "○") + "</span> " + txt + "</div>"; };
    var molGbm = o[5] === 1 || o[6] === 1 || o[7] === 1;
    return "<div class=\"sm muted\">What each diagnosis needs (WHO CNS5, CAP):</div>" +
      row(wt && (g4 || molGbm), "<b>GBM</b>: IDH-wildtype by <i>sequencing</i> (a negative R132H stain is not enough) " + (wt ? "✓" : "○") + " and grade 4 histology or TERT / EGFR / +7−10 " + (g4 || molGbm ? "✓" : "○")) +
      row(mut && (o[4] === 0 || o[2] === 1 || o[3] === 1), "<b>Astro</b>: IDH-mutant " + (mut ? "✓" : "○") + " and 1p/19q intact, or ATRX loss / p53 mutant pattern (surrogate) " + (o[4] === 0 || o[2] === 1 || o[3] === 1 ? "✓" : "○")) +
      row(mut && o[4] === 1, "<b>Oligo</b>: IDH-mutant " + (mut ? "✓" : "○") + " and 1p/19q codeleted " + (o[4] === 1 ? "✓" : "○"));
  }
  function testName(j) { return j == null ? null : INFO[T[j]][0]; }
  function availTag(st, t) { return st.avail.indexOf(t) < 0 ? " <span class=\"pill\">not available here</span>" : st.pending.indexOf(t) >= 0 ? " <span class=\"pill\">pending</span>" : ""; }
  function costOf(st, t) { return E.cost(st.cfg, t); }

  /* ---------------------------------------------------------------- render */
  function render() {
    if (!M) return;
    var st = read(), o = st.o, g4 = st.g4, w = st.w, sup = E.support(o, g4, st.cfg), sum = [];
    last = {grade: st.grade, g4: g4, r: st.r, results: {}, pending: st.pending, unavailable: T.filter(function (t) { return st.avail.indexOf(t) < 0; }),
            supported: sup, next_test: null, surrogate: false, nos: false};
    T.forEach(function (t, j) { if (o[j] === 0 || o[j] === 1) last.results[t] = o[j]; });
    // probabilities
    $("postCard").innerHTML = "<h2>Probabilities</h2><div class=\"bars\">" + [0, 1, 2].map(function (c) {
      return "<div class=\"bar\"><span>" + SHORT[c] + "</span><div class=\"f\" style=\"width:" + Math.max(1, Math.round(w[c] * 260)) + "px\"></div><span class=\"v\">" + pct(w[c]) + "</span></div>"; }).join("") +
      "</div><div class=\"sm muted\">Start: " + esc(st.priorLabel) + " → " + [0, 1, 2].map(function (c) { return SHORT[c] + " " + pct(st.prior[c]); }).join(", ") +
      ". Updated with each reported result (naive Bayes, public model). A probability is not a diagnosis: the evidence rule below decides.</div>";
    // evidence
    var ev = $("evidenceCard"); ev.className = "card " + (sup >= 0 ? "okc" : "warnc");
    var html = "<h2>CNS5 evidence</h2>";
    if (sup >= 0) {
      html += "<div class=\"big\">Supported: " + esc(FULL[sup]) + "</div><div class=\"sm\">" + esc(reason(o, g4, sup)) + "</div>";
      sum.push("Integrated diagnosis supported: " + FULL[sup] + " (" + reason(o, g4, sup) + ").");
    } else {
      html += "<div class=\"big\">Not yet supported</div>"; sum.push("CNS5 evidence not yet complete.");
    }
    html += checklist(o, g4);
    if (sup === 1 && o[4] !== 0 && o[4] !== 1) {
      var codelHere = st.avail.indexOf("codel") >= 0;
      html += "<div class=\"alert\"><b>Surrogate warning.</b> Astrocytoma rests on ATRX/p53 without 1p/19q. Model estimate that this is a 1p/19q-codeleted oligodendroglioma: <b>" + pct(w[2]) +
        "</b> (naive Bayes, public model; that cohort's ATRX/p53 values come from mutation calls, so treat the number as rough). Confirming costs one molecular test (" + st.r + " units)" +
        (codelHere ? "" : ", which would have to be sent out") + ". In GlioAgent's evaluation this shortcut caused every wrong diagnosis made by the planner, GlioAgent and the CAP pathway (TCGA and 917 external patients).</div>";
      last.surrogate = true;
      sum.push("Caution: astrocytoma supported by the ATRX/p53 surrogate without 1p/19q; model P(oligodendroglioma) " + pct(w[2]) + ".");
    }
    if (sup === 1) html += "<div class=\"note\">Grade: CDKN2A/B homozygous deletion makes an IDH-mutant astrocytoma CNS WHO grade 4" + (o[8] === 1 ? " — <b>reported deleted</b>." : o[8] === 0 ? " — reported not deleted." : " — not tested. Grading is not part of this planner.") + "</div>";
    if (sup === 0 && !g4) html += "<div class=\"note\">IDH-wildtype diffuse astrocytic glioma with TERT, EGFR or +7/−10 is glioblastoma, CNS WHO grade 4, on molecular criteria, even without grade 4 histology.</div>";
    ev.innerHTML = html;
    // next step
    var nx = $("nextCard"), h = "<h2>Next step</h2>";
    if (sup >= 0) {
      h += "<div>No further test is needed for the CNS5 class.</div>"; nx.className = "card";
    } else {
      var d = E.dpChoose(w, o, g4, M.L, st.cfg);
      if (d.j != null) {
        var q = E.qValues(w, o, g4, M.L, st.cfg), tj = T[d.j];
        h += "<div class=\"big\">Order next: " + esc(INFO[tj][0]) + " <span class=\"pill\">cost " + costOf(st, tj) + "</span></div>" +
          "<div class=\"sm\">Expected further cost to a supported diagnosis: <b>" + num(d.v) + "</b> units (stain = 1, molecular = " + st.r + "), if the planner continues optimally.</div>";
        h += "<table class=\"q\"><tr><th>If you order</th><th>Result</th><th>Then</th><th>Expected total</th></tr>" + q.map(function (x) {
          var then = function (b, v) {
            if (b.p < 1e-9) return "—";
            return esc(INFO[x.test][v]) + " (" + pct(b.p) + "): " + (b.support >= 0 ? "<b>" + SHORT[b.support] + " supported</b>" : b.next != null ? "then " + esc(testName(b.next)) : "no test can complete it");
          };
          return "<tr" + (x.j === d.j ? " class=\"best\"" : "") + "><td>" + esc(INFO[x.test][0]) + "<div class=\"sm muted\">cost " + x.cost + "</div></td><td colspan=\"2\">" +
            then(x.pos, 2) + "<br>" + then(x.neg, 1) + "</td><td>" + num(x.expected_total) + (x.j === d.j ? " ★" : "") + "</td></tr>";
        }).join("") + "</table>";
        last.next_test = tj;
        sum.push("Planner's next test: " + INFO[tj][0] + " (expected further cost " + num(d.v) + " units).");
      } else if (st.pending.length) {
        h += "<div class=\"big\">Wait for the pending result" + (st.pending.length > 1 ? "s" : "") + "</div><div class=\"sm\">No additional test helps before they return. See below for what each result would mean.</div>";
        sum.push("Awaiting: " + st.pending.map(function (t) { return INFO[t][0]; }).join(", ") + ".");
      } else {
        var send = T.filter(function (t) { return st.avail.indexOf(t) < 0 && o[E.TI[t]] === -1 && E.relevant(o, g4, w, E.cfgOf({r: st.r, tests: st.cfg.tests.concat([t])})).length; });
        h += "<div class=\"alert\"><b>A CNS5 integrated diagnosis cannot be reached with the tests available here.</b> Report as <b>diffuse glioma, NOS</b>" +
          (send.length ? ", or send out: " + send.map(function (t) { return esc(INFO[t][0]); }).join(", ") : "") + ".</div>";
        last.nos = true;
        sum.push("CNS5 diagnosis not reachable with available tests: diffuse glioma, NOS" + (send.length ? "; send-out options: " + send.map(function (t) { return INFO[t][0]; }).join(", ") : "") + ".");
      }
      ["cap", "tree"].forEach(function (k) {
        var t = E.pathwayNext(o, g4, st.cfg, k);
        h += "<div class=\"sm\" style=\"margin-top:6px\">" + (k === "cap" ? "CAP-style pathway" : "Marker tree (always tests 1p/19q)") + " would order: " +
          (t ? esc(INFO[t][0]) + availTag(st, t) : "nothing further (refer)") + "</div>";
      });
    }
    nx.innerHTML = h;
    // pending what-ifs
    var pc = $("pendingCard");
    if (st.pending.length) {
      var ph = "<h2>Pending results: what each would mean</h2><table class=\"q\"><tr><th>Test</th><th>Result</th><th>Evidence</th><th>Planner's next</th></tr>";
      st.pending.forEach(function (t) {
        var j = E.TI[t], L = M.L[j], p1 = (w[0] * L[0] + w[1] * L[1]) + w[2] * L[2];
        [1, 0].forEach(function (v) {
          var on = o.slice(); on[j] = v; var wn = E.update(w, M.L, j, v), sp = E.support(on, g4, st.cfg);
          var others = st.pending.filter(function (x) { return x !== t; }), cfg2 = E.cfgOf({r: st.r, tests: st.avail.filter(function (x) { return others.indexOf(x) < 0; })});
          var nd = sp >= 0 ? null : E.dpChoose(wn, on, g4, M.L, cfg2).j;
          ph += "<tr><td>" + esc(INFO[t][0]) + "</td><td>" + esc(INFO[t][v ? 2 : 1]) + " (" + pct(v ? p1 : 1 - p1) + ")</td><td>" + (sp >= 0 ? "<b>" + SHORT[sp] + " supported</b>" : "not yet") +
            "</td><td>" + (sp >= 0 ? "—" : nd != null ? esc(testName(nd)) : (others.length ? "wait for other results" : "NOS with tests here")) + "</td></tr>";
        });
      });
      pc.innerHTML = ph + "</table><div class=\"sm muted\">Probabilities of each result come from the current probabilities and the public model.</div>"; pc.hidden = false;
    } else pc.hidden = true;
    // treatment relevance (static, sourced)
    var tx = $("txCard");
    if ((sup === 1 || sup === 2) && st.grade === "2") {
      tx.innerHTML = "<h2>Treatment relevance (reference only)</h2><div>On 6 Aug 2024 the FDA approved <b>vorasidenib</b> (Voranigo) for adults and children aged 12 and over with <b>grade 2 astrocytoma or oligodendroglioma with a susceptible IDH1 or IDH2 mutation</b>, following surgery including biopsy, subtotal resection or gross total resection.</div>" +
        "<div class=\"sm\" style=\"margin-top:6px\">Source: <a href=\"" + FDA_URL + "\" target=\"_blank\" rel=\"noopener noreferrer\">FDA announcement</a>. Eligibility depends on the full label and the treating team. This tool does not recommend treatment. MGMT promoter methylation is not modelled.</div>";
      tx.hidden = false;
    } else tx.hidden = true;
    // summary
    var lines = ["Case summary (research prototype; not for clinical decisions)",
      "Age " + (isNaN(st.age) ? "unknown" : st.age) + "; histological grade " + (st.grade === "?" ? "unknown" : st.grade) + "; grade 4 features: " + (g4 ? "yes" : "no") + ".",
      "Results: " + (done(o).join("; ") || "none") + (st.pending.length ? ". Pending: " + st.pending.map(function (t) { return INFO[t][0]; }).join(", ") : "") + ".",
      "Probabilities (" + st.priorLabel + ", updated): " + [0, 1, 2].map(function (c) { return SHORT[c] + " " + pct(w[c]); }).join(", ") + "."].concat(sum);
    if (st.avail.length < T.length) lines.push("Not available at this site: " + T.filter(function (t) { return st.avail.indexOf(t) < 0; }).map(function (t) { return INFO[t][0]; }).join(", ") + ".");
    $("summaryCard").innerHTML = "<h2>Summary for the tumour board</h2><textarea class=\"sum\" id=\"sumtxt\" readonly></textarea><button class=\"g\" id=\"copy\">Copy</button>";
    $("sumtxt").value = lines.join("\n");
    $("copy").addEventListener("click", function () { $("sumtxt").select(); try { document.execCommand("copy"); } catch (e) { /* select is enough */ } $("copy").textContent = "Copied"; });
    if (TEAM_LOG) teamLog();
  }

  function teamLog() {
    var box = document.createElement("div"); box.className = "note";
    box.innerHTML = "<button class=\"g\" id=\"save\">Save to team log</button> <span id=\"saveMsg\"></span><div class=\"sm\" style=\"margin-top:6px\">Stores in your institution's Informer: grade, grade 4 flag, marker results, pending and unavailable tests, cost ratio and this tool's output, with your user name and the time saved. No patient identifiers: no age, free text, names, birth dates or record numbers.</div><div id=\"teamSum\" class=\"sm\" style=\"margin-top:6px\"></div>";
    $("summaryCard").appendChild(box);
    $("save").addEventListener("click", function () {
      $("save").disabled = true;
      fetch(LOG_URL, {method: "POST", headers: {"Content-Type": "application/json"}, credentials: "same-origin", body: JSON.stringify(last)})
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function () { $("saveMsg").textContent = "Saved."; loadTeam(); })
        .catch(function (e) { $("saveMsg").textContent = "Not saved (" + e.message + ")."; $("save").disabled = false; });
    });
    loadTeam();
  }

  function loadTeam() {
    fetch(LOG_URL + "/summary", {credentials: "same-origin"}).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !$("teamSum")) return;
      $("teamSum").innerHTML = "<b>Team log</b>: " + d.cases + " cases · astrocytoma on the ATRX/p53 surrogate alone: " + d.surrogate +
        " · NOS with local tests: " + d.nos + (d.next && d.next.length ? " · most recommended next tests: " + d.next.map(function (x) { return esc(INFO[x.test] ? INFO[x.test][0] : x.test) + " " + x.n; }).join(", ") : "");
    }).catch(function () { /* summary is optional */ });
  }

  function how() {
    var s = M.source;
    $("how").innerHTML = "<h2>How it works</h2><ul>" +
      "<li><b>Evidence rule.</b> WHO CNS5 / CAP criteria for the three adult diffuse gliomas, including the CAP shortcut that accepts ATRX loss or a p53 mutant pattern as enough for astrocytoma.</li>" +
      "<li><b>Next test.</b> An exact planner (dynamic programming) picks the test with the lowest expected cost to reach a supported diagnosis, given your results, the tests your site has, and your molecular-to-stain cost ratio. It is the RECAST v2 planner, ported line by line and checked against the Python original.</li>" +
      "<li><b>GlioAgent.</b> RECAST's language-model agent (Qwen3-8B), trained to imitate this planner and then with reinforcement learning, matches it: −3.92 vs −3.89 on 644 held-out TCGA patients, −3.59 vs −3.61 on 917 patients from three other cohorts, about 0.9 better than a CAP-style pathway. This page uses the planner itself: it is exact, free and auditable.</li>" +
      "<li><b>Model.</b> Fitted on " + s.n + " adults from the public " + esc(s.name) + " (" + esc(s.citation) + "). " + esc(s.notes.join(" ")) + " Licence: " + esc(s.licence) + ".</li>" +
      "<li><b>Limits.</b> Three classes only; no grading, NOS/NEC, paediatric-type or IDH-wildtype non-GBM entities; no reflex panels, turnaround times or tissue limits; costs are relative units. Not validated prospectively.</li></ul>";
  }

  fetch(document.body.getAttribute("data-model") || "model.json").then(function (r) { return r.json(); }).then(function (m) {
    M = m; buildInputs(); how(); render();
  }).catch(function (e) { $("postCard").textContent = "Could not load the model: " + e; });
})();
