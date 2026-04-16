-- End question early when every active player has submitted a guess for the current round.
-- Scoring: points = relative error vs answer (0 = exact); no guess = 1. Same value stored in relative_error for this round.

create or replace function public._all_players_submitted_guess(p_room_id uuid, p_round int)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id and rp.kicked_at is null
  )
  and not exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id and rp.kicked_at is null
    and not exists (
      select 1 from public.round_guesses g
      where g.room_id = rp.room_id and g.round_index = p_round and g.user_id = rp.user_id
    )
  );
$$;

create or replace function public._score_round(p_room_id uuid, p_round int)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  ans double precision;
begin
  select q.answer into ans
  from public.rooms r
  join public.questions q on q.id = r.current_question_id
  where r.id = p_room_id;
  if ans is null then return; end if;

  delete from public.round_scores where room_id = p_room_id and round_index = p_round;

  insert into public.round_scores (room_id, round_index, user_id, relative_error, points)
  select
    p_room_id,
    p_round,
    rp.user_id,
    case
      when g.guess is null then 1.0::double precision
      else (abs(g.guess - ans) / greatest(abs(ans), 1e-9))::double precision
    end,
    case
      when g.guess is null then 1.0::double precision
      else (abs(g.guess - ans) / greatest(abs(ans), 1e-9))::double precision
    end
  from public.room_players rp
  left join public.round_guesses g
    on g.room_id = rp.room_id and g.round_index = p_round and g.user_id = rp.user_id
  where rp.room_id = p_room_id and rp.kicked_at is null;
end;
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
    if public._all_players_submitted_guess(p_room_id, r.current_round) then
      perform public._enter_reveal(p_room_id);
      select phase into out_phase from public.rooms where id = p_room_id;
      return out_phase;
    end if;
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

alter function public._score_round(uuid, int) set row_security to off;
