-- G6 Labs — Points System
-- Run in Supabase SQL Editor

-- Points log table
create table if not exists task_points (
  id           uuid default gen_random_uuid() primary key,
  assignee     text not null,
  task_id      uuid references tasks(id) on delete set null,
  task_title   text,
  points       integer not null,         -- positive = earned, negative = deducted
  reason       text,                     -- 'completed', 'missed_daily', 'missed_weekly', etc.
  date         date default current_date,
  created_at   timestamptz default now()
);

-- Assignee points summary (materialized manually)
create table if not exists assignee_points (
  assignee     text primary key,
  total_points integer default 100,      -- starts at 100
  updated_at   timestamptz default now()
);

-- Seed starting points for all assignees
insert into assignee_points (assignee, total_points) values
  ('ashokh', 100),
  ('diva',   100),
  ('anisa',  100)
on conflict (assignee) do nothing;

-- Indexes
create index if not exists idx_points_assignee on task_points(assignee, date);
create index if not exists idx_points_date on task_points(date);

-- Disable RLS
alter table task_points disable row level security;
alter table assignee_points disable row level security;

-- Grant access
grant all on task_points to anon;
grant all on assignee_points to anon;
