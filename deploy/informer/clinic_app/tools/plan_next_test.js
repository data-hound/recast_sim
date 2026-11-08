// Agent tool: the GlioAgent expected-cost planner and the WHO CNS5 / CAP evidence rule on ONE case state passed in.
// Same engine and model as the clinician tool in the page (lib/clinic_engine.js and lib/model.js are generated from
// web/js/clinic_engine.js and web/clinic/model.json by sync.sh). Read-only; no storage, no network, no patient identifiers:
// the input is grade, a grade-4 flag, marker results, pending/unavailable tests and the molecular:stain cost ratio. Age is not an input.
import E from '../lib/clinic_engine.js';
import M from '../lib/model.js';

export const description =
  'Run the GlioAgent exact expected-cost planner on one adult diffuse glioma workup. Input: histological grade, grade-4 features, ' +
  'reported marker results (0 = negative/wild-type/intact/retained/absent, 1 = positive/mutant/codeleted/lost/present), pending and ' +
  'unavailable tests, and the molecular:stain cost ratio. Returns the WHO CNS5 evidence status (which diagnosis is supported and why, ' +
  'with the ATRX/p53 surrogate warning), the cost-optimal next test with its expected further cost and the alternatives, and the ' +
  'CAP-pathway and marker-tree comparisons. Research prototype: never use it to decide care. Uses a grade-only prior (age is not an input) ' +
  'unless you pass a prior; the result says which prior was used.';

export const schema = {
  type: 'object',
  properties: {
    grade: { type: 'string', enum: ['2', '3', '4', '?'], description: 'Histological WHO grade; "?" if unknown.' },
    grade4_features: { type: 'boolean', description: 'True if glioblastoma histology (necrosis or microvascular proliferation) is reported.' },
    results: {
      type: 'object',
      description: 'Reported results only; leave a test out if it is not done or still pending.',
      properties: {
        ihc: { type: 'integer', enum: [0, 1], description: 'IDH1 R132H IHC (1 = positive)' },
        seq: { type: 'integer', enum: [0, 1], description: 'IDH1/2 sequencing (1 = mutant)' },
        atrx: { type: 'integer', enum: [0, 1], description: 'ATRX IHC (1 = lost)' },
        tp53: { type: 'integer', enum: [0, 1], description: 'p53 IHC (1 = mutant pattern)' },
        codel: { type: 'integer', enum: [0, 1], description: '1p/19q (1 = codeleted)' },
        tert: { type: 'integer', enum: [0, 1], description: 'TERT promoter (1 = mutant)' },
        cnv: { type: 'integer', enum: [0, 1], description: 'Chromosome +7/-10 (1 = present)' },
        egfr: { type: 'integer', enum: [0, 1], description: 'EGFR amplification (1 = amplified)' },
        cdkn: { type: 'integer', enum: [0, 1], description: 'CDKN2A/B homozygous deletion (1 = deleted)' }
      },
      additionalProperties: false
    },
    pending: { type: 'array', items: { type: 'string', enum: ['ihc', 'seq', 'atrx', 'tp53', 'codel', 'tert', 'cnv', 'egfr', 'cdkn'] }, description: 'Tests ordered, result not back.' },
    unavailable: { type: 'array', items: { type: 'string', enum: ['ihc', 'seq', 'atrx', 'tp53', 'codel', 'tert', 'cnv', 'egfr', 'cdkn'] }, description: 'Tests this site cannot run.' },
    cost_ratio: { type: 'number', description: 'Cost of a molecular test relative to a stain (stain = 1). Default 3.' },
    prior: { type: 'array', items: { type: 'number' }, description: 'Optional starting probabilities [GBM, Astro, Oligo]; floored at 0.01 and renormalised. Default: grade-only clinical prior.' }
  },
  required: []
};

const TESTS = ['ihc', 'seq', 'atrx', 'tp53', 'codel', 'tert', 'cnv', 'egfr', 'cdkn'];
const INFO = {
  ihc: ['IDH1 R132H IHC', 'negative', 'positive'], seq: ['IDH1/2 sequencing', 'wild-type', 'mutant'],
  atrx: ['ATRX IHC', 'retained', 'lost'], tp53: ['p53 IHC', 'wild-type pattern', 'mutant pattern'],
  codel: ['1p/19q', 'intact', 'codeleted'], tert: ['TERT promoter', 'wild-type', 'mutant'],
  cnv: ['Chr +7/-10', 'absent', 'present'], egfr: ['EGFR amplification', 'not amplified', 'amplified'],
  cdkn: ['CDKN2A/B homozygous deletion', 'not deleted', 'deleted']
};
const SHORT = ['GBM', 'Astro', 'Oligo'];
const FULL = ['Glioblastoma, IDH-wildtype', 'Astrocytoma, IDH-mutant', 'Oligodendroglioma, IDH-mutant and 1p/19q-codeleted'];
const r4 = (x) => Math.round(x * 10000) / 10000;
const r2 = (x) => Math.round(x * 100) / 100;

function reason(o, g4, c) {
  const b = o[1] === 1 ? 'IDH-mutant by sequencing' : o[1] === 0 ? 'IDH-wildtype by sequencing' : o[0] === 1 ? 'IDH-mutant by IDH1 R132H IHC' : null;
  if (c === 2) return b + ' + 1p/19q codeleted';
  if (c === 1) {
    return o[4] === 0 ? b + ' + 1p/19q intact'
      : b + ' + ' + [o[2] === 1 ? 'ATRX loss' : null, o[3] === 1 ? 'p53 mutant pattern' : null].filter(Boolean).join(' and ') + ' (CAP surrogate; 1p/19q not tested)';
  }
  const m = [g4 ? 'glioblastoma histology' : null, o[5] === 1 ? 'TERT promoter mutation' : null, o[6] === 1 ? '+7/-10' : null, o[7] === 1 ? 'EGFR amplification' : null].filter(Boolean);
  return b + ' + ' + m.join(', ');
}

