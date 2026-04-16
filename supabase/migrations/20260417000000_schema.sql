-- Exponent: schema + RLS + realtime + seed data (idempotent)

-- Extensions
create extension if not exists pgcrypto;

-- Types
do $$ begin
  create type public.game_time_mode as enum ('total_30', 'after_first_30');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.game_phase as enum ('lobby', 'question', 'reveal', 'final');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.topic_mode as enum ('preset', 'random', 'ai_custom');
exception when duplicate_object then null; end $$;

-- Topics
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 64),
  short_description text not null check (char_length(short_description) between 1 and 96),
  source text not null default 'preset' check (source in ('preset', 'ai')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (name, short_description)
);

create index if not exists topics_created_at_idx on public.topics (created_at desc);

-- Questions (answers hidden from direct reads via RLS)
create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  answer double precision not null,
  topic_id uuid references public.topics (id),
  image_query text,
  image_query_stock text,
  image_url text,
  image_source_url text,
  image_provider text check (image_provider in ('wikimedia', 'openverse'))
);

create index if not exists questions_topic_id_idx on public.questions (topic_id);

-- Rooms
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  host_id uuid not null references auth.users (id) on delete cascade,
  phase public.game_phase not null default 'lobby',
  time_mode public.game_time_mode not null default 'total_30',
  question_seconds int not null default 30 check (question_seconds between 10 and 90),
  show_question_images boolean not null default true,
  topic_mode public.topic_mode not null default 'preset',
  topic_id uuid references public.topics (id),
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
create index if not exists rooms_topic_id_idx on public.rooms (topic_id);

-- Players
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

-- Used questions
create table if not exists public.room_used_questions (
  room_id uuid not null references public.rooms (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  primary key (room_id, question_id)
);

-- Guesses
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

-- Scores
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

-- RLS
alter table public.questions enable row level security;
alter table public.topics enable row level security;
alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.room_used_questions enable row level security;
alter table public.round_guesses enable row level security;
alter table public.round_scores enable row level security;

-- Topics: authenticated users can list for dropdown
drop policy if exists "topics_select" on public.topics;
create policy "topics_select" on public.topics
for select using (auth.uid() is not null);

-- Questions: deny direct select (answers hidden)
drop policy if exists "questions_no_select" on public.questions;
create policy "questions_no_select" on public.questions for select using (false);

-- Helper functions used by RLS are defined in the RPC migration.
-- Policies below reference them; they will work after you run the RPC migration.

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
do $$ begin
  alter publication supabase_realtime add table public.topics;
exception when duplicate_object then null; end $$;

-- Seed default topic + sample questions
insert into public.topics (name, short_description, source)
values ('Sample topic', 'Seeded', 'preset')
on conflict (name, short_description) do nothing;

with t as (
  select id from public.topics where name = 'Sample topic' and short_description = 'Seeded' limit 1
)
insert into public.questions (prompt, answer, topic_id)
select v.prompt, v.answer, (select id from t) from (values
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
where exists (select 1 from t)
  and not exists (select 1 from public.questions limit 1);

