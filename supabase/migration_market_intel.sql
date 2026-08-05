-- Market Intel — adds one table for recurring Firecrawl monitor results
-- (competitor pricing/services, Google review activity, wellness content
-- research). Run this once in the Supabase SQL editor, after the original
-- schema.sql, on an existing project — it's additive and doesn't touch any
-- existing table.
--
-- Written only by netlify/functions/firecrawl-webhook.js using the
-- service_role key (bypasses RLS), the same pattern daily-report.js already
-- uses — so there's deliberately no client-side insert/update/delete policy
-- here, only a read policy for managers/supervisors.

create table public.market_intel_checks (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('competitor', 'review', 'content')),
  label text not null,
  monitor_id text,
  check_id text,
  event_type text,
  status text,
  is_meaningful boolean,
  summary text,
  diff_text text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index market_intel_checks_category_created_idx
  on public.market_intel_checks (category, created_at desc);

alter table public.market_intel_checks enable row level security;

create policy "market_intel_checks readable by manager"
  on public.market_intel_checks for select
  to authenticated
  using (public.can_manage());
