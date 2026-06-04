import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * PUBLIC (anon) client.
 *
 * Subject to Row Level Security. Use this for operations that should run
 * with the public/anon privileges — e.g. verifying a user's JWT via
 * `supabase.auth.getUser(token)`.
 */
export const supabase: SupabaseClient = createClient(
  env.supabase.url,
  env.supabase.anonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

/**
 * ADMIN (service-role) client.
 *
 * BYPASSES Row Level Security. This is the trusted backend identity used
 * for privileged reads/writes — e.g. fetching a user's role from `profiles`
 * after their token has been verified, or any server-owned data operation.
 *
 * SECURITY: the service-role key must never be sent to a browser/client.
 * It lives only in server-side environment variables.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  env.supabase.url,
  env.supabase.serviceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export default supabase;
