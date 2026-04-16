-- Force topic-aware question selection (safe to run repeatedly).
-- If your DB still has the older _pick_question (random across all questions),
-- topic selection will appear broken.

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

  if tid is null then
    raise exception 'room has no topic_id';
  end if;

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

  if qid is null then
    raise exception 'no questions for topic %', tid;
  end if;

  return qid;
end;
$$;

grant execute on function public._pick_question(uuid) to authenticated;
alter function public._pick_question(uuid) set row_security to off;

