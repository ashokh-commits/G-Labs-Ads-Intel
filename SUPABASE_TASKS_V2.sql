-- Run in Supabase SQL Editor

-- TASK COMMENTS
create table if not exists task_comments (
  id          uuid default gen_random_uuid() primary key,
  task_id     uuid references tasks(id) on delete cascade,
  author      text not null,
  message     text not null,
  created_at  timestamptz default now()
);

-- TASK ATTACHMENTS (for design tasks)
create table if not exists task_attachments (
  id          uuid default gen_random_uuid() primary key,
  task_id     uuid references tasks(id) on delete cascade,
  filename    text not null,
  url         text not null,
  uploaded_by text,
  created_at  timestamptz default now()
);

-- Add due_date and due_time columns to tasks
alter table tasks add column if not exists due_date date;
alter table tasks add column if not exists due_time time;
alter table tasks add column if not exists notified boolean default false;

-- Indexes
create index if not exists idx_comments_task on task_comments(task_id);
create index if not exists idx_attachments_task on task_attachments(task_id);

-- Disable RLS on new tables
alter table task_comments disable row level security;
alter table task_attachments disable row level security;

-- Grant access
grant all on task_comments to anon;
grant all on task_attachments to anon;

-- Storage bucket for task files (run separately if needed)
-- insert into storage.buckets (id, name, public) values ('task-files', 'task-files', true) on conflict do nothing;
