-- Supabase schema (beginner-friendly) — uses an RPC function claim_job(job_id) with SECURITY DEFINER

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- 1) enum
do $$ begin
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type job_status as enum ('open','assigned','complete','canceled');
  end if;
end $$;

-- 2) profiles (maps 1:1 to auth.users)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text check (role in ('admin','guide')) default 'guide',
  certs text[] default '{}',
  is_active boolean default true,
  created_at timestamptz default now()
);

-- 3) jobs
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  date date not null,
  call_time time not null,
  dock_time time,
  location text,
  boat text,
  requirements text[] default '{}',
  pay numeric(10,2),
  notes text,
  status job_status not null default 'open',
  claimed_by uuid references profiles(id),
  claimed_at timestamptz,
  created_by uuid references profiles(id) not null,
  created_at timestamptz default now()
);

-- 4) claims (first writer wins)
create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  guide_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique(job_id) -- ensures only one claim per job
);

-- indexes
create index if not exists idx_jobs_status_date on jobs(status, date);
create index if not exists idx_claims_guide_id on claims(guide_id);

-- Row Level Security
alter table profiles enable row level security;
alter table jobs enable row level security;
alter table claims enable row level security;

-- Policies
-- profiles: user can see/update their own profile; admins can see all
do $$ begin
  if not exists (select 1 from pg_policies where policyname='read own or admin all' and tablename='profiles') then
    create policy "read own or admin all" on profiles for select using (
      auth.uid() = id or exists (
        select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
      )
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where policyname='update own' and tablename='profiles') then
    create policy "update own" on profiles for update using (auth.uid() = id);
  end if;
end $$;

-- jobs: guides can read open jobs and jobs they’ve claimed; admins read/write all
do $$ begin
  if not exists (select 1 from pg_policies where policyname='read open or own assignments' and tablename='jobs') then
    create policy "read open or own assignments" on jobs for select using (
      status = 'open' or claimed_by = auth.uid() or exists (
        select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
      )
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where policyname='insert jobs admin only' and tablename='jobs') then
    create policy "insert jobs admin only" on jobs for insert with check (
      exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where policyname='update jobs admin only' and tablename='jobs') then
    create policy "update jobs admin only" on jobs for update using (
      exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
    );
  end if;
end $$;

-- claims: user can insert a claim for themselves; read their own claims; admin can read all
do $$ begin
  if not exists (select 1 from pg_policies where policyname='insert own claim' and tablename='claims') then
    create policy "insert own claim" on claims for insert with check (
      guide_id = auth.uid()
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where policyname='read own claims or admin' and tablename='claims') then
    create policy "read own claims or admin" on claims for select using (
      guide_id = auth.uid() or exists (
        select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
      )
    );
  end if;
end $$;

-- Atomic claim RPC (uses SECURITY DEFINER to bypass RLS internally but uses auth.uid() to bind the caller)
create or replace function claim_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted int := 0;
begin
  -- only open jobs can be claimed
  if not exists (select 1 from jobs where id = p_job_id and status = 'open') then
    return false;
  end if;

  -- attempt to insert a claim for the current user
  insert into claims(job_id, guide_id)
  values (p_job_id, auth.uid())
  on conflict (job_id) do nothing;

  get diagnostics inserted = row_count;

  if inserted = 1 then
    -- we won the race; mark job assigned
    update jobs
       set status = 'assigned',
           claimed_by = auth.uid(),
           claimed_at = now()
     where id = p_job_id;
    return true;
  else
    -- someone else already claimed
    return false;
  end if;
end;
$$;

-- Allow authenticated users to execute the function
revoke all on function claim_job(uuid) from public;
grant execute on function claim_job(uuid) to authenticated;


-- Auto-create a profile row whenever a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- Enable realtime for these tables
do $$ begin
  begin
    alter publication supabase_realtime add table jobs;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table claims;
  exception when others then null;
  end;
end $$;
