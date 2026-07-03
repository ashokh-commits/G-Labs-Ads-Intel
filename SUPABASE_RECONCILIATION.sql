-- Run in Supabase SQL Editor
-- Ad Spend Reconciliation: match Meta ad invoices to credit card statement charges

-- One row per upload (CSV or PDF). Lets the UI show upload history and
-- delete a bad import as a single unit (cascades to invoices/txns/matches).
create table if not exists recon_batches (
  id              uuid default gen_random_uuid() primary key,
  batch_type      text not null,              -- 'meta_csv' | 'card_pdf'
  label           text not null,              -- user-entered tag: ad account/client (meta_csv) or card name (card_pdf)
  source_filename text,
  row_count       integer default 0,
  warnings        jsonb default '[]',
  uploaded_by     text,
  created_at      timestamptz default now()
);

-- Parsed rows from a Meta Ads Manager billing CSV export.
create table if not exists recon_invoices (
  id             uuid default gen_random_uuid() primary key,
  batch_id       uuid references recon_batches(id) on delete cascade,
  label          text not null,               -- denormalized copy of batch label
  invoice_date   date not null,
  amount         numeric(12,2) not null,
  currency       text default 'USD',
  transaction_id text,
  description    text,
  raw_row        jsonb,                       -- full original parsed CSV row, for audit
  match_status   text not null default 'unmatched',  -- 'unmatched' | 'suggested' | 'confirmed' | 'ignored'
  created_at     timestamptz default now()
);

-- Parsed lines from credit card statement PDFs, pre-filtered at parse time
-- to only lines whose description looks like a Meta/Facebook ad charge.
create table if not exists recon_card_transactions (
  id            uuid default gen_random_uuid() primary key,
  batch_id      uuid references recon_batches(id) on delete cascade,
  label         text not null,                -- denormalized copy of batch label (card name)
  txn_date      date not null,
  amount        numeric(12,2) not null,
  currency      text default 'MYR',
  description   text not null,
  raw_line      text,                         -- original PDF line text, for user sanity-check
  confidence    text not null default 'high', -- 'high' | 'low' (ambiguous parse, needs review)
  match_status  text not null default 'unmatched',
  created_at    timestamptz default now()
);

-- Invoice <-> card transaction pairing.
create table if not exists recon_matches (
  id               uuid default gen_random_uuid() primary key,
  invoice_id       uuid references recon_invoices(id) on delete cascade,
  card_txn_id      uuid references recon_card_transactions(id) on delete cascade,
  score            numeric(4,3),
  date_diff_days   integer,
  amount_diff_pct  numeric(6,2),
  status           text not null default 'suggested',  -- 'suggested' | 'confirmed' | 'rejected'
  matched_by       text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique(invoice_id)
);

-- Indexes
create index if not exists idx_recon_invoices_batch on recon_invoices(batch_id);
create index if not exists idx_recon_invoices_label_date on recon_invoices(label, invoice_date);
create index if not exists idx_recon_invoices_status on recon_invoices(match_status);
create index if not exists idx_recon_cardtxn_batch on recon_card_transactions(batch_id);
create index if not exists idx_recon_cardtxn_label_date on recon_card_transactions(label, txn_date);
create index if not exists idx_recon_cardtxn_status on recon_card_transactions(match_status);
create index if not exists idx_recon_matches_invoice on recon_matches(invoice_id);
create index if not exists idx_recon_matches_cardtxn on recon_matches(card_txn_id);

-- Disable RLS (auth enforced server-side in api/supabase-proxy.js, not Postgres)
alter table recon_batches disable row level security;
alter table recon_invoices disable row level security;
alter table recon_card_transactions disable row level security;
alter table recon_matches disable row level security;

-- Grant access
grant all on recon_batches to anon;
grant all on recon_invoices to anon;
grant all on recon_card_transactions to anon;
grant all on recon_matches to anon;
