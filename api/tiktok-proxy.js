/**
 * G6 Labs — TikTok Ads Proxy
 * Fetches ad-level insights from the TikTok Business API and returns them in the
 * SAME shape as api/meta-proxy.js, so the frontend loadAccount() mapping and all
 * render functions (renderOverview / renderAdIntel / renderHealth) work unchanged.
 *
 * POST body: { accountId, since, until }   (accountId = TikTok advertiser_id)
 *
 * Env vars:
 *   TIKTOK_ACCESS_TOKEN   — long-term access token from TikTok for Business
 *   JWT_SECRET            — shared auth secret (same as other proxies)
 *
 * Docs: https://business-api.tiktok.com/portal/docs?id=1740302848100353  (integrated report)
 */

const crypto = require('crypto');

const JWT_SECRET   = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';
const TIKTOK_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const BASE         = 'https://business-api.tiktok.com/open_api/v1.3';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

// Build a Meta-shaped ad object so the frontend treats TikTok exactly like Meta
function toMetaShape(row) {
  const m   = row.metrics || {};
  const dim = row.dimensions || {};
  const spend   = parseFloat(m.spend || 0);
  const impr    = parseInt(m.impressions || 0);
  const clicks  = parseInt(m.clicks || 0);
  const ctr     = parseFloat(m.ctr || 0);           // TikTok returns CTR as a percentage already
  const cpc     = parseFloat(m.cpc || 0);
  const cpm     = parseFloat(m.cpm || 0);
  const reach   = parseInt(m.reach || 0);
  const convs   = parseInt(m.conversion || 0);
  const cpa     = parseFloat(m.cost_per_conversion || 0);
  const results = convs;

  return {
    id:     dim.ad_id || m.ad_id || '',
    name:   m.ad_name || 'TikTok Ad',
    status: (m.operation_status || '').toLowerCase() === 'enable' ? 'ACTIVE' : 'PAUSED',
    effective_status: (m.operation_status || '').toLowerCase() === 'enable' ? 'ACTIVE' : 'PAUSED',
    campaign: { name: m.campaign_name || '' },
    insights: { data: [{
      spend:           String(spend),
      impressions:     String(impr),
      reach:           String(reach),
      cpm:             String(cpm),
      cpc:             String(cpc),
      ctr:             String(ctr),
      frequency:       '0',                    // TikTok has no frequency at ad level
      cost_per_result: String(cpa || (results > 0 ? spend / results : 0)),
      conversations:   String(convs),
      link_clicks:     String(clicks),
      results:         String(results),
    }] },
  };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST' && !req.body) {
    await new Promise(resolve => {
      let d = ''; req.on('data', c => { d += c; });
      req.on('end', () => { try { req.body = JSON.parse(d); } catch { req.body = {}; } resolve(); });
    });
  }

  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const user = verifyToken(token);
  if (!user)  return res.status(401).json({ error: 'Invalid or expired session' });

  const { accountId, since, until } = req.body || {};
  if (!accountId || !since || !until) return res.status(400).json({ error: 'Missing params' });

  // Client ACL — same pattern as meta-proxy
  if (user.role === 'client') {
    const allowed = user.accounts || [];
    if (!allowed.includes(accountId)) return res.status(403).json({ error: 'Access denied to this account' });
  }

  if (!TIKTOK_TOKEN) return res.status(500).json({ error: 'TIKTOK_ACCESS_TOKEN not configured' });

  // TikTok integrated report — ad-level, with names so we can group by campaign
  const params = new URLSearchParams({
    advertiser_id: accountId,
    report_type:   'BASIC',
    data_level:    'AUCTION_AD',
    start_date:    since,
    end_date:      until,
    page_size:     '200',
  });
  params.append('dimensions', JSON.stringify(['ad_id']));
  params.append('metrics', JSON.stringify([
    'ad_name', 'campaign_name', 'operation_status',
    'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm',
    'conversion', 'cost_per_conversion',
  ]));

  try {
    const url = `${BASE}/report/integrated/get/?${params.toString()}`;
    const r   = await fetch(url, { headers: { 'Access-Token': TIKTOK_TOKEN } });
    const j   = await r.json();

    if (j.code !== 0) {
      return res.status(502).json({ error: `TikTok API error: ${j.message || j.code}` });
    }

    const rows = j.data?.list || [];
    const data = rows.map(toMetaShape).filter(ad => {
      const ins = ad.insights.data[0];
      return parseFloat(ins.spend) > 0 || parseInt(ins.impressions) > 0;
    });

    return res.status(200).json({ data, platform: 'tiktok' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
