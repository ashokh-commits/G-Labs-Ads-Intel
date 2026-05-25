const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET   = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function verifyToken(token) {
  try {
    const [h,b,s] = token.split('.');
    const exp = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64')
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    if (s !== exp) return null;
    const p = JSON.parse(Buffer.from(b,'base64').toString());
    if (Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

async function sb(method, table, body=null, query='') {
  const url  = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const hdrs = {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation,resolution=merge-duplicates',
  };
  if (method === 'GET') hdrs['Range'] = '0-9999';
  const opts = { method, headers: hdrs };
  if (body)  opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    if (!res.ok) console.error(`[SB] ${method} ${table}${query} → ${res.status}:`, JSON.stringify(parsed).slice(0,300));
    return { ok: res.ok, status: res.status, data: parsed };
  } catch {
    return { ok: res.ok, status: res.status, data: [] };
  }
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers['authorization']||'').replace('Bearer ','').trim();
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const user = verifyToken(token);
  if (!user)  return res.status(401).json({ error: 'Invalid session' });
  if (user.role === 'client') return res.status(403).json({ error: 'Access denied' });

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured — check SUPABASE_URL and SUPABASE_ANON_KEY' });

  const action = (req.query?.action || '').toLowerCase();
  const body   = await parseBody(req);

  try {
    // ── TASKS ──────────────────────────────────────────────────────────────
    if (action === 'get_tasks') {
      const freq = req.query?.frequency || '';
      let q = '?order=priority.desc,created_at.asc';
      if (freq) q += `&frequency=eq.${freq}`;
      const r = await sb('GET', 'tasks', null, q);
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'create_task') {
      const payload = { ...body, created_by: user.userId, status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const r = await sb('POST', 'tasks', payload, '');
      console.log('[SB] create_task result:', JSON.stringify(r.data).slice(0,200));
      return res.status(200).json(r.data);
    }

    if (action === 'update_task') {
      const { id, ...updates } = body;
      updates.updated_at = new Date().toISOString();
      const r = await sb('PATCH', 'tasks', updates, `?id=eq.${id}`);
      return res.status(200).json(r.data);
    }

    if (action === 'delete_task') {
      await sb('DELETE', 'tasks', null, `?id=eq.${body.id}`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'complete_task') {
      await sb('POST', 'task_completions', {
        task_id:      body.task_id,
        completed_by: user.userId,
        notes:        body.notes || '',
        date:         new Date().toISOString().split('T')[0],
      }, '');
      const taskR = await sb('GET', 'tasks', null, `?id=eq.${body.task_id}`);
      const task  = Array.isArray(taskR.data) ? taskR.data[0] : null;
      if (task && task.frequency === 'once') {
        await sb('PATCH', 'tasks', { status:'done', completed_at: new Date().toISOString(), completed_by: user.userId, updated_at: new Date().toISOString() }, `?id=eq.${body.task_id}`);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'get_completions') {
      const date = req.query?.date || new Date().toISOString().split('T')[0];
      const r    = await sb('GET', 'task_completions', null, `?date=eq.${date}`);
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    // ── META SNAPSHOTS ─────────────────────────────────────────────────────
    if (action === 'save_meta_snapshot') {
      const snapshots = body.snapshots || [];
      if (!snapshots.length) return res.status(400).json({ error: 'No snapshots' });
      const r = await sb('POST', 'meta_snapshots', snapshots, '?on_conflict=account_id,date');
      return res.status(200).json({ saved: snapshots.length });
    }

    if (action === 'get_meta_history') {
      const accountId = req.query?.account_id || '';
      const from      = req.query?.from || '';
      const to        = req.query?.to   || '';
      let q = `?account_id=eq.${accountId}&order=date.asc`;
      if (from) q += `&date=gte.${from}`;
      if (to)   q += `&date=lte.${to}`;
      const r = await sb('GET', 'meta_snapshots', null, q);
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    // ── LEADS SNAPSHOTS ────────────────────────────────────────────────────
    if (action === 'save_leads_snapshot') {
      const r = await sb('POST', 'leads_snapshots', body, '?on_conflict=client,zone,date');
      return res.status(200).json({ ok: true });
    }

    if (action === 'get_leads_history') {
      const client = req.query?.client || 'isihat';
      const from   = req.query?.from   || '';
      const to     = req.query?.to     || '';
      let q = `?client=eq.${client}&order=date.asc`;
      if (from) q += `&date=gte.${from}`;
      if (to)   q += `&date=lte.${to}`;
      const r = await sb('GET', 'leads_snapshots', null, q);
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    return res.status(404).json({ error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('[Supabase proxy error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
