// Agent tool: read-only counts from the opt-in team case log (the same table as GET /api/_server/caselog/summary).
// The log holds no patient identifiers and this tool returns no user names, only counts.
export const description =
  'Read-only counts from the team case log of the GlioAgent clinician tool: total cases, cases in the last N hours, how many rested on the ' +
  'ATRX/p53 surrogate without 1p/19q, how many ended as NOS with the local tests, the most recommended next tests, the supported-class mix, ' +
  'the grade mix and the tests sites most often lack. Counts only; no patient or user identifiers.';

export const schema = {
  type: 'object',
  properties: {
    window_hours: { type: 'integer', minimum: 1, maximum: 720, description: 'Recent window in hours (default 24).' }
  },
  required: []
};

const CLASS = { '-1': 'no class supported yet', '0': 'GBM', '1': 'Astro', '2': 'Oligo' };

export async function handler({ args, query }) {
  const h = Math.min(Math.max(Math.floor(+(args && args.window_hours) || 24), 1), 720);
  const one = async (where, params) => (await query(
    'SELECT count(*)::int AS cases, count(*) FILTER (WHERE surrogate)::int AS surrogate, count(*) FILTER (WHERE nos)::int AS nos ' +
    'FROM case_log ' + where, params))[0];
  const all = await one('', []);
  const recent = await one("WHERE created > now() - make_interval(hours => $1::int)", [h]);
  const next = await query('SELECT next_test AS test, count(*)::int AS n FROM case_log WHERE next_test IS NOT NULL GROUP BY next_test ORDER BY n DESC LIMIT 5');
  const cls = await query('SELECT supported, count(*)::int AS n FROM case_log GROUP BY supported ORDER BY supported');
  const grade = await query('SELECT grade, count(*)::int AS n FROM case_log GROUP BY grade ORDER BY grade');
  const lacking = await query("SELECT t AS test, count(*)::int AS n FROM case_log, jsonb_array_elements_text(coalesce(unavailable, '[]'::jsonb)) AS t GROUP BY t ORDER BY n DESC LIMIT 5");
  return {
    all_time: all, last_window: { hours: h, ...recent },
    most_recommended_next_tests: next, supported_class: cls.map((c) => ({ class: CLASS[String(c.supported)] || String(c.supported), n: c.n })),
    grade_mix: grade, tests_most_often_unavailable: lacking
  };
}
