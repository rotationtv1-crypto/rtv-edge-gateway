/**
 * Shared env surface for ported Supabase Edge Functions (Deno → Workers).
 * All values are provided as Worker secrets/vars (wrangler secret put <KEY>).
 */
export interface EdgeFunctionsEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  VENICE_API_KEY?: string;
  CF_STREAM_TOKEN?: string;
  CRON_SECRET?: string;
}
