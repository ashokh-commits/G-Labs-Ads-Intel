const crypto       = require('crypto');
const sendTaskNotif = require('./task-notify');

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
  if (body) opts.body = JSON.stringify(body);
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers['authorization']||'').replace('Bearer ','').trim();
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const user = verifyToken(token);
  if (!user)  return res.status(401).json({ error: 'Invalid session' });
  if (user.role === 'client') return res.status(403).json({ error: 'Access denied' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

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

    if (action === 'get_all_tasks') {
      const r = await sb('GET', 'tasks', null, '?order=created_at.desc');
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'create_task') {
      const payload = {
        ...body,
        created_by: user.userId,
        status:     body.status || 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const r = await sb('POST', 'tasks', payload, '');
      const created = Array.isArray(r.data) ? r.data[0] : r.data;
      // Send notification if assigned to specific person
      if (created && created.assignee && created.assignee !== 'all' && created.assignee !== user.userId) {
        sendTaskNotif(created, user.userId).catch(()=>{});
      }
      return res.status(200).json(created || {});
    }

    if (action === 'update_task') {
      const { id, ...updates } = body;
      const prevR    = await sb('GET', 'tasks', null, `?id=eq.${id}`);
      const prev     = Array.isArray(prevR.data) ? prevR.data[0] : null;
      updates.updated_at = new Date().toISOString();
      const r = await sb('PATCH', 'tasks', updates, `?id=eq.${id}`);
      const updated = Array.isArray(r.data) ? r.data[0] : r.data;
      // Notify if assignee changed
      if (updated && prev && updated.assignee !== prev.assignee && updated.assignee !== 'all' && updated.assignee !== user.userId) {
        sendTaskNotif(updated, user.userId).catch(()=>{});
      }
      return res.status(200).json(updated || {});
    }

    if (action === 'update_task_status') {
      const { id, status } = body;
      const r = await sb('PATCH', 'tasks', { status, updated_at: new Date().toISOString() }, `?id=eq.${id}`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_task') {
      await sb('DELETE', 'tasks', null, `?id=eq.${body.id}`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'complete_task') {
      await sb('POST', 'task_completions', {
        task_id: body.task_id, completed_by: user.userId,
        notes: body.notes || '', date: new Date().toISOString().split('T')[0],
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

    // ── COMMENTS ───────────────────────────────────────────────────────────
    if (action === 'get_comments') {
      const r = await sb('GET', 'task_comments', null, `?task_id=eq.${req.query?.task_id}&order=created_at.asc`);
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'add_comment') {
      const r = await sb('POST', 'task_comments', {
        task_id:    body.task_id,
        author:     user.userId,
        message:    body.message,
        created_at: new Date().toISOString(),
      }, '');
      return res.status(200).json(Array.isArray(r.data) ? r.data[0] : r.data);
    }

    if (action === 'delete_comment') {
      await sb('DELETE', 'task_comments', null, `?id=eq.${body.id}`);
      return res.status(200).json({ ok: true });
    }

    // ── ATTACHMENTS ────────────────────────────────────────────────────────
    if (action === 'save_attachment') {
      const r = await sb('POST', 'task_attachments', {
        task_id:     body.task_id,
        filename:    body.filename,
        url:         body.url,
        uploaded_by: user.userId,
        created_at:  new Date().toISOString(),
      }, '');
      return res.status(200).json(Array.isArray(r.data) ? r.data[0] : r.data);
    }

    if (action === 'get_attachments') {
      const r = await sb('GET', 'task_attachments', null, `?task_id=eq.${req.query?.task_id}&order=created_at.desc`);
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

    // ── FILE UPLOAD ────────────────────────────────────────────────────────
    if (action === 'get_upload_url') {
      // Return Supabase storage upload URL
      const filename = body.filename || 'file';
      const path     = `tasks/${body.task_id}/${Date.now()}_${filename}`;
      return res.status(200).json({
        uploadUrl: `${SUPABASE_URL}/storage/v1/object/task-files/${path}`,
        publicUrl: `${SUPABASE_URL}/storage/v1/object/public/task-files/${path}`,
        path,
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      });
    }

    // ── POINTS SYSTEM ──────────────────────────────────────────────────────
    if (action === 'get_points') {
      const r = await sb('GET', 'assignee_points', null, '?order=total_points.desc');
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'get_points_log') {
      const assignee = req.query?.assignee || '';
      const from     = req.query?.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
      let q = `?date=gte.${from}&order=created_at.desc`;
      if (assignee) q += `&assignee=eq.${assignee}`;
      const r = await sb('GET', 'task_points', null, q);
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'deduct_points') {
      // Deduct points for missed task
      const { assignee, task_id, task_title, frequency } = body;
      const deductMap = { daily: -3, weekly: -5, monthly: -10, once: -5 };
      const pts = deductMap[frequency] || -3;

      // Log the deduction
      await sb('POST', 'task_points', {
        assignee, task_id, task_title,
        points: pts,
        reason: `missed_${frequency}`,
        date:   new Date().toISOString().split('T')[0],
      }, '');

      // Update total
      const cur = await sb('GET', 'assignee_points', null, `?assignee=eq.${assignee}`);
      const hasRow = Array.isArray(cur.data) && cur.data[0];
      const curPts = hasRow ? cur.data[0].total_points : 100;
      if (hasRow) {
        await sb('PATCH', 'assignee_points', { total_points: Math.max(0, curPts + pts), updated_at: new Date().toISOString() }, `?assignee=eq.${assignee}`);
      } else {
        await sb('POST', 'assignee_points', { assignee, total_points: Math.max(0, curPts + pts), updated_at: new Date().toISOString() }, '');
      }

      return res.status(200).json({ ok: true, points: pts });
    }

    if (action === 'award_points') {
      // Award points for completing a task
      const { assignee, task_id, task_title, frequency } = body;
      const awardMap = { daily: 2, weekly: 4, monthly: 8, once: 3 };
      const pts = awardMap[frequency] || 2;

      await sb('POST', 'task_points', {
        assignee, task_id, task_title,
        points: pts,
        reason: `completed_${frequency}`,
        date:   new Date().toISOString().split('T')[0],
      }, '');

      const cur = await sb('GET', 'assignee_points', null, `?assignee=eq.${assignee}`);
      const hasRow = Array.isArray(cur.data) && cur.data[0];
      const curPts = hasRow ? cur.data[0].total_points : 100;
      if (hasRow) {
        await sb('PATCH', 'assignee_points', { total_points: curPts + pts, updated_at: new Date().toISOString() }, `?assignee=eq.${assignee}`);
      } else {
        await sb('POST', 'assignee_points', { assignee, total_points: curPts + pts, updated_at: new Date().toISOString() }, '');
      }

      return res.status(200).json({ ok: true, points: pts });
    }

    if (action === 'reset_points') {
      // Admin only — reset all points to 100
      if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      for (const a of ['ashokh','diva','anisa']) {
        const cur = await sb('GET', 'assignee_points', null, `?assignee=eq.${a}`);
        if (Array.isArray(cur.data) && cur.data[0]) {
          await sb('PATCH', 'assignee_points', { total_points: 100, updated_at: new Date().toISOString() }, `?assignee=eq.${a}`);
        } else {
          await sb('POST', 'assignee_points', { assignee: a, total_points: 100, updated_at: new Date().toISOString() }, '');
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'batch_deduct_points') {
      // Superadmin only — deduct missed-daily points for multiple assignees in one request.
      // Body: { byAssignee: { diva: { pts: -N, tasks: [{id, title}] }, ... } }
      // Avoids N×M sequential requests that cause race conditions.
      const { byAssignee } = body;
      if (!byAssignee || typeof byAssignee !== 'object') return res.status(400).json({ error: 'byAssignee required' });
      const today = new Date().toISOString().split('T')[0];

      const debugResults = {};
      for (const [assignee, data] of Object.entries(byAssignee)) {
        // Log each individual task miss
        for (const t of (data.tasks || [])) {
          await sb('POST', 'task_points', {
            assignee,
            task_id:    t.id   || null,
            task_title: t.title || '',
            points:    -3,
            reason:    'missed_daily',
            date:      today,
          }, '');
        }
        // GET current → PATCH new total
        const cur    = await sb('GET', 'assignee_points', null, `?assignee=eq.${assignee}`);
        const rows   = Array.isArray(cur.data) ? cur.data : [];
        const curPts = rows[0] ? rows[0].total_points : null;
        const newPts = Math.max(0, (curPts ?? 100) + (data.pts || 0));
        let patchResult;
        if (curPts === null) {
          // No row exists — plain INSERT
          patchResult = await sb('POST', 'assignee_points',
            { assignee, total_points: newPts, updated_at: new Date().toISOString() },
            ''
          );
        } else {
          patchResult = await sb('PATCH', 'assignee_points',
            { total_points: newPts, updated_at: new Date().toISOString() },
            `?assignee=eq.${assignee}`
          );
        }
        debugResults[assignee] = { rows: rows.length, curPts, newPts, patchStatus: patchResult.status };
        console.log(`[batch_deduct] ${assignee}: rows=${rows.length} curPts=${curPts} newPts=${newPts} patchStatus=${patchResult.status}`);
      }
      return res.status(200).json({ ok: true, debug: debugResults });
    }

    // ── AD SNAPSHOTS ───────────────────────────────────────────────────────

    if (action === 'save_ad_snapshots') {
      // Upsert an array of ad×day rows (used for today's auto-save from live data)
      const rows = body.rows || [];
      if (!rows.length) return res.status(400).json({ error: 'No rows provided' });
      const CHUNK = 200;
      let saved = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const r = await sb('POST', 'ad_snapshots', chunk, '?on_conflict=account_id,ad_id,date');
        if (r.ok) saved += chunk.length;
        else console.error('[save_ad_snapshots] chunk error:', JSON.stringify(r.data).slice(0, 200));
      }
      return res.status(200).json({ ok: true, saved });
    }

    if (action === 'get_ad_summary') {
      // Aggregate ad_snapshots for an account over a date range.
      // Returns one object per ad with summed metrics and computed rates.
      const accountId = req.query?.account_id || '';
      const from      = req.query?.from || '';
      const to        = req.query?.to   || '';
      if (!accountId) return res.status(400).json({ error: 'account_id required' });
      let q = `?account_id=eq.${accountId}&order=date.asc`;
      if (from) q += `&date=gte.${from}`;
      if (to)   q += `&date=lte.${to}`;
      const r    = await sb('GET', 'ad_snapshots', null, q);
      const rows = Array.isArray(r.data) ? r.data : [];

      // Group by ad_id and sum all metrics
      const byAd = {};
      rows.forEach(row => {
        const key = row.ad_id;
        if (!byAd[key]) {
          byAd[key] = {
            ad_id: row.ad_id, ad_name: row.ad_name || '', campaign_name: row.campaign_name || '',
            spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, conversations: 0,
            freq_sum: 0, freq_count: 0, days: 0,
          };
        }
        const a = byAd[key];
        a.spend         += parseFloat(row.spend || 0);
        a.impressions   += parseInt(row.impressions || 0);
        a.reach         += parseInt(row.reach || 0);
        a.clicks        += parseInt(row.clicks || 0);
        a.results       += parseInt(row.results || 0);
        a.conversations += parseInt(row.conversations || 0);
        if (parseFloat(row.frequency || 0) > 0) {
          a.freq_sum   += parseFloat(row.frequency);
          a.freq_count += 1;
        }
        a.days += 1;
      });

      const summary = Object.values(byAd).map(a => ({
        ad_id:         a.ad_id,
        ad_name:       a.ad_name,
        campaign_name: a.campaign_name,
        spend:         parseFloat(a.spend.toFixed(2)),
        impressions:   a.impressions,
        reach:         a.reach,
        clicks:        a.clicks,
        results:       a.results,
        conversations: a.conversations,
        ctr:           a.impressions > 0 ? parseFloat((a.clicks / a.impressions * 100).toFixed(4)) : 0,
        cpl:           a.results > 0 ? parseFloat((a.spend / a.results).toFixed(2))
                         : a.conversations > 0 ? parseFloat((a.spend / a.conversations).toFixed(2)) : 0,
        avg_frequency: a.freq_count > 0 ? parseFloat((a.freq_sum / a.freq_count).toFixed(2)) : 0,
        days:          a.days,
      })).sort((a, b) => b.spend - a.spend);

      return res.status(200).json(summary);
    }

    if (action === 'check_ad_data') {
      // Return distinct dates for which ad_snapshots exist for an account+range.
      // Used by the backfill UI to show which months already have data.
      const accountId = req.query?.account_id || '';
      const from      = req.query?.from || '';
      const to        = req.query?.to   || '';
      if (!accountId) return res.status(400).json({ error: 'account_id required' });
      let q = `?account_id=eq.${accountId}&select=date`;
      if (from) q += `&date=gte.${from}`;
      if (to)   q += `&date=lte.${to}`;
      const r    = await sb('GET', 'ad_snapshots', null, q);
      const rows = Array.isArray(r.data) ? r.data : [];
      const dates = [...new Set(rows.map(row => row.date))].sort();
      return res.status(200).json({ count: rows.length, dates, has_data: rows.length > 0 });
    }

    if (action === 'clear_ad_snapshots') {
      // Superadmin only — delete all ad_snapshots for an account so dirty MTD data
      // can be replaced with accurate daily rows via backfill.
      if (user.superadmin !== true && user.userId !== 'ashokh') return res.status(403).json({ error: 'Superadmin only' });
      const accountId = body.account_id || '';
      if (!accountId) return res.status(400).json({ error: 'account_id required' });
      const r = await sb('DELETE', 'ad_snapshots', null, `?account_id=eq.${accountId}`);
      console.log(`[clear_ad_snapshots] Cleared ad_snapshots for account ${accountId}`);
      return res.status(200).json({ ok: true, deleted: true });
    }

    // ── TASK MANAGER RESET (superadmin only) ─────────────────────────────────

    if (action === 'reset_tasks') {
      if (user.superadmin !== true && user.userId !== 'ashokh') return res.status(403).json({ error: 'Superadmin only' });
      // Body: { assignments: { "Toothland Dental": "anisa", "Ang Dental": "diva", ... } }
      const assignments = body.assignments || {};
      const now = new Date().toISOString();

      // 1) Wipe everything (order matters for FK references)
      const wipeFilter = '?id=not.is.null';
      await sb('DELETE', 'task_points',      null, wipeFilter).catch(()=>{});
      await sb('DELETE', 'task_completions', null, wipeFilter).catch(()=>{});
      await sb('DELETE', 'task_comments',    null, wipeFilter).catch(()=>{});
      await sb('DELETE', 'task_attachments', null, wipeFilter).catch(()=>{});
      await sb('DELETE', 'tasks',            null, wipeFilter);

      // 2) Reset all points to 100
      for (const a of ['ashokh','diva','anisa']) {
        await sb('POST', 'assignee_points', { assignee: a, total_points: 100, updated_at: now }, '?on_conflict=assignee').catch(()=>{});
      }

      // 3) Seed 5 daily ops tasks per assigned client
      const TYPES = [
        { t: 'Ads Report',                        cat: 'report',  pri: 'high'   },
        { t: 'Answer Client Queries',             cat: 'general', pri: 'urgent' },
        { t: 'Check Scheduled Content Posting',   cat: 'content', pri: 'high'   },
        { t: 'Follow Up Content in Design Status',cat: 'design',  pri: 'medium' },
        { t: 'Ads Monitoring',                    cat: 'ads',     pri: 'high'   },
      ];
      const rows = [];
      for (const [client, assignee] of Object.entries(assignments)) {
        if (!assignee || assignee === 'skip') continue;
        for (const ty of TYPES) {
          rows.push({
            title:       `${ty.t} — ${client}`,
            description: `Client: ${client}`,
            assignee,
            priority:    ty.pri,
            category:    ty.cat,
            frequency:   'daily',
            status:      'pending',
            created_by:  user.userId,
            created_at:  now,
            updated_at:  now,
          });
        }
      }
      if (rows.length) {
        // Insert in chunks of 100
        for (let i = 0; i < rows.length; i += 100) {
          await sb('POST', 'tasks', rows.slice(i, i + 100), '');
        }
      }
      console.log(`[reset_tasks] Wiped all tasks, seeded ${rows.length} daily tasks`);
      return res.status(200).json({ ok: true, created: rows.length });
    }

    // ── USER MANAGEMENT (superadmin only) ────────────────────────────────────

    const isSuperAdmin = user.superadmin === true || user.userId === 'ashokh';

    if (action === 'get_users') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Superadmin only' });
      const r = await sb('GET', 'users', null, '?select=username,name,role,superadmin,accounts,email,active&order=created_at.asc');
      if (!r.ok) {
        // Table likely doesn't exist yet — return a clear error so the UI can guide the user
        console.error('[get_users] Supabase error:', JSON.stringify(r.data).slice(0, 200));
        return res.status(500).json({ error: 'users_table_missing', hint: 'Run SUPABASE_USERS.sql in Supabase SQL Editor first.' });
      }
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'create_user') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Superadmin only' });
      const { username, name, password, role, superadmin: sa, accounts: accts, email } = body;
      if (!username || !password) return res.status(400).json({ error: 'username and password required' });
      const password_hash = crypto.createHmac('sha256', JWT_SECRET).update(password.trim()).digest('hex');
      const r = await sb('POST', 'users', {
        username:      username.toLowerCase().trim(),
        password_hash,
        name:          name || username,
        role:          role || 'client',
        superadmin:    sa === true,
        accounts:      Array.isArray(accts) ? accts : (role === 'admin' ? ['*'] : []),
        email:         email || null,
        active:        true,
      }, '');
      const created = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!r.ok) return res.status(400).json({ error: 'Failed to create user', detail: r.data });
      return res.status(200).json({ ok: true, user: created });
    }

    if (action === 'update_user') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Superadmin only' });
      const { username, password, ...updates } = body;
      if (!username) return res.status(400).json({ error: 'username required' });
      const payload = { ...updates, updated_at: new Date().toISOString() };
      if (password) payload.password_hash = crypto.createHmac('sha256', JWT_SECRET).update(password.trim()).digest('hex');
      delete payload.username; // don't overwrite PK
      const r = await sb('PATCH', 'users', payload, `?username=eq.${encodeURIComponent(username)}`);
      return res.status(200).json({ ok: r.ok });
    }

    if (action === 'toggle_user') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Superadmin only' });
      const { username, active } = body;
      if (!username) return res.status(400).json({ error: 'username required' });
      if (username === user.userId) return res.status(400).json({ error: 'Cannot deactivate yourself' });
      const r = await sb('PATCH', 'users', { active: !!active, updated_at: new Date().toISOString() }, `?username=eq.${encodeURIComponent(username)}`);
      return res.status(200).json({ ok: r.ok });
    }

    // ── WHATSAPP GROUPS ───────────────────────────────────────────────────────
    if (action === 'get_wa_groups') {
      const r = await sb('GET', 'whatsapp_groups', null, '?order=created_at.desc');
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'save_wa_group') {
      if (!user.superadmin) return res.status(403).json({ error: 'Superadmin only' });
      const { id, jid, client_name, assignee, enabled } = body;
      if (!jid || !client_name || !assignee) return res.status(400).json({ error: 'jid, client_name, assignee required' });
      const now = new Date().toISOString();
      if (id) {
        const r = await sb('PATCH', 'whatsapp_groups', { jid, client_name, assignee, enabled: enabled !== false, updated_at: now }, `?id=eq.${id}`);
        return res.status(200).json({ ok: r.ok });
      } else {
        const r = await sb('POST', 'whatsapp_groups', [{ jid, client_name, assignee, enabled: true, created_at: now, updated_at: now }], '');
        return res.status(200).json({ ok: r.ok, data: r.data });
      }
    }

    if (action === 'delete_wa_group') {
      if (!user.superadmin) return res.status(403).json({ error: 'Superadmin only' });
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb('DELETE', 'whatsapp_groups', null, `?id=eq.${id}`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'toggle_wa_group') {
      if (!user.superadmin) return res.status(403).json({ error: 'Superadmin only' });
      const { id, enabled } = body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const r = await sb('PATCH', 'whatsapp_groups', { enabled: !!enabled, updated_at: new Date().toISOString() }, `?id=eq.${id}`);
      return res.status(200).json({ ok: r.ok });
    }

    if (action === 'get_wa_task_log') {
      const limit = parseInt(req.query?.limit || '50');
      const r = await sb('GET', 'whatsapp_task_log', null, `?order=created_at.desc&limit=${limit}`);
      return res.status(200).json(Array.isArray(r.data) ? r.data : []);
    }

    if (action === 'dismiss_wa_log') {
      if (!user.superadmin) return res.status(403).json({ error: 'Superadmin only' });
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb('DELETE', 'whatsapp_task_log', null, `?id=eq.${id}`);
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('[Supabase proxy error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
