-- Admin assignment: set a specific guide as claimer and mark assigned
create or replace function public.assign_job(p_job_id uuid, p_guide_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
begin
  v_is_admin := public.is_admin();
  if not v_is_admin then
    -- Only admins can assign jobs to others directly
    return false;
  end if;

  update public.jobs
     set claimed_by = p_guide_id,
         status = 'assigned'
   where id = p_job_id;

  if not found then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.assign_job(uuid, uuid) from public;
grant execute on function public.assign_job(uuid, uuid) to authenticated;

-- Mark complete: allowed for admin or the assigned guide
create or replace function public.complete_job(p_job_id uuid)
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
       set status = 'complete'
     where id = p_job_id;
    return true;
  else
    return false;
  end if;
end;
$$;

revoke all on function public.complete_job(uuid) from public;
grant execute on function public.complete_job(uuid) to authenticated;
