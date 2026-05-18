// supabase/functions/auth-bridge/index.ts
//
// POST { action: 'login' | 'refresh' | 'logout' | 'verify', ... }

import { create, verify, getNumericDate } from 'djwt';
import { createClient } from 'supabase';

const JWT_SECRET           = Deno.env.get('APP_JWT_HS_SECRET')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GAS_HR_URL           = Deno.env.get('GAS_HR_URL')!;
const ACCESS_TTL           = Number(Deno.env.get('JWT_ACCESS_TTL_SECONDS')  ?? 28800);
const REFRESH_TTL          = Number(Deno.env.get('JWT_REFRESH_TTL_SECONDS') ?? 2592000);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function getJwtKey(): Promise<CryptoKey> {
  const enc = new TextEncoder().encode(JWT_SECRET);
  return await crypto.subtle.importKey(
    'raw', enc, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function uuid(): string {
  return crypto.randomUUID();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

async function signAccessToken(opts: {
  username: string; name: string; user_role: string; jti: string;
}): Promise<{ token: string; exp: number }> {
  const key = await getJwtKey();
  const exp = getNumericDate(ACCESS_TTL);
  const iat = getNumericDate(0);
  const token = await create(
    { alg: 'HS256', typ: 'JWT' },
    {
      iss: 'thegood-stock',
      aud: 'authenticated',
      sub: opts.username,
      role: 'authenticated',
      user_role: opts.user_role,
      name: opts.name,
      username: opts.username,
      jti: opts.jti,
      iat,
      exp,
    },
    key
  );
  return { token, exp };
}

async function handleLogin(req: Request, body: any): Promise<Response> {
  const { username, password } = body;
  if (!username || !password) return json({ error: 'missing_fields' }, 400);

  let gasResp: any;
  try {
    const r = await fetch(GAS_HR_URL, {
      method:  'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body:    JSON.stringify({ username, password }),
      redirect: 'follow',
    });
    if (!r.ok) return json({ error: 'gas_unreachable', upstream_status: r.status }, 502);
    gasResp = await r.json();
  } catch (e) {
    return json({ error: 'gas_unreachable', detail: String(e) }, 502);
  }

  if (gasResp?.status !== 'success') {
    const msg = String(gasResp?.message ?? '');
    if (msg.includes('สิทธิ์'))   return json({ error: 'account_inactive' }, 403);
    return json({ error: 'invalid_credentials' }, 401);
  }

  const name      = gasResp.name ?? username;
  const user_role = gasResp.role ?? 'Employee';
  const jti       = uuid();

  const { token, exp } = await signAccessToken({ username, name, user_role, jti });
  const refreshToken  = uuid();
  const refreshExp    = new Date(Date.now() + REFRESH_TTL * 1000).toISOString();
  const accessExp     = new Date(exp * 1000).toISOString();

  const ip   = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const ua   = req.headers.get('user-agent') || null;

  const { error } = await sb.from('user_sessions').insert({
    username, name, role: user_role,
    jwt_jti: jti,
    refresh_token: refreshToken,
    expires_at: accessExp,
    refresh_expires_at: refreshExp,
    ip, user_agent: ua,
    last_seen_at: new Date().toISOString(),
  });
  if (error) return json({ error: 'session_persist_failed', detail: error.message }, 500);

  return json({
    access_token:  token,
    refresh_token: refreshToken,
    name,
    user_role,
    username,
    expires_at:    accessExp,
  });
}

async function handleRefresh(_req: Request, body: any): Promise<Response> {
  const { refresh_token } = body;
  if (!refresh_token) return json({ error: 'missing_fields' }, 400);

  const { data: row } = await sb
    .from('user_sessions')
    .select('*')
    .eq('refresh_token', refresh_token)
    .eq('revoked', false)
    .gt('refresh_expires_at', new Date().toISOString())
    .maybeSingle();

  if (!row) return json({ error: 'invalid_refresh' }, 401);

  const jti = uuid();
  const { token, exp } = await signAccessToken({
    username: row.username, name: row.name, user_role: row.role, jti,
  });
  const newRefresh   = uuid();
  const refreshExp   = new Date(Date.now() + REFRESH_TTL * 1000).toISOString();
  const accessExp    = new Date(exp * 1000).toISOString();

  await sb.from('user_sessions').update({
    jwt_jti: jti,
    refresh_token: newRefresh,
    expires_at: accessExp,
    refresh_expires_at: refreshExp,
    last_seen_at: new Date().toISOString(),
  }).eq('id', row.id);

  return json({
    access_token:  token,
    refresh_token: newRefresh,
    expires_at:    accessExp,
  });
}

async function handleLogout(_req: Request, body: any): Promise<Response> {
  const { refresh_token } = body;
  if (!refresh_token) return json({ ok: true });
  await sb.from('user_sessions').update({ revoked: true }).eq('refresh_token', refresh_token);
  return json({ ok: true });
}

async function handleVerify(_req: Request, body: any): Promise<Response> {
  const { access_token } = body;
  if (!access_token) return json({ valid: false, reason: 'missing_token' }, 401);
  try {
    const key = await getJwtKey();
    const payload: any = await verify(access_token, key);
    const { data: sess } = await sb
      .from('user_sessions')
      .select('revoked')
      .eq('jwt_jti', payload.jti)
      .maybeSingle();
    if (!sess || sess.revoked) return json({ valid: false, reason: 'revoked' }, 401);

    return json({
      valid:     true,
      username:  payload.username,
      user_role: payload.user_role,
      name:      payload.name,
      jti:       payload.jti,
    });
  } catch (e) {
    return json({ valid: false, reason: 'invalid_signature_or_expired' }, 401);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  switch (body?.action) {
    case 'login':   return await handleLogin(req, body);
    case 'refresh': return await handleRefresh(req, body);
    case 'logout':  return await handleLogout(req, body);
    case 'verify':  return await handleVerify(req, body);
    default:        return json({ error: 'unknown_action' }, 400);
  }
});
