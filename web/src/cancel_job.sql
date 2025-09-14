-- Cancel job RPC: admin-only by default. Sets status='canceled' and clears claimed_by.
create or replace function public.cancel_job(p_job_id uuid)
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
    return false;
  end if;

  update public.jobs
     set status = 'canceled',
         claimed_by = null
   where id = p_job_id;

  if not found then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.cancel_job(uuid) from public;
grant execute on function public.cancel_job(uuid) to authenticated;
