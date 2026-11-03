-- =====================================================================
--  לפני שנגמר — מבנה בסיס הנתונים (Supabase)
--  להריץ פעם אחת: Supabase → SQL Editor → New query → להדביק הכול → Run
--  כל חנות רואה רק את הנתונים שלה (Row Level Security).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.stores (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  name        text not null check (char_length(name) between 2 and 80),
  whatsapp    text check (whatsapp is null or whatsapp ~ '^05[0-9]{8}$'),
  template    text not null default E'היי {שם}, כאן {חנות}.\nלפי החישוב שלנו ל{חיה} נשאר {מה} {ימים}.\nלהכין לך {מוצר}? אפשר לאסוף או לקבל משלוח.\n(להפסקת תזכורות השב/י "הסר")',
  video_path  text,
  video_orig_path text,
  plan       text not null default 'trial',
  created_at  timestamptz not null default now()
);
create unique index if not exists stores_one_per_owner on public.stores(owner);

create table if not exists public.products (
  id        uuid primary key default gen_random_uuid(),
  store_id  uuid not null references public.stores(id) on delete cascade,
  name      text not null,
  kind      text not null check (kind in ('dog','cat','litter','rabbit','hens','bird')),
  kg        numeric not null check (kg > 0),
  price     numeric not null default 0 check (price >= 0),
  active    boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists products_store on public.products(store_id);

create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores(id) on delete cascade,
  name            text not null,
  phone           text not null check (phone ~ '^05[0-9]{8}$'),
  pet             text not null check (pet in ('dog','cat','rabbit','hens','bird')),
  pet_name        text,
  size            numeric not null default 1 check (size > 0),
  count           int not null default 1 check (count between 1 and 50),
  product_id      uuid references public.products(id) on delete set null,
  consent_at      timestamptz not null default now(),
  consent_source  text not null check (consent_source in ('qr','seller')),
  opted_out       boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (store_id, phone)
);
create index if not exists customers_store on public.customers(store_id);

create table if not exists public.purchases (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id  uuid references public.products(id) on delete set null,
  price       numeric not null default 0,
  date        date not null default ((now() at time zone 'Asia/Jerusalem')::date),
  created_at  timestamptz not null default now()
);
create index if not exists purchases_store on public.purchases(store_id);

create table if not exists public.reminders (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  date        date not null default ((now() at time zone 'Asia/Jerusalem')::date),
  created_at  timestamptz not null default now()
);
create index if not exists reminders_store on public.reminders(store_id);

-- ---------- ownership helper ----------
create or replace function public.owns_store(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stores s where s.id = sid and s.owner = auth.uid());
$$;

-- a child row must point at rows of the same store
create or replace function public.check_same_store() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name in ('purchases','reminders') then
    if not exists (select 1 from public.customers c where c.id = new.customer_id and c.store_id = new.store_id) then
      raise exception 'customer does not belong to this store';
    end if;
  end if;
  if tg_table_name in ('purchases','customers') and new.product_id is not null then
    if not exists (select 1 from public.products p where p.id = new.product_id and p.store_id = new.store_id) then
      raise exception 'product does not belong to this store';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists same_store on public.purchases;
create trigger same_store before insert or update on public.purchases for each row execute function public.check_same_store();
drop trigger if exists same_store on public.reminders;
create trigger same_store before insert or update on public.reminders for each row execute function public.check_same_store();
drop trigger if exists same_store on public.customers;
create trigger same_store before insert or update on public.customers for each row execute function public.check_same_store();

-- ---------- row level security ----------
alter table public.stores    enable row level security;
alter table public.products  enable row level security;
alter table public.customers enable row level security;
alter table public.purchases enable row level security;
alter table public.reminders enable row level security;

drop policy if exists stores_owner on public.stores;
create policy stores_owner on public.stores for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists products_owner on public.products;
create policy products_owner on public.products for all to authenticated
  using (public.owns_store(store_id)) with check (public.owns_store(store_id));
drop policy if exists customers_owner on public.customers;
create policy customers_owner on public.customers for all to authenticated
  using (public.owns_store(store_id)) with check (public.owns_store(store_id));
drop policy if exists purchases_owner on public.purchases;
create policy purchases_owner on public.purchases for all to authenticated
  using (public.owns_store(store_id)) with check (public.owns_store(store_id));
drop policy if exists reminders_owner on public.reminders;
create policy reminders_owner on public.reminders for all to authenticated
  using (public.owns_store(store_id)) with check (public.owns_store(store_id));

