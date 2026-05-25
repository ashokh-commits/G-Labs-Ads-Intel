-- ─────────────────────────────────────────────
-- G6 Labs Asia — Supabase Schema
-- Run this in Supabase → SQL Editor → New query
-- ─────────────────────────────────────────────

-- TASKS TABLE
create table if not exists tasks (
  id            uuid default gen_random_uuid() primary key,
  title         text not null,
  description   text,
  assignee      text,                          -- 'ashokh', 'diva', 'anisa', 'all'
  priority      text default 'medium',         -- 'low', 'medium', 'high', 'urgent'
  category      text default 'general',        -- 'ads', 'content', 'design', 'report', 'general'
  frequency     text default 'once',           -- 'once', 'daily', 'weekly', 'monthly'
  status        text default 'pending',        -- 'pending', 'in_progress', 'done', 'skipped'
  due_date      date,
  completed_at  timestamptz,
  completed_by  text,
  created_by    text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- TASK COMPLETIONS (for recurring tasks — log each completion)
create table if not exists task_completions (
  id          uuid default gen_random_uuid() primary key,
  task_id     uuid references tasks(id) on delete cascade,
  completed_by text,
  completed_at timestamptz default now(),
  notes       text,
  date        date default current_date
);

-- META ADS SNAPSHOTS (daily performance per account)
create table if not exists meta_snapshots (
  id            uuid default gen_random_uuid() primary key,
  account_id    text not null,
  account_name  text,
  date          date not null,
  spend         numeric(12,2) default 0,
  impressions   bigint default 0,
  clicks        bigint default 0,
  ctr           numeric(8,4) default 0,
  cpm           numeric(10,2) default 0,
  cpc           numeric(10,2) default 0,
  leads         integer default 0,
  cpl           numeric(10,2) default 0,
  results       integer default 0,
  frequency     numeric(8,2) default 0,
  reach         bigint default 0,
  created_at    timestamptz default now(),
  unique(account_id, date)
);

-- LEADS SNAPSHOTS (daily per client+zone)
create table if not exists leads_snapshots (
  id            uuid default gen_random_uuid() primary key,
  client        text not null,               -- 'isihat', 'smile', 'af'
  zone          text not null,               -- 'pg', 'kl', 'tlow', 'sb_kk', 'af_sg'
  zone_name     text,
  date          date not null,
  total         integer default 0,
  converted     integer default 0,
  good_quality  integer default 0,
  bad_quality   integer default 0,
  disqualified  integer default 0,
  created_at    timestamptz default now(),
  unique(client, zone, date)
);

-- INDEXES for fast queries
create index if not exists idx_meta_account_date on meta_snapshots(account_id, date);
create index if not exists idx_meta_date on meta_snapshots(date);
create index if not exists idx_leads_client_date on leads_snapshots(client, date);
create index if not exists idx_tasks_assignee on tasks(assignee);
create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_completions_task on task_completions(task_id, date);

-- ROW LEVEL SECURITY (disable for now — using server-side auth)
alter table tasks disable row level security;
alter table task_completions disable row level security;
alter table meta_snapshots disable row level security;
alter table leads_snapshots disable row level security;

-- SEED: Default recurring tasks for marketing team
insert into tasks (title, description, assignee, priority, category, frequency, created_by) values
  ('Check Meta Ads performance', 'Review all active campaigns — CPL, CTR, spend', 'all', 'high', 'ads', 'daily', 'system'),
  ('Reply to leads in Lark', 'Follow up on all new leads assigned', 'all', 'urgent', 'ads', 'daily', 'system'),
  ('Update lead progress in Lark', 'Update status for all leads contacted yesterday', 'all', 'high', 'ads', 'daily', 'system'),
  ('Check ad spend vs budget', 'Ensure accounts are not overspending', 'ashokh', 'high', 'ads', 'daily', 'system'),
  ('Post daily content (IG/FB)', 'Schedule or post approved content for the day', 'diva', 'high', 'content', 'daily', 'system'),
  ('Create content for next day', 'Design and caption for tomorrow''s posts', 'diva', 'medium', 'design', 'daily', 'system'),
  ('Weekly performance report', 'Compile weekly Meta Ads + leads report for clients', 'ashokh', 'high', 'report', 'weekly', 'system'),
  ('Content calendar planning', 'Plan next week''s content for all clients', 'diva', 'medium', 'content', 'weekly', 'system'),
  ('Client WhatsApp update', 'Send weekly performance summary to all clients', 'ashokh', 'high', 'report', 'weekly', 'system'),
  ('Review and optimise ad creatives', 'Pause low-performing ads, test new creatives', 'ashokh', 'medium', 'ads', 'weekly', 'system'),
  ('Monthly performance deck', 'Build monthly report deck for all clients', 'ashokh', 'high', 'report', 'monthly', 'system'),
  ('Monthly budget reconciliation', 'Verify all client ad spends vs invoices', 'ashokh', 'high', 'ads', 'monthly', 'system'),
  ('Update content strategy', 'Review and update content themes per client', 'diva', 'medium', 'content', 'monthly', 'system'),
  ('Competitor analysis', 'Monthly competitor ad library review', 'ashokh', 'low', 'ads', 'monthly', 'system')
on conflict do nothing;
