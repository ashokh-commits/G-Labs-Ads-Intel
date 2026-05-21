/**
 * G6 Labs — Google Analytics GA4 Proxy
 * Uses API Key — no service account needed
 *
 * Required env vars:
 *   GA4_PROPERTY_ID  — format: "properties/123456789"
 *   GA4_API_KEY      — from Google Cloud Console → Credentials → API Key
 */

const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';

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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function runReport(propertyId, apiKey, body) {
  const url = `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport?key=${apiKey}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

function parseRows(report) {
  if (!report?.rows) return [];
  const dimH = report.dimensionHeaders?.map(h => h.name) || [];
  const metH = report.metricHeaders?.map(h => h.name)   || [];
  return report.rows.map(row => {
    const obj = {};
    (row.dimensionValues || []).forEach((v,i) => { obj[dimH[i]] = v.value; });
    (row.metricValues   || []).forEach((v,i) => { obj[metH[i]] = v.value; });
    return obj;
  });
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (!verifyToken(token)) return res.status(401).json({ error: 'Invalid or expired session' });

  const propertyId = process.env.GA4_PROPERTY_ID;
  const apiKey     = process.env.GA4_API_KEY;

  if (!propertyId) return res.status(500).json({ error: 'GA4_PROPERTY_ID not set in Vercel env vars' });
  if (!apiKey)     return res.status(500).json({ error: 'GA4_API_KEY not set in Vercel env vars' });

  // Current month date range
  const now   = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const end   = 'today';

  try {
    const [overview, topPages, traffic, countries, devices, daily] = await Promise.all([

      // Overview KPIs
      runReport(propertyId, apiKey, {
        dateRanges: [{ startDate: start, endDate: end }],
        metrics: [
          { name: 'sessions' },
          { name: 'activeUsers' },
          { name: 'newUsers' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'screenPageViews' },
          { name: 'conversions' },
        ],
      }),

      // Top pages
      runReport(propertyId, apiKey, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'bounceRate' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      }),

      // Traffic sources
      runReport(propertyId, apiKey, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'conversions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      }),

      // Countries
      runReport(propertyId, apiKey, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10,
      }),

      // Devices
      runReport(propertyId, apiKey, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      }),

      // Daily trend last 30 days
      runReport(propertyId, apiKey, {
        dateRanges: [{ startDate: '30daysAgo', endDate: end }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
      }),
    ]);

    const ovRow = overview.rows?.[0];
    const metrics = ovRow ? {
      sessions:    ovRow.metricValues[0]?.value || '0',
      users:       ovRow.metricValues[1]?.value || '0',
      newUsers:    ovRow.metricValues[2]?.value || '0',
      bounceRate:  (parseFloat(ovRow.metricValues[3]?.value || 0) * 100).toFixed(1),
      avgDuration: parseFloat(ovRow.metricValues[4]?.value || 0).toFixed(0),
      pageviews:   ovRow.metricValues[5]?.value || '0',
      conversions: ovRow.metricValues[6]?.value || '0',
    } : { sessions:'0', users:'0', newUsers:'0', bounceRate:'0', avgDuration:'0', pageviews:'0', conversions:'0' };

    return res.status(200).json({
      period:    `${start} → today`,
      metrics,
      topPages:  parseRows(topPages),
      traffic:   parseRows(traffic),
      countries: parseRows(countries),
      devices:   parseRows(devices),
      daily:     parseRows(daily),
    });

  } catch(e) {
    console.error('[GA4] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
