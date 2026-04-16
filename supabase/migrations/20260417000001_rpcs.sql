-- Exponent: helpers + RPCs + game loop (idempotent)

-- Helpers used by RLS policies (SECURITY DEFINER + row_security off to avoid recursion)
create or replace function public._is_room_member(p_room_id uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id and rp.user_id = p_uid and rp.kicked_at is null
  );
$$;

create or replace function public._is_host(p_room_id uuid, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.host_id = p_uid and r.deleted_at is null
  );
$$;

grant execute on function public._is_room_member(uuid, uuid) to authenticated;
grant execute on function public._is_host(uuid, uuid) to authenticated;

-- Ready check
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

-- Submitted check (end question early when everyone answered)
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

-- Pick random unused question within room topic
create or replace function public._pick_question(p_room_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  qid uuid;
  tid uuid;
begin
  select r.topic_id into tid
  from public.rooms r
  where r.id = p_room_id;

  select q.id into qid
  from public.questions q
  where q.topic_id = tid
    and not exists (
      select 1 from public.room_used_questions u
      where u.room_id = p_room_id and u.question_id = q.id
    )
  order by random()
  limit 1;

  if qid is null then
    select q2.id into qid
    from public.questions q2
    where q2.topic_id = tid
    order by random()
    limit 1;
  end if;

  return qid;
end;
$$;

-- Score a round (lower is better). No-guess score = worst_guess_score + 1; or 1 if nobody guessed.
create or replace function public._score_round(p_room_id uuid, p_round int)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  ans double precision;
  max_err double precision;
  no_guess_score double precision;
begin
  select q.answer into ans
  from public.rooms r
  join public.questions q on q.id = r.current_question_id
  where r.id = p_room_id;
  if ans is null then return; end if;

  select max(abs(g.guess - ans) / greatest(abs(ans), 1e-9)) into max_err
  from public.round_guesses g
  where g.room_id = p_room_id and g.round_index = p_round;

  no_guess_score := case when max_err is null then 1.0 else (max_err + 1.0) end;

  delete from public.round_scores where room_id = p_room_id and round_index = p_round;

  insert into public.round_scores (room_id, round_index, user_id, relative_error, points)
  select
    p_room_id,
    p_round,
    rp.user_id,
    case
      when g.guess is null then no_guess_score
      else (abs(g.guess - ans) / greatest(abs(ans), 1e-9))::double precision
    end,
    case
      when g.guess is null then no_guess_score
      else (abs(g.guess - ans) / greatest(abs(ans), 1e-9))::double precision
    end
  from public.room_players rp
  left join public.round_guesses g
    on g.room_id = rp.room_id and g.round_index = p_round and g.user_id = rp.user_id
  where rp.room_id = p_room_id and rp.kicked_at is null;
end;
$$;

-- Enter reveal (30s wait after round)
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
    reveal_deadline_at = now() + interval '30 seconds',
    question_deadline_at = null
  where id = p_room_id;

  update public.room_players set is_ready = false
  where room_id = p_room_id and kicked_at is null;
end;
$$;

-- Start question
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

-- Tick room state machine (returns current phase)
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

-- RPC: create_room (robust default topic selection)
drop function if exists public.create_room(text, public.game_time_mode, int);
create function public.create_room(
  p_nickname text,
  p_time_mode public.game_time_mode,
  p_rounds int
)
returns table (res_room_id uuid, res_code text)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid := auth.uid();
  new_code text;
  rid uuid;
  tid uuid;
  i int := 0;
  j int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_rounds < 3 or p_rounds > 15 then raise exception 'invalid rounds'; end if;

  select t.id into tid
  from public.topics t
  where t.name = 'Sample topic' and t.short_description = 'Seeded'
  limit 1;

  if tid is null then
    insert into public.topics (name, short_description, source)
    values ('Sample topic', 'Seeded', 'preset')
    on conflict (name, short_description) do update set source = excluded.source
    returning id into tid;
  end if;

  loop
    new_code := '';
    for j in 1..6 loop
      new_code := new_code || chr(65 + floor(random() * 26)::int);
    end loop;
    exit when not exists (select 1 from public.rooms where rooms.code = new_code and deleted_at is null);
    i := i + 1;
    if i > 50 then raise exception 'could not allocate code'; end if;
  end loop;

  insert into public.rooms (host_id, code, time_mode, rounds_total, phase, topic_mode, topic_id, question_seconds)
  values (uid, new_code, p_time_mode, p_rounds, 'lobby', 'preset', tid, 30)
  returning id into rid;

  insert into public.room_players (room_id, user_id, nickname)
  values (rid, uid, trim(p_nickname))
  on conflict (room_id, user_id) do update set nickname = excluded.nickname, kicked_at = null;

  res_room_id := rid;
  res_code := new_code;
  return next;
end;
$$;

grant execute on function public.create_room(text, public.game_time_mode, int) to authenticated;

-- RPC: join_room
drop function if exists public.join_room(text, text);
create function public.join_room(p_code text, p_nickname text)
returns uuid
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid := auth.uid();
  rid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select r.id into rid
  from public.rooms r
  where r.code = upper(trim(p_code)) and r.deleted_at is null and r.expires_at > now()
  limit 1;
  if rid is null then raise exception 'room_not_found'; end if;

  if exists (
    select 1 from public.room_players rp
    where rp.room_id = rid and rp.user_id = uid and rp.kicked_at is not null
  ) then
    raise exception 'you_were_removed';
  end if;

  insert into public.room_players (room_id, user_id, nickname)
  values (rid, uid, trim(p_nickname))
  on conflict (room_id, user_id) do update set nickname = excluded.nickname, kicked_at = null;

  return rid;
end;
$$;

grant execute on function public.join_room(text, text) to authenticated;

-- RPC: update_room_settings (lobby only)
create or replace function public.update_room_settings(
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

-- RPC: kick_player
create or replace function public.kick_player(p_room_id uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;
  if p_target = auth.uid() then raise exception 'cannot kick self'; end if;

  update public.room_players set kicked_at = now()
  where room_id = p_room_id and user_id = p_target;
end;
$$;

grant execute on function public.kick_player(uuid, uuid) to authenticated;

-- RPC: delete_room
create or replace function public.delete_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;
  update public.rooms set deleted_at = now(), code = null where id = p_room_id;
end;
$$;

grant execute on function public.delete_room(uuid) to authenticated;

-- RPC: start_game (locks random topic once)
create or replace function public.start_game(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  r public.rooms%rowtype;
  tid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if r.phase <> 'lobby' or r.deleted_at is not null then return; end if;

  if r.topic_mode = 'random' then
    select t.id into tid from public.topics t order by random() limit 1;
    if tid is null then raise exception 'no_topics'; end if;
    update public.rooms set topic_id = tid where id = p_room_id;
  end if;

  update public.rooms set current_round = 1
  where id = p_room_id and phase = 'lobby' and deleted_at is null;

  perform public._start_question(p_room_id);
end;
$$;

grant execute on function public.start_game(uuid) to authenticated;

-- RPC: submit_guess (starts timer in after-first mode)
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

-- RPC: set_ready
create or replace function public.set_ready(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_room_member(p_room_id, auth.uid()) then raise exception 'not a member'; end if;

  update public.room_players set is_ready = true
  where room_id = p_room_id and user_id = auth.uid() and kicked_at is null;

  perform public.room_tick(p_room_id);
end;
$$;

grant execute on function public.set_ready(uuid) to authenticated;

-- RPC: host_back_to_lobby
create or replace function public.host_back_to_lobby(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;

  delete from public.round_scores where room_id = p_room_id;
  delete from public.round_guesses where room_id = p_room_id;
  delete from public.room_used_questions where room_id = p_room_id;

  update public.rooms set
    phase = 'lobby',
    current_round = 0,
    current_question_id = null,
    question_deadline_at = null,
    reveal_started_at = null,
    reveal_deadline_at = null,
    reveal_answer = null
  where id = p_room_id;
end;
$$;

grant execute on function public.host_back_to_lobby(uuid) to authenticated;

-- RPC: get_question_prompt (no answer)
create or replace function public.get_question_prompt(p_room_id uuid)
returns text
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  pr text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_room_member(p_room_id, auth.uid()) then raise exception 'not a member'; end if;

  select q.prompt into pr
  from public.rooms r
  join public.questions q on q.id = r.current_question_id
  where r.id = p_room_id and r.phase = 'question';

  return pr;
end;
$$;

grant execute on function public.get_question_prompt(uuid) to authenticated;

-- RPC: create_topic_with_questions (AI persistence)
create or replace function public.create_topic_with_questions(
  p_name text,
  p_short_description text,
  p_questions jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  uid uuid := auth.uid();
  tid uuid;
  n int;
  item jsonb;
  pr text;
  ans double precision;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_name is null or char_length(trim(p_name)) < 1 or char_length(trim(p_name)) > 64 then
    raise exception 'invalid_topic_name';
  end if;
  if p_short_description is null or char_length(trim(p_short_description)) < 1 or char_length(trim(p_short_description)) > 96 then
    raise exception 'invalid_topic_description';
  end if;
  if jsonb_typeof(p_questions) <> 'array' then raise exception 'invalid_questions'; end if;

  n := jsonb_array_length(p_questions);
  if n < 5 or n > 50 then raise exception 'invalid_question_count'; end if;

  insert into public.topics (name, short_description, source, created_by)
  values (trim(p_name), trim(p_short_description), 'ai', uid)
  on conflict (name, short_description) do update
    set source = excluded.source
  returning id into tid;

  for item in select jsonb_array_elements(p_questions) loop
    pr := nullif(trim(item->>'prompt'), '');
    if pr is null or char_length(pr) > 240 then
      raise exception 'invalid_prompt';
    end if;
    begin
      ans := (item->>'answer')::double precision;
    exception when others then
      raise exception 'invalid_answer';
    end;
    insert into public.questions (prompt, answer, topic_id)
    values (pr, ans, tid);
  end loop;

  return tid;
end;
$$;

grant execute on function public.create_topic_with_questions(text, text, jsonb) to authenticated;

-- Ensure these functions bypass RLS when called via RPC
alter function public.room_tick(uuid) set row_security to off;
alter function public._pick_question(uuid) set row_security to off;
alter function public._score_round(uuid, int) set row_security to off;
alter function public._enter_reveal(uuid) set row_security to off;
alter function public._start_question(uuid) set row_security to off;
alter function public.create_room(text, public.game_time_mode, int) set row_security to off;
alter function public.join_room(text, text) set row_security to off;
alter function public.update_room_settings(uuid, public.game_time_mode, int, public.topic_mode, uuid, int) set row_security to off;
alter function public.kick_player(uuid, uuid) set row_security to off;
alter function public.delete_room(uuid) set row_security to off;
alter function public.start_game(uuid) set row_security to off;
alter function public.submit_guess(uuid, double precision) set row_security to off;
alter function public.set_ready(uuid) set row_security to off;
alter function public.host_back_to_lobby(uuid) set row_security to off;
alter function public.get_question_prompt(uuid) set row_security to off;
alter function public.create_topic_with_questions(text, text, jsonb) set row_security to off;
alter function public._is_room_member(uuid, uuid) set row_security to off;
alter function public._is_host(uuid, uuid) set row_security to off;
alter function public._all_players_ready(uuid) set row_security to off;
alter function public._all_players_submitted_guess(uuid, int) set row_security to off;

