/**
 * G6 Labs — Supabase Proxy
 * Handles: tasks CRUD, meta snapshots, leads snapshots, historical queries
 */

const crypto = require('crypto');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET    = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';

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

// Supabase REST helper
async function sb(method, table, body=null, query='') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const opts = {
    method,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=representation' : 'return=representation',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// Parse request body
async function parseBody(req) {
  if (req.body) return req.body;
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const token = (req.headers['authorization']||'').replace('Bearer ','').trim();
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const user = verifyToken(token);
  if (!user)  return res.status(401).json({ error: 'Invalid session' });

  // Block clients
  if (user.role === 'client') return res.status(403).json({ error: 'Access denied' });

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  const action = (req.query?.action || '').toLowerCase();
  const body   = await parseBody(req);

  try {
    // ── TASKS ──────────────────────────────────────────────────────────────
    if (action === 'get_tasks') {
      const freq   = req.query?.frequency || '';
      const who    = req.query?.assignee  || '';
      let query = '?order=priority.desc,created_at.asc';
      if (freq) query += `&frequency=eq.${freq}`;
      if (who)  query += `&or=(assignee.eq.${who},assignee.eq.all)`;
      const r = await sb('GET', 'tasks', null, query);
      return res.status(200).json(r.data);
    }

    if (action === 'create_task') {
      const r = await sb('POST', 'tasks', { ...body, created_by: user.userId });
      return res.status(200).json(r.data);
    }

    if (action === 'update_task') {
      const { id, ...updates } = body;
      updates.updated_at = new Date().toISOString();
      const r = await sb('PATCH', 'tasks', updates, `?id=eq.${id}`);
      return res.status(200).json(r.data);
    }

    if (action === 'delete_task') {
      const r = await sb('DELETE', 'tasks', null, `?id=eq.${body.id}`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'complete_task') {
      // Log completion
      await sb('POST', 'task_completions', {
        task_id:      body.task_id,
        completed_by: user.userId,
        notes:        body.notes || '',
        date:         new Date().toISOString().split('T')[0],
      });
      // Update task status if not recurring
      const taskR = await sb('GET', 'tasks', null, `?id=eq.${body.task_id}`);
      const task  = taskR.data?.[0];
      if (task && task.frequency === 'once') {
        await sb('PATCH', 'tasks', {
          status:       'done',
          completed_at: new Date().toISOString(),
          completed_by: user.userId,
          updated_at:   new Date().toISOString(),
        }, `?id=eq.${body.task_id}`);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'get_completions') {
      const date  = req.query?.date || new Date().toISOString().split('T')[0];
      const r = await sb('GET', 'task_completions', null, `?date=eq.${date}`);
      return res.status(200).json(r.data);
    }

    // ── META SNAPSHOTS ─────────────────────────────────────────────────────
    if (action === 'save_meta_snapshot') {
      const snapshots = body.snapshots || [];
      if (!snapshots.length) return res.status(400).json({ error: 'No snapshots' });
      const r = await sb('POST', 'meta_snapshots', snapshots,
        '?on_conflict=account_id,date');
      return res.status(200).json({ saved: snapshots.length });
    }

    if (action === 'get_meta_history') {
      const accountId = req.query?.account_id || '';
      const from      = req.query?.from || '';
      const to        = req.query?.to   || '';
      let query = `?account_id=eq.${accountId}&order=date.asc`;
      if (from) query += `&date=gte.${from}`;
      if (to)   query += `&date=lte.${to}`;
      const r = await sb('GET', 'meta_snapshots', null, query);
      return res.status(200).json(r.data);
    }

    if (action === 'get_meta_comparison') {
      // Returns this month vs last month for an account
      const accountId = req.query?.account_id || '';
      const now       = new Date();
      const thisStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      const lastStart = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().split('T')[0];
      const lastEnd   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

      const [thisMonth, lastMonth] = await Promise.all([
        sb('GET', 'meta_snapshots', null, `?account_id=eq.${accountId}&date=gte.${thisStart}&order=date.asc`),
        sb('GET', 'meta_snapshots', null, `?account_id=eq.${accountId}&date=gte.${lastStart}&date=lte.${lastEnd}&order=date.asc`),
      ]);

      const aggregate = rows => rows.reduce((acc, r) => ({
        spend:       acc.spend       + parseFloat(r.spend||0),
        impressions: acc.impressions + parseInt(r.impressions||0),
        clicks:      acc.clicks      + parseInt(r.clicks||0),
        leads:       acc.leads       + parseInt(r.leads||0),
      }), { spend:0, impressions:0, clicks:0, leads:0 });

      return res.status(200).json({
        thisMonth: { rows: thisMonth.data, totals: aggregate(thisMonth.data||[]) },
        lastMonth: { rows: lastMonth.data, totals: aggregate(lastMonth.data||[]) },
      });
    }

    // ── LEADS SNAPSHOTS ────────────────────────────────────────────────────
    if (action === 'save_leads_snapshot') {
      const r = await sb('POST', 'leads_snapshots', body,
        '?on_conflict=client,zone,date');
      return res.status(200).json({ ok: true });
    }

    if (action === 'get_leads_history') {
      const client = req.query?.client || 'isihat';
      const from   = req.query?.from   || '';
      const to     = req.query?.to     || '';
      let query = `?client=eq.${client}&order=date.asc`;
      if (from) query += `&date=gte.${from}`;
      if (to)   query += `&date=lte.${to}`;
      const r = await sb('GET', 'leads_snapshots', null, query);
      return res.status(200).json(r.data);
    }

    return res.status(404).json({ error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('[Supabase]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
