// GET /api/_server/caselog/summary : team stewardship summary (counts only).
export async function GET({ query }) {
  const tot = await query('SELECT count(*)::int AS cases, count(*) FILTER (WHERE surrogate)::int AS surrogate, ' +
                          'count(*) FILTER (WHERE nos)::int AS nos FROM case_log');
  const next = await query('SELECT next_test AS test, count(*)::int AS n FROM case_log WHERE next_test IS NOT NULL ' +
                           'GROUP BY next_test ORDER BY n DESC LIMIT 3');
  return { cases: tot[0].cases, surrogate: tot[0].surrogate, nos: tot[0].nos, next };
}
