-- ─────────────────────────────────────────────────────────────────────────────
-- G6 Labs Asia — Users Table (Supabase-based authentication)
-- Run this in Supabase → SQL Editor → New query
--
-- Password hashes = HMAC-SHA256(JWT_SECRET, plaintext_password)
-- To generate a hash for a new user, run in your terminal:
--   node -e "const c=require('crypto');console.log(c.createHmac('sha256','YOUR_JWT_SECRET').update('thepassword').digest('hex'))"
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists users (
  id            uuid default gen_random_uuid() primary key,
  username      text unique not null,
  password_hash text not null,         -- HMAC-SHA256(JWT_SECRET, plaintext) as hex
  name          text,
  role          text default 'client', -- 'admin' | 'client'
  superadmin    boolean default false, -- true = full access (Ashokh only)
  accounts      text[] default '{}',   -- ad account IDs; '{*}' = all accounts
  email         text,
  active        boolean default true,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists idx_users_username on users(username);
create index if not exists idx_users_active   on users(active);

-- Disable RLS (auth is enforced in the API layer, anon key is server-side only)
alter table users disable row level security;

-- Grant SELECT to anon so the auth function can query it (server-side only)
grant select on users to anon;

-- ─── Seed initial users ──────────────────────────────────────────────────────
-- Default JWT_SECRET = 'G6LabsAsia2026SecureKey'
-- Passwords below are hashed with that secret.  Re-hash if you change the secret.
--
--   ashokh  →  AshokH@G6Labs2026
--   nanda   →  (existing hash preserved)
--   diva    →  DivaG6!2026
--   anisa   →  AnisaG6!2026
--
-- To change a password: update password_hash with a new hash, e.g.:
--   update users set password_hash = 'newhashhere', updated_at = now()
--   where username = 'diva';

insert into users (username, password_hash, name, role, superadmin, accounts, email)
values
  (
    'ashokh',
    '14e520cb3361809278f3278d6921f70d15935b19c312d5fc459e8b02923544ed',
    'Ashokh', 'admin', true,
    '{*}',
    'ashokh@trisquare.com.my'
  ),
  (
    'nanda',
    'ed18f7d04dbb700eeaaaa57602ff1138dfca550dd15e162c00f4df5568a539a5',
    'Nanda', 'client', false,
    '{854069203683598,5841452755981834,4486576511589217}',
    null
  ),
  (
    'diva',
    'f70823170fd427359aa09927397fb35785366668bdca58fa929d1fdc451ad01d',
    'Diva', 'admin', false,
    '{*}',
    'diva@g6labs.asia'
  ),
  (
    'anisa',
    'f475cc1e9aae7c173926b0471f620bd0c8f011dc447a7f0bf8ddbace04928961',
    'Anisa', 'admin', false,
    '{*}',
    'anisa@g6labs.asia'
  )
on conflict (username) do update set
  name          = excluded.name,
  role          = excluded.role,
  superadmin    = excluded.superadmin,
  accounts      = excluded.accounts,
  email         = excluded.email,
  active        = true,
  updated_at    = now();
