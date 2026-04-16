-- Topic-aware RPCs + AI topic insertion

-- _pick_question: random unused question within the room's topic
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

-- create_room: set default topic to General - Seeded
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
  if tid is null then raise exception 'default topic missing'; end if;

  loop
    new_code := '';
    for j in 1..6 loop
      new_code := new_code || chr(65 + floor(random() * 26)::int);
    end loop;
    exit when not exists (select 1 from public.rooms where rooms.code = new_code and deleted_at is null);
    i := i + 1;
    if i > 50 then raise exception 'could not allocate code'; end if;
  end loop;

  insert into public.rooms (host_id, code, time_mode, rounds_total, phase, topic_mode, topic_id)
  values (uid, new_code, p_time_mode, p_rounds, 'lobby', 'preset', tid)
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

-- update_room_settings: include topic mode/id (only in lobby)
drop function if exists public.update_room_settings(uuid, public.game_time_mode, int);
create function public.update_room_settings(
  p_room_id uuid,
  p_time_mode public.game_time_mode,
  p_rounds int,
  p_topic_mode public.topic_mode,
  p_topic_id uuid
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
    topic_id = case when p_topic_mode = 'random' then topic_id else p_topic_id end
  where id = p_room_id and phase = 'lobby' and deleted_at is null;
end;
$$;

grant execute on function public.update_room_settings(uuid, public.game_time_mode, int, public.topic_mode, uuid) to authenticated;

-- start_game: lock in random topic once, then start first question
drop function if exists public.start_game(uuid);
create function public.start_game(p_room_id uuid)
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

-- create_topic_with_questions: insert (or reuse) topic + bulk insert questions
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

