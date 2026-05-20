/**
 * G6 Labs — Auth Function
 * Hardcoded users — just deploy and it works
 * To add/change users: update USERS array below and redeploy
 */

const crypto = require('crypto');

// ── SECRET KEY — also set this as JWT_SECRET in Netlify env vars ──────────
const JWT_SECRET      = process.env.JWT_SECRET || 'G6LabsAsia2026SecureKey';
const MAX_ATTEMPTS    = 5;
const LOCKOUT_MINUTES = 15;
const SESSION_HOURS   = 4;

// ── USERS ─────────────────────────────────────────────────────────────────
// To add a user: copy a block, change userId/name/passwordHash/role/accounts
// passwordHash = HMAC-SHA256 of password using JWT_SECRET above
// role: "admin" = sees all accounts | "client" = sees only assigned accounts
// accounts: ["*"] for admin | specific account IDs for clients
const USERS = [
  {
    userId:       'ashokh',
    name:         'Ashokh',
    passwordHash: '14e520cb3361809278f3278d6921f70d15935b19c312d5fc459e8b02923544ed', // Jutawan123
    role:         'admin',
    accounts:     ['*'],
  },
  {
    userId:       'nanda',
    name:         'Nanda',
    passwordHash: 'ed18f7d04dbb700eeaaaa57602ff1138dfca550dd15e162c00f4df5568a539a5', // Isihat123
    role:         'client',
    accounts:     ['854069203683598', '185825224320502'], // I-Sihat Dental Care 2 + I-Sihat Dental Care
  },
];

// ── BRUTE FORCE ───────────────────────────────────────────────────────────
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

// ── PASSWORD HASH ─────────────────────────────────────────────────────────
function hashPw(password) {
  return crypto.createHmac('sha256', JWT_SECRET).update(password.trim()).digest('hex');
}

// ── JWT ───────────────────────────────────────────────────────────────────
function b64url(s) {
  return Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function makeToken(payload) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`)
    .digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${b}.${s}`;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json',
};

// ── HANDLER ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const ip   = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const path = (event.path || '').replace(/.*\/auth/, '');

  // ── POST /login ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && (path === '/login' || path === '' || path === '/')) {
    const body = JSON.parse(event.body || '{}');
    const userId   = (body.userId || '').trim();
    const password = body.password || '';

    if (!userId || !password) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'User ID and password required' }) };
    }

    // Brute force check
    const lock = checkLock(ip);
    if (lock.locked) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({
        error: `Too many failed attempts. Try again in ${lock.mins} minute${lock.mins > 1 ? 's' : ''}.`
      })};
    }

    // Find user
    const user = USERS.find(u => u.userId.toLowerCase() === userId.toLowerCase());

    if (!user || hashPw(password) !== user.passwordHash) {
      recordFail(ip);
      const left = Math.max(0, MAX_ATTEMPTS - (attempts[ip]?.count || 0));
      return { statusCode: 401, headers: CORS, body: JSON.stringify({
        error: 'Invalid User ID or password',
        attemptsLeft: left,
      })};
    }

    clearLock(ip);

    const now     = Date.now();
    const payload = {
      sub:      user.userId,
      userId:   user.userId,
      name:     user.name,
      role:     user.role,
      accounts: user.accounts,
      iat:      now,
      exp:      now + SESSION_HOURS * 3600 * 1000,
    };

    console.log(`[Auth] Login: ${user.userId} (${user.role}) from ${ip}`);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      token: makeToken(payload),
      user:  { userId: user.userId, name: user.name, role: user.role, accounts: user.accounts },
    })};
  }

  // ── GET /verify ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && path === '/verify') {
    const token = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };

    try {
      const [h, b, s] = token.split('.');
      const expected  = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`)
        .digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      if (s !== expected) throw new Error('Bad signature');
      const p = JSON.parse(Buffer.from(b, 'base64').toString());
      if (Date.now() > p.exp) throw new Error('Expired');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ valid: true, user: p }) };
    } catch(e) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }
  }

  return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };
};
