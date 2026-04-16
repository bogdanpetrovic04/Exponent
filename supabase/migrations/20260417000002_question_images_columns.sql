-- Add question image fields for existing databases (safe, idempotent)

alter table public.questions
  add column if not exists image_query text,
  add column if not exists image_url text,
  add column if not exists image_source_url text,
  add column if not exists image_provider text;

do $$
begin
  -- Add a lightweight check constraint if missing.
  if not exists (
    select 1
    from pg_constraint
    where conname = 'questions_image_provider_check'
  ) then
    alter table public.questions
      add constraint questions_image_provider_check
      check (image_provider is null or image_provider in ('wikimedia', 'openverse'));
  end if;
end $$;

