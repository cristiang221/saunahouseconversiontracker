// Public Supabase project config. The anon key is safe to ship to the
// client by design — access control is enforced server-side by the RLS
// policies in supabase/schema.sql, not by keeping this key secret.
//
// Fill these in from Supabase Dashboard -> Project Settings -> API,
// after running supabase/schema.sql. See README.md for the full setup flow.

export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
