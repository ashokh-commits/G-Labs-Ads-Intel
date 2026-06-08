/**
 * G6 Labs — WhatsApp Auto-Task Webhook
 * Receives incoming messages from Evolution API.
 * Uses Claude AI (Haiku) to detect task requests and auto-creates tasks.
 *
 * Env vars required:
 *   SUPABASE_URL / SUPABASE_ANON_KEY  — database
 *   ANTHROPIC_API_KEY                 — Claude AI for task detection
 *   EVOLUTION_API_URL / KEY / INSTANCE — to send confirmation messages
 *   WEBHOOK_SECRET (optional)         — shared secret from Evolution webhook config
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EVO_URL       = process.env.EVOLUTION_API_URL;
const EVO_KEY       = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCE  = process.env.EVOLUTION_INSTANCE;

// ── Supabase helper ──────────────────────────────────────────────────────────
async function sb(method, table, body = null, query = '') {
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
  try   { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: [] }; }
}

// ── Claude AI: detect task in message ───────────────────────────────────────
async function analyzeWithClaude(message, clientName, senderName) {
  if (!ANTHROPIC_KEY) {
    // Fallback: keyword detection
    return keywordDetect(message);
  }

  const prompt = `You are a task detection assistant for G6 Labs, a digital marketing agency in Malaysia.

Analyze this WhatsApp message from a client and determine if it contains a task request or action item that the G6 Labs team needs to act on.

Client name: ${clientName}
Sender: ${senderName}
Message: "${message}"

Respond in JSON only (no markdown, no explanation):
{
  "is_task": true or false,
  "confidence": 0.0 to 1.0,
  "task_title": "short action-oriented title (max 60 chars) or null",
  "priority": "urgent" or "high" or "medium" or "low",
  "category": "ads" or "content" or "design" or "report" or "general",
  "due_hint": "today / tomorrow / this week / specific date / null",
  "reason": "one sentence why this is or isn't a task"
}

Rules:
- is_task = true if the client is requesting action, asking for something to be done, or flagging an issue
- is_task = false for greetings, acknowledgements, general chat, "ok", "thanks", questions about data only
- confidence < 0.6 = not confident enough, treat as false
- task_title must start with a verb (e.g. "Update", "Check", "Send", "Follow up")`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 300,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    const text = data?.content?.[0]?.text || '{}';
    const result = JSON.parse(text);
    if (!result.is_task || result.confidence < 0.6) return null;
    return result;
  } catch (e) {
    console.error('[WA Webhook] Claude API error:', e.message);
    return keywordDetect(message);
  }
}

// ── Fallback: keyword-based detection ───────────────────────────────────────
function keywordDetect(message) {
  const msg   = message.toLowerCase();
  const taskKw = [
    'tolong','please','boleh','can you','could you','need','nak',
    'update','check','send','follow up','remind','fix','change',
    'urgent','asap','segera','esok','tomorrow','by friday','by monday',
    'bila','when will','status','macam mana','how about','dah buat ke',
  ];
  const noTaskKw = ['ok','okay','terima kasih','thanks','tq','noted','roger','received','paham','faham'];
  const hasTask  = taskKw.some(k => msg.includes(k));
  const isNoise  = noTaskKw.some(k => msg === k || msg === k + '.' || msg === k + '!');
  if (!hasTask || isNoise) return null;

  return {
    is_task:    true,
    confidence: 0.65,
    task_title: `Follow up — ${message.slice(0, 50)}`,
    priority:   msg.includes('urgent') || msg.includes('asap') || msg.includes('segera') ? 'urgent' : 'medium',
    category:   'general',
    due_hint:   msg.includes('esok') || msg.includes('tomorrow') ? 'tomorrow' : null,
    reason:     'Keyword match',
  };
}

// ── Resolve due_date from due_hint ───────────────────────────────────────────
function resolveDueDate(hint) {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000); // MYT
  const fmt  = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  if (!hint) return fmt(now);
  const h = (hint || '').toLowerCase();
  if (h === 'today')    return fmt(now);
  if (h === 'tomorrow') { now.setUTCDate(now.getUTCDate() + 1); return fmt(now); }
  if (h.includes('this week')) { now.setUTCDate(now.getUTCDate() + 3); return fmt(now); }
  // Try to parse a specific date
  try { const d = new Date(hint); if (!isNaN(d)) return fmt(d); } catch {}
  return fmt(now);
}

// ── Send WhatsApp reply ──────────────────────────────────────────────────────
async function sendReply(jid, text) {
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return;
  try {
    await fetch(`${EVO_URL.replace(/\/$/, '')}/message/sendText/${EVO_INSTANCE}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
      body:    JSON.stringify({ number: jid, text }),
    });
  } catch (e) {
    console.error('[WA Webhook] Reply failed:', e.message);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Optional secret check
  if (process.env.WEBHOOK_SECRET) {
    const incoming = req.headers['x-webhook-secret'] || req.query?.secret || '';
    if (incoming !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse body
  let payload = req.body;
  if (!payload || typeof payload !== 'object') {
    payload = await new Promise(resolve => {
      let d = '';
      req.on('data', c => { d += c; });
      req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
  }

  // Evolution API sends different event types — we only want messages.upsert
  const event = payload?.event || payload?.type || '';
  if (event && event !== 'messages.upsert') {
    return res.status(200).json({ ok: true, skipped: `event:${event}` });
  }

  // Extract message data
  const msgData = payload?.data || payload;
  const rawMsg  = msgData?.message || {};
  const text    = rawMsg?.conversation
    || rawMsg?.extendedTextMessage?.text
    || rawMsg?.imageMessage?.caption
    || '';

  if (!text || text.trim().length < 3) {
    return res.status(200).json({ ok: true, skipped: 'empty_message' });
  }

  const jid        = msgData?.key?.remoteJid || msgData?.remoteJid || '';
  const fromMe     = msgData?.key?.fromMe ?? false;
  const senderName = msgData?.pushName || msgData?.key?.participant || 'Unknown';

  // Skip messages sent by us
  if (fromMe) return res.status(200).json({ ok: true, skipped: 'from_me' });

  // Skip status broadcasts
  if (jid === 'status@broadcast') return res.status(200).json({ ok: true, skipped: 'status' });

  console.log(`[WA Webhook] Message from ${jid} (${senderName}): "${text.slice(0, 100)}"`);

  // ── Load group config ────────────────────────────────────────────────────
  const groupsRes = await sb('GET', 'whatsapp_groups', null, `?jid=eq.${encodeURIComponent(jid)}&enabled=eq.true`);
  const groups    = Array.isArray(groupsRes.data) ? groupsRes.data : [];

  if (groups.length === 0) {
    // Log unmapped message (for discovery in Settings UI)
    await sb('POST', 'whatsapp_task_log', [{
      jid, sender: senderName, message: text.slice(0, 500),
      status: 'unmapped', created_at: new Date().toISOString(),
    }], '');
    return res.status(200).json({ ok: true, skipped: 'no_group_mapping' });
  }

  const group      = groups[0];
  const clientName = group.client_name;
  const assignee   = group.assignee;

  // ── Analyze with Claude AI ──────────────────────────────────────────────
  const analysis = await analyzeWithClaude(text, clientName, senderName);

  // Log every message (task or not)
  const logEntry = {
    jid,
    sender:      senderName,
    client_name: clientName,
    message:     text.slice(0, 500),
    is_task:     !!analysis,
    task_title:  analysis?.task_title || null,
    confidence:  analysis?.confidence || null,
    reason:      analysis?.reason || null,
    status:      'analyzed',
    created_at:  new Date().toISOString(),
  };

  if (!analysis) {
    logEntry.status = 'not_task';
    await sb('POST', 'whatsapp_task_log', [logEntry], '');
    return res.status(200).json({ ok: true, task_detected: false, reason: 'not a task' });
  }

  // ── Create the task ─────────────────────────────────────────────────────
  const now     = new Date().toISOString();
  const dueDate = resolveDueDate(analysis.due_hint);

  const task = {
    title:       analysis.task_title,
    description: `Client: ${clientName}\n\nAuto-created from WhatsApp message by ${senderName}:\n"${text.slice(0, 300)}"`,
    assignee,
    priority:    analysis.priority || 'medium',
    category:    analysis.category || 'general',
    frequency:   'once',
    status:      'pending',
    due_date:    dueDate,
    created_at:  now,
    updated_at:  now,
  };

  const taskRes = await sb('POST', 'tasks', [task], '');
  const created = Array.isArray(taskRes.data) ? taskRes.data[0] : null;

  // Log with task id
  logEntry.status  = 'task_created';
  logEntry.task_id = created?.id || null;
  await sb('POST', 'whatsapp_task_log', [logEntry], '');

  // ── Send confirmation to the group ──────────────────────────────────────
  const priorityEmoji = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
  const confirmMsg = [
    `✅ *Task created automatically*`,
    ``,
    `📋 *${analysis.task_title}*`,
    `👤 Assigned to: ${assignee}`,
    `📅 Due: ${dueDate}`,
    `${priorityEmoji[analysis.priority] || '🟡'} Priority: ${analysis.priority}`,
    ``,
    `_Detected from your message. If this is incorrect, it can be deleted from the G6 dashboard._`,
  ].join('\n');

  await sendReply(jid, confirmMsg);

  console.log(`[WA Webhook] Task created: "${analysis.task_title}" for ${clientName} → ${assignee}`);

  return res.status(200).json({
    ok:         true,
    task_detected: true,
    task_title: analysis.task_title,
    assignee,
    client:     clientName,
    due_date:   dueDate,
    confidence: analysis.confidence,
  });
};
