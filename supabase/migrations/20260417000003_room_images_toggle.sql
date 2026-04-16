-- Host toggle: show question images; second image query for stock fallback

alter table public.rooms
  add column if not exists show_question_images boolean not null default true;

alter table public.questions
  add column if not exists image_query_stock text;
