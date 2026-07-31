-- Sauna House conversion tracker — schema, roles, and RLS policies.
-- Run this once in the Supabase SQL editor for a fresh project.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null default 'staff' check (role in ('staff', 'manager')),
  created_at timestamptz not null default now()
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete cascade,
  date date not null,
  visits int not null check (visits >= 0),
  sold int not null check (sold >= 0),
  member_name text,
  created_at timestamptz not null default now()
);

create table public.settings (
  id int primary key default 1 check (id = 1),
  target int not null default 20,
  note text
);
insert into public.settings (id, target) values (1, 20);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) > 0 and char_length(body) <= 2000),
  created_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  notes text,
  followed_up boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they can read profiles/settings
-- without recursing through the RLS policies defined on those tables)
-- ---------------------------------------------------------------------------

create or replace function public.is_manager()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'manager'
  );
$$;

create or replace function public.has_manager()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.profiles where role = 'manager');
$$;

-- Exposed so the signed-out client can decide whether to show the
-- "first-time setup" screen or a normal sign-in form.
grant execute on function public.has_manager() to anon, authenticated;
grant execute on function public.is_manager() to authenticated;

-- ---------------------------------------------------------------------------
-- New-user bootstrap: every auth.users row gets a matching profiles row.
-- The very first user in the whole system becomes the manager; everyone
-- after that defaults to staff.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    case when public.has_manager() then 'staff' else 'manager' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.entries enable row level security;
alter table public.settings enable row level security;
alter table public.messages enable row level security;
alter table public.leads enable row level security;

-- profiles: readable by any signed-in user (names/roles aren't sensitive);
-- writable only by the row owner (name) or a manager (name + role); no
-- client-side insert policy — new rows only ever come from the trigger
-- above or the admin API (both bypass RLS).
create policy "profiles readable by authenticated"
  on public.profiles for select
  to authenticated
  using (true);

create policy "profiles updatable by owner or manager"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_manager())
  with check (id = auth.uid() or public.is_manager());

create policy "profiles deletable by manager"
  on public.profiles for delete
  to authenticated
  using (public.is_manager());

-- entries: staff see/act on their own rows only; managers see/act on all.
create policy "entries readable by owner or manager"
  on public.entries for select
  to authenticated
  using (staff_id = auth.uid() or public.is_manager());

create policy "entries insertable by owner or manager"
  on public.entries for insert
  to authenticated
  with check (staff_id = auth.uid() or public.is_manager());

create policy "entries updatable by owner or manager"
  on public.entries for update
  to authenticated
  using (staff_id = auth.uid() or public.is_manager())
  with check (staff_id = auth.uid() or public.is_manager());

create policy "entries deletable by owner or manager"
  on public.entries for delete
  to authenticated
  using (staff_id = auth.uid() or public.is_manager());

-- settings: everyone signed in can read the target; only managers can set it.
create policy "settings readable by authenticated"
  on public.settings for select
  to authenticated
  using (true);

create policy "settings updatable by manager"
  on public.settings for update
  to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- messages: a single team-wide chat, visible to everyone signed in. No
-- update/delete policy on purpose — once posted, a message stays forever.
create policy "messages readable by authenticated"
  on public.messages for select
  to authenticated
  using (true);

create policy "messages insertable by sender"
  on public.messages for insert
  to authenticated
  with check (sender_id = auth.uid());

-- Broadcast new messages over Supabase Realtime so the chat updates live.
alter publication supabase_realtime add table public.messages;

-- leads: follow-up list ("people who were interested"). Staff see/act on
-- only their own; managers see/act on everyone's, grouped by who added it.
create policy "leads readable by owner or manager"
  on public.leads for select
  to authenticated
  using (staff_id = auth.uid() or public.is_manager());

create policy "leads insertable by owner or manager"
  on public.leads for insert
  to authenticated
  with check (staff_id = auth.uid() or public.is_manager());

create policy "leads updatable by owner or manager"
  on public.leads for update
  to authenticated
  using (staff_id = auth.uid() or public.is_manager())
  with check (staff_id = auth.uid() or public.is_manager());

create policy "leads deletable by owner or manager"
  on public.leads for delete
  to authenticated
  using (staff_id = auth.uid() or public.is_manager());

-- ---------------------------------------------------------------------------
-- Leaderboard: per-staff, per-month totals for everyone, visible to any
-- signed-in user. Security definer so staff (who can only read their own
-- rows in `entries` per the policy above) still get the aggregate figures
-- for the whole team, without exposing anyone's individual daily entries.
-- ---------------------------------------------------------------------------

create or replace function public.monthly_leaderboard()
returns table (
  staff_id uuid,
  name text,
  month date,
  visits bigint,
  sold bigint,
  rate numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.id as staff_id,
    p.name,
    date_trunc('month', e.date)::date as month,
    sum(e.visits) as visits,
    sum(e.sold) as sold,
    case when sum(e.visits) > 0
      then round(sum(e.sold)::numeric / sum(e.visits) * 100, 1)
      else 0
    end as rate
  from public.entries e
  join public.profiles p on p.id = e.staff_id
  group by p.id, p.name, date_trunc('month', e.date);
$$;

grant execute on function public.monthly_leaderboard() to authenticated;
