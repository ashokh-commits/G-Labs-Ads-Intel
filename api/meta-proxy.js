const crypto = require('crypto');

const BASE       = 'https://graph.facebook.com/v21.0';
const JWT_SECRET = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';

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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body for Vercel
  if (req.method === 'POST' && !req.body) {
    await new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { req.body = JSON.parse(data); } catch { req.body = {}; }
        resolve();
      });
    });
  }

  // Auth
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const user = verifyToken(token);
  if (!user)  return res.status(401).json({ error: 'Invalid or expired session' });

  const { accountId, since, until } = req.body || {};
  if (!accountId || !since || !until) return res.status(400).json({ error: 'Missing params' });

  // Client account access control
  if (user.role === 'client') {
    const allowed = user.accounts || [];
    if (!allowed.includes(accountId)) {
      return res.status(403).json({ error: 'Access denied to this account' });
    }
  }

  const META_TOKEN = process.env.META_ACCESS_TOKEN;
  const fields = 'name,status,effective_status,campaign{name},insights{spend,impressions,reach,cpm,cpc,ctr,frequency,cost_per_result,actions,results}';
  const filtering = JSON.stringify([{ field: 'impressions', operator: 'GREATER_THAN', value: '0' }]);
  const timeRange = JSON.stringify({ since, until });

  const url = `${BASE}/act_${accountId}/ads`
    + `?fields=${encodeURIComponent(fields)}`
    + `&time_range=${encodeURIComponent(timeRange)}`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&limit=200`
    + `&access_token=${META_TOKEN}`;

  try {
    const apiRes = await fetch(url);
    const data   = await apiRes.json();

    if (data.data) {
      data.data = data.data.map(ad => {
        const ins = ad.insights?.data?.[0];
        if (ins) {
          if (Array.isArray(ins.cost_per_result) && ins.cost_per_result.length > 0) {
            ins.cost_per_result = ins.cost_per_result[0].value || '0';
          } else if (typeof ins.cost_per_result !== 'string') {
            ins.cost_per_result = '0';
          }
          if (Array.isArray(ins.results) && ins.results.length > 0) {
            ins.results = ins.results[0].value || '0';
          }
          if (Array.isArray(ins.actions)) {
            const msg = ins.actions.find(a =>
              a.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
              a.action_type === 'onsite_conversion.messaging_conversation_started'
            );
            const lc = ins.actions.find(a => a.action_type === 'link_click');
            ins.conversations = msg?.value || '0';
            ins.link_clicks   = lc?.value  || '0';
          }
        }
        return ad;
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
