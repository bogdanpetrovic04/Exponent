-- Rename default seeded topic + increase reveal wait to 30s

-- Ensure "Sample topic - Seeded" exists and migrate from old "General - Seeded"
do $$
declare
  old_id uuid;
  new_id uuid;
begin
  select id into old_id from public.topics where name = 'General' and short_description = 'Seeded' limit 1;

  insert into public.topics (name, short_description, source)
  values ('Sample topic', 'Seeded', 'preset')
  on conflict (name, short_description) do update set source = excluded.source
  returning id into new_id;

  if old_id is not null and old_id <> new_id then
    update public.questions set topic_id = new_id where topic_id = old_id;
    update public.rooms set topic_id = new_id where topic_id = old_id;
    delete from public.topics where id = old_id;
  end if;
end $$;

-- _enter_reveal: default wait after round is 30s
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

