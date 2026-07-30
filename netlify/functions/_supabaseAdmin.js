const { createClient } = require('@supabase/supabase-js');

// Service-role client — full DB/auth admin access. Only ever used
// server-side; SUPABASE_SERVICE_ROLE_KEY must be set as a Netlify
// environment variable and must never be shipped to the browser.
function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured on the server.');
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Verifies the caller's bearer token belongs to a signed-in manager.
// Returns { admin, managerId } on success, or throws an Error with a
// `.statusCode` the handler can use directly in its response.
async function requireManager(event) {
  const admin = getAdminClient();

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    const err = new Error('Missing bearer token.');
    err.statusCode = 401;
    throw err;
  }

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    const err = new Error('Invalid or expired session.');
    err.statusCode = 401;
    throw err;
  }

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || profile?.role !== 'manager') {
    const err = new Error('Manager access required.');
    err.statusCode = 403;
    throw err;
  }

  return { admin, managerId: userData.user.id };
}

module.exports = { getAdminClient, requireManager };
