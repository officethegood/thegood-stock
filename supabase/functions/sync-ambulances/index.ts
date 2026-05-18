// supabase/functions/sync-ambulances/index.ts
// POST (no body). Admin JWT required.

import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const JWT_SECRET       = Deno.env.get('APP_JWT_HS_SECRET')!;
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

async function requireAdminJWT(req: Request): Promise<{ ok: true; payload: any } | { ok: false; resp: Response }> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, resp: json({ error: 'unauthorized' }, 401) };
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const payload: any = await verify(token, key);
    if (payload.user_role !== 'Admin') {
      return { ok: false, resp: json({ error: 'forbidden_not_admin' }, 403) };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, resp: json({ error: 'unauthorized' }, 401) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  const auth = await requireAdminJWT(req);
  if (!auth.ok) return auth.resp;

  const t0 = Date.now();

  const { data: setting } = await sb.from('settings').select('value').eq('key', 'AMBULANCE_GAS_URL').maybeSingle();
  const url = setting?.value;
  if (!url) return json({ error: 'ambulance_gas_url_not_set' }, 400);

  let list: any[];
  try {
    const r = await fetch(`${url}?action=listAmbulances`, { method: 'GET', redirect: 'follow' });
    if (!r.ok) return json({ error: 'gas_unreachable', upstream_status: r.status }, 502);
    const data = await r.json();
    if (!Array.isArray(data)) return json({ error: 'parse_error', detail: 'expected array' }, 502);
    list = data;
  } catch (e) {
    return json({ error: 'gas_unreachable', detail: String(e) }, 502);
  }

  if (list.length === 0) return json({ error: 'empty_response' }, 500);

  const rows = list.map((it) => ({
    gas_id:         String(it.id ?? it.ambulance_id ?? it.gas_id ?? ''),
    plate:          String(it.plate ?? it.license ?? it.tabian ?? '').trim(),
    callsign:       it.callsign ?? it.call_sign ?? null,
    active:         true,
    raw:            it,
    last_synced_at: new Date().toISOString(),
  })).filter((r) => r.gas_id && r.plate);

  if (rows.length === 0) return json({ error: 'no_valid_rows', detail: 'every row missing gas_id or plate' }, 500);

  const incomingIds = rows.map((r) => r.gas_id);

  const { error: upErr, count: upCount } = await sb
    .from('ambulances')
    .upsert(rows, { onConflict: 'gas_id', count: 'exact' });
  if (upErr) return json({ error: 'upsert_failed', detail: upErr.message }, 500);

  const { error: deErr, count: deCount } = await sb
    .from('ambulances')
    .update({ active: false, last_synced_at: new Date().toISOString() })
    .not('gas_id', 'in', `(${incomingIds.map((id) => `"${id}"`).join(',')})`)
    .eq('active', true);

  const duration_ms = Date.now() - t0;
  return json({
    ok: true,
    fetched:        list.length,
    upserted:       upCount ?? rows.length,
    deactivated:    deCount ?? 0,
    duration_ms,
    last_synced_at: new Date().toISOString(),
  });
});
