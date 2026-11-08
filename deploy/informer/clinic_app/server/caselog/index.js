// POST /api/_server/caselog : save one case without patient identifiers (opt-in button in the page).
// GET  /api/_server/caselog : the 200 most recent cases of this app's workspace (team view).
// Informer server-route contract (docs.entrinsik.com/developer/apps/reference/server-routes): one context object with
// query(sql, params) and request {body, user, roles}. UNTESTED on an Informer server: we had no tenant when writing it.
const TESTS = ['ihc', 'seq', 'atrx', 'tp53', 'codel', 'tert', 'cnv', 'egfr', 'cdkn'];

function clean(b) {
  const results = {};
  for (const t of TESTS) {
    const v = b && b.results ? b.results[t] : undefined;
    if (v === 0 || v === 1) results[t] = v;
  }
  const list = (x) => (Array.isArray(x) ? x.filter((t) => TESTS.includes(t)) : []);
  const grade = ['2', '3', '4', '?'].includes(b.grade) ? b.grade : '?';
  const sup = [-1, 0, 1, 2].includes(b.supported) ? b.supported : -1;
  return {
    grade, g4: !!b.g4, results, pending: list(b.pending), unavailable: list(b.unavailable),
    r: Number.isFinite(+b.r) ? Math.min(Math.max(+b.r, 0.1), 100) : 3, supported: sup,
    next_test: TESTS.includes(b.next_test) ? b.next_test : null, surrogate: !!b.surrogate, nos: !!b.nos
  };
}

export async function POST({ request, query }) {
  const c = clean(request.body || {});
  const user = (request.user && request.user.username) || 'unknown';
  const rows = await query(
    'INSERT INTO case_log (username, grade, g4, results, pending, unavailable, r, supported, next_test, surrogate, nos) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, created',
    [user, c.grade, c.g4, JSON.stringify(c.results), JSON.stringify(c.pending), JSON.stringify(c.unavailable), c.r, c.supported,
     c.next_test, c.surrogate, c.nos]);
  return { id: rows[0].id, created: rows[0].created };
}

export async function GET({ query }) {
  return query('SELECT id, username, created, grade, g4, results, pending, unavailable, r, supported, next_test, surrogate, nos ' +
               'FROM case_log ORDER BY created DESC LIMIT 200');
}
