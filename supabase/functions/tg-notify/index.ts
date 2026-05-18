// supabase/functions/tg-notify/index.ts
// POST { event_type, entity_type?, entity_id?, dedupe_key, message, payload? }
// Auth: Admin JWT OR (service_role + X-Internal: true)

import { verify } from 'djwt';
import { createClient } from 'supabase';

const JWT_SECRET       = Deno.env.get('APP_JWT_HS_SECRET')!;
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const NOTIFY_PROXY     = Deno.env.get('NOTIFY_PROXY_URL')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-internal',
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

async function isAuthorized(req: Request): Promise<boolean> {
  const internal = req.headers.get('x-internal') === 'true';
  const auth     = req.headers.get('authorization') || '';
  const token    = auth.replace(/^Bearer\s+/i, '');

  if (internal && token === SERVICE_ROLE_KEY) return true;

  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const payload: any = await verify(token, key);
    return payload.user_role === 'Admin';
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  if (!(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const { event_type, entity_type, entity_id, dedupe_key, message, payload } = body;
  if (!event_type || !dedupe_key || !message) return json({ error: 'missing_fields' }, 400);

  const { data: enabledRow } = await sb.from('settings').select('value').eq('key', 'NOTIFY_TELEGRAM_ENABLED').maybeSingle();
  if (enabledRow?.value !== 'true') return json({ ok: true, sent: false, reason: 'disabled' });

  const { data: windowRow } = await sb.from('settings').select('value').eq('key', 'LOW_STOCK_DEDUPE_HOURS').maybeSingle();
  const hours = Number(windowRow?.value ?? 24);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const { data: existing } = await sb
    .from('notification_log')
    .select('id')
    .eq('dedupe_key', dedupe_key)
    .gt('sent_at', since)
    .limit(1);

  if (existing && existing.length > 0) return json({ ok: true, sent: false, dedupe_hit: true });

  let success = true; let errMsg: string | null = null;
  try {
    const r = await fetch(`${NOTIFY_PROXY}/notify/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        case_id:    entity_id ?? dedupe_key,
        alert_type: event_type,
        message,
        deep_link:  '',
      }),
    });
    if (!r.ok) { success = false; errMsg = `worker_${r.status}`; }
  } catch (e) {
    success = false; errMsg = String(e);
  }

  const { data: logRow } = await sb.from('notification_log').insert({
    event_type, entity_type, entity_id, dedupe_key,
    channel: 'telegram', message, payload,
    success, error: errMsg,
  }).select('id').single();

  return json({ ok: true, sent: success, dedupe_hit: false, log_id: logRow?.id, error: errMsg });
});
