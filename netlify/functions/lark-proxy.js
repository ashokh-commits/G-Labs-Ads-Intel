/**
 * G6 Labs — Lark Bitable Proxy
 * Fetches leads from all 3 zone tables (PG, KL, T-Low)
 * Authenticates with Lark API using app credentials
 *
 * Required env variables:
 *   LARK_APP_ID         — from Lark Developer Console
 *   LARK_APP_SECRET     — from Lark Developer Console
 *   LARK_APP_TOKEN      — from Bitable URL
 *   LARK_TABLE_PG       — Table ID for Pasir Gudang
 *   LARK_TABLE_KL       — Table ID for KL
 *   LARK_TABLE_TLOW     — Table ID for T-Low
 */

const LARK_BASE    = process.env.LARK_API_BASE || 'https://open.larksuite.com/open-apis';
const APP_ID       = process.env.LARK_APP_ID;
const APP_SECRET   = process.env.LARK_APP_SECRET;
const APP_TOKEN    = process.env.LARK_APP_TOKEN;

const ZONES = [
  { id: 'pg',   name: 'Pasir Gudang', tableEnv: 'LARK_TABLE_PG' },
  { id: 'kl',   name: 'KL',           tableEnv: 'LARK_TABLE_KL' },
  { id: 'tlow', name: 'T-Low',        tableEnv: 'LARK_TABLE_TLOW' },
];

// Progress groupings
const PROGRESS_GROUPS = {
  converted:    ['Completed', 'Set Appointment'],
  good_quality: ['Responsive', 'Waiting Reply', 'Yet to set appt', 'Surveying', 'No resp after price', 'No resp before price'],
  bad_quality:  ['No Respond at all', 'No Respond after 1st message/price', 'Delete Message'],
  disqualified: ['SPAM/Job vacancy', 'Out of location', 'Language Problem', 'Another clinic', 'Pass to Other Branch'],
};

function getGroup(progress) {
  if (!progress) return 'active';
  for (const [group, statuses] of Object.entries(PROGRESS_GROUPS)) {
    if (statuses.some(s => s.toLowerCase() === progress.toLowerCase())) return group;
  }
  return 'active';
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

// ── GET LARK ACCESS TOKEN ──────────────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getLarkToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }
  const res  = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const text = await res.text();
  console.log('[Lark] Auth response:', text);
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error(`Lark auth returned invalid JSON: ${text.slice(0,200)}`); }
  if (data.code !== 0) throw new Error(`Lark auth failed (code ${data.code}): ${data.msg}`);
  tokenCache = {
    token:     data.tenant_access_token,
    expiresAt: Date.now() + data.expire * 1000,
  };
  return tokenCache.token;
}

