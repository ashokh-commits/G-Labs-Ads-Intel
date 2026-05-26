/**
 * G6 Labs — Meta Ads Historical Backfill
 * POST /api/meta-backfill
 *
 * Body: { accountId, since, until }
 * Fetches daily ad-level insights from Meta Graph API v21.0
 * and upserts each ad×day row into the `ad_snapshots` Supabase table.
 *
 * Auth: admin JWT required (Authorization: Bearer <token>)
 * Returns: { ok, saved, records, message }
 */

const crypto = require('crypto');

const META_TOKEN   = process.env.META_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET   = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function verifyToken(token) {
  try {
    const [h, b, s] = token.split('.');
    const exp = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    if (s !== exp) return null;
    const p = JSON.parse(Buffer.from(b, 'base64').toString());
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

/** Parse a Meta API value that may be a number, string, or [{action_type, value}] array */
function parseMetaNum(val) {
  if (!val) return 0;
  if (Array.isArray(val)) {
    const first = val.find(x => x.value && parseFloat(x.value) > 0);
    return first ? parseFloat(first.value) : 0;
  }
  return parseFloat(val) || 0;
}

/** Extract conversation count from Meta actions array */
function extractConversations(actions) {
  if (!Array.isArray(actions)) return 0;
  const conv = actions.find(a =>
    a.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
    a.action_type === 'messaging_first_reply' ||
    (a.action_type || '').includes('messaging_conversation')
  );
  return parseInt(conv?.value || 0);
}

/** Extract results count from Meta results array or fallback */
function extractResults(resultsField, conversations) {
  if (Array.isArray(resultsField)) {
    const first = resultsField.find(x => x.value && parseInt(x.value) > 0);
    return first ? parseInt(first.value) : conversations;
  }
  const n = parseInt(resultsField || 0);
  return n > 0 ? n : conversations;
}

/** Upsert rows to Supabase ad_snapshots in chunks of 200 */
async function sbUpsert(rows) {
  if (!rows.length) return { saved: 0 };
  const CHUNK = 200;
  let saved = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ad_snapshots?on_conflict=account_id,ad_id,date`,
      {
        method:  'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(chunk),
      }
    );
    if (r.ok) {
      saved += chunk.length;
    } else {
      const err = await r.text();
      console.error('[Backfill] Supabase upsert error:', err.slice(0, 300));
    }
  }
  return { saved };
}

// ── Main handler ──────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Auth required' });
  const user = verifyToken(token);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  if (!META_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing env vars (META_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY)' });
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  const body = await parseBody(req);
  const { accountId, since, until } = body;

  if (!accountId || !since || !until) {
    return res.status(400).json({ error: 'accountId, since, until are required' });
  }

  console.log(`[Backfill] Starting: act_${accountId} from ${since} to ${until}`);

  try {
    const rows = [];

    // ── Meta API: /insights with level=ad and time_increment=1 ─────────────
    // This returns one row per ad per day in a flat list — perfect for storage.
    const fields = [
      'ad_id',
      'ad_name',
      'campaign_name',
      'date_start',
      'spend',
      'impressions',
      'reach',
      'inline_link_clicks',
      'cpm',
      'cpc',
      'ctr',
      'frequency',
      'cost_per_result',
      'actions',
      'results',
    ].join(',');

    const timeRange = JSON.stringify({ since, until });

    let url = `https://graph.facebook.com/v21.0/act_${accountId}/insights` +
      `?level=ad` +
      `&fields=${encodeURIComponent(fields)}` +
      `&time_range=${encodeURIComponent(timeRange)}` +
      `&time_increment=1` +
      `&limit=500` +
      `&access_token=${META_TOKEN}`;

    let pageCount = 0;
    const MAX_PAGES = 20; // safety cap against runaway pagination

    while (url && pageCount < MAX_PAGES) {
      pageCount++;
      const r    = await fetch(url);
      const json = await r.json();

      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }

      (json.data || []).forEach(row => {
        const spend  = parseFloat(row.spend || 0);
        const impr   = parseInt(row.impressions || 0);
        const clicks = parseInt(row.inline_link_clicks || 0);
        const convs  = extractConversations(row.actions);
        const res    = extractResults(row.results, convs);
        const cpr    = parseMetaNum(row.cost_per_result);
        const cpl    = cpr > 0 ? cpr : (res > 0 ? spend / res : (convs > 0 ? spend / convs : 0));

        rows.push({
          account_id:    accountId,
          ad_id:         row.ad_id,
          ad_name:       row.ad_name || '',
          campaign_name: row.campaign_name || '',
          date:          row.date_start,
          spend:         spend.toFixed(2),
          impressions:   impr,
          reach:         parseInt(row.reach || 0),
          clicks,
          ctr:           parseFloat(row.ctr || 0).toFixed(4),
          cpm:           parseFloat(row.cpm || 0).toFixed(2),
          cpc:           parseFloat(row.cpc || 0).toFixed(2),
          frequency:     parseFloat(row.frequency || 0).toFixed(2),
          results:       res,
          conversations: convs,
          cpl:           cpl.toFixed(2),
        });
      });

      url = json.paging?.next || null;
    }

    console.log(`[Backfill] Fetched ${rows.length} rows, upserting to Supabase...`);
    const { saved } = await sbUpsert(rows);
    console.log(`[Backfill] Done: ${saved} rows saved for act_${accountId} (${since} → ${until})`);

    return res.status(200).json({
      ok:      true,
      records: rows.length,
      saved,
      message: `Saved ${saved} ad×day records for ${since} → ${until}`,
    });

  } catch (e) {
    console.error('[Backfill error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
