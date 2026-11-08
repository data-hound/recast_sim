// Agent tool: store the morning-huddle digest the stewardship agent wrote (shown to stewards in the clinician tool tab).
// Counts-only text: the agent never sees patient identifiers, and this tool refuses anything over 2000 characters.
export const description = 'Save the finished morning-huddle digest (plain text, at most 2000 characters, counts and trends only, no identifiers). Call it once at the end.';

export const schema = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 2000, description: 'The digest.' },
    cases: { type: 'integer', minimum: 0, description: 'Total cases in the log when the digest was written.' }
  },
  required: ['text']
};

export async function handler({ args, query }) {
  const text = String((args && args.text) || '').trim().slice(0, 2000);
  if (!text) return { error: 'text is required' };
  const cases = Number.isFinite(+(args && args.cases)) ? Math.max(0, Math.floor(+args.cases)) : null;
  const rows = await query('INSERT INTO huddle_digest (body, cases) VALUES ($1, $2) RETURNING id, created', [text, cases]);
  return { saved: true, id: rows[0].id, created: rows[0].created };
}
