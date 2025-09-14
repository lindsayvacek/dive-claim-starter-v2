-- Lock-safe first-come-first-serve claims & unclaims

-- CLAIM: Only succeeds if job is currently unclaimed.
-- Uses FOR UPDATE to lock the row and avoid races.
create or replace function public.claim_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed_by uuid;
begin
  select claimed_by into v_claimed_by
    from public.jobs
   where id = p_job_id
   for update;

  if not found then
    return false;
  end if;

  if v_claimed_by is null then
    update public.jobs
       set claimed_by = auth.uid(),
           status = 'assigned'
     where id = p_job_id;
    return true;
  else
    return false;
  end if;
end;
$$;

revoke all on function public.claim_job(uuid) from public;
grant execute on function public.claim_job(uuid) to authenticated;


-- UNCLAIM: Admin or current claimer can return job to pool.
-- Always clears claimed_by and sets status='open'.
create or replace function public.unclaim_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed_by uuid;
  v_is_admin boolean;
begin
  select claimed_by into v_claimed_by
    from public.jobs
   where id = p_job_id
   for update;
  if not found then
    return false;
  end if;

  v_is_admin := public.is_admin();

  if v_is_admin or v_claimed_by = auth.uid() then
    update public.jobs
       set claimed_by = null,
           status = 'open'
     where id = p_job_id;
    return true;
  else
    return false;
  end if;
end;
$$;

revoke all on function public.unclaim_job(uuid) from public;
grant execute on function public.unclaim_job(uuid) to authenticated;
