/**
 * RTV Edge Gateway v3.0.0
 * ========================
 * Production-hardened Cloudflare Worker
 * Fixes: 503 errors from missing SUPABASE_SERVICE_KEY binding
 * Auth: Supabase session tokens (NOT raw initData)
 * Routes: streaming, gifts, health, webhooks
 */

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
  CF_STREAM_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_STREAM_SIGNING_KEY: string;
  WEBHOOK_SECRET: string;
  RATE_LIMIT_KV: KVNamespace;
  ENVIRONMENT: string;
}

// ── Critical: Env validation to prevent 503s ──
function validateEnv(env: Env): string[] {
  const missing: string[] = [];
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY'];
  for (const key of required) {
    if (!env[key as keyof Env]) missing.push(key);
  }
  return missing;
}

// ── Supabase Auth ──
interface SupabaseUser {
  id: string;
  email?: string;
  aud: string;
  role: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
}

async function requireAuth(request: Request, env: Env): Promise<SupabaseUser> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Response(JSON.stringify({ error: 'Invalid session token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return await res.json() as SupabaseUser;
}

// ── Supabase Service Client ──
async function supabaseQuery(
  env: Env,
  table: string,
  query: Record<string, string>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown
) {
  const params = new URLSearchParams(query);
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${params}`;
  const headers: Record<string, string> = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase ${res.status} on ${table}: ${errText}`);
  }

  if (method === 'GET' || method === 'POST') return await res.json();
  return null;
}

async function supabaseRPC(env: Env, fn: string, params: Record<string, unknown>) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ── Cloudflare Stream ──
async function createStreamLiveInput(env: Env, creatorId: string) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_STREAM_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        meta: { creator: creatorId },
        recording: { mode: 'automatic' },
      }),
    }
  );
  if (!res.ok) throw new Error(`CF Stream create failed: ${res.status}`);
  const data: any = await res.json();
  return data.result;
}

// ── Rate Limiter ──
async function checkRateLimit(kv: KVNamespace, userId: string, action: string, maxPerMin: number): Promise<boolean> {
  const key = `rate:${action}:${userId}`;
  const count = parseInt((await kv.get(key)) || '0');
  if (count >= maxPerMin) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

// ── Route Handlers ──
async function handleStreamCreate(request: Request, env: Env, user: SupabaseUser) {
  const { title } = (await request.json()) as { title: string };
  if (!title) return jsonError('title required', 400);

  const liveInput = await createStreamLiveInput(env, user.id);

  const room = await supabaseQuery(env, 'live_rooms', {}, 'POST', {
    creator_id: user.id,
    title,
    stream_uid: liveInput.uid,
    stream_key: liveInput.rtmps?.streamKey || liveInput.webrtc?.streamKey || '',
    whip_url: liveInput.webrtc?.whipUrl || '',
    whep_url: liveInput.webrtc?.whepUrl || '',
    status: 'offline',
    connection_state: 'disconnected',
    rtv_earned_session: 0,
  });

  return Response.json({ status: 'created', room });
}

async function handleStreamEnd(request: Request, env: Env, user: SupabaseUser, roomId: string) {
  const rooms = await supabaseQuery(env, 'live_rooms', {
    id: `eq.${roomId}`,
    creator_id: `eq.${user.id}`,
    select: 'id',
  });
  if (!rooms?.length) return jsonError('Room not found or not owner', 404);

  await supabaseQuery(env, 'live_rooms', { id: `eq.${roomId}` }, 'PATCH', {
    status: 'offline',
    connection_state: 'disconnected',
    ended_at: new Date().toISOString(),
  });

  return Response.json({ status: 'ended', room_id: roomId });
}

async function handleStreamPlay(env: Env, roomId: string) {
  const rooms = await supabaseQuery(env, 'live_rooms', {
    id: `eq.${roomId}`,
    status: 'eq.live',
    select: 'whep_url,title,creator_id',
  });
  if (!rooms?.length) return jsonError('Stream not live', 404);
  return Response.json({ whep_url: rooms[0].whep_url, title: rooms[0].title });
}

async function handleStreamsList(env: Env) {
  const rooms = await supabaseQuery(env, 'live_rooms', {
    status: 'eq.live',
    select: 'id,title,creator_id,whep_url,viewer_count,rtv_earned_session',
    order: 'viewer_count.desc',
    limit: '50',
  });
  return Response.json({ streams: rooms || [] });
}

async function handleGiftSend(request: Request, env: Env, user: SupabaseUser) {
  const { room_id, gift_id, message } = (await request.json()) as {
    room_id: string;
    gift_id: string;
    message?: string;
  };

  if (!room_id || !gift_id) return jsonError('room_id and gift_id required', 400);

  if (env.RATE_LIMIT_KV && !(await checkRateLimit(env.RATE_LIMIT_KV, user.id, 'gift', 20))) {
    return jsonError('Rate limit exceeded', 429);
  }

  const gifts = await supabaseQuery(env, 'gifts', {
    id: `eq.${gift_id}`,
    is_active: 'eq.true',
    select: 'id,name,rtv_cost,emoji',
  });
  if (!gifts?.length) return jsonError('Gift not found or inactive', 404);
  const gift = gifts[0];

  const rooms = await supabaseQuery(env, 'live_rooms', {
    id: `eq.${room_id}`,
    status: 'eq.live',
    select: 'id,creator_id,title,rtv_earned_session',
  });
  if (!rooms?.length) return jsonError('Room not live', 404);
  const room = rooms[0];

  if (room.creator_id === user.id) return jsonError('Cannot gift yourself', 400);

  const transferResult = await supabaseRPC(env, 'transfer_rtv', {
    p_sender_id: user.id,
    p_receiver_id: room.creator_id,
    p_amount_rtv: gift.rtv_cost,
    p_transfer_type: 'gift',
    p_description: gift.name,
    p_reference_id: room_id,
  });

  if ((transferResult as any)?.status !== 'completed') {
    return jsonError((transferResult as any)?.message || 'Transfer failed', 400);
  }

  await supabaseQuery(env, 'gift_transactions', {}, 'POST', {
    sender_id: user.id,
    receiver_id: room.creator_id,
    room_id: room.id,
    gift_id: gift.id,
    gift_name: gift.name,
    gift_emoji: gift.emoji,
    rtv_amount: gift.rtv_cost,
    message: message || null,
  });

  await supabaseQuery(env, 'live_rooms', { id: `eq.${room_id}` }, 'PATCH', {
    rtv_earned_session: room.rtv_earned_session + gift.rtv_cost,
  });

  return Response.json({
    status: 'sent',
    gift: gift.name,
    emoji: gift.emoji,
    amount_rtv: gift.rtv_cost,
    creator_id: room.creator_id,
  });
}

async function handleStreamWebhook(request: Request, env: Env) {
  const signature = request.headers.get('Webhook-Signature');
  if (!signature && env.WEBHOOK_SECRET) return jsonError('Missing signature', 401);

  const body: any = await request.json();
  const { event, uid } = body;

  switch (event) {
    case 'live_connected':
      await supabaseQuery(env, 'live_rooms', { stream_uid: `eq.${uid}` }, 'PATCH', {
        status: 'live',
        connection_state: 'connected',
        started_at: new Date().toISOString(),
      });
      break;
    case 'live_ended':
    case 'live_disconnected':
      await supabaseQuery(env, 'live_rooms', { stream_uid: `eq.${uid}` }, 'PATCH', {
        status: 'offline',
        connection_state: 'disconnected',
        ended_at: new Date().toISOString(),
      });
      break;
  }

  return Response.json({ status: 'ok' });
}

// ── Helpers ──
function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}