// ── FETCH ALL RECORDS FROM A TABLE (handles pagination) ────────────────────
async function fetchTableRecords(larkToken, tableId) {
  const records = [];
  let pageToken = null;
  const MAX_PAGES = 4; // max 4 pages × 500 = 2000 records per zone
  let pageCount  = 0;

  do {
    const url = `${LARK_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`;
    const res  = await fetch(url, {
      headers: { 'Authorization': `Bearer ${larkToken}` },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { throw new Error(`Invalid JSON from Lark records API: ${text.slice(0,100)}`); }
    if (data.code !== 0) throw new Error(`Lark records failed (code ${data.code}): ${data.msg}`);

    // Log first page structure for debugging
    if (records.length === 0) {
      console.log('[Lark] First page response keys:', JSON.stringify(Object.keys(data)));
      console.log('[Lark] data.data keys:', JSON.stringify(Object.keys(data.data || {})));
      console.log('[Lark] items count:', (data.data?.items || []).length);
      if (data.data?.items?.[0]) {
        console.log('[Lark] First item fields:', JSON.stringify(Object.keys(data.data.items[0].fields || {})));
        console.log('[Lark] First item sample:', JSON.stringify(data.data.items[0]).slice(0, 500));
      }
    }

    pageCount++;

    (data.data?.items || []).forEach(item => {
      const f = item.fields || {};

      // Extract customer name — try multiple possible field names
      const name = extractText(
        f['Customer Name'] || f['customer name'] || f['Name'] || f['name'] || ''
      );

      // Extract platform
      const platform = extractText(
        f['Platform'] || f['platform'] || f['Source'] || ''
      );

      // Extract treatment
      const treatment = extractText(
        f['Treatment Requested'] || f['treatment requested'] ||
        f['Treatment'] || f['treatment'] || f['Tr'] || ''
      );

      // Extract progress
      const progress = extractText(
        f['Progress'] || f['progress'] || f['Status'] || f['status'] || ''
      );

      // Extract appointment date
      const appointment = extractDate(
        f['Appointment Date'] || f['appointment date'] ||
        f['Date'] || f['date'] || null
      );

      // Extract handler
      const handler = extractText(
        f['Handled By'] || f['handled by'] ||
        f['Handler'] || f['Assigned To'] || ''
      );

      // Skip records with no meaningful data
      if (!name && !progress && !platform) return;

      records.push({
        id:          item.record_id,
        name,
        platform,
        treatment,
        progress,
        appointment,
        handler,
        group:       getGroup(progress),
        createdAt:   item.created_time || null,
      });
    });

    pageToken = (data.data?.has_more && pageCount < MAX_PAGES) ? data.data.page_token : null;
  } while (pageToken);

  return records;
}

// ── FIELD EXTRACTORS ───────────────────────────────────────────────────────
function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map(v => v.text || v.value || v).join(', ').trim();
  if (typeof val === 'object' && val.text) return val.text.trim();
  return String(val).trim();
}

function extractDate(val) {
  if (!val) return null;
  if (typeof val === 'number') return new Date(val).toISOString().split('T')[0];
  if (typeof val === 'string') return val.split('T')[0];
  return null;
}

// ── MAIN HANDLER ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // Verify JWT
  const crypto2 = require('crypto');
  const JWT_SECRET2 = process.env.JWT_SECRET || 'change-this-secret';
  function verifyTok(token) {
    try {
      const [h,b,s] = token.split('.');
      const exp = crypto2.createHmac('sha256',JWT_SECRET2).update(`${h}.${b}`).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      if (s!==exp) return null;
      const p = JSON.parse(Buffer.from(b,'base64').toString());
      if (Date.now()>p.exp) return null;
      return p;
    } catch { return null; }
  }
  const tok = (event.headers['authorization']||'').replace('Bearer ','').trim();
  if (!tok) return { statusCode:401, headers:CORS, body: JSON.stringify({error:'Authentication required'}) };
  if (!verifyTok(tok)) return { statusCode:401, headers:CORS, body: JSON.stringify({error:'Invalid or expired session'}) };

  try {
    const larkToken = await getLarkToken();

    // Fetch all 3 zones IN PARALLEL — much faster, avoids timeout
    const zoneResults = await Promise.allSettled(
      ZONES.map(async (zone) => {
        const tableId = process.env[zone.tableEnv];
        if (!tableId) return { zoneId: zone.id, name: zone.name, records: [], error: 'Table ID not configured' };
        try {
          const records = await fetchTableRecords(larkToken, tableId);
          return { zoneId: zone.id, name: zone.name, records };
        } catch(e) {
          return { zoneId: zone.id, name: zone.name, records: [], error: e.message };
        }
      })
    );

    const result = {};
    zoneResults.forEach((r) => {
      if (r.status === 'fulfilled') {
        result[r.value.zoneId] = { name: r.value.name, records: r.value.records, error: r.value.error };
      }
    });

    // Build aggregate stats
    const allRecords = Object.values(result).flatMap(z => z.records);
    const stats = buildStats(allRecords, result);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ zones: result, stats, total: allRecords.length }),
    };

  } catch (e) {
    console.error('[Lark] Error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

// ── BUILD STATS ────────────────────────────────────────────────────────────
function buildStats(all, zones) {
  // By group
  const byGroup = { converted: 0, good_quality: 0, bad_quality: 0, disqualified: 0 };
  all.forEach(r => { if (byGroup[r.group] !== undefined) byGroup[r.group]++; });

  // By progress
  const byProgress = {};
  all.forEach(r => {
    const p = r.progress || 'Unknown';
    byProgress[p] = (byProgress[p] || 0) + 1;
  });

  // By platform
  const byPlatform = {};
  all.forEach(r => {
    const p = r.platform || 'Unknown';
    byPlatform[p] = (byPlatform[p] || 0) + 1;
  });

  // By treatment
  const byTreatment = {};
  all.forEach(r => {
    const t = r.treatment || 'Unknown';
    byTreatment[t] = (byTreatment[t] || 0) + 1;
  });

  // By handler
  const byHandler = {};
  all.forEach(r => {
    const h = r.handler || 'Unassigned';
    if (!byHandler[h]) byHandler[h] = { total: 0, converted: 0 };
    byHandler[h].total++;
    if (r.group === 'converted') byHandler[h].converted++;
  });

  // By zone — include good_quality and bad_quality
  const byZone = {};
  Object.entries(zones).forEach(([zoneId, zoneData]) => {
    const recs = zoneData.records || [];
    byZone[zoneId] = {
      name:         zoneData.name,
      total:        recs.length,
      converted:    recs.filter(r => r.group === 'converted').length,
      good_quality: recs.filter(r => r.group === 'good_quality').length,
      bad_quality:  recs.filter(r => r.group === 'bad_quality').length,
      disqualified: recs.filter(r => r.group === 'disqualified').length,
    };
  });

  // Conversion rate — exclude disqualified from denominator
  const convertible = all.filter(r => r.group !== 'disqualified').length;
  const convRate    = convertible > 0 ? ((byGroup.converted / convertible) * 100).toFixed(1) : '0.0';

  // Upcoming appointments (next 7 days)
  const today    = new Date(); today.setHours(0,0,0,0);
  const next7    = new Date(today); next7.setDate(next7.getDate() + 7);
  const upcoming = all
    .filter(r => r.appointment && new Date(r.appointment) >= today && new Date(r.appointment) <= next7)
    .sort((a,b) => new Date(a.appointment) - new Date(b.appointment));

  return { byGroup, byProgress, byPlatform, byTreatment, byHandler, byZone, convRate, upcoming };
}
