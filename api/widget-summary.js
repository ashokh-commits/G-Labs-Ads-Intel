/**
 * G6 Labs — Widget Summary (read-only)
 * Powers an iOS WidgetKit home-screen widget showing a rolling 7-day ads
 * performance snapshot (spend, leads, ROAS) for the i-Sihat client.
 *
 * Route:  GET /api/widget-summary?client=isihat
 * Auth:   header `x-widget-key` must match env var WIDGET_API_KEY (401 otherwise).
 *         This is a lightweight shared-secret, separate from the JWT system used
 *         by the dashboard — the widget has no user login.
 *
 * Env vars:
 *   WIDGET_API_KEY            — shared secret the widget sends as x-widget-key (required)
 *   ISIHAT_AVG_TREATMENT_VALUE — avg revenue per converted lead, MYR (default 300)
 *   META_ACCESS_TOKEN         — Meta Graph API token (already configured)
 *   LARK_APP_ID / LARK_APP_SECRET / LARK_APP_TOKEN — Lark Bitable creds (already configured)
 *   LARK_TABLE_PG / LARK_TABLE_KL / LARK_TABLE_TLOW — i-Sihat zone table IDs (fall back to known IDs)
 *
 * Caching: responds with Cache-Control: s-maxage=900 (15 min) so the WidgetKit
 *          timeline can poll without hitting Meta/Lark on every request.
 */

const BASE       = 'https://graph.facebook.com/v21.0';
const LARK_BASE  = process.env.LARK_API_BASE || 'https://open.larksuite.com/open-apis';
const META_TOKEN = process.env.META_ACCESS_TOKEN;

// ── i-Sihat data sources ────────────────────────────────────────────────────
// Meta-only today (TikTok not yet wired up for this client in the dashboard).
const ISIHAT_META_ACCOUNTS = ['854069203683598', '185825224320502'];

// i-Sihat Lark zone tables (env-driven, with documented fallbacks)
const ISIHAT_ZONES = [
  { id: 'pg',   name: 'Pasir Gudang', tableId: process.env.LARK_TABLE_PG   || 'tblJekn5JWY04kQ7' },
  { id: 'kl',   name: 'KL',           tableId: process.env.LARK_TABLE_KL   || 'tblrFgCTMEU0FJEE' },
  { id: 'tlow', name: 'T-Low',        tableId: process.env.LARK_TABLE_TLOW || 'tbl5PqzwTpZLNfbs' },
];

// Progress-status grouping — mirrors api/lark-proxy.js. `converted` = closed/booked.
const PROGRESS_GROUPS = {
  converted:    ['Completed', 'Set Appointment', 'Done', 'Closed', 'Joined', 'Member', 'Closing Date'],
  good_quality: ['Responsive', 'Waiting Reply', 'Yet to set appt', 'Surveying', 'No resp after price', 'No resp before price', 'Contacted', 'Interested', 'Follow up', 'Appointment set', 'Coming'],
  bad_quality:  ['No Respond at all', 'No Respond after 1st message/price', 'Delete Message', 'Not Reply', 'No Reply', 'Not Replied', 'No response', 'No Response', 'Not respond', 'Not Respond', 'No reply at all', 'Spam'],
  disqualified: ['SPAM/Job vacancy', 'Out of location', 'Language Problem', 'Another clinic', 'Pass to Other Branch', 'Not Interested', 'Cancel', 'Wrong number', 'Blacklisted', 'Job', 'Vacancy'],
};

function getGroup(progress) {
  if (!progress) return 'good_quality';
  const p = progress.toLowerCase();
  for (const [group, statuses] of Object.entries(PROGRESS_GROUPS)) {
    if (statuses.some(s => s.toLowerCase() === p)) return group;
  }
  if (p.includes('not reply') || p.includes('no reply') || p.includes('not respond') || p.includes('no respond') || p.includes('tidak') || p.includes('tak balas')) return 'bad_quality';
  if (p.includes('done') || p.includes('close') || p.includes('join') || p.includes('member') || p.includes('paid')) return 'converted';
  if (p.includes('cancel') || p.includes('spam') || p.includes('wrong') || p.includes('not interested')) return 'disqualified';
  return 'good_quality';
}

// ── Date helpers (Malaysia time, UTC+8, no DST) ─────────────────────────────
function nowMYT() { return new Date(Date.now() + 8 * 60 * 60 * 1000); }
function fmtDate(d) {
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}
// Rolling 7-day window: today-6 .. today (inclusive), in MYT calendar dates.
function sevenDayWindow() {
  const end = nowMYT();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { since: fmtDate(start), until: fmtDate(end) };
}
function nowIsoMYT() {
  // ISO timestamp with +08:00 offset
  const d = nowMYT();
  return fmtDate(d) + 'T' +
    String(d.getUTCHours()).padStart(2, '0') + ':' +
    String(d.getUTCMinutes()).padStart(2, '0') + ':' +
    String(d.getUTCSeconds()).padStart(2, '0') + '+08:00';
}

function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map(v => v.text || v.value || v).join(', ').trim();
  if (typeof val === 'object' && val.text) return val.text.trim();
  return String(val).trim();
}