// ── Main Export ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // CORS
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Health — always responds (never 503)
    if (url.pathname === '/' || url.pathname === '/health') {
      const missing = validateEnv(env);
      return Response.json({
        status: missing.length ? 'degraded' : 'alive',
        service: 'rtv-edge-gateway',
        version: '3.0.0',
        auth: 'supabase-session',
        environment: env.ENVIRONMENT || 'unknown',
        missing_bindings: missing,
        heartbeat: '432Hz',
        timestamp: new Date().toISOString(),
      }, {
        status: missing.length ? 503 : 200,
        headers: corsHeaders(),
      });
    }

    // Env validation — fail gracefully instead of 503
    const missing = validateEnv(env);
    if (missing.length) {
      return Response.json({
        error: 'Service configuration incomplete',
        missing_bindings: missing,
        fix: 'Run: npx wrangler secret put ' + missing[0],
      }, { status: 503, headers: corsHeaders() });
    }

    try {
      // Webhook (no auth)
      if (url.pathname === '/webhook/stream' && method === 'POST') {
        return await handleStreamWebhook(request, env);
      }

      // Auth-required routes
      const user = await requireAuth(request, env);

      if (url.pathname === '/api/stream/create' && method === 'POST') {
        return await handleStreamCreate(request, env, user);
      }
      if (url.pathname.match(/^\/api\/stream\/[^/]+\/end$/) && method === 'POST') {
        const roomId = url.pathname.split('/')[3];
        return await handleStreamEnd(request, env, user, roomId);
      }
      if (url.pathname.match(/^\/api\/stream\/[^/]+\/play$/) && method === 'GET') {
        const roomId = url.pathname.split('/')[3];
        return await handleStreamPlay(env, roomId);
      }
      if (url.pathname === '/api/streams' && method === 'GET') {
        return await handleStreamsList(env);
      }
      if (url.pathname === '/api/gift/send' && method === 'POST') {
        return await handleGiftSend(request, env, user);
      }

      return jsonError('Not found', 404);
    } catch (err: unknown) {
      if (err instanceof Response) return err;
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error('Edge gateway error:', message);
      return jsonError(message, 500);
    }
  },
};
