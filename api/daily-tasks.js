/**
 * G6 Labs — Daily Task Reset Cron
 * Runs at midnight MYT (16:00 UTC) every day.
 * 1. Marks any pending/in_progress daily tasks from previous days as 'backlog'
 * 2. Creates fresh daily task rows for today based on existing client→assignee assignments
 *
 * Protected by CRON_SECRET env var (set in Vercel).
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// Malaysia time (UTC+8)
function todayMYT() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function sb(method, table, body=null, query='') {
  const url  = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const hdrs = {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  };
  if (method === 'GET') hdrs['Range'] = '0-9999';
  const opts = { method, headers: hdrs };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok) console.error(`[daily-tasks] ${method} ${table}${query} → ${res.status}:`, JSON.stringify(data).slice(0,300));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: res.ok, status: res.status, data: [] };
  }
}

const TASK_TYPES = [
  { t: 'Ads Report',                         cat: 'report',  pri: 'high'   },
  { t: 'Answer Client Queries',              cat: 'general', pri: 'urgent' },
  { t: 'Check Scheduled Content Posting',    cat: 'content', pri: 'high'   },
  { t: 'Follow Up Content in Design Status', cat: 'design',  pri: 'medium' },
  { t: 'Ads Monitoring',                     cat: 'ads',     pri: 'high'   },
];

module.exports = async (req, res) => {
  // Auth guard
  if (process.env.CRON_SECRET) {
    const key = req.query?.key || (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (key !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = todayMYT();
  const now   = new Date().toISOString();

  // 1. Find all active daily tasks that are NOT from today (previous days' tasks)
  const oldTasksRes = await sb('GET', 'tasks', null,
    `?frequency=eq.daily&status=in.(pending,in_progress)&created_at=lt.${today}T00:00:00+08:00&select=id,title,assignee,category,priority,created_at`
  );
  const oldTasks = Array.isArray(oldTasksRes.data) ? oldTasksRes.data : [];

  // 2. Mark old uncompleted daily tasks as 'backlog'
  let backlogs = 0;
  if (oldTasks.length > 0) {
    const ids = oldTasks.map(t => t.id);
    // Patch in chunks of 50
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const inList = chunk.map(id => `"${id}"`).join(',');
      await sb('PATCH', 'tasks',
        { status: 'backlog', updated_at: now },
        `?id=in.(${inList})`
      );
    }
    backlogs = ids.length;
  }

  // 3. Derive client→assignee mapping from the most recent tasks
  const allTasksRes = await sb('GET', 'tasks', null,
    `?frequency=eq.daily&select=title,assignee,description&limit=500&order=created_at.desc`
  );
  const allDailyTasks = Array.isArray(allTasksRes.data) ? allTasksRes.data : [];

  // Extract unique client→assignee pairs from task descriptions ("Client: X")
  const assignments = {};
  for (const t of allDailyTasks) {
    const match = (t.description || '').match(/^Client:\s*(.+)$/);
    if (match && t.assignee && !assignments[match[1]]) {
      assignments[match[1]] = t.assignee;
    }
  }

  if (Object.keys(assignments).length === 0) {
    return res.status(200).json({ ok: true, today, backlogs, created: 0, note: 'No existing assignments found — run reset_tasks from Settings first' });
  }

  // 4. Check if today's tasks already exist
  const todayTasksRes = await sb('GET', 'tasks', null,
    `?frequency=eq.daily&created_at=gte.${today}T00:00:00+08:00&select=id&limit=1`
  );
  const todayTasks = Array.isArray(todayTasksRes.data) ? todayTasksRes.data : [];
  if (todayTasks.length > 0) {
    return res.status(200).json({ ok: true, today, backlogs, created: 0, note: "Today's tasks already exist" });
  }

  // 5. Create today's fresh daily tasks
  const rows = [];
  for (const [client, assignee] of Object.entries(assignments)) {
    for (const ty of TASK_TYPES) {
      rows.push({
        title:       `${ty.t} — ${client}`,
        description: `Client: ${client}`,
        assignee,
        priority:    ty.pri,
        category:    ty.cat,
        frequency:   'daily',
        status:      'pending',
        due_date:    today,
        created_at:  now,
        updated_at:  now,
      });
    }
  }

  let created = 0;
  for (let i = 0; i < rows.length; i += 100) {
    await sb('POST', 'tasks', rows.slice(i, i + 100), '');
    created += Math.min(100, rows.length - i);
  }

  console.log(`[daily-tasks] ${today}: ${backlogs} backlogs, ${created} new tasks created`);
  return res.status(200).json({ ok: true, today, backlogs, created, assignments });
};
