-- Fix: create_room should not fail if the default topic rename migration wasn't run yet.
-- Prefer "Sample topic - Seeded", fall back to "General - Seeded", and create if missing.

create or replace function public.create_room(
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

  -- Prefer the new name.
  select t.id into tid
  from public.topics t
  where t.name = 'Sample topic' and t.short_description = 'Seeded'
  limit 1;

  -- Backwards-compatible fallback.
  if tid is null then
    select t.id into tid
    from public.topics t
    where t.name = 'General' and t.short_description = 'Seeded'
    limit 1;
  end if;

  -- Absolute fallback: create the default.
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
alter function public.create_room(text, public.game_time_mode, int) set row_security to off;

