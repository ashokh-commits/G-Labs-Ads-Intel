/**
 * G6 Labs — Daily WhatsApp Summary
 * Cron endpoint. Computes month-to-date + yesterday metrics for each account
 * and sends a formatted summary to a WhatsApp group via Evolution API.
 *
 * Env vars required:
 *   META_ACCESS_TOKEN        — Meta Graph API token (already configured)
 *   EVOLUTION_API_URL        — e.g. https://evo.yourserver.com
 *   EVOLUTION_API_KEY        — Evolution API global/instance key
 *   EVOLUTION_INSTANCE       — instance name (e.g. g6labs)
 *   EVOLUTION_WA_GROUP       — recipient JID (group: 1203...@g.us  ·  individual: 60123...@s.whatsapp.net)
 * Optional:
 *   SUMMARY_THRESHOLD_CPL / _CTR / _FREQ — alert thresholds (defaults 15 / 0.5 / 3)
 *   CRON_SECRET              — if set, request must include ?key=<CRON_SECRET> or matching Bearer
 */

const BASE = 'https://graph.facebook.com/v21.0';
const META_TOKEN = process.env.META_ACCESS_TOKEN;

const EVO_URL      = process.env.EVOLUTION_API_URL;
const EVO_KEY      = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
const EVO_GROUP    = process.env.EVOLUTION_WA_GROUP;

const THRESHOLDS = {
  CPL:  parseFloat(process.env.SUMMARY_THRESHOLD_CPL || process.env.THRESHOLD_CPL || '15'),
  CTR:  parseFloat(process.env.SUMMARY_THRESHOLD_CTR || process.env.THRESHOLD_CTR || '0.5'),
  FREQ: parseFloat(process.env.SUMMARY_THRESHOLD_FREQ || process.env.THRESHOLD_FREQ || '3'),
};

// Accounts to include in the daily summary (Meta only — TikTok/Google added later)
const ACCOUNTS = [
  { id: '854069203683598',  name: 'I-Sihat Dental Care 2' },
  { id: '185825224320502',  name: 'I-Sihat Dental Care' },
  { id: '523654495274543',  name: 'Ang Dental' },
  { id: '429121129294808',  name: 'Toothland Dental' },
  { id: '548718067784065',  name: 'Putih Dental' },
  { id: '5841452755981834', name: 'Smile Borneo' },
  { id: '1027194858744741', name: 'Purple Antz' },
  { id: '509470387773096',  name: 'SVASIKA' },
];

// ── Date helpers (Malaysia time UTC+8) ────────────────────────────────────
function nowMYT(){return new Date(Date.now()+8*60*60*1000);}
function fmtDate(d){return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');}
function monthStart(){const d=nowMYT();return fmtDate(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)));}
function yesterday(){const d=nowMYT();d.setUTCDate(d.getUTCDate()-1);return fmtDate(d);}
function rm(v){const n=parseFloat(v)||0;return 'RM '+n.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2});}
function todayLabel(){return new Date().toLocaleDateString('en-MY',{timeZone:'Asia/Kuala_Lumpur',weekday:'long',day:'numeric',month:'long',year:'numeric'});}
function ydLabel(){const d=new Date();d.setDate(d.getDate()-1);return d.toLocaleDateString('en-MY',{timeZone:'Asia/Kuala_Lumpur',weekday:'long',day:'numeric',month:'long'});}
function monthLabel(){return new Date().toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',month:'long',year:'numeric'});}

// ── Fetch ads from Meta for a date range and aggregate ─────────────────────
async function fetchAggregate(accountId, since, until) {
  const fields = 'name,status,effective_status,insights{spend,impressions,ctr,frequency,cost_per_result,actions,results}';
  const filtering = JSON.stringify([{ field:'impressions', operator:'GREATER_THAN', value:'0' }]);
  const url = `${BASE}/act_${accountId}/ads?fields=${encodeURIComponent(fields)}`
    + `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    + `&filtering=${encodeURIComponent(filtering)}&limit=300&access_token=${META_TOKEN}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);

  let spend = 0, impr = 0, clicks = 0, leads = 0, activeCount = 0, alerts = 0, warns = 0;
  (data.data || []).forEach(ad => {
    const ins = ad.insights?.data?.[0] || {};
    const sp  = parseFloat(ins.spend || 0);
    const im  = parseInt(ins.impressions || 0);
    const ctr = parseFloat(ins.ctr || 0);
    const freq= parseFloat(ins.frequency || 0);
    let convs = 0, lc = 0;
    if (Array.isArray(ins.actions)) {
      const msg = ins.actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d' || a.action_type === 'onsite_conversion.messaging_conversation_started');
      const link= ins.actions.find(a => a.action_type === 'link_click');
      convs = parseInt(msg?.value || 0);
      lc    = parseInt(link?.value || 0);
    }
    let res = parseInt(ins.results || 0) || convs;
    let cpr = 0;
    if (Array.isArray(ins.cost_per_result) && ins.cost_per_result[0]) cpr = parseFloat(ins.cost_per_result[0].value || 0);
    else cpr = parseFloat(ins.cost_per_result || 0);
    if (cpr === 0 && res > 0) cpr = sp / res;

    const isActive = (ad.effective_status || ad.status || '').toLowerCase() === 'active';
    if (sp > 0 || im > 0) {
      spend += sp; impr += im; clicks += lc; leads += res;
      if (isActive) {
        activeCount++;
        if (cpr > 0 && cpr > THRESHOLDS.CPL) alerts++;
        if (im > 500 && ctr > 0 && ctr < THRESHOLDS.CTR) warns++;
        if (freq > THRESHOLDS.FREQ) warns++;
      }
    }
  });

  const ctr = impr > 0 ? (clicks / impr * 100) : 0;
  const cpl = leads > 0 ? (spend / leads) : 0;
  return { spend, impr, clicks, leads, ctr, cpl, activeCount, alerts, warns };
}

