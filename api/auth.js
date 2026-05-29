/**
 * G6 Labs — Authentication
 * Validates credentials against the Supabase `users` table.
 * Falls back to hardcoded users if Supabase is not yet configured.
 *
 * POST /api/auth        → login  { userId, password }
 * GET  /api/auth/verify → verify Bearer token
 */

const crypto = require('crypto');

const JWT_SECRET      = process.env.JWT_SECRET      || 'G6LabsAsia2026SecureKey';
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY;
const MAX_ATTEMPTS    = 5;
const LOCKOUT_MINUTES = 15;
const SESSION_HOURS   = 4;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// ── Hardcoded fallback (used when Supabase users table is not yet set up) ──
const FALLBACK_USERS = [
  {
    username: 'ashokh', name: 'Ashokh',
    password_hash: '14e520cb3361809278f3278d6921f70d15935b19c312d5fc459e8b02923544ed',
    role: 'admin', superadmin: true, accounts: ['*'],
  },
  {
    username: 'nanda', name: 'Nanda',
    password_hash: 'ed18f7d04dbb700eeaaaa57602ff1138dfca550dd15e162c00f4df5568a539a5',
    role: 'client', superadmin: false,
    accounts: ['854069203683598', '5841452755981834', '4486576511589217'],
  },
  {
    username: 'diva', name: 'Diva',
    password_hash: crypto.createHmac('sha256', JWT_SECRET).update('DivaG6!2026').digest('hex'),
    role: 'admin', superadmin: false, accounts: ['*'],
  },
  {
    username: 'anisa', name: 'Anisa',
    password_hash: crypto.createHmac('sha256', JWT_SECRET).update('AnisaG6!2026').digest('hex'),
    role: 'admin', superadmin: false, accounts: ['*'],
  },
];

// ── Brute-force protection (in-memory, resets on cold start) ───────────────
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

// ── Helpers ────────────────────────────────────────────────────────────────
function hashPw(password) {
  return crypto.createHmac('sha256', JWT_SECRET).update(password.trim()).digest('hex');
}

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function makeToken(payload) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = b64url(JSON.stringify(payload));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${b}.${s}`;
}

// ── Supabase user lookup ───────────────────────────────────────────────────
async function findUserInSupabase(username) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/users` +
      `?select=username,password_hash,name,role,superadmin,accounts,email,active` +
      `&username=eq.${encodeURIComponent(username.toLowerCase())}` +
      `&active=eq.true&limit=1`;
    const res  = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.warn('[Auth] Supabase lookup failed:', e.message);
    return null;
  }
}

async function findUser(username) {
  // Try Supabase first
  const sbUser = await findUserInSupabase(username);
  if (sbUser) return sbUser;

  // Fallback to hardcoded list (migration period / Supabase not configured)
  const fallback = FALLBACK_USERS.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (fallback) {
    console.log('[Auth] Using fallback user for:', username);
    return fallback;
  }
  return null;
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body for Vercel
  if (req.method === 'POST' && !req.body) {
    await new Promise(resolve => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { req.body = JSON.parse(data); } catch { req.body = {}; }
        resolve();
      });
    });
  }

  const ip      = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const rawPath = req.url || '';
  const path    = rawPath.replace('/api/auth', '').split('?')[0] || '/';

  // ── POST /api/auth — login ───────────────────────────────────────────────
  if (req.method === 'POST' && (path === '' || path === '/' || path === '/login')) {
    const { userId, password } = req.body || {};
    if (!userId || !password) {
      return res.status(400).json({ error: 'User ID and password required' });
    }

    const lock = checkLock(ip);
    if (lock.locked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${lock.mins} minute${lock.mins > 1 ? 's' : ''}.` });
    }

    const user = await findUser(userId.trim());

    if (!user || hashPw(password) !== user.password_hash) {
      recordFail(ip);
      const left = Math.max(0, MAX_ATTEMPTS - (attempts[ip]?.count || 0));
      return res.status(401).json({ error: 'Invalid User ID or password', attemptsLeft: left });
    }

    clearLock(ip);
    const now  = Date.now();
    const accounts = Array.isArray(user.accounts) ? user.accounts : [];

    const payload = {
      sub:        user.username,
      userId:     user.username,
      name:       user.name || user.username,
      role:       user.role || 'client',
      superadmin: user.superadmin === true,
      accounts,
      iat:        now,
      exp:        now + SESSION_HOURS * 3600 * 1000,
    };

    console.log(`[Auth] Login OK: ${user.username} (${user.role}${user.superadmin ? ' · superadmin' : ''})`);
    return res.status(200).json({
      token: makeToken(payload),
      user:  {
        userId:     user.username,
        name:       user.name || user.username,
        role:       user.role || 'client',
        superadmin: user.superadmin === true,
        accounts,
      },
    });
  }

  // ── GET /api/auth/verify ─────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/verify') {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      const [h, b, s] = token.split('.');
      const exp = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      if (s !== exp) throw new Error('Bad signature');
      const p = JSON.parse(Buffer.from(b, 'base64').toString());
      if (Date.now() > p.exp) throw new Error('Expired');
      // Ensure superadmin field is present (backward compat for tokens issued before this change)
      if (p.superadmin === undefined) p.superadmin = p.userId === 'ashokh';
      return res.status(200).json({ valid: true, user: p });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  return res.status(404).json({ error: 'Not found' });
};
