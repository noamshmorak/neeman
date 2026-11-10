-- נאמן v5: סנכרון "נאמן ספקים" בין מכשירים. אפשר להריץ שוב בלי נזק.
-- שורה אחת לכל מסמך (ספק / מוצר / חשבונית / הצעת מחיר...). המסמך נשמר כמו שהוא ב-data.
create table if not exists public.sup_docs (
  store_id   uuid not null references public.stores(id) on delete cascade,
  path       text not null check (char_length(path) between 3 and 200),
  data       jsonb,
  ts         bigint not null,                    -- זמן השינוי במכשיר (מילישניות). השינוי החדש יותר מנצח
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (store_id, path)
);
create index if not exists sup_docs_pull on public.sup_docs (store_id, updated_at);

-- שינוי ישן (ממכשיר שהיה לא מקוון) לא דורס שינוי חדש יותר
create or replace function public.sup_docs_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.ts < old.ts then return null; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists sup_docs_guard on public.sup_docs;
create trigger sup_docs_guard before insert or update on public.sup_docs for each row execute function public.sup_docs_guard();

alter table public.sup_docs enable row level security;
drop policy if exists sup_docs_owner on public.sup_docs;
create policy sup_docs_owner on public.sup_docs for all to authenticated
  using (public.owns_store(store_id)) with check (public.owns_store(store_id));
