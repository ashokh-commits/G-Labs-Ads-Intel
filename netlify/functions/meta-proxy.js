const crypto = require('crypto');

exports.handler = async (event) => {
  const META_TOKEN = process.env.META_ACCESS_TOKEN;
  const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
  const BASE = 'https://graph.facebook.com/v21.0';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'POST,OPTIONS'}, body:'' };
  }

  // Verify JWT
  function verifyToken(token) {
    try {
      const [h,b,s] = token.split('.');
      const exp = crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      if (s!==exp) return null;
      const p = JSON.parse(Buffer.from(b,'base64').toString());
      if (Date.now()>p.exp) return null;
      return p;
    } catch { return null; }
  }

  const token = (event.headers['authorization']||'').replace('Bearer ','').trim();
  if (!token) return { statusCode:401, headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}, body: JSON.stringify({error:'Authentication required'}) };
  const user = verifyToken(token);
  if (!user)  return { statusCode:401, headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}, body: JSON.stringify({error:'Invalid or expired session'}) };

  const { accountId, since, until } = JSON.parse(event.body || '{}');
  if (!accountId || !since || !until) return { statusCode:400, body: JSON.stringify({error:'Missing params'}) };

  // Client role — enforce account-level access server-side
  if (user.role === 'client') {
    const allowed = user.accounts || [];
    if (!allowed.includes(accountId)) {
      return { statusCode:403, headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}, body: JSON.stringify({error:'Access denied to this account'}) };
    }
  }

  // cost_per_result and actions come back as arrays — we flatten them server-side
  const fields = 'name,status,effective_status,campaign{name},insights{spend,impressions,reach,cpm,cpc,ctr,frequency,cost_per_result,actions,results}';

  const filtering = JSON.stringify([
    { field: 'impressions', operator: 'GREATER_THAN', value: '0' }
  ]);

  const timeRange = JSON.stringify({ since, until });

  const url = `${BASE}/act_${accountId}/ads`
    + `?fields=${encodeURIComponent(fields)}`
    + `&time_range=${encodeURIComponent(timeRange)}`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&limit=200`
    + `&access_token=${META_TOKEN}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();

    // Normalize cost_per_result: Meta returns it as [{action_type, value}]
    // Pick the first value (primary result) and expose as a plain string
    if (data.data) {
      data.data = data.data.map(ad => {
        const ins = ad.insights?.data?.[0];
        if (ins) {
          // cost_per_result: array → first value
          if (Array.isArray(ins.cost_per_result) && ins.cost_per_result.length > 0) {
            ins.cost_per_result = ins.cost_per_result[0].value || '0';
          } else if (typeof ins.cost_per_result !== 'string') {
            ins.cost_per_result = '0';
          }

          // results: array → first value (total result count)
          if (Array.isArray(ins.results) && ins.results.length > 0) {
            ins.results = ins.results[0].value || '0';
          }

          // actions: extract messaging_conversation_started and link_click
          if (Array.isArray(ins.actions)) {
            const msgAction = ins.actions.find(a =>
              a.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
              a.action_type === 'onsite_conversion.messaging_conversation_started'
            );
            const linkClick = ins.actions.find(a => a.action_type === 'link_click');
            ins.conversations = msgAction?.value || '0';
            ins.link_clicks   = linkClick?.value  || '0';
          }
        }
        return ad;
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
