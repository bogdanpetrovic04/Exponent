-- Configurable round length + reveal duration change

-- Store per-room question duration (seconds)
alter table public.rooms
  add column if not exists question_seconds int not null default 30
  check (question_seconds between 10 and 90);

-- _enter_reveal: default wait after round is 15s (was 10s)
create or replace function public._enter_reveal(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  ans double precision;
  rnd int;
begin
  select r.current_round, q.answer into rnd, ans
  from public.rooms r
  join public.questions q on q.id = r.current_question_id
  where r.id = p_room_id;

  perform public._score_round(p_room_id, rnd);

  update public.rooms set
    phase = 'reveal',
    reveal_answer = ans,
    reveal_started_at = now(),
    reveal_deadline_at = now() + interval '15 seconds',
    question_deadline_at = null
  where id = p_room_id;

  update public.room_players set is_ready = false
  where room_id = p_room_id and kicked_at is null;
end;
$$;

-- _start_question: use rooms.question_seconds for total-time mode
create or replace function public._start_question(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  r public.rooms%rowtype;
  qid uuid;
  deadline timestamptz;
begin
  select * into r from public.rooms where id = p_room_id for update;
  qid := public._pick_question(p_room_id);
  insert into public.room_used_questions (room_id, question_id) values (p_room_id, qid)
  on conflict do nothing;

  update public.rooms set
    current_question_id = qid,
    reveal_answer = null,
    reveal_started_at = null,
    reveal_deadline_at = null,
    phase = 'question',
    question_started_at = now()
  where id = p_room_id;

  if r.time_mode = 'total_30' then
    deadline := now() + make_interval(secs => greatest(10, least(90, r.question_seconds)));
    update public.rooms set question_deadline_at = deadline where id = p_room_id;
  else
    update public.rooms set question_deadline_at = null where id = p_room_id;
  end if;
end;
$$;

-- submit_guess: when starting timer after-first-guess, use rooms.question_seconds
create or replace function public.submit_guess(p_room_id uuid, p_guess double precision)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  r public.rooms%rowtype;
  rnd int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_room_member(p_room_id, auth.uid()) then raise exception 'not a member'; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if r.phase <> 'question' then raise exception 'not in question phase'; end if;
  if r.question_deadline_at is not null and now() > r.question_deadline_at then raise exception 'time_up'; end if;

  rnd := r.current_round;

  insert into public.round_guesses (room_id, round_index, user_id, guess)
  values (p_room_id, rnd, auth.uid(), p_guess)
  on conflict (room_id, round_index, user_id) do update set guess = excluded.guess, created_at = now();

  if r.time_mode = 'after_first_30' then
    if r.question_deadline_at is null then
      update public.rooms
      set question_deadline_at = now() + make_interval(secs => greatest(10, least(90, r.question_seconds)))
      where id = p_room_id;
    end if;
  end if;

  perform public.room_tick(p_room_id);
end;
$$;

grant execute on function public.submit_guess(uuid, double precision) to authenticated;
alter function public.submit_guess(uuid, double precision) set row_security to off;

-- update_room_settings: add question seconds
drop function if exists public.update_room_settings(uuid, public.game_time_mode, int, public.topic_mode, uuid);
create function public.update_room_settings(
  p_room_id uuid,
  p_time_mode public.game_time_mode,
  p_rounds int,
  p_topic_mode public.topic_mode,
  p_topic_id uuid,
  p_question_seconds int
)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;
  if p_rounds < 3 or p_rounds > 15 then raise exception 'invalid rounds'; end if;
  if p_question_seconds < 10 or p_question_seconds > 90 then raise exception 'invalid question seconds'; end if;

  if p_topic_mode = 'preset' or p_topic_mode = 'ai_custom' then
    if p_topic_id is null then raise exception 'topic_required'; end if;
    if not exists (select 1 from public.topics t where t.id = p_topic_id) then
      raise exception 'topic_not_found';
    end if;
  end if;

  update public.rooms
  set
    time_mode = p_time_mode,
    rounds_total = p_rounds,
    topic_mode = p_topic_mode,
    topic_id = case when p_topic_mode = 'random' then topic_id else p_topic_id end,
    question_seconds = p_question_seconds
  where id = p_room_id and phase = 'lobby' and deleted_at is null;
end;
$$;

grant execute on function public.update_room_settings(uuid, public.game_time_mode, int, public.topic_mode, uuid, int) to authenticated;
alter function public.update_room_settings(uuid, public.game_time_mode, int, public.topic_mode, uuid, int) set row_security to off;

