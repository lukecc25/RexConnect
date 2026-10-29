create table if not exists public.rex_store (
  id integer primary key check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.rex_store enable row level security;

insert into public.rex_store (id, data)
values (1, '{"waiting":{},"groups":[],"created":{}}'::jsonb)
on conflict (id) do nothing;