// ── Send a text message via Evolution API ──────────────────────────────────
async function sendWhatsApp(text) {
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE || !EVO_GROUP) {
    console.warn('[Summary] Evolution API not configured — skipping WhatsApp send');
    return { skipped: true };
  }
  const endpoint = `${EVO_URL.replace(/\/$/, '')}/message/sendText/${EVO_INSTANCE}`;
  const r = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
    body:    JSON.stringify({ number: EVO_GROUP, text }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('[Summary] Evolution send failed:', r.status, JSON.stringify(out).slice(0, 200)); return { ok: false, status: r.status }; }
  return { ok: true };
}

// ── Build the per-account summary text block ───────────────────────────────
function buildAccountBlock(name, mtd, yd) {
  const lines = [
    `📊 *${name}*`,
    `📆 MTD (${monthLabel()}): 💰 ${rm(mtd.spend)} · 📞 ${mtd.leads} leads · CTR ${mtd.ctr.toFixed(2)}% · CPL ${mtd.cpl > 0 ? rm(mtd.cpl) : '—'}`,
    `📅 Yesterday: 💰 ${rm(yd.spend)} · 📞 ${yd.leads} leads`,
  ];
  if (mtd.alerts > 0 || mtd.warns > 0) {
    lines.push(`${mtd.alerts > 0 ? '🔴' : '🟡'} ${mtd.alerts} alert${mtd.alerts !== 1 ? 's' : ''} · ${mtd.warns} warning${mtd.warns !== 1 ? 's' : ''}`);
  }
  return lines.join('\n');
}

// ── Main handler ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Optional shared-secret guard
  if (process.env.CRON_SECRET) {
    const key = req.query?.key || (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (key !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!META_TOKEN) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  const mtdSince = monthStart(), mtdUntil = yesterday();
  const yStr     = yesterday();

  // Compute MTD spend total across all accounts for the header
  const blocks = [];
  let grandSpend = 0, grandLeads = 0, ydSpend = 0, ydLeads = 0, failures = 0;

  for (const acc of ACCOUNTS) {
    try {
      const [mtd, yd] = await Promise.all([
        fetchAggregate(acc.id, mtdSince, mtdUntil),
        fetchAggregate(acc.id, yStr, yStr),
      ]);
      grandSpend += mtd.spend; grandLeads += mtd.leads;
      ydSpend    += yd.spend;  ydLeads    += yd.leads;
      blocks.push(buildAccountBlock(acc.name, mtd, yd));
    } catch (e) {
      console.error(`[Summary] ${acc.name} failed:`, e.message);
      failures++;
    }
  }

  const header = [
    `🟠 *G6 Labs — Daily Ads Summary*`,
    `📅 ${todayLabel()}`,
    ``,
    `*🏢 ALL ACCOUNTS — MTD (${monthLabel()})*`,
    `💰 Total Spend: ${rm(grandSpend)}`,
    `📞 Total Leads: ${grandLeads.toLocaleString()}`,
    `📅 Yesterday (${ydLabel()}): 💰 ${rm(ydSpend)} · 📞 ${ydLeads} leads`,
    ``,
    `━━━━━━━━━━━━━━━`,
    ``,
  ].join('\n');

  const fullMessage = header + blocks.join('\n\n') + '\n\n— G6 Labs Ads Intelligence';

  const sendResult = await sendWhatsApp(fullMessage);

  return res.status(200).json({
    accounts: ACCOUNTS.length,
    failures,
    grandSpend: grandSpend.toFixed(2),
    grandLeads,
    whatsapp: sendResult,
    preview: fullMessage,
  });
};
