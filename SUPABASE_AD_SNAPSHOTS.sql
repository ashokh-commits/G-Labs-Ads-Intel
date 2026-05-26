-- ─────────────────────────────────────────────────────────────────────────────
-- G6 Labs Asia — Ad-Level Snapshots (daily per-ad historical data)
-- Run this in Supabase → SQL Editor → New query
-- ─────────────────────────────────────────────────────────────────────────────

-- AD SNAPSHOTS TABLE (daily per-ad, per-account)
create table if not exists ad_snapshots (
  id            uuid default gen_random_uuid() primary key,
  account_id    text not null,
  ad_id         text not null,
  ad_name       text,
  campaign_name text,
  date          date not null,
  spend         numeric(12,2) default 0,
  impressions   bigint default 0,
  reach         bigint default 0,
  clicks        bigint default 0,
  ctr           numeric(8,4) default 0,
  cpm           numeric(10,2) default 0,
  cpc           numeric(10,2) default 0,
  frequency     numeric(8,2) default 0,
  results       integer default 0,
  conversations integer default 0,
  cpl           numeric(10,2) default 0,
  created_at    timestamptz default now(),
  -- unique constraint: one row per ad per day per account
  unique(account_id, ad_id, date)
);

-- Indexes for fast queries
create index if not exists idx_ad_snaps_account_date  on ad_snapshots(account_id, date);
create index if not exists idx_ad_snaps_ad_date       on ad_snapshots(ad_id, date);
create index if not exists idx_ad_snaps_date          on ad_snapshots(date);
create index if not exists idx_ad_snaps_campaign      on ad_snapshots(account_id, campaign_name, date);

-- Disable RLS (server-side auth handled in proxy)
alter table ad_snapshots disable row level security;

-- Grant access to anon key (same pattern as other tables)
grant all on ad_snapshots to anon;
