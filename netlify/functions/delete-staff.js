const { requireManager } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let admin, managerId;
  try {
    ({ admin, managerId } = await requireManager(event));
  } catch (err) {
    return { statusCode: err.statusCode || 500, body: JSON.stringify({ error: err.message }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const staffId = (payload.staffId || '').trim();
  if (!staffId) return { statusCode: 400, body: JSON.stringify({ error: 'staffId is required.' }) };
  if (staffId === managerId) {
    return { statusCode: 400, body: JSON.stringify({ error: "You can't remove your own account." }) };
  }

  // Deleting the auth user cascades to profiles and entries via the
  // "on delete cascade" foreign keys in supabase/schema.sql.
  const { error } = await admin.auth.admin.deleteUser(staffId);
  if (error) {
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