// Convert a Lark date field to a YYYY-MM-DD calendar string (UTC basis, matching
// how lark-proxy reads Lark's ms timestamps).
function larkDateStr(raw) {
  let ms = null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') ms = raw;
  else if (typeof raw === 'string') { const p = Date.parse(raw); if (!isNaN(p)) ms = p; }
  else if (Array.isArray(raw) && raw[0]) ms = typeof raw[0] === 'number' ? raw[0] : Date.parse(raw[0]);
  if (ms === null || isNaN(ms)) return null;
  return new Date(ms).toISOString().split('T')[0];
}

// ── Meta: total spend across the i-Sihat accounts for the date range ────────
async function fetchMetaSpend(since, until) {
  if (!META_TOKEN) throw new Error('META_ACCESS_TOKEN not configured');
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  let total = 0;
  for (const acc of ISIHAT_META_ACCOUNTS) {
    const url = `${BASE}/act_${acc}/insights?fields=spend&time_range=${timeRange}&access_token=${META_TOKEN}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) throw new Error(`Meta act_${acc}: ${data.error.message}`);
    (data.data || []).forEach(row => { total += parseFloat(row.spend || 0); });
  }
  return total;
}

// ── Lark token (mirrors lark-proxy auth flow) ───────────────────────────────
async function getLarkToken() {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('LARK_APP_ID / LARK_APP_SECRET not configured');
  const r = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await r.json();
  if (data.code !== 0) throw new Error(`Lark auth failed (${data.code}): ${data.msg}`);
  return data.tenant_access_token;
}

// ── Lark: pull records from one zone table within the date window ────────────
async function fetchZoneLeads(larkToken, appToken, tableId, since, until) {
  let leads = 0, converted = 0;
  let pageToken = null, pages = 0;
  const MAX_PAGES = 20;
  do {
    const url = `${LARK_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${larkToken}` } });
    const data = await r.json();
    if (data.code !== 0) throw new Error(`Lark records failed (${data.code}): ${data.msg}`);
    pages++;
    (data.data?.items || []).forEach(item => {
      const f = item.fields || {};
      const dateStr = larkDateStr(f['Date'] || f['date'] || null);
      if (!dateStr || dateStr < since || dateStr > until) return; // outside 7-day window
      leads++;
      const progress = extractText(f['Progress'] || f['Status'] || '');
      if (getGroup(progress) === 'converted') converted++;
    });
    pageToken = (data.data?.has_more && pages < MAX_PAGES) ? data.data.page_token : null;
  } while (pageToken);
  return { leads, converted };
}

async function fetchLarkLeads(since, until) {
  const appToken = process.env.LARK_APP_TOKEN;
  if (!appToken) throw new Error('LARK_APP_TOKEN not configured');
  const larkToken = await getLarkToken();
  let leads = 0, converted = 0;
  for (const zone of ISIHAT_ZONES) {
    const z = await fetchZoneLeads(larkToken, appToken, zone.tableId, since, until);
    leads += z.leads;
    converted += z.converted;
  }
  return { leads, converted };
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-widget-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Shared-secret auth ────────────────────────────────────────────────────
  const expected = process.env.WIDGET_API_KEY;
  if (!expected) return res.status(500).json({ error: 'WIDGET_API_KEY not configured' });
  const provided = req.headers['x-widget-key'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Invalid or missing widget key' });
  }

  const client = (req.query?.client || 'isihat').toLowerCase();
  if (client !== 'isihat') {
    return res.status(400).json({ error: `Unsupported client "${client}" (only "isihat" is available)` });
  }

  const { since, until } = sevenDayWindow();
  const avgTreatmentValue = parseFloat(process.env.ISIHAT_AVG_TREATMENT_VALUE || '300');

  // Fetch both sources independently — one failure must not sink the response.
  const [metaR, larkR] = await Promise.allSettled([
    fetchMetaSpend(since, until),
    fetchLarkLeads(since, until),
  ]);

  const errors = [];
  let spend = null, leads = null, leadsConverted = null;

  if (metaR.status === 'fulfilled') spend = metaR.value;
  else errors.push({ source: 'meta', message: metaR.reason?.message || String(metaR.reason) });

  if (larkR.status === 'fulfilled') { leads = larkR.value.leads; leadsConverted = larkR.value.converted; }
  else errors.push({ source: 'lark', message: larkR.reason?.message || String(larkR.reason) });

  // ROAS estimate: (converted leads × avg treatment value) / spend.
  let roas = null;
  if (spend !== null && spend > 0 && leadsConverted !== null) {
    roas = (leadsConverted * avgTreatmentValue) / spend;
  } else if (spend === 0 && leadsConverted !== null) {
    roas = 0;
  }

  const body = {
    client: 'isihat',
    period: { start: since, end: until, tz: 'Asia/Kuala_Lumpur' },
    spend_myr: spend !== null ? Math.round(spend * 100) / 100 : null,
    spend_source: 'meta',
    leads: leads,
    leads_converted: leadsConverted,
    roas: roas !== null ? Math.round(roas * 10) / 10 : null,
    roas_estimated: true,
    avg_treatment_value: avgTreatmentValue,
    updated_at: nowIsoMYT(),
  };

  if (errors.length > 0) { body.partial = true; body.errors = errors; }

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=60');
  return res.status(200).json(body);
};
