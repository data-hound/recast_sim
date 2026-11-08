/* Hospital simulation + Daily Workup practice (web/hospital/). Simulation for demonstration only: fictional hospitals,
   cases from public research cohorts (cases.json), compressed time. Every decision aid is computed in this page by
   clinic_engine.js (the RECAST planner and the WHO CNS5 / CAP evidence rule). Network: model.json and cases.json only.
   Storage: the simulation lives in sessionStorage (simulated data only); Daily Workup history in localStorage ("dw_"). */
(function () {
  "use strict";
  var SECONDS_PER_DAY = 60;                 // real seconds per simulated day (override with ?speed=N)
  var START_MIN = 8 * 60, DAY = 1440, MAX_CASES = 12, FIRST_CASES = 3, KEY = "hosp_sim_v1";
  var E = window.ClinicEngine, T = E.TESTS, M = null, D = null, HOSP = {}, ALL = [], PR = [], IU = null;
  var INFO = {
    ihc: ["IDH1 R132H IHC", "negative", "positive"], seq: ["IDH1/2 sequencing", "wild-type", "mutant"],
    atrx: ["ATRX IHC", "retained", "lost"], tp53: ["p53 IHC", "wild-type pattern", "mutant pattern"],
    codel: ["1p/19q", "intact", "codeleted"], tert: ["TERT promoter", "wild-type", "mutant"],
    cnv: ["Chr +7/−10", "absent", "present"], egfr: ["EGFR amplification", "not amplified", "amplified"],
    cdkn: ["CDKN2A/B homozygous deletion", "not deleted", "deleted"]};
  var STAIN = {ihc: 1, atrx: 1, tp53: 1};
  var SHORT = ["GBM", "Astro", "Oligo"];
  var FULL = ["Glioblastoma, IDH-wildtype", "Astrocytoma, IDH-mutant", "Oligodendroglioma, IDH-mutant and 1p/19q-codeleted"];
  var PREFIX = {lakeside: "LK", riverbend: "RB", harbor: "HP", northgate: "NG", valley: "VC"};
  /* Demo accounts: fictional hospitals on reserved ".example" domains (RFC 2606), so no address can belong to a real site.
     The password is shown on the sign-in page: this sign-in picks a simulated persona; it is not a security boundary
     (on Informer, the real access control is Informer's own sign-in and the App's roles). */
  var DOMAIN = {lakeside: "lakeside-general.example", riverbend: "riverbend-university.example", harbor: "harborpoint-cancer.example",
                northgate: "northgate-regional.example", valley: "valley-community.example"};
  var DEMO_PASSWORD = "demo";
  var USERS = Object.keys(DOMAIN).map(function (h) { return {id: "dummy_clinician@" + DOMAIN[h], role: "Clinician", site: h}; }).concat([
    {id: "dummy_steward@" + DOMAIN.lakeside, role: "Data steward", site: "lakeside", steward: true},
    {id: "judge@glioagent-demo.example", role: "Judge (any hospital)", site: "lakeside", steward: true, judge: true}]);

  var qs = {};
  location.search.replace(/^\?/, "").split("&").forEach(function (kv) { var p = kv.split("="); if (p[0]) qs[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ""); });
  var SPEED = +qs.speed > 0 ? +qs.speed : SECONDS_PER_DAY;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c]; }); }
  function pct(x) { return x >= 0.995 ? ">99%" : x < 0.005 ? "<1%" : Math.round(x * 100) + "%"; }
  function num(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function fmtCost(x) { return Math.round(x) === x ? String(x) : num(x); }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  /* Storage may be missing or throw on first access (e.g. an Informer sandboxed iframe without allow-same-origin). Every
     access goes through these helpers; on any failure that storage kind switches to an in-memory map for the rest of the
     page's life, so the page works fully and only loses persistence across reloads. */
  var MEM = {localStorage: {}, sessionStorage: {}}, BROKEN = {};
  function store(kind) {
    if (BROKEN[kind]) return null;
    try { var s = window[kind]; if (!s) throw new Error("no " + kind); return s; } catch (e) { BROKEN[kind] = true; return null; }
  }
  function sget(kind, k) {
    var s = store(kind), raw = null;
    if (s) { try { raw = s.getItem(k); } catch (e) { BROKEN[kind] = true; s = null; } }
    if (!s) raw = MEM[kind].hasOwnProperty(k) ? MEM[kind][k] : null;
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function sset(kind, k, v) {
    var raw = JSON.stringify(v), s = store(kind); MEM[kind][k] = raw;
    if (s) { try { s.setItem(k, raw); } catch (e) { BROKEN[kind] = true; } }
  }
  function sdel(kind, k) { delete MEM[kind][k]; var s = store(kind); if (s) { try { s.removeItem(k); } catch (e) { BROKEN[kind] = true; } } }

  /* ---------------------------------------------------------------- state */
  var S = null;
  function freshState(user, hid) {
    return {v: 1, seed: qs.seed ? hash(qs.seed) : (Math.floor(Math.random() * 4294967296) >>> 0), base: START_MIN, anchor: null,
            user: user || null, hid: hid || null, tab: "work", open: null, hosp: {}};
  }
  function save() { sset("sessionStorage", KEY, S); }
  function now() { return S.anchor == null ? S.base : S.base + (Date.now() - S.anchor) / (SPEED * 1000) * DAY; }
  function startClock() { if (S.anchor == null) { S.anchor = Date.now(); save(); } }
  function setClock(m) { S.base = m; S.anchor = Date.now(); save(); }
  function fmtTime(m) {
    m = Math.floor(m); var d = Math.floor(m / DAY) + 1, r = m % DAY, h = Math.floor(r / 60), mi = r % 60;
    return "Day " + d + " · " + (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
  }
  function days(m) { return (Math.round(m / DAY * 10) / 10).toFixed(1); }
  function hs(hid) { if (!S.hosp[hid]) S.hosp[hid] = {cases: {}}; return S.hosp[hid]; }
  function cstate(hid, cid) { var h = hs(hid); if (!h.cases[cid]) h.cases[cid] = {orders: [], signed: null}; return h.cases[cid]; }

  /* Arrivals: deterministic for (session seed, hospital). 3 cases at Day 1 08:00, then one every 0.5–1.0 simulated day. */
  var arrCache = {};
  function arrivals(hid) {
    var k = S.seed + ":" + hid;
    if (arrCache[k]) return arrCache[k];
    var H = HOSP[hid], r = rng(hash(k)), idx = H.cases.map(function (c, i) { return i; });
    for (var i = idx.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    var out = [], at = START_MIN;
    idx.slice(0, MAX_CASES).forEach(function (ci, n) {
      if (n >= FIRST_CASES) at += Math.round((0.5 + 0.5 * r()) * DAY);
      out.push({c: H.cases[ci], at: at, n: n});
    });
    return (arrCache[k] = out);
  }
  function arrived(hid, tm) { return arrivals(hid).filter(function (a) { return a.at <= tm; }); }
  function findArr(hid, cid) { var a = arrivals(hid); for (var i = 0; i < a.length; i++) if (a[i].c.id === cid) return a[i]; return null; }
  function shortId(hid, c) { return (PREFIX[hid] || "XX") + "-" + c.id.slice(0, 5).toUpperCase(); }
  function tat(H, t) { return STAIN[t] ? H.settings.tat.stain : H.settings.tat.molecular; }
  function histo(c) { return "grade " + (c.grade ? c.grade : "unknown") + " · " + (c.g4 ? "GBM features (necrosis/MVP)" : "no grade 4 features"); }
  function priorOf(c) { return E.clinicalPrior(M.prior_counts, c.age, c.grade); }
  function availOf(H) { return T.filter(function (t) { return H.settings.unavailable.indexOf(t) < 0; }); }

  /* Everything the page shows about a hospital case at simulated time tm (sign-out freezes it at the sign-out time). */
  function view(hid, a, tm) {
    var H = HOSP[hid], c = a.c, cs = cstate(hid, c.id);
    if (cs.signed) tm = Math.min(tm, cs.signed.at);
    var o = T.map(function () { return -1; }), pending = [], ordered = {}, costSum = 0;
    cs.orders.forEach(function (od) {
      var j = E.TI[od.t]; ordered[od.t] = od; costSum += E.cost(E.cfgOf({r: H.settings.r}), od.t);
      if (od.due <= tm) o[j] = c.results[j]; else pending.push(od.t);
    });
    var avail = availOf(H), panel = avail.filter(function (t) { return pending.indexOf(t) < 0; });
    var cfg = E.cfgOf({r: H.settings.r, tests: panel}), prior = priorOf(c), w = E.posterior(prior, M.L, o), sup = E.support(o, c.g4, cfg);
    var d = sup >= 0 ? {j: null, v: 0} : E.dpChoose(w, o, c.g4, M.L, cfg);
    var nos = sup < 0 && d.j == null && !pending.length;
    var status = cs.signed ? "signed" : !cs.orders.length && sup < 0 ? "new" : pending.length && sup < 0 ? "pending" : (sup >= 0 || nos) ? "ready" : "work";
    return {H: H, c: c, a: a, cs: cs, tm: tm, o: o, pending: pending, ordered: ordered, cost: costSum, avail: avail, cfg: cfg, prior: prior, w: w,
            sup: sup, d: d, nos: nos, status: status};
  }

  /* Rollouts on the true results: the planner (full panel minus unavailable) and the CAP-style pathway. */
  function rollPlanner(c, r, unavail) {
    var cfg = E.cfgOf({r: r, tests: T.filter(function (t) { return unavail.indexOf(t) < 0; })}), prior = priorOf(c);
    var o = T.map(function () { return -1; }), seq = [], cost = 0;
    for (var k = 0; k < 12 && E.support(o, c.g4, cfg) < 0; k++) {
      var d = E.dpChoose(E.posterior(prior, M.L, o), o, c.g4, M.L, cfg);
      if (d.j == null) break;
      o[d.j] = c.results[d.j]; seq.push(T[d.j]); cost += E.cost(cfg, T[d.j]);
    }
    return {seq: seq, cost: cost, cls: E.support(o, c.g4, cfg), o: o};
  }
  function rollCap(c, r, unavail) {
    var cfg = E.cfgOf({r: r}), o = T.map(function () { return -1; }), seq = [], cost = 0, refer = null;
    for (var k = 0; k < 12 && E.support(o, c.g4, cfg) < 0; k++) {
      var t = E.pathwayNext(o, c.g4, cfg, "cap");
      if (!t) break;
      if (unavail.indexOf(t) >= 0) { refer = t; break; }
      o[E.TI[t]] = c.results[E.TI[t]]; seq.push(t); cost += E.cost(cfg, t);
    }
    return {seq: seq, cost: cost, cls: E.support(o, c.g4, cfg), refer: refer};
  }

  /* ---------------------------------------------------------------- shared pieces */
  function bars(w, prior, label) {
    return "<h2>Probabilities</h2><div class=\"bars\">" + [0, 1, 2].map(function (c) {
      return "<div class=\"bar\"><span>" + SHORT[c] + "</span><div class=\"f\" style=\"width:" + Math.max(1, Math.round(w[c] * 240)) + "px\"></div><span class=\"v\">" + pct(w[c]) + "</span></div>"; }).join("") +
      "</div><div class=\"sm muted\">Start: " + esc(label) + " → " + [0, 1, 2].map(function (c) { return SHORT[c] + " " + pct(prior[c]); }).join(", ") +
      ". Updated with returned results only (naive Bayes, public model). A probability is not a diagnosis: the evidence rule decides.</div>";
  }
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
  function evidence(o, g4, sup, w, r, codelNote) {
    var html = "<h2>CNS5 evidence</h2>";
    html += sup >= 0 ? "<div class=\"big\" id=\"supported\" data-cls=\"" + sup + "\">Supported: " + esc(FULL[sup]) + "</div><div class=\"sm\">" + esc(reason(o, g4, sup)) + "</div>"
      : "<div class=\"big\" id=\"supported\" data-cls=\"-1\">Not yet supported</div>";
    html += checklist(o, g4);
    if (sup === 1 && o[4] !== 0 && o[4] !== 1) {
      html += "<div class=\"alert\" id=\"surrogate\"><b>Surrogate warning.</b> Astrocytoma rests on ATRX/p53 without 1p/19q. Model estimate that this is a 1p/19q-codeleted oligodendroglioma: <b>" + pct(w[2]) +
        "</b> (naive Bayes, public model; that cohort's ATRX/p53 values come from mutation calls, so treat the number as rough). Confirming costs one molecular test (" + esc(r) + " units)" +
        (codelNote || "") + ". In GlioAgent's evaluation this shortcut caused every wrong diagnosis made by the planner, GlioAgent and the CAP pathway (TCGA and 917 external patients).</div>";
    }
    return html;
  }
  function seqText(seq) { return seq.length ? seq.map(function (t) { return INFO[t][0]; }).join(" → ") : "no tests"; }
  function clsText(c) { return c >= 0 ? FULL[c] : "diffuse glioma, NOS"; }

  /* ---------------------------------------------------------------- header, tabs */
  function renderHeader() {
    var signed = !!(S && S.user && S.hid);
    $("hinfo").hidden = !signed; $("tabs").hidden = !signed; $("logout").hidden = !(S && S.user);
    if (!signed) return;
    $("who").innerHTML = "<b>" + esc(S.user.name) + "</b> · " + esc(S.user.role);
    var sel = "";
    if (S.user.judge || S.user.anySite) {
      sel = "<select id=\"hsel\" class=\"hsel\" aria-label=\"Hospital\">" + D.hospitals.map(function (h) {
        return "<option value=\"" + esc(h.id) + "\"" + (h.id === S.hid ? " selected" : "") + ">" + esc(h.name) + "</option>"; }).join("") + "</select>";
      $("hname").innerHTML = sel;
    } else $("hname").textContent = HOSP[S.hid].name;
    var tabs = [["work", "Worklist · GlioAgent assistant"]];
    if ($("toolPane")) tabs.push(["tool", "Clinician tool (any case)"]);
    if (S.user.steward) tabs.push(["dash", "Site dashboard"]);
    tabs.push(["practice", "Practice · Daily Workup"]);
    $("tabs").innerHTML = tabs.map(function (t) { return "<button class=\"g" + (S.tab === t[0] ? " sel" : "") + "\" data-act=\"tab\" data-tab=\"" + t[0] + "\" id=\"tab_" + t[0] + "\">" + esc(t[1]) + "</button>"; }).join("") +
      "<span class=\"sp sm muted\">" + (IU ? "Informer: " + esc(IU.name) + " · demo persona" : "Demo sign-in") + " · simulated hospitals · public research data · 1 simulated day = " + esc(SPEED) + " s</span>" +
      "<button class=\"g sm\" data-act=\"reset\" id=\"resetBtn\">Reset simulation</button>";
    tickClock();
  }
  function tickClock() { if (S && S.hid && $("hclock")) $("hclock").textContent = fmtTime(now()); }

  function render() {
    renderHeader();
    var tp = $("toolPane"), onTool = !!(tp && S.user && S.hid && S.tab === "tool");
    if (tp) tp.hidden = !onTool;
    $("view").hidden = onTool;
    if (onTool) return;
    if (!S.user || !S.hid) return renderSignin();
    if (S.tab === "dash" && S.user.steward) return renderDash();
    if (S.tab === "practice") return renderPractice();
    S.tab = "work";
    if (S.open && findArr(S.hid, S.open) && findArr(S.hid, S.open).at <= now()) return renderCase();
    S.open = null; renderWorklist();
  }

  /* ---------------------------------------------------------------- sign-in */
  function informerUser() {
    var I = window.__INFORMER__;
    if (!I || typeof I !== "object" || !I.user || typeof I.user !== "object") return null;
    var u = I.user, name = u.displayName || u.display_name || u.name || u.username || u.id || "Informer user";
    var raw = [].concat(Array.isArray(u.roles) ? u.roles : [], Array.isArray(I.roles) ? I.roles : []);
    var roles = raw.map(function (r) { return typeof r === "string" ? r : r && typeof r === "object" ? String(r.id || r.name || "") : ""; });
    var site = null;
    roles.forEach(function (r) { var m = /^site_(.+)$/.exec(r); if (m && HOSP[m[1]] && !site) site = m[1]; });
    var steward = roles.indexOf("steward") >= 0;
    return {id: String(u.username || u.id || name), name: String(name), role: (steward ? "Data steward" : "Clinician") + " (Informer)", site: site, steward: steward,
            anySite: !site, informer: true};
  }
  function renderSignin() {
    var v = $("view"), pre = "";
    if (IU && IU.site) USERS.forEach(function (u) { if (!pre && u.site === IU.site && !u.steward) pre = u.id; });
    v.innerHTML = "<div class=\"card signin\"><h2>Sign in · GlioAgent Workup</h2>" +
      "<div class=\"sm muted\">Simulated hospital accounts. Hospitals are fictional; their worklists are adult glioma cases from the public TCGA cohort, split by the contributing institution. " +
      "Time is compressed (1 simulated day = " + esc(SPEED) + " real seconds). This is a demonstration, not a clinical system.</div>" +
      (IU ? "<div class=\"note\">Signed in to Informer as <b>" + esc(IU.name) + "</b>. Choose the simulated hospital account to use.</div>" : "") +
      "<form id=\"loginForm\" class=\"login\" autocomplete=\"off\"><label>Email<input id=\"loginEmail\" type=\"email\" placeholder=\"dummy_clinician@lakeside-general.example\" value=\"" + esc(pre) + "\"></label>" +
      "<label>Password<input id=\"loginPass\" type=\"password\" placeholder=\"demo\"></label>" +
      "<button class=\"g pri\" type=\"submit\" id=\"loginBtn\">Sign in</button><div class=\"sm bad\" id=\"loginErr\" role=\"alert\"></div></form>" +
      "<h3>Demo accounts (password: <code>" + esc(DEMO_PASSWORD) + "</code>)</h3><div class=\"sm muted\">Click one to fill the form. Every account also has the Clinician tool and Practice · Daily Workup (external cohorts, not the hospital's own cases).</div>" +
      "<div class=\"ulist\">" + USERS.map(function (u, i) {
        return "<button class=\"g\" type=\"button\" data-act=\"fill\" data-u=\"" + esc(u.id) + "\" id=\"u_" + i + "\"><b>" + esc(u.id) + "</b><span class=\"sm muted\">" + esc(u.role) +
          (u.judge ? " · can switch hospital" : " · " + esc(HOSP[u.site].name)) + "</span></button>"; }).join("") + "</div></div>";
  }
  function tryLogin() {
    var em = ($("loginEmail").value || "").trim().toLowerCase(), pw = $("loginPass").value || "";
    var u = USERS.filter(function (x) { return x.id === em; })[0];
    if (!u) { $("loginErr").textContent = "No demo account with that email. Pick one from the list below."; return; }
    if (pw !== DEMO_PASSWORD) { $("loginErr").textContent = "Wrong password. The demo password is shown below."; return; }
    signIn(u);
  }

  /* ---------------------------------------------------------------- worklist */
  var STATUS = {"new": ["new", "new"], pending: ["tests pending", "pend"], ready: ["ready to sign out", "ready"], work: ["needs next test", "work"], signed: ["signed out", "done"]};
  function renderWorklist() {
    var hid = S.hid, H = HOSP[hid], tm = now(), arr = arrived(hid, tm), all = arrivals(hid);
    var next = all.filter(function (a) { return a.at > tm; })[0];
    var rows = arr.map(function (a) {
      var x = view(hid, a, tm), st = STATUS[x.status], end = x.cs.signed ? x.cs.signed.at : tm;
      return "<tr class=\"wrow\" data-act=\"open\" data-c=\"" + esc(a.c.id) + "\"><td><b>" + esc(shortId(hid, a.c)) + "</b></td><td>" + esc(a.c.age_band) + "</td><td>" + esc(histo(a.c)) +
        "</td><td><span class=\"st " + st[1] + "\">" + esc(st[0]) + "</span>" + (x.status === "ready" && x.nos ? " <span class=\"st nos\">NOS</span>" : "") +
        (x.pending.length ? " <span class=\"sm muted\">" + x.pending.length + " pending</span>" : "") + "</td><td>" + days(end - a.at) + "</td><td>" + esc(fmtTime(a.at)) + "</td></tr>";
    }).join("");
    var s = H.settings;
    $("view").innerHTML = "<div class=\"card\"><h2>Worklist · " + esc(H.name) + "</h2><div class=\"sm muted\">Molecular test cost " + esc(s.r) + "× a stain · turnaround: stains " + esc(s.tat.stain) +
      " day" + (s.tat.stain > 1 ? "s" : "") + ", molecular " + esc(s.tat.molecular) + " days" + (s.sendout ? " (send-out)" : "") +
      (s.unavailable.length ? " · not available here: " + s.unavailable.map(function (t) { return esc(INFO[t][0]); }).join(", ") : "") + "</div>" +
      "<table class=\"wl\" id=\"worklist\"><tr><th>Case</th><th>Age</th><th>Histology</th><th>Status</th><th>Days open</th><th>Arrived</th></tr>" + rows + "</table>" +
      "<div class=\"sm muted\" style=\"margin-top:8px\">" + arr.length + " of " + all.length + " cases arrived" + (next ? " · next arrival " + esc(fmtTime(next.at)) : " · no more arrivals in this session") +
      ". Click a case to open it.</div></div>";
  }

  /* ---------------------------------------------------------------- case view */
  function renderCase() {
    var hid = S.hid, a = findArr(hid, S.open), x = view(hid, a, now()), H = x.H, c = x.c, o = x.o, s = H.settings;
    var signed = !!x.cs.signed, rcfg = E.cfgOf({r: s.r});
    var res = "<table class=\"res\" id=\"hresults\">" + T.map(function (t, j) {
      var od = x.ordered[t], cell;
      if (o[j] === 0 || o[j] === 1) cell = "<span class=\"rv " + (o[j] ? "pos" : "neg") + "\">" + esc(INFO[t][o[j] ? 2 : 1]) + "</span>" + (c.simulated.indexOf(t) >= 0 ? " <span class=\"pill\">simulated value</span>" : "");
      else if (od) cell = "<span class=\"rv pend\">pending · due " + esc(fmtTime(od.due)) + "</span>";
      else cell = "<span class=\"muted\">" + (s.unavailable.indexOf(t) >= 0 ? "not available here" : "not ordered") + "</span>";
      return "<tr><td>" + esc(INFO[t][0]) + "</td><td>" + cell + "</td></tr>"; }).join("") + "</table>";
    var btns = "<div class=\"tgrid\" id=\"testBtns\">" + T.map(function (t) {
      var un = s.unavailable.indexOf(t) >= 0, od = x.ordered[t], dis = un || !!od || signed;
      var sub = un ? "not available here" : "cost " + fmtCost(E.cost(rcfg, t)) + " · " + (STAIN[t] ? "stain" : "molecular") + " · " + tat(H, t) + " day" + (tat(H, t) > 1 ? "s" : "") +
        (!STAIN[t] && s.sendout ? " · send-out" : "");
      return "<button class=\"g" + (od ? " ord" : "") + "\" data-act=\"order\" data-t=\"" + t + "\"" + (dis ? " disabled" : "") + ">" + esc(INFO[t][0]) +
        "<span class=\"sm muted\">" + esc(od ? (x.pending.indexOf(t) >= 0 ? "ordered · pending" : "ordered · resulted") : sub) + "</span></button>"; }).join("") + "</div>";
    var left = "<div class=\"card\"><h2>Case " + esc(shortId(hid, c)) + "</h2><div>Age " + esc(c.age_band) + " · " + esc(histo(c)) + "</div><div class=\"sm muted\">Arrived " + esc(fmtTime(a.at)) +
      " · " + (signed ? "signed out " + esc(fmtTime(x.cs.signed.at)) : "open " + days(now() - a.at) + " days") + " · tests ordered so far cost " + esc(fmtCost(x.cost)) + " units</div></div>" +
      "<div class=\"card\"><h2>Results</h2>" + res + "</div><div class=\"card\"><h2>Order tests</h2><div class=\"sm muted\">Order one at a time (cheaper, slower) or several in parallel (faster, costs more). Stain = 1 unit, molecular = " +
      esc(s.r) + " units here.</div>" + btns + "</div>";
    // right column
    var right = "";
    if (signed) right += debrief(x);
    right += "<div class=\"card\">" + bars(x.w, x.prior, "clinical model (age " + c.age_band + ", grade " + (c.grade || "unknown") + ")") + "</div>";
    right += "<div class=\"card " + (x.sup >= 0 ? "okc" : "warnc") + "\">" + evidence(o, c.g4, x.sup, x.w, s.r,
      s.unavailable.indexOf("codel") >= 0 ? ", which would have to be sent out" : x.ordered.codel ? "; it is already pending" : "") + "</div>";
    if (!signed) {
      var nx = "<h2>Assistant</h2>";
      if (x.sup >= 0) nx += "<div id=\"sug\" data-t=\"\">Evidence complete: no further test is needed for the CNS5 class.</div>";
      else if (x.d.j != null) {
        var tj = T[x.d.j];
        nx += "<div class=\"big\" id=\"sug\" data-t=\"" + tj + "\">Assistant suggests: " + esc(INFO[tj][0]) + " <span class=\"pill\">cost " + esc(fmtCost(E.cost(rcfg, tj))) + "</span></div>" +
          "<div class=\"sm\">Expected further cost to a supported diagnosis: <b>" + num(x.d.v) + "</b> units (stain = 1, molecular = " + esc(s.r) + "), over tests available here and not pending.</div>" +
          (x.pending.length ? "<div class=\"note\">The suggestion plans as if the pending result" + (x.pending.length > 1 ? "s" : "") + " (" + esc(x.pending.map(function (t) { return INFO[t][0]; }).join(", ")) +
            ") were not coming. Ordering now runs in parallel (faster, may cost more); waiting with ⏩ Next result may make it unnecessary.</div>" : "");
      } else if (x.pending.length) {
        nx += "<div class=\"big\" id=\"sug\" data-t=\"\">Wait for the pending result" + (x.pending.length > 1 ? "s" : "") + "</div><div class=\"sm\">No additional test available here helps before " +
          (x.pending.length > 1 ? "they return" : "it returns") + ". Press ⏩ Next result to advance the clock.</div>";
      } else {
        var send = s.unavailable.filter(function (t) { return o[E.TI[t]] === -1 && E.relevant(o, c.g4, x.w, E.cfgOf({r: s.r, tests: x.avail.concat([t])})).length; });
        nx += "<div class=\"alert\" id=\"sug\" data-t=\"\" data-nos=\"1\"><b>A CNS5 integrated diagnosis cannot be reached with the tests available here.</b> Report as <b>diffuse glioma, NOS</b>" +
          (send.length ? ", or send out: " + send.map(function (t) { return esc(INFO[t][0]); }).join(", ") : "") + ".</div>";
      }
      if (x.sup < 0) {
        var cap = E.pathwayNext(o, c.g4, E.cfgOf({r: s.r}), "cap");
        nx += "<div class=\"sm\" style=\"margin-top:6px\">CAP-style pathway would order: " + (cap ? esc(INFO[cap][0]) + (s.unavailable.indexOf(cap) >= 0 ? " <span class=\"pill\">not available here</span>" :
          x.pending.indexOf(cap) >= 0 ? " <span class=\"pill\">pending</span>" : "") : "nothing further (refer)") + "</div>";
      }
      nx += "<h3>Sign out</h3><div class=\"signs\" id=\"signBtns\">" + [0, 1, 2].map(function (k) {
        return "<button class=\"" + (x.sup === k ? "b" : "g") + "\" data-act=\"signout\" data-cls=\"" + k + "\"" + (x.sup === k ? "" : " disabled") + ">Sign out " + esc(SHORT[k]) + "</button>"; }).join("") +
        "<button class=\"g\" data-act=\"signout\" data-cls=\"-1\"" + (x.nos ? "" : " disabled") + ">Sign out: diffuse glioma, NOS</button></div>" +
        "<div class=\"sm muted\" style=\"margin-top:4px\">Only the class the evidence supports can be signed out; NOS only when no test available here can complete the evidence and nothing is pending.</div>";
      right += "<div class=\"card\">" + nx + "</div>";
    }
    $("view").innerHTML = "<button class=\"g back\" data-act=\"back\">← Worklist</button><div class=\"cols\"><section class=\"col\">" + left + "</section><section class=\"col\">" + right + "</section></div>";
  }

  function debrief(x) {
    var H = x.H, c = x.c, s = H.settings, cs = x.cs, cls = cs.signed.cls;
    var pl = rollPlanner(c, s.r, s.unavailable), cap = rollCap(c, s.r, s.unavailable);
    var tatSum = function (seq) { return seq.reduce(function (acc, t) { return acc + tat(H, t); }, 0); };
    var verdict = cls < 0 ? "NOS (no CNS5 class asserted)" : cls === c.y ? "correct" : "wrong";
    var matched = cs.orders.filter(function (od) { return od.match; }).length;
    var outc = function (k) { return k >= 0 ? (k === c.y ? "✓ " : "✗ ") + SHORT[k] : "NOS"; };
    var h = "<div class=\"card debrief\" id=\"debrief\"><h2>Debrief (simulation only)</h2>" +
      "<div class=\"big\">True class: <span id=\"trueCls\">" + esc(FULL[c.y]) + "</span></div>" +
      "<div>You signed out: <b>" + esc(clsText(cls)) + "</b> · <span id=\"verdict\">" + esc(verdict) + "</span></div>" +
      "<div class=\"sm muted\">Days from arrival to sign-out: <b>" + days(cs.signed.at - x.a.at) + "</b> · your test cost: <b>" + esc(fmtCost(x.cost)) +
      "</b> units (every ordered test counts, including any still pending at sign-out).</div>" +
      "<table class=\"q\" id=\"compare\"><tr><th></th><th>Tests</th><th>Cost</th><th>Days if one at a time</th><th>Outcome</th></tr>" +
      "<tr><td>You</td><td>" + esc(seqText(cs.orders.map(function (od) { return od.t; }))) + "</td><td>" + esc(fmtCost(x.cost)) + "</td><td>" + days(cs.signed.at - x.a.at) + " (actual)</td><td>" + esc(cls >= 0 ? outc(cls) : "NOS") + "</td></tr>" +
      "<tr><td>Planner</td><td>" + esc(seqText(pl.seq)) + "</td><td>" + esc(fmtCost(pl.cost)) + "</td><td>" + tatSum(pl.seq) + "</td><td>" + esc(outc(pl.cls)) + "</td></tr>" +
      "<tr><td>CAP pathway</td><td>" + esc(seqText(cap.seq)) + (cap.refer ? " → refer (needs " + esc(INFO[cap.refer][0]) + ", not available here)" : "") + "</td><td>" + esc(fmtCost(cap.cost)) +
      "</td><td>" + tatSum(cap.seq) + "</td><td>" + esc(cap.refer ? "refer" : outc(cap.cls)) + "</td></tr></table>" +
      "<div class=\"sm muted\" style=\"margin-top:4px\">Planner and CAP rows replay the true results of this case with this hospital's tests and costs (" + esc(s.r) + "× molecular), one test at a time.</div>";
    if (cs.orders.length) {
      h += "<h3>Your orders vs the assistant at the time</h3><div class=\"sm\">" + cs.orders.map(function (od) {
        return esc(INFO[od.t][0]) + " (" + esc(fmtTime(od.at)) + "): " + (od.match ? "matched the suggestion ✓" : od.sug ? "assistant suggested " + esc(INFO[od.sug][0]) : "assistant had no suggestion (evidence complete or waiting)");
      }).join("<br>") + "</div><div class=\"sm muted\">" + matched + " of " + cs.orders.length + " orders matched.</div>";
    }
    return h + (c.simulated.length ? "<div class=\"sm muted\" style=\"margin-top:6px\">Results marked “simulated value” (" + esc(c.simulated.map(function (t) { return INFO[t][0]; }).join(", ")) +
      ") were filled in for this demo where the public cohort had no measurement.</div>" : "") + "</div>";
  }

  /* ---------------------------------------------------------------- dashboard */
  function median(a) { if (!a.length) return null; var b = a.slice().sort(function (x, y) { return x - y; }), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
  function renderDash() {
    var hid = S.hid, H = HOSP[hid], tm = now(), rows = [];
    arrived(hid, tm).forEach(function (a) { var x = view(hid, a, tm); if (x.cs.signed) rows.push(x); });
    var cls = rows.filter(function (x) { return x.cs.signed.cls >= 0; }), correct = cls.filter(function (x) { return x.cs.signed.cls === x.c.y; }).length;
    var surr = rows.filter(function (x) { return x.cs.signed.cls === 1 && x.o[4] !== 0 && x.o[4] !== 1; }).length, nos = rows.length - cls.length;
    var orders = 0, match = 0, md = median(rows.map(function (x) { return (x.cs.signed.at - x.a.at) / DAY; }));
    rows.forEach(function (x) { orders += x.cs.orders.length; match += x.cs.orders.filter(function (od) { return od.match; }).length; });
    var meanCost = rows.length ? rows.reduce(function (s, x) { return s + x.cost; }, 0) / rows.length : null;
    var kpi = function (id, k, v) { return "<div class=\"kpi\" id=\"" + id + "\"><div class=\"k\">" + esc(k) + "</div><div class=\"v\">" + esc(v) + "</div></div>"; };
    $("view").innerHTML = "<div class=\"card\" id=\"dash\"><h2>Site dashboard · " + esc(H.name) + "</h2><div class=\"sm muted\">Signed-out cases in this simulated session (all users at this hospital in this browser tab).</div><div class=\"kpis\">" +
      kpi("k_n", "Signed out", String(rows.length)) +
      kpi("k_days", "Median days to diagnosis", md == null ? "—" : md.toFixed(1)) +
      kpi("k_cost", "Mean test cost (units)", meanCost == null ? "—" : num(meanCost)) +
      kpi("k_correct", "Correct class (sim; of class sign-outs)", cls.length ? Math.round(100 * correct / cls.length) + "% (" + correct + "/" + cls.length + ")" : "—") +
      kpi("k_surr", "Astrocytoma on ATRX/p53 surrogate only", String(surr)) +
      kpi("k_nos", "Signed out NOS", String(nos)) +
      kpi("k_match", "Orders matching the assistant", orders ? Math.round(100 * match / orders) + "% (" + match + "/" + orders + ")" : "—") + "</div>" +
      (rows.length ? "<table class=\"q\"><tr><th>Case</th><th>Signed out</th><th>True (sim)</th><th>Days</th><th>Cost</th><th>Tests</th></tr>" + rows.map(function (x) {
        return "<tr><td>" + esc(shortId(hid, x.c)) + "</td><td>" + esc(clsText(x.cs.signed.cls)) + "</td><td>" + esc(SHORT[x.c.y]) + "</td><td>" + days(x.cs.signed.at - x.a.at) +
          "</td><td>" + esc(fmtCost(x.cost)) + "</td><td>" + esc(seqText(x.cs.orders.map(function (od) { return od.t; }))) + "</td></tr>"; }).join("") + "</table>" : "<div class=\"note\">No cases signed out yet in this session.</div>") +
      "<div class=\"note\">Computed from this browser tab's simulated session only (not yet shared across the team).</div></div>";
  }

  /* ---------------------------------------------------------------- practice: Daily Workup */
  var P = null, PCFG = null;
  function today() { var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  function dailyCase(date) { var pool = PR.length ? PR : ALL; return pool[hash("daily-workup:" + date) % pool.length]; }
  function hist() { return sget("localStorage", "dw_history") || {}; }
  function streak(h) {
    var d = new Date(), n = 0, key = function (x) { var p = function (k) { return (k < 10 ? "0" : "") + k; }; return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate()); };
    if (!h[key(d)]) d.setDate(d.getDate() - 1);
    while (h[key(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function golf(diff, wrong) {
    if (wrong) return ["Out of bounds", "oob"];
    return diff <= -2 ? ["Eagle", "good"] : diff === -1 ? ["Birdie", "good"] : diff === 0 ? ["Par", "par"] : diff <= 2 ? ["Bogey", "over"] : ["Double bogey+", "over"];
  }
  function newGame(c, daily) {
    var pl = rollPlanner(c, 3, []);
    P = {c: c, daily: daily, date: today(), o: T.map(function () { return -1; }), seq: [], cost: 0, par: pl.cost, done: null, prior: priorOf(c)};
  }
  function startPractice() {
    var date = today(), h = hist();
    if (P && P.daily && P.date === date) return;
    if (P && !P.daily) return;
    var c = dailyCase(date); newGame(c, true);
    var prog = sget("localStorage", "dw_progress");
    if (h[date]) { (h[date].seq || []).forEach(function (t) { practiceReveal(t); }); finish(h[date].cls, true); }
    else if (prog && prog.date === date) prog.seq.forEach(function (t) { practiceReveal(t); });
  }
  function practiceReveal(t) {
    var j = E.TI[t]; if (P.o[j] !== -1) return;
    P.o[j] = P.c.results[j]; P.seq.push(t); P.cost += E.cost(PCFG, t);
  }
  function finish(cls, restored) {
    var c = P.c, wrong = cls >= 0 && cls !== c.y, g = golf(P.cost - P.par, wrong);
    P.done = {cls: cls, wrong: wrong, label: g[0], tone: g[1], diff: P.cost - P.par};
    if (P.daily && !restored) {
      var h = hist(); h[P.date] = {cls: cls, y: c.y, cost: P.cost, par: P.par, label: g[0], seq: P.seq.slice(), correct: cls === c.y};
      sset("localStorage", "dw_history", h); sdel("localStorage", "dw_progress");
    }
  }
  function shareText() {
    var mark = P.done.cls < 0 ? "❔" : P.done.wrong ? "❌" : "✅";
    return "Daily Workup " + P.date + " · Par " + fmtCost(P.par) + " · " + P.done.label + "\n" + P.seq.map(function (t) { return STAIN[t] ? "🟦" : "🟪"; }).join("") + mark;
  }
  function renderPractice() {
    startPractice();
    var c = P.c, o = P.o, w = E.posterior(P.prior, M.L, o), sup = E.support(o, c.g4, PCFG), h = hist();
    var d = sup >= 0 || P.done ? null : E.dpChoose(w, o, c.g4, M.L, PCFG), stuck = !P.done && sup < 0 && d && d.j == null;
    var played = Object.keys(h).length;
    var head = "<div class=\"card\"><h2>" + (P.daily ? "Daily Workup · " + esc(P.date) : "Practice case (not counted)") + "</h2>" +
      "<div class=\"sm muted\">" + (P.daily ? "One case a day, the same for everyone, from external public cohorts (MSK, GLASS), never your hospital\u2019s own cases. " : "A random extra case; it does not change your streak. ") +
      "Order tests one at a time; results are instant. The case closes as soon as the CNS5 evidence supports a class. Par = the planner's cost on this case (full panel, molecular = 3, stain = 1).</div>" +
      "<div style=\"margin-top:6px\">Age " + esc(c.age_band) + " · " + esc(histo(c)) + " · <b>Par " + esc(fmtCost(P.par)) + "</b> · your cost so far <b id=\"dwCost\">" + esc(fmtCost(P.cost)) + "</b></div>" +
      "<div class=\"sm muted\">Streak: <b class=\"streak\">" + streak(h) + "</b> day" + (streak(h) === 1 ? "" : "s") + " · days played: " + played + "</div></div>";
    var btns = "<div class=\"card\"><h2>Order a test</h2><div class=\"tgrid\" id=\"dwTests\">" + T.map(function (t, j) {
      var r = o[j] === 0 || o[j] === 1;
      return "<button class=\"g" + (r ? " ord" : "") + "\" data-act=\"dw-order\" data-t=\"" + t + "\"" + (r || P.done ? " disabled" : "") + ">" + esc(INFO[t][0]) +
        "<span class=\"sm " + (r ? "rv " + (o[j] ? "pos" : "neg") : "muted") + "\">" + esc(r ? INFO[t][o[j] ? 2 : 1] + (c.simulated.indexOf(t) >= 0 ? " (simulated value)" : "") :
        "cost " + fmtCost(E.cost(PCFG, t)) + " · " + (STAIN[t] ? "stain" : "molecular")) + "</span></button>"; }).join("") + "</div>" +
      (stuck ? "<div class=\"alert\" id=\"dwNos\">No further test can complete the CNS5 evidence on this case. <button class=\"g\" data-act=\"dw-nos\">Sign out: diffuse glioma, NOS</button></div>" : "") + "</div>";
    var res = "";
    if (P.done) {
      var pl = rollPlanner(c, 3, []), cap = rollCap(c, 3, []);
      res = "<div class=\"card " + (P.done.tone === "oob" ? "badc" : P.done.tone === "over" ? "warnc" : "okc") + "\" id=\"dwResult\"><h2>Result</h2><div class=\"golf " + P.done.tone + "\" id=\"golf\">" + esc(P.done.label) + "</div>" +
        "<div>You: <b>" + esc(clsText(P.done.cls)) + "</b> · cost " + esc(fmtCost(P.cost)) + " vs par " + esc(fmtCost(P.par)) + " (" + (P.done.diff > 0 ? "+" : "") + esc(fmtCost(P.done.diff)) + ")</div>" +
        "<div>True class (public cohort): <b>" + esc(FULL[c.y]) + "</b>" + (P.done.cls < 0 ? " · NOS asserts no class, so it is scored on cost only" : P.done.wrong ? " · wrong class: the ATRX/p53 surrogate without 1p/19q" : " · correct") + "</div>" +
        "<div class=\"seq\">Your sequence: " + esc(seqText(P.seq)) + "</div>" +
        "<div class=\"seq\">Planner: " + esc(seqText(pl.seq)) + " · cost " + esc(fmtCost(pl.cost)) + " · " + esc(clsText(pl.cls)) + "</div>" +
        "<div class=\"seq\">CAP pathway: " + esc(seqText(cap.seq)) + " · cost " + esc(fmtCost(cap.cost)) + " · " + esc(clsText(cap.cls)) + "</div>";
      if (P.daily) res += "<h3>Share</h3><textarea class=\"share\" id=\"shareTxt\" readonly></textarea><button class=\"g\" data-act=\"dw-copy\" id=\"copyBtn\">Copy</button> " +
        "<span class=\"sm muted\">Already played today: come back tomorrow for a new case.</span>";
      res += "<div style=\"margin-top:10px\"><button class=\"b\" data-act=\"dw-extra\" id=\"extraBtn\">Practice another case</button>" + (!P.daily ? " <button class=\"g\" data-act=\"dw-today\">Back to today's case</button>" : "") + "</div></div>";
    } else if (!P.daily) res = "<div class=\"card\"><button class=\"g\" data-act=\"dw-today\">Back to today's case</button></div>";
    else if (h[P.date] == null) res = "<div class=\"card sm muted\">One attempt per day. <button class=\"g\" data-act=\"dw-extra\" id=\"extraBtn\">Practice another case</button> (not counted)</div>";
    $("view").innerHTML = "<div class=\"cols\"><section class=\"col\">" + head + (P.done ? res + btns : btns + res) + "</section><section class=\"col\"><div class=\"card\">" +
      bars(w, P.prior, "clinical model (age " + c.age_band + ", grade " + (c.grade || "unknown") + ")") + "</div><div class=\"card " + (sup >= 0 ? "okc" : "warnc") + "\">" +
      evidence(o, c.g4, sup, w, 3, "") + "</div></section></div>";
    if (P.done && P.daily) $("shareTxt").value = shareText();
  }
  function practiceOrder(t) {
    if (!P || P.done) return;
    practiceReveal(t);
    if (P.daily) sset("localStorage", "dw_progress", {date: P.date, seq: P.seq});
    var sup = E.support(P.o, P.c.g4, PCFG);
    if (sup >= 0) finish(sup, false);
  }

  /* ---------------------------------------------------------------- events */
  function signIn(u) {
    S.user = {id: u.id, name: u.id, role: u.role, steward: !!u.steward, judge: !!u.judge};
    S.hid = u.site; S.tab = "work"; S.open = null; startClock(); save(); render();
  }
  function nextEvent() {
    var tm = now(), hid = S.hid, best = null;
    arrived(hid, tm).forEach(function (a) {
      var cs = cstate(hid, a.c.id); if (cs.signed) return;
      cs.orders.forEach(function (od) { if (od.due > tm && (best == null || od.due < best)) best = od.due; });
    });
    if (best == null) { var nx = arrivals(hid).filter(function (a) { return a.at > tm; })[0]; if (nx) best = nx.at; }
    if (best != null) { setClock(best); lastSig = null; render(); }
  }
  function onClick(e) {
    var el = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || el.disabled) return;
    var act = el.getAttribute("data-act");
    if (act === "logout" || act === "next" || act === "reset") e.preventDefault();
    if (act === "fill") { $("loginEmail").value = el.getAttribute("data-u"); $("loginPass").value = ""; $("loginErr").textContent = ""; $("loginPass").focus(); return; }
    if (act === "pickhosp") { S.hid = el.getAttribute("data-h"); startClock(); save(); render(); return; }
    if (act === "logout") { S.user = null; S.hid = null; S.open = null; save(); render(); return; }
    if (act === "reset") { var u2 = S.user, h2 = S.hid; S = freshState(u2, h2); arrCache = {}; startClock(); save(); render(); return; }
    if (act === "tab") { S.tab = el.getAttribute("data-tab"); if (S.tab === "work") S.open = null; save(); render(); window.scrollTo(0, 0); return; }
    if (act === "next") { nextEvent(); return; }
    if (act === "open") { S.open = el.getAttribute("data-c"); save(); render(); window.scrollTo(0, 0); return; }
    if (act === "back") { S.open = null; save(); render(); return; }
    if (act === "order") {
      var a = findArr(S.hid, S.open), x = view(S.hid, a, now()), t = el.getAttribute("data-t");
      if (x.cs.signed || x.ordered[t] || x.H.settings.unavailable.indexOf(t) >= 0) return;
      var sug = x.sup < 0 && x.d.j != null ? T[x.d.j] : null, tm = now();
      x.cs.orders.push({t: t, at: tm, due: tm + tat(x.H, t) * DAY, sug: sug, match: sug === t}); save(); render(); return;
    }
    if (act === "signout") {
      var a2 = findArr(S.hid, S.open), x2 = view(S.hid, a2, now()), k = +el.getAttribute("data-cls");
      if (x2.cs.signed || !((k >= 0 && k === x2.sup) || (k < 0 && x2.nos))) return;
      x2.cs.signed = {cls: k, at: now()}; save(); render(); window.scrollTo(0, 0); return;
    }
    if (act === "dw-order") { practiceOrder(el.getAttribute("data-t")); render(); return; }
    if (act === "dw-nos") { if (P && !P.done) finish(-1, false); render(); return; }
    if (act === "dw-extra") { var pool = PR.length ? PR : ALL, r = pool[Math.floor(Math.random() * pool.length)]; newGame(r, false); render(); return; }
    if (act === "dw-today") { P = null; render(); return; }
    if (act === "dw-copy") {
      var ta = $("shareTxt"), done = function () { el.textContent = "Copied"; };
      var fallback = function () { ta.select(); try { document.execCommand("copy"); } catch (err) { /* text stays selected */ } done(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, fallback); else fallback();
    }
  }
  function onChange(e) {
    if (e.target && e.target.id === "hsel") { S.hid = e.target.value; S.open = null; save(); lastSig = null; render(); }
  }

  /* Re-render only when something visible happens (a case arrives or a result returns), never on every tick. */
  var lastSig = null;
  function signature() {
    var tm = now(), hid = S.hid, arr = arrived(hid, tm), n = 0;
    arr.forEach(function (a) { cstate(hid, a.c.id).orders.forEach(function (od) { if (od.due <= tm) n++; }); });
    return arr.length + ":" + n;
  }
  function tick() {
    if (!S || !S.user || !S.hid) return;
    tickClock();
    var sig = signature();
    if (sig !== lastSig) { var first = lastSig == null; lastSig = sig; if (!first && S.tab !== "practice") render(); }
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    PCFG = E.cfgOf({r: 3});
    D.hospitals.forEach(function (h) { HOSP[h.id] = h; h.cases.forEach(function (c) { ALL.push(c); }); });
    PR = D.practice || [];
    var saved = sget("sessionStorage", KEY);
    S = saved && saved.v === 1 && saved.hosp ? saved : freshState();
    if (S.hid && !HOSP[S.hid]) S.hid = null;
    try { IU = informerUser(); } catch (e) { IU = null; }   // unknown host object shape: never break the page
    if (S.user && S.user.informer) { S.user = null; S.hid = null; }   // older sessions auto-signed-in from Informer
    save();
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("submit", function (e) { if (e.target && e.target.id === "loginForm") { e.preventDefault(); tryLogin(); } });
    render();
    setInterval(tick, 250);
    window.__HOSP = {model: M, practice: function () { return P ? {id: P.c.id, o: P.o.slice(), g4: P.c.g4, prior: P.prior.slice(), done: P.done, par: P.par, cost: P.cost} : null; },
                     now: function () { return now(); }};
  }
  Promise.all([fetch(document.body.getAttribute("data-model") || "../clinic/model.json").then(function (r) { if (!r.ok) throw new Error("model " + r.status); return r.json(); }),
               fetch(document.body.getAttribute("data-cases") || "cases.json").then(function (r) { if (!r.ok) throw new Error("cases " + r.status); return r.json(); })])
    .then(function (v) { M = v[0]; D = v[1]; boot(); })
    .catch(function (e) { $("view").innerHTML = "<div class=\"card\">Could not load the simulation data: " + esc(e.message || e) + "</div>"; });
})();
