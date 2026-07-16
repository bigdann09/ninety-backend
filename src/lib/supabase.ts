import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) {
  throw new Error("SUPABASE_URL environment variable is required");
}

// Prefer a real secret key (bypasses RLS, meant for a trusted backend) if provided — Supabase's
// current naming is SUPABASE_SECRET_KEY (sb_secret_...), with SUPABASE_SERVICE_ROLE_KEY kept as
// a fallback for older projects still on the legacy service_role JWT. Falls back further to the
// publishable/anon key only so the server doesn't hard-crash on a half-configured environment —
// admin writes will fail under RLS in that case, this is not a supported configuration.
const supabaseServiceKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseServiceKey) {
  throw new Error("SUPABASE_SECRET_KEY (or a publishable/anon key fallback) environment variable is required");
}
if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "[Supabase] No SUPABASE_SECRET_KEY set — falling back to an anon/publishable key for admin operations. " +
    "This only works if your RLS policies explicitly permit these writes. Set SUPABASE_SECRET_KEY for a proper trusted-backend client."
  );
}

// Admin client — server-only, never expose this client or its key to the frontend/bot.
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