-- the plan column is yours (billing), not the store's: only you (service role / SQL editor) can change it
create or replace function public.guard_store() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    if tg_op = 'INSERT' then
      new.plan := 'trial';
      new.owner := auth.uid();
    elsif new.plan is distinct from old.plan or new.owner is distinct from old.owner then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_store on public.stores;
create trigger guard_store before insert or update on public.stores for each row execute function public.guard_store();

-- ---------- default products for a new store ----------
create or replace function public.seed_products() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.products (store_id, name, kind, kg, price) values
    (new.id, 'מזון יבש לכלב בוגר, גזע גדול', 'dog', 15, 389),
    (new.id, 'מזון לכלב גזע קטן', 'dog', 3, 129),
    (new.id, 'מזון יבש לחתול בוגר', 'cat', 2, 89),
    (new.id, 'חול מתגבש לחתולים', 'litter', 10, 59),
    (new.id, 'כופתיות לארנבים', 'rabbit', 5, 79),
    (new.id, 'תערובת למטילות', 'hens', 20, 119),
    (new.id, 'תערובת זרעים לתוכים', 'bird', 3, 69);
  return new;
end $$;
drop trigger if exists seed_products on public.stores;
create trigger seed_products after insert on public.stores for each row execute function public.seed_products();

-- ---------- public pages (no login): the customer's sign-up page ----------
create or replace function public.public_store(p_slug text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'name', s.name,
    'video_path', s.video_path,
    'products', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'kind', p.kind, 'kg', p.kg) order by p.created_at)
                          from public.products p where p.store_id = s.id and p.active), '[]'::json))
  from public.stores s where s.slug = lower(p_slug);
$$;

create or replace function public.join_store(
  p_slug text, p_name text, p_phone text, p_pet text, p_pet_name text,
  p_size numeric, p_product uuid, p_bought_now boolean, p_consent boolean
) returns json
language plpgsql security definer set search_path = public as $$
declare s public.stores; pr public.products; c_id uuid; recent int;
begin
  if p_consent is distinct from true then raise exception 'consent required'; end if;
  select * into s from public.stores where slug = lower(p_slug);
  if not found then raise exception 'store not found'; end if;
  if p_phone !~ '^05[0-9]{8}$' then raise exception 'bad phone'; end if;
  if char_length(coalesce(trim(p_name),'')) not between 1 and 60 then raise exception 'bad name'; end if;
  if p_pet not in ('dog','cat','rabbit','hens','bird') then raise exception 'bad pet'; end if;
  select * into pr from public.products where id = p_product and store_id = s.id and active;
  if not found then raise exception 'bad product'; end if;
  -- simple flood guard: at most 60 public sign-ups per store per hour
  select count(*) into recent from public.customers where store_id = s.id and consent_source = 'qr' and created_at > now() - interval '1 hour';
  if recent >= 60 then raise exception 'too many sign-ups, try later'; end if;

  insert into public.customers (store_id, name, phone, pet, pet_name, size, product_id, consent_source, consent_at, opted_out)
  values (s.id, trim(p_name), p_phone, p_pet, nullif(trim(coalesce(p_pet_name,'')),''), greatest(coalesce(p_size,1),0.5), pr.id, 'qr', now(), false)
  on conflict (store_id, phone) do update
    set consent_at = now(), consent_source = 'qr', opted_out = false, product_id = excluded.product_id,
        pet = excluded.pet, pet_name = coalesce(excluded.pet_name, public.customers.pet_name), size = excluded.size
  returning id into c_id;

  if p_bought_now then
    insert into public.purchases (store_id, customer_id, product_id, price) values (s.id, c_id, pr.id, pr.price);
  end if;
  return json_build_object('ok', true, 'kg', pr.kg, 'kind', pr.kind);
end $$;

revoke all on function public.public_store(text) from public;
revoke all on function public.join_store(text,text,text,text,text,numeric,uuid,boolean,boolean) from public;
grant execute on function public.public_store(text) to anon, authenticated;
grant execute on function public.join_store(text,text,text,text,text,numeric,uuid,boolean,boolean) to anon, authenticated;

-- ---------- store videos (Storage) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-videos', 'store-videos', true, 62914560, array['video/mp4','video/webm','video/quicktime'])
on conflict (id) do nothing;

drop policy if exists videos_owner_insert on storage.objects;
create policy videos_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'store-videos' and public.owns_store(((storage.foldername(name))[1])::uuid));
drop policy if exists videos_owner_update on storage.objects;
create policy videos_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'store-videos' and public.owns_store(((storage.foldername(name))[1])::uuid));
drop policy if exists videos_owner_delete on storage.objects;
create policy videos_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'store-videos' and public.owns_store(((storage.foldername(name))[1])::uuid));
