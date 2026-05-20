const crypto = require('crypto');

const JWT_SECRET      = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';
const MAX_ATTEMPTS    = 5;
const LOCKOUT_MINUTES = 15;
const SESSION_HOURS   = 4;

const USERS = [
  {
    userId:       'ashokh',
    name:         'Ashokh',
    passwordHash: '14e520cb3361809278f3278d6921f70d15935b19c312d5fc459e8b02923544ed',
    role:         'admin',
    accounts:     ['*'],
  },
  {
    userId:       'nanda',
    name:         'Nanda',
    passwordHash: 'ed18f7d04dbb700eeaaaa57602ff1138dfca550dd15e162c00f4df5568a539a5',
    role:         'client',
    accounts:     ['854069203683598', '185825224320502'],
  },
];

const attempts = {};

function checkLock(ip) {
  const now = Date.now();
  const rec = attempts[ip] || { count: 0, first: now, until: 0 };
  if (rec.until > now) return { locked: true, mins: Math.ceil((rec.until - now) / 60000) };
  if (now - rec.first > LOCKOUT_MINUTES * 60000) attempts[ip] = { count: 0, first: now, until: 0 };
  return { locked: false };
}
function recordFail(ip) {
  const now = Date.now();
  if (!attempts[ip]) attempts[ip] = { count: 0, first: now, until: 0 };
  attempts[ip].count++;
  if (attempts[ip].count >= MAX_ATTEMPTS) attempts[ip].until = now + LOCKOUT_MINUTES * 60000;
}
function clearLock(ip) { delete attempts[ip]; }

function hashPw(password) {
  return crypto.createHmac('sha256', JWT_SECRET).update(password.trim()).digest('hex');
}

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function makeToken(payload) {
  const h = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const b = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return `${h}.${b}.${s}`;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

module.exports = async (req, res) => {
  // CORS
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip   = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const path = (req.url || '').replace('/api/auth', '').split('?')[0];

  if (req.method === 'POST' && (path === '' || path === '/' || path === '/login')) {
    const { userId, password } = req.body || {};
    if (!userId || !password) return res.status(400).json({ error: 'User ID and password required' });
    const lock = checkLock(ip);
    if (lock.locked) return res.status(429).json({ error: `Too many failed attempts. Try again in ${lock.mins} minute${lock.mins>1?'s':''}.` });
    const user = USERS.find(u => u.userId.toLowerCase() === userId.toLowerCase().trim());
    if (!user || hashPw(password) !== user.passwordHash) { recordFail(ip); const left = Math.max(0,MAX_ATTEMPTS-(attempts[ip]?.count||0)); return res.status(401).json({ error: 'Invalid User ID or password', attemptsLeft: left }); }
    clearLock(ip);
    const now = Date.now();
    console.log(`[Auth] Login: ${user.userId} (${user.role})`);
    return res.status(200).json({ token: makeToken({ sub: user.userId, userId: user.userId, name: user.name, role: user.role, accounts: user.accounts, iat: now, exp: now+SESSION_HOURS*3600*1000 }), user: { userId: user.userId, name: user.name, role: user.role, accounts: user.accounts } });
  }
  if (req.method === 'GET' && path === '/verify') {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    try { const [h,b,s]=token.split('.'); const exp=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); if(s!==exp)throw new Error('Bad'); const p=JSON.parse(Buffer.from(b,'base64').toString()); if(Date.now()>p.exp)throw new Error('Exp'); return res.status(200).json({ valid: true, user: p }); } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  }
  return res.status(404).json({ error: 'Not found' });
};
