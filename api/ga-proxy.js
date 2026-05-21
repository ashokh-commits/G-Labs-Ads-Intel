/**
 * G6 Labs — Google Analytics GA4 Proxy
 * Fetches key metrics from GA4 Data API
 *
 * Required env vars:
 *   GA4_PROPERTY_ID        — e.g. "properties/123456789"
 *   GA4_SERVICE_ACCOUNT_KEY — JSON string of service account credentials
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

// ── Google OAuth2 token using service account ─────────────────────────────
let gaTokenCache = { token: null, expiresAt: 0 };

async function getGAToken() {
  if (gaTokenCache.token && Date.now() < gaTokenCache.expiresAt - 60000) return gaTokenCache.token;

  const keyJson = process.env.GA4_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GA4_SERVICE_ACCOUNT_KEY not set');

  const key = JSON.parse(keyJson);
  const now  = Math.floor(Date.now() / 1000);

  // Build JWT for Google OAuth2
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   key.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).toString('base64url');

  const signInput = `${header}.${payload}`;

  // Sign with RS256
  const privateKey = crypto.createPrivateKey(key.private_key);
  const sig = crypto.sign('sha256', Buffer.from(signInput), privateKey).toString('base64url');
  const jwt = `${signInput}.${sig}`;

  // Exchange for access token
  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (data.error) throw new Error(`GA4 auth failed: ${data.error_description || data.error}`);

  gaTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return gaTokenCache.token;
}

// ── Run GA4 report ─────────────────────────────────────────────────────────
async function runReport(gaToken, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${gaToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(`GA4 report failed: ${data.error.message}`);
  return data;
}

function parseRows(report) {
  if (!report?.rows) return [];
  const dimHeaders = report.dimensionHeaders?.map(h => h.name) || [];
  const metHeaders = report.metricHeaders?.map(h => h.name) || [];
  return report.rows.map(row => {
    const obj = {};
    (row.dimensionValues || []).forEach((v,i) => { obj[dimHeaders[i]] = v.value; });
    (row.metricValues   || []).forEach((v,i) => { obj[metHeaders[i]] = v.value; });
    return obj;
  });
}

// ── HANDLER ───────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (!verifyToken(token)) return res.status(401).json({ error: 'Invalid or expired session' });

  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) return res.status(500).json({ error: 'GA4_PROPERTY_ID not set' });

  try {
    const gaToken = await getGAToken();

    // Date range: current month
    const now   = new Date();
    const start = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const end   = 'today';

    // Run all reports in parallel
    const [overview, topPages, traffic, countries, devices, dailyTrend] = await Promise.all([

      // Overview — sessions, users, bounce rate, avg session duration, pageviews
      runReport(gaToken, propertyId, {
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
      runReport(gaToken, propertyId, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'bounceRate' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      }),

      // Traffic sources
      runReport(gaToken, propertyId, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'conversions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      }),

      // Countries
      runReport(gaToken, propertyId, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10,
      }),

      // Devices
      runReport(gaToken, propertyId, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      }),

      // Daily trend (last 30 days)
      runReport(gaToken, propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: end }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
      }),
    ]);

    // Parse overview metrics
    const ovRow = overview.rows?.[0];
    const metrics = ovRow ? {
      sessions:    ovRow.metricValues[0]?.value || '0',
      users:       ovRow.metricValues[1]?.value || '0',
      newUsers:    ovRow.metricValues[2]?.value || '0',
      bounceRate:  (parseFloat(ovRow.metricValues[3]?.value || 0) * 100).toFixed(1),
      avgDuration: parseFloat(ovRow.metricValues[4]?.value || 0).toFixed(0),
      pageviews:   ovRow.metricValues[5]?.value || '0',
      conversions: ovRow.metricValues[6]?.value || '0',
    } : {};

    return res.status(200).json({
      period:    `${start} → ${end}`,
      metrics,
      topPages:  parseRows(topPages),
      traffic:   parseRows(traffic),
      countries: parseRows(countries),
      devices:   parseRows(devices),
      daily:     parseRows(dailyTrend),
    });

  } catch(e) {
    console.error('[GA4] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
