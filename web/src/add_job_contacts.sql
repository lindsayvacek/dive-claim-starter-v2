-- Add a separate table for customer contact info so we don't leak PII on open jobs.
-- Run this in Supabase SQL Editor.

-- Make sure the helper exists (safe to re-run)
create or replace function public.is_admin()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
end;
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 1) Table
create table if not exists public.job_contacts (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  customer_name text not null,
  customer_phone text,
  customer_email text,
  created_at timestamptz default now()
);

-- 2) RLS: only admins or the guide who claimed the job can see contact info
alter table public.job_contacts enable row level security;

drop policy if exists "read contacts admin or assigned guide" on public.job_contacts;
create policy "read contacts admin or assigned guide" on public.job_contacts
  for select using (
    is_admin() or exists (
      select 1 from public.jobs j
      where j.id = job_id and j.claimed_by = auth.uid()
    )
  );

drop policy if exists "insert contacts admin only" on public.job_contacts;
create policy "insert contacts admin only" on public.job_contacts
  for insert with check (is_admin());

drop policy if exists "update contacts admin only" on public.job_contacts;
create policy "update contacts admin only" on public.job_contacts
  for update using (is_admin()) with check (is_admin());
