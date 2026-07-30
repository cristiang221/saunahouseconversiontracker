const crypto = require('crypto');
const { requireManager } = require('./_supabaseAdmin');

// Generates a readable-but-random temp password, e.g. "brisk-ember-4821".
function generateTempPassword() {
  const words = ['brisk', 'ember', 'cedar', 'basin', 'grove', 'quiet', 'amber', 'birch', 'clove', 'stone'];
  const w1 = words[crypto.randomInt(words.length)];
  const w2 = words[crypto.randomInt(words.length)];
  const digits = crypto.randomInt(1000, 9999);
  return `${w1}-${w2}-${digits}`;
}

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
  void managerId;

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const name = (payload.name || '').trim();
  const email = (payload.email || '').trim().toLowerCase();
  if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'Name is required.' }) };
  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A valid email is required.' }) };
  }

  const tempPassword = generateTempPassword();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { name },
  });

  if (error) {
    const statusCode = /already registered|already exists/i.test(error.message) ? 409 : 400;
    return { statusCode, body: JSON.stringify({ error: error.message }) };
  }

  // The auth.users trigger (see supabase/schema.sql) creates the matching
  // profiles row automatically with role 'staff'. Make sure the name is set
  // from what the manager typed rather than derived from the email.
  await admin.from('profiles').update({ name }).eq('id', data.user.id);

  return {
    statusCode: 200,
    body: JSON.stringify({ id: data.user.id, email, tempPassword }),
  };
};
