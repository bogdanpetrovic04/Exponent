-- room_tick: return current phase so the client can advance immediately after a successful tick.
-- Use clock_timestamp() for deadline checks (wall clock; avoids edge cases with transaction now()).
-- _all_players_ready: SECURITY DEFINER + row_security off so RLS cannot break reads when invoked from SQL.

create or replace function public._all_players_ready(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select coalesce(bool_and(rp.is_ready), true)
  from public.room_players rp
  where rp.room_id = p_room_id and rp.kicked_at is null;
$$;

drop function if exists public.room_tick(uuid);

create function public.room_tick(p_room_id uuid)
returns public.game_phase
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  r public.rooms%rowtype;
  out_phase public.game_phase;
  t timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_room_member(p_room_id, auth.uid()) then raise exception 'not a member'; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if not found then raise exception 'room not found'; end if;

  if r.deleted_at is not null then
    select phase into out_phase from public.rooms where id = p_room_id;
    return out_phase;
  end if;

  if r.phase = 'question' then
    if r.question_deadline_at is not null and t >= r.question_deadline_at then
      perform public._enter_reveal(p_room_id);
      select phase into out_phase from public.rooms where id = p_room_id;
      return out_phase;
    end if;
    if r.time_mode = 'after_first_30'
       and r.question_deadline_at is null
       and r.question_started_at is not null
       and t >= r.question_started_at + interval '5 minutes' then
      perform public._enter_reveal(p_room_id);
      select phase into out_phase from public.rooms where id = p_room_id;
      return out_phase;
    end if;
  end if;

  if r.phase = 'reveal' then
    if (public._all_players_ready(p_room_id) or (r.reveal_deadline_at is not null and t >= r.reveal_deadline_at)) then
      if r.current_round >= r.rounds_total then
        update public.rooms set phase = 'final' where id = p_room_id;
      else
        update public.rooms set current_round = r.current_round + 1 where id = p_room_id;
        perform public._start_question(p_room_id);
      end if;
    end if;
  end if;

  select phase into out_phase from public.rooms where id = p_room_id;
  return out_phase;
end;
$$;

grant execute on function public.room_tick(uuid) to authenticated;
