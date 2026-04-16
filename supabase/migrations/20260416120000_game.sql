-- Multiplayer guessing game schema + RPCs
-- Run in Supabase SQL Editor or via supabase db push

-- Extensions
create extension if not exists pgcrypto;

-- Types
do $$ begin
  create type public.game_time_mode as enum ('total_30', 'after_first_30');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.game_phase as enum ('lobby', 'question', 'reveal', 'final');
exception when duplicate_object then null; end $$;

-- Questions (answer hidden from direct client reads via RLS)
create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  answer double precision not null
);

-- Rooms
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  host_id uuid not null references auth.users (id) on delete cascade,
  phase public.game_phase not null default 'lobby',
  time_mode public.game_time_mode not null default 'total_30',
  rounds_total int not null default 5 check (rounds_total >= 3 and rounds_total <= 15),
  current_round int not null default 0 check (current_round >= 0),
  current_question_id uuid references public.questions (id),
  question_deadline_at timestamptz,
  question_started_at timestamptz,
  reveal_started_at timestamptz,
  reveal_deadline_at timestamptz,
  reveal_answer double precision,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists rooms_code_idx on public.rooms (code) where deleted_at is null;

create table if not exists public.room_players (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 32),
  is_ready boolean not null default false,
  kicked_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_players_room_idx on public.room_players (room_id);

