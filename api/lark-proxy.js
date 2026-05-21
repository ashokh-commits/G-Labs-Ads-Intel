const crypto = require('crypto');

const LARK_BASE  = process.env.LARK_API_BASE || 'https://open.larksuite.com/open-apis';
const APP_ID     = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const APP_TOKEN  = process.env.LARK_APP_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';

const ZONES = [
  { id: 'pg',   name: 'Pasir Gudang', tableEnv: 'LARK_TABLE_PG' },
  { id: 'kl',   name: 'KL',           tableEnv: 'LARK_TABLE_KL' },
  { id: 'tlow', name: 'T-Low',        tableEnv: 'LARK_TABLE_TLOW' },
];

const PROGRESS_GROUPS = {
  converted:    ['Completed', 'Set Appointment'],
  good_quality: ['Responsive', 'Waiting Reply', 'Yet to set appt', 'Surveying', 'No resp after price', 'No resp before price'],
  bad_quality:  ['No Respond at all', 'No Respond after 1st message/price', 'Delete Message'],
  disqualified: ['SPAM/Job vacancy', 'Out of location', 'Language Problem', 'Another clinic', 'Pass to Other Branch'],
};

function getGroup(progress) {
  if (!progress) return 'good_quality';
  for (const [group, statuses] of Object.entries(PROGRESS_GROUPS)) {
    if (statuses.some(s => s.toLowerCase() === progress.toLowerCase())) return group;
  }
  return 'good_quality';
}

function verifyToken(token) {
  try {
    const [h,b,s] = token.split('.');
    const exp = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64')
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    if (s !== exp) return null;
    const p = JSON.parse(Buffer.from(b, 'base64').toString());
    if (Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

let tokenCache = { token: null, expiresAt: 0 };

async function getLarkToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const r    = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Lark auth invalid JSON: ${text.slice(0,100)}`); }
  if (data.code !== 0) throw new Error(`Lark auth failed (${data.code}): ${data.msg}`);
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + data.expire * 1000 };
  return tokenCache.token;
}

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

async function fetchTableRecords(larkToken, tableId) {
  const records  = [];
  let pageToken  = null;
  const MAX_PAGES = 6;
  let pageCount   = 0;

  do {
    const url = `${LARK_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`;
    const r   = await fetch(url, { headers: { 'Authorization': `Bearer ${larkToken}` } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Lark records invalid JSON: ${text.slice(0,100)}`); }
    if (data.code !== 0) throw new Error(`Lark records failed (${data.code}): ${data.msg}`);

    if (pageCount === 0) {
      console.log(`[Lark] Table ${tableId}: ${(data.data?.items||[]).length} items, fields:`, Object.keys(data.data?.items?.[0]?.fields || {}));
    }

    pageCount++;

    // Current month boundaries (Malaysia time, UTC+8)
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0,0,0,0);
    const todayEnd   = new Date(now);
    todayEnd.setHours(23,59,59,999);

    (data.data?.items || []).forEach(item => {
      const f = item.fields || {};
      const name      = extractText(f['Customer Name'] || f['Name'] || '');
      const platform  = extractText(f['Platform'] || '');
      const treatment = extractText(f['Treatment Requested'] || f['Treatment'] || '');
      const progress  = extractText(f['Progress'] || f['Status'] || '');
      const handler   = extractText(f['Handled By'] || f['Handler'] || '');
      const appointment = extractDate(f['Appointment Date'] || null);

      // Date column — lead entry date, used for month filtering
      const dateRaw = f['Date'] || f['date'] || f['Created Date'] || null;
      const leadDate = dateRaw ? new Date(typeof dateRaw === 'number' ? dateRaw : dateRaw) : null;

      // Filter: only include leads from current month
      if (leadDate) {
        if (leadDate < monthStart || leadDate > todayEnd) return;
      }

      if (!name && !progress && !platform) return;
      records.push({
        id: item.record_id, name, platform, treatment, progress,
        appointment, handler,
        date: leadDate ? leadDate.toISOString().split('T')[0] : null,
        group: getGroup(progress),
        createdAt: item.created_time || null,
      });
    });

    pageToken = (data.data?.has_more && pageCount < MAX_PAGES) ? data.data.page_token : null;
  } while (pageToken);

  return records;
}

function buildStats(all, zones) {
  const byGroup = { converted:0, good_quality:0, bad_quality:0, disqualified:0 };
  all.forEach(r => { if (byGroup[r.group] !== undefined) byGroup[r.group]++; });
  const byProgress={}, byPlatform={}, byTreatment={}, byHandler={};
  all.forEach(r => {
    const p=r.progress||'Unknown'; byProgress[p]=(byProgress[p]||0)+1;
    const pl=r.platform||'Unknown'; byPlatform[pl]=(byPlatform[pl]||0)+1;
    const t=r.treatment||'Unknown'; byTreatment[t]=(byTreatment[t]||0)+1;
    const h=r.handler||'Unassigned';
    if(!byHandler[h])byHandler[h]={total:0,converted:0};
    byHandler[h].total++;
    if(r.group==='converted')byHandler[h].converted++;
  });
  const byZone={};
  Object.entries(zones).forEach(([zoneId,zoneData])=>{
    const recs=zoneData.records||[];
    byZone[zoneId]={name:zoneData.name,total:recs.length,converted:recs.filter(r=>r.group==='converted').length,good_quality:recs.filter(r=>r.group==='good_quality').length,bad_quality:recs.filter(r=>r.group==='bad_quality').length,disqualified:recs.filter(r=>r.group==='disqualified').length};
  });
  const convertible=all.filter(r=>r.group!=='disqualified').length;
  const convRate=convertible>0?((byGroup.converted/convertible)*100).toFixed(1):'0.0';
  const today=new Date();today.setHours(0,0,0,0);
  const next7=new Date(today);next7.setDate(next7.getDate()+7);
  const upcoming=all.filter(r=>r.appointment&&new Date(r.appointment)>=today&&new Date(r.appointment)<=next7).sort((a,b)=>new Date(a.appointment)-new Date(b.appointment));
  return{byGroup,byProgress,byPlatform,byTreatment,byHandler,byZone,convRate,upcoming};
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (!verifyToken(token)) return res.status(401).json({ error: 'Invalid or expired session' });

  try {
    const larkToken = await getLarkToken();
    const zoneResults = await Promise.allSettled(
      ZONES.map(async zone => {
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
    zoneResults.forEach(r => {
      if (r.status === 'fulfilled') {
        result[r.value.zoneId] = { name: r.value.name, records: r.value.records, error: r.value.error };
      }
    });

    const allRecords = Object.values(result).flatMap(z => z.records || []);
    const stats      = buildStats(allRecords, result);

    return res.status(200).json({ zones: result, stats, total: allRecords.length });
  } catch(e) {
    console.error('[Lark] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
