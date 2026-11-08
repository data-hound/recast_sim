// GET /api/_server/caselog/huddle : the latest morning-huddle digest written by the stewardship agent (read-only; {body: null} until it has run).
export async function GET({ query }) {
  const rows = await query('SELECT id, created, body, cases FROM huddle_digest ORDER BY created DESC LIMIT 1');
  return rows.length ? rows[0] : { body: null };
}