const named = (j) => (j == null ? null : { id: TESTS[j], name: INFO[TESTS[j]][0] });

export async function handler({ args }) {
  const a = args || {};
  const grade = ['2', '3', '4', '?'].includes(a.grade) ? a.grade : '?';
  const g4 = !!a.grade4_features;
  const res = a.results && typeof a.results === 'object' ? a.results : {};
  const ignored = Object.keys(res).filter((k) => !TESTS.includes(k) || (res[k] !== 0 && res[k] !== 1));
  const o = TESTS.map((t) => (res[t] === 0 ? 0 : res[t] === 1 ? 1 : -1));
  const list = (x) => (Array.isArray(x) ? x.filter((t, i) => TESTS.includes(t) && x.indexOf(t) === i) : []);
  const pending = list(a.pending).filter((t) => o[E.TI[t]] === -1);
  const unavailable = list(a.unavailable);
  const r = Number.isFinite(+a.cost_ratio) && +a.cost_ratio > 0 ? Math.min(Math.max(+a.cost_ratio, 0.1), 100) : 3;
  const panel = TESTS.filter((t) => unavailable.indexOf(t) < 0 && pending.indexOf(t) < 0);
  const cfg = E.cfgOf({ r, tests: panel });
  const given = Array.isArray(a.prior) && a.prior.length === 3 && a.prior.every((x) => Number.isFinite(+x));
  const prior = given ? E.safePrior(a.prior.map(Number)) : E.clinicalPrior(M.prior_counts, null, grade);
  const w = E.posterior(prior, M.L, o);
  const sup = E.support(o, g4, cfg);
  const out = {
    research_prototype: 'Research prototype, not for clinical use. Probabilities come from a naive-Bayes model fitted on public TCGA adults; costs are relative units.',
    inputs_used: {
      grade, grade4_features: g4, cost_ratio: r,
      results: TESTS.filter((t, j) => o[j] >= 0).map((t) => ({ id: t, name: INFO[t][0], result: INFO[t][o[E.TI[t]] === 1 ? 2 : 1] })),
      pending: pending.map((t) => INFO[t][0]), unavailable: unavailable.map((t) => INFO[t][0]), ignored_inputs: ignored
    },
    prior: { used: given ? 'caller-supplied (floored at 0.01, renormalised)' : 'clinical model: grade ' + (grade === '?' ? 'unknown' : grade) + ', age unknown', probabilities: Object.fromEntries(SHORT.map((s, c) => [s, r4(prior[c])])) },
    posterior: Object.fromEntries(SHORT.map((s, c) => [s, r4(w[c])])),
    cns5_evidence: sup >= 0
      ? { supported: true, diagnosis: FULL[sup], basis: reason(o, g4, sup) }
      : { supported: false, note: 'WHO CNS5 evidence not yet complete. A probability is not a diagnosis: the evidence rule decides.' }
  };
  if (sup === 1 && o[4] !== 0 && o[4] !== 1) {
    out.cns5_evidence.surrogate_warning = 'Astrocytoma rests on ATRX/p53 without 1p/19q. Model estimate that this is a 1p/19q-codeleted oligodendroglioma: ' +
      r4(w[2]) + '. Confirming costs one molecular test (' + r + ' units). In the GlioAgent evaluation this shortcut caused every wrong diagnosis made by the planner, GlioAgent and the CAP pathway.';
  }
  if (sup >= 0) {
    out.planner = { status: 'no_further_test_needed' };
  } else {
    const d = E.dpChoose(w, o, g4, M.L, cfg);
    if (d.j != null) {
      const q = E.qValues(w, o, g4, M.L, cfg);
      const branch = (b, test, v) => (b.p < 1e-9 ? null : {
        result: INFO[test][v], chance_of_this_result: r4(b.p),
        then: b.support >= 0 ? SHORT[b.support] + ' supported' : b.next != null ? 'next: ' + INFO[TESTS[b.next]][0] : 'no test can complete it'
      });
      out.planner = {
        status: 'order_next', next_test: { ...named(d.j), cost: E.cost(cfg, TESTS[d.j]) }, expected_further_cost: r2(d.v),
        cost_units: 'stain = 1, molecular = ' + r,
        alternatives: q.slice(0, 5).map((x) => ({ ...named(x.j), cost: x.cost, expected_total: r2(x.expected_total), if_positive: branch(x.pos, x.test, 2), if_negative: branch(x.neg, x.test, 1) }))
      };
    } else if (pending.length) {
      out.planner = { status: 'wait_for_pending', note: 'No additional test helps before the pending results return.', pending: pending.map((t) => INFO[t][0]) };
    } else {
      const sendOut = TESTS.filter((t) => unavailable.indexOf(t) >= 0 && o[E.TI[t]] === -1 &&
        E.relevant(o, g4, w, E.cfgOf({ r, tests: cfg.tests.concat([t]) })).length).map((t) => INFO[t][0]);
      out.planner = { status: 'nos_with_local_tests', note: 'A CNS5 integrated diagnosis cannot be reached with the tests available here: report as diffuse glioma, NOS.', send_out_options: sendOut };
    }
    out.comparisons = {
      cap_pathway_next: E.pathwayNext(o, g4, cfg, 'cap') ? INFO[E.pathwayNext(o, g4, cfg, 'cap')][0] : 'nothing further (refer)',
      marker_tree_next: E.pathwayNext(o, g4, cfg, 'tree') ? INFO[E.pathwayNext(o, g4, cfg, 'tree')][0] : 'nothing further (refer)'
    };
  }
  return out;
}
