/**
 * G6 Labs — Google Ads Proxy
 * Fetches ad-level metrics via the Google Ads API (GAQL) and returns them in the
 * SAME shape as api/meta-proxy.js, so the frontend works unchanged.
 *
 * POST body: { accountId, since, until }   (accountId = 10-digit Google customer ID, no dashes)
 *
 * Env vars:
 *   GOOGLE_DEVELOPER_TOKEN   — Google Ads API developer token
 *   GOOGLE_CLIENT_ID         — OAuth2 client ID
 *   GOOGLE_CLIENT_SECRET     — OAuth2 client secret
 *   GOOGLE_REFRESH_TOKEN     — OAuth2 refresh token for the Ads account
 *   GOOGLE_LOGIN_CUSTOMER_ID — (optional) manager/MCC customer ID, digits only
 *   JWT_SECRET               — shared auth secret (same as other proxies)
 *
 * Docs: https://developers.google.com/google-ads/api/docs/start
 */

const crypto = require('crypto');

const JWT_SECRET   = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';
const DEV_TOKEN    = process.env.GOOGLE_DEVELOPER_TOKEN;
const CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET= process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN= process.env.GOOGLE_REFRESH_TOKEN;
const LOGIN_CID    = (process.env.GOOGLE_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
const API_VERSION  = 'v17';

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

// Exchange refresh token → short-lived access token
async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }).toString(),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google OAuth refresh failed: ' + (j.error_description || j.error || 'unknown'));
  return j.access_token;
}

// Convert one GAQL result row to a Meta-shaped ad object
function toMetaShape(row) {
  const ad   = row.adGroupAd || {};
  const adObj= ad.ad || {};
  const camp = row.campaign || {};
  const m    = row.metrics || {};

  const spend   = (parseInt(m.costMicros || 0)) / 1e6;
  const impr    = parseInt(m.impressions || 0);
  const clicks  = parseInt(m.clicks || 0);
  const ctr     = (parseFloat(m.ctr || 0)) * 100;          // Google CTR is a fraction
  const cpc     = (parseInt(m.averageCpc || 0)) / 1e6;
  const cpm     = (parseInt(m.averageCpm || 0)) / 1e6;
  const convs   = parseFloat(m.conversions || 0);
  const cpa     = (parseInt(m.costPerConversion || 0)) / 1e6;
  const results = Math.round(convs);
  const status  = (ad.status || '').toUpperCase() === 'ENABLED' ? 'ACTIVE' : 'PAUSED';

  return {
    id:     adObj.id || '',
    name:   adObj.name || (adObj.responsiveSearchAd?.headlines?.[0]?.text) || `Ad ${adObj.id || ''}`,
    status,
    effective_status: status,
    campaign: { name: camp.name || '' },
    insights: { data: [{
      spend:           String(spend),
      impressions:     String(impr),
      reach:           '0',                     // Google Ads API has no reach at ad level
      cpm:             String(cpm),
      cpc:             String(cpc),
      ctr:             String(ctr),
      frequency:       '0',
      cost_per_result: String(cpa || (results > 0 ? spend / results : 0)),
      conversations:   String(results),
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

  if (user.role === 'client') {
    const allowed = user.accounts || [];
    if (!allowed.includes(accountId)) return res.status(403).json({ error: 'Access denied to this account' });
  }

  if (!DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    return res.status(500).json({ error: 'Google Ads API credentials not configured' });
  }

  const customerId = String(accountId).replace(/-/g, '');
  const query = `
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.status,
      campaign.name,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.average_cpm,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM ad_group_ad
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `.trim();

  try {
    const accessToken = await getAccessToken();
    const headers = {
      'Authorization':   `Bearer ${accessToken}`,
      'developer-token': DEV_TOKEN,
      'Content-Type':    'application/json',
    };
    if (LOGIN_CID) headers['login-customer-id'] = LOGIN_CID;

    const r = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ query }),
    });
    const j = await r.json();

    if (!r.ok) {
      const msg = j?.error?.message || j?.[0]?.error?.message || JSON.stringify(j).slice(0, 200);
      return res.status(502).json({ error: `Google Ads API error: ${msg}` });
    }

    const rows = j.results || [];
    const data = rows.map(toMetaShape).filter(ad => {
      const ins = ad.insights.data[0];
      return parseFloat(ins.spend) > 0 || parseInt(ins.impressions) > 0;
    });

    return res.status(200).json({ data, platform: 'google' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
