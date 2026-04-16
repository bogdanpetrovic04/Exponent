-- Topics + topic-aware questions/rooms

-- Type: topic_mode
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

-- Ensure a default topic exists for seeded questions + existing rooms.
insert into public.topics (name, short_description, source)
values ('General', 'Seeded', 'preset')
on conflict (name, short_description) do nothing;

-- Questions: add topic_id and backfill
alter table public.questions
  add column if not exists topic_id uuid references public.topics (id);

update public.questions q
set topic_id = t.id
from public.topics t
where q.topic_id is null and t.name = 'General' and t.short_description = 'Seeded';

alter table public.questions
  alter column topic_id set not null;

create index if not exists questions_topic_id_idx on public.questions (topic_id);

-- Rooms: add topic settings and backfill
alter table public.rooms
  add column if not exists topic_mode public.topic_mode not null default 'preset',
  add column if not exists topic_id uuid references public.topics (id);

update public.rooms r
set topic_id = t.id
from public.topics t
where r.topic_id is null and t.name = 'General' and t.short_description = 'Seeded';

alter table public.rooms
  alter column topic_id set not null;

create index if not exists rooms_topic_id_idx on public.rooms (topic_id);

-- RLS
alter table public.topics enable row level security;

drop policy if exists "topics_select" on public.topics;
create policy "topics_select" on public.topics
for select using (auth.uid() is not null);

-- Realtime publication (ignore if already member)
do $$ begin
  alter publication supabase_realtime add table public.topics;
exception when duplicate_object then null; end $$;