create table if not exists public.room_used_questions (
  room_id uuid not null references public.rooms (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  primary key (room_id, question_id)
);

create table if not exists public.round_guesses (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  round_index int not null check (round_index >= 1),
  user_id uuid not null references auth.users (id) on delete cascade,
  guess double precision not null,
  created_at timestamptz not null default now(),
  unique (room_id, round_index, user_id)
);

create index if not exists round_guesses_room_round on public.round_guesses (room_id, round_index);

create table if not exists public.round_scores (
  room_id uuid not null references public.rooms (id) on delete cascade,
  round_index int not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  relative_error double precision not null,
  points double precision not null,
  primary key (room_id, round_index, user_id)
);

-- Updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists rooms_updated_at on public.rooms;
create trigger rooms_updated_at before update on public.rooms
for each row execute function public.set_updated_at();

-- Helpers
create or replace function public._is_room_member(p_room_id uuid, p_uid uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id and rp.user_id = p_uid and rp.kicked_at is null
  );
$$;

create or replace function public._is_host(p_room_id uuid, p_uid uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.host_id = p_uid and r.deleted_at is null
  );
$$;

-- Pick random unused question (must bypass questions RLS: policy is deny-all for clients)
create or replace function public._pick_question(p_room_id uuid)
returns uuid language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare qid uuid;
begin
  select q.id into qid
  from public.questions q
  where not exists (
    select 1 from public.room_used_questions u
    where u.room_id = p_room_id and u.question_id = q.id
  )
  order by random()
  limit 1;
  if qid is null then
    select q2.id into qid from public.questions q2 order by random() limit 1;
  end if;
  return qid;
end; $$;

create or replace function public._score_round(p_room_id uuid, p_round int)
returns void language plpgsql security definer set search_path = public as $$
declare
  ans double precision;
  rel_err double precision;
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
      when g.guess is null then 1e9
      else abs(g.guess - ans) / greatest(abs(ans), 1e-9)
    end,
    case
      when g.guess is null then 0
      else 1.0 / (1.0 + (abs(g.guess - ans) / greatest(abs(ans), 1e-9)))
    end
  from public.room_players rp
  left join public.round_guesses g
    on g.room_id = rp.room_id and g.round_index = p_round and g.user_id = rp.user_id
  where rp.room_id = p_room_id and rp.kicked_at is null;
end; $$;

create or replace function public._enter_reveal(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
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
    reveal_deadline_at = now() + interval '10 seconds',
    question_deadline_at = null
  where id = p_room_id;

  update public.room_players set is_ready = false
  where room_id = p_room_id and kicked_at is null;
end; $$;

create or replace function public._start_question(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
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
    deadline := now() + interval '30 seconds';
    update public.rooms set question_deadline_at = deadline where id = p_room_id;
  else
    update public.rooms set question_deadline_at = null where id = p_room_id;
  end if;
end; $$;

create or replace function public._all_players_ready(p_room_id uuid)
returns boolean language sql stable as $$
  select coalesce(bool_and(rp.is_ready), true)
  from public.room_players rp
  where rp.room_id = p_room_id and rp.kicked_at is null;
$$;

create or replace function public.room_tick(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_room_member(p_room_id, auth.uid()) then raise exception 'not a member'; end if;

  select * into r from public.rooms where id = p_room_id for update;
  if r.deleted_at is not null then return; end if;

  -- Close question phase when deadline hit (total_30) or after_first max wait (5 min with no guesses)
  if r.phase = 'question' then
    if r.question_deadline_at is not null and now() >= r.question_deadline_at then
      perform public._enter_reveal(p_room_id);
      return;
    end if;
    if r.time_mode = 'after_first_30'
       and r.question_deadline_at is null
       and r.question_started_at is not null
       and now() >= r.question_started_at + interval '5 minutes' then
      perform public._enter_reveal(p_room_id);
      return;
    end if;
  end if;

  -- Reveal: advance if all ready or deadline
  if r.phase = 'reveal' then
    if (public._all_players_ready(p_room_id) or (r.reveal_deadline_at is not null and now() >= r.reveal_deadline_at)) then
      if r.current_round >= r.rounds_total then
        update public.rooms set phase = 'final' where id = p_room_id;
      else
        update public.rooms set current_round = r.current_round + 1 where id = p_room_id;
        perform public._start_question(p_room_id);
      end if;
    end if;
  end if;
end; $$;

grant execute on function public.room_tick(uuid) to authenticated;

-- RPC: create_room
create or replace function public.create_room(
  p_nickname text,
  p_time_mode public.game_time_mode,
  p_rounds int
)
returns table (room_id uuid, code text)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  new_code text;
  rid uuid;
  i int := 0;
  j int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_rounds < 3 or p_rounds > 15 then raise exception 'invalid rounds'; end if;

  loop
    new_code := '';
    for j in 1..6 loop
      new_code := new_code || chr(65 + floor(random() * 26)::int);
    end loop;
    exit when not exists (select 1 from public.rooms where rooms.code = new_code and deleted_at is null);
    i := i + 1;
    if i > 50 then raise exception 'could not allocate code'; end if;
  end loop;

  insert into public.rooms (host_id, code, time_mode, rounds_total, phase)
  values (uid, new_code, p_time_mode, p_rounds, 'lobby')
  returning id into rid;

  insert into public.room_players (room_id, user_id, nickname)
  values (rid, uid, trim(p_nickname))
  on conflict (room_id, user_id) do update set nickname = excluded.nickname, kicked_at = null;

  return query select rid, new_code;
end; $$;

grant execute on function public.create_room(text, public.game_time_mode, int) to authenticated;

-- join_room
create or replace function public.join_room(p_code text, p_nickname text)
returns table (room_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  rid uuid;
  c text := upper(trim(p_code));
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if length(c) <> 6 then raise exception 'invalid_code'; end if;

  select r.id into rid
  from public.rooms r
  where r.code = c and r.deleted_at is null
    and r.expires_at > now()
    and r.phase = 'lobby';

  if rid is null then
    raise exception 'room_not_found_or_unavailable';
  end if;

  if exists (select 1 from public.room_players where room_id = rid and user_id = uid and kicked_at is not null) then
    raise exception 'you_were_removed';
  end if;

  insert into public.room_players (room_id, user_id, nickname)
  values (rid, uid, trim(p_nickname))
  on conflict (room_id, user_id) do update set nickname = excluded.nickname, kicked_at = null;

  return query select rid;
exception
  when others then
    raise;
end; $$;

grant execute on function public.join_room(text, text) to authenticated;

-- update_room_settings
create or replace function public.update_room_settings(
  p_room_id uuid,
  p_time_mode public.game_time_mode,
  p_rounds int
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;
  if p_rounds < 3 or p_rounds > 15 then raise exception 'invalid rounds'; end if;

  update public.rooms set time_mode = p_time_mode, rounds_total = p_rounds
  where id = p_room_id and phase = 'lobby' and deleted_at is null;
end; $$;

grant execute on function public.update_room_settings(uuid, public.game_time_mode, int) to authenticated;

-- kick_player
create or replace function public.kick_player(p_room_id uuid, p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;
  if p_target = auth.uid() then raise exception 'cannot kick self'; end if;

  update public.room_players set kicked_at = now()
  where room_id = p_room_id and user_id = p_target;
end; $$;

grant execute on function public.kick_player(uuid, uuid) to authenticated;

-- delete_room
create or replace function public.delete_room(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;

  update public.rooms set deleted_at = now(), code = null where id = p_room_id;
end; $$;

grant execute on function public.delete_room(uuid) to authenticated;

-- start_game
create or replace function public.start_game(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_host(p_room_id, auth.uid()) then raise exception 'not host'; end if;

  update public.rooms set current_round = 1
  where id = p_room_id and phase = 'lobby' and deleted_at is null;

  perform public._start_question(p_room_id);
end; $$;

grant execute on function public.start_game(uuid) to authenticated;

-- submit_guess
create or replace function public.submit_guess(p_room_id uuid, p_guess double precision)
returns void language plpgsql security definer set search_path = public as $$
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
      update public.rooms set question_deadline_at = now() + interval '30 seconds' where id = p_room_id;
    end if;
  end if;

  perform public.room_tick(p_room_id);
end; $$;

grant execute on function public.submit_guess(uuid, double precision) to authenticated;

-- set_ready
create or replace function public.set_ready(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public._is_room_member(p_room_id, auth.uid()) then raise exception 'not a member'; end if;

  update public.room_players set is_ready = true
  where room_id = p_room_id and user_id = auth.uid() and kicked_at is null;

  perform public.room_tick(p_room_id);
end; $$;

grant execute on function public.set_ready(uuid) to authenticated;

-- host_back_to_lobby
create or replace function public.host_back_to_lobby(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
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
end; $$;

grant execute on function public.host_back_to_lobby(uuid) to authenticated;

-- get_question_prompt (no answer)
create or replace function public.get_question_prompt(p_room_id uuid)
returns text language plpgsql security definer set search_path = public as $$
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
end; $$;

grant execute on function public.get_question_prompt(uuid) to authenticated;

-- RLS
alter table public.questions enable row level security;
alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.room_used_questions enable row level security;
alter table public.round_guesses enable row level security;
alter table public.round_scores enable row level security;

-- Questions: no direct select of answer for users (only via RPC). For admin seed use service role.
drop policy if exists "questions_no_select" on public.questions;
create policy "questions_no_select" on public.questions for select using (false);

-- Rooms: members see room
drop policy if exists "rooms_member_select" on public.rooms;
create policy "rooms_member_select" on public.rooms
for select using (
  deleted_at is null
  and public._is_room_member(id, auth.uid())
);

-- Room players
drop policy if exists "room_players_select" on public.room_players;
create policy "room_players_select" on public.room_players
for select using (public._is_room_member(room_id, auth.uid()));

-- Used questions
drop policy if exists "room_used_select" on public.room_used_questions;
create policy "room_used_select" on public.room_used_questions
for select using (public._is_room_member(room_id, auth.uid()));

-- Guesses
drop policy if exists "round_guesses_select" on public.round_guesses;
create policy "round_guesses_select" on public.round_guesses
for select using (public._is_room_member(room_id, auth.uid()));

-- Scores
drop policy if exists "round_scores_select" on public.round_scores;
create policy "round_scores_select" on public.round_scores
for select using (public._is_room_member(room_id, auth.uid()));

-- Realtime publication (ignore if already member)
do $$ begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.room_players;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.round_guesses;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.round_scores;
exception when duplicate_object then null; end $$;

-- RLS: RPCs run as invoker unless row_security is off; inserts into rooms were blocked for many setups.
alter function public.create_room(text, public.game_time_mode, int) set row_security to off;
alter function public.join_room(text, text) set row_security to off;
alter function public.update_room_settings(uuid, public.game_time_mode, int) set row_security to off;
alter function public.kick_player(uuid, uuid) set row_security to off;
alter function public.delete_room(uuid) set row_security to off;
alter function public.start_game(uuid) set row_security to off;
alter function public.submit_guess(uuid, double precision) set row_security to off;
alter function public.set_ready(uuid) set row_security to off;
alter function public.host_back_to_lobby(uuid) set row_security to off;
alter function public.get_question_prompt(uuid) set row_security to off;
alter function public.room_tick(uuid) set row_security to off;
alter function public._score_round(uuid, int) set row_security to off;
alter function public._enter_reveal(uuid) set row_security to off;
alter function public._start_question(uuid) set row_security to off;

-- Seed sample questions (idempotent-ish: only if empty)
insert into public.questions (prompt, answer)
select v.prompt, v.answer from (values
  ('How many meters tall is the Eiffel Tower (approx)?', 330::float),
  ('In what year did the Apollo 11 Moon landing occur?', 1969::float),
  ('How many keys on a standard modern piano?', 88::float),
  ('Approximate speed of sound in dry air at 20°C (m/s)?', 343::float),
  ('How many bones in an adult human body (approx)?', 206::float),
  ('Boiling point of water at sea level (°C)?', 100::float),
  ('How many countries in the United Nations (approx, 2020s)?', 193::float),
  ('Circumference of Earth at equator (km, approx)?', 40075::float),
  ('How many minutes in a leap year?', 527040::float),
  ('Golden ratio (phi) to 3 decimals?', 1.618::float),
  ('How many chromosomes in a typical human cell?', 46::float),
  ('Distance Earth–Sun in AU?', 1::float),
  ('How many bits in a byte?', 8::float),
  ('Approximate population of Japan (millions, 2020s)?', 125::float),
  ('How many sides on a dodecagon?', 12::float)
) as v(prompt, answer)
where not exists (select 1 from public.questions limit 1);
