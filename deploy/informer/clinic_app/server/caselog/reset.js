// POST /api/_server/caselog/reset : clear the team log (demo reset). Stewardship lead role only; app owners and
// publishers hold every role in Informer.
export async function POST({ request, query }) {
  const roles = request.roles || [];
  if (!roles.includes('steward')) return { status: 403, body: { error: 'steward role required' } };
  const rows = await query('DELETE FROM case_log RETURNING id');
  return { deleted: rows.length };
}
