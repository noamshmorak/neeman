-- נאמן v3: ייבוא לקוחות מהקופה (אקסל). אפשר להריץ שוב בלי נזק.

-- 1. new customer fields
alter table public.customers add column if not exists ext_id   text;   -- customer number in the POS (BOSS)
alter table public.customers add column if not exists city     text;
alter table public.customers add column if not exists note     text;
alter table public.customers add column if not exists next_at  date;   -- reminder date that came from the POS
alter table public.customers add column if not exists next_set date;   -- when next_at was set (a later purchase cancels it)

-- the same POS customer number can't be twice in one store
create unique index if not exists customers_store_ext on public.customers(store_id, ext_id) where ext_id is not null;

-- 2. consent sources: imported customers start as 'import' (not yet confirmed on WhatsApp)
alter table public.customers drop constraint if exists customers_consent_source_check;
alter table public.customers add constraint customers_consent_source_check
  check (consent_source in ('qr','seller','import','import_ok'));

-- 3. QR sign-up of a customer that already came from the POS: keep the POS number, city and note
create or replace function public.join_store(
  p_slug text, p_name text, p_phone text, p_pet text, p_pet_name text,
  p_product uuid, p_bought_now boolean, p_consent boolean,
  p_days int default null, p_rules uuid[] default '{}'
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
  if p_days is not null and p_days not between 3 and 1000 then raise exception 'bad days'; end if;
  select * into pr from public.products where id = p_product and store_id = s.id and active;
  if not found then raise exception 'bad product'; end if;
  select count(*) into recent from public.customers where store_id = s.id and consent_source = 'qr' and created_at > now() - interval '1 hour';
  if recent >= 60 then raise exception 'too many sign-ups, try later'; end if;

  insert into public.customers (store_id, name, phone, pet, pet_name, product_id, days_override, consent_source, consent_at, opted_out)
  values (s.id, trim(p_name), p_phone, p_pet, nullif(trim(coalesce(p_pet_name,'')),''), pr.id,
          case when p_days is not null and p_days <> coalesce(pr.days, -1) then p_days end, 'qr', now(), false)
  on conflict (store_id, phone) do update
    set consent_at = now(), consent_source = 'qr', opted_out = false, product_id = excluded.product_id,
        pet = excluded.pet, pet_name = coalesce(excluded.pet_name, public.customers.pet_name), days_override = excluded.days_override,
        next_at = null
  returning id into c_id;

  if p_bought_now then
    insert into public.purchases (store_id, customer_id, product_id, price, src) values (s.id, c_id, pr.id, pr.price, 'qr');
  end if;
  insert into public.customer_rules (store_id, customer_id, rule_id)
    select s.id, c_id, r.id from public.rules r where r.store_id = s.id and r.id = any(coalesce(p_rules,'{}')) and p_pet = any(r.pets)
  on conflict (customer_id, rule_id) do nothing;
  insert into public.events (store_id, customer_name, text) values (s.id, trim(p_name), 'נרשם/ה דרך ה-QR');
  return json_build_object('ok', true, 'days', coalesce(case when p_days is not null then p_days end, pr.days, 30), 'kind', pr.kind);
end $$;

-- 4. the answer page knows if this is the first message to an imported customer
create or replace function public.reply_info(p_token uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('store', s.name, 'first_name', split_part(c.name, ' ', 1), 'pet', c.pet, 'pet_name', c.pet_name,
                           'product', p.name, 'kg', p.kg, 'kind', p.kind, 'optin', c.consent_source = 'import')
  from public.customers c join public.stores s on s.id = c.store_id left join public.products p on p.id = c.product_id
  where c.reply_token = p_token and not c.opted_out;
$$;

-- 5. any answer except "remove" from an imported customer = confirmed on WhatsApp
create or replace function public.reply_action(p_token uuid, p_action text, p_days_ago int default 0) returns json
language plpgsql security definer set search_path = public as $$
declare c public.customers; p public.products; d date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  select * into c from public.customers where reply_token = p_token and not opted_out;
  if not found then raise exception 'not found'; end if;
  select * into p from public.products where id = c.product_id;
  if p_action in ('yes','bought','optin') and c.consent_source = 'import' then
    update public.customers set consent_source = 'import_ok', consent_at = now() where id = c.id;
  end if;
  if p_action = 'yes' then
    update public.customers set pending_product = c.product_id, pending_at = d where id = c.id;
    insert into public.events (store_id, customer_name, text) values (c.store_id, c.name, 'ביקש/ה ' || coalesce(p.name, 'שק'));
  elsif p_action = 'bought' then
    if p_days_ago not between 0 and 120 then raise exception 'bad days'; end if;
    insert into public.purchases (store_id, customer_id, product_id, price, date, src) values (c.store_id, c.id, c.product_id, 0, d - p_days_ago, 'reported');
    update public.customers set pending_product = null, pending_at = null, next_at = null where id = c.id;
    insert into public.events (store_id, customer_name, text) values (c.store_id, c.name, 'דיווח/ה שכבר קנה/תה (' || case when p_days_ago = 0 then 'היום' else 'לפני ' || p_days_ago || ' ימים' end || ')');
  elsif p_action = 'optin' then
    insert into public.events (store_id, customer_name, text) values (c.store_id, c.name, 'אישר/ה תזכורות בוואטסאפ');
  elsif p_action = 'remove' then
    update public.customers set opted_out = true, pending_product = null where id = c.id;
    insert into public.events (store_id, customer_name, text) values (c.store_id, c.name, 'ביקש/ה להסיר מהתזכורות');
  else
    raise exception 'bad action';
  end if;
  return json_build_object('ok', true);
end $$;

revoke all on function public.join_store(text,text,text,text,text,uuid,boolean,boolean,int,uuid[]) from public;
revoke all on function public.reply_info(uuid) from public;
revoke all on function public.reply_action(uuid,text,int) from public;
grant execute on function public.join_store(text,text,text,text,text,uuid,boolean,boolean,int,uuid[]) to anon, authenticated;
grant execute on function public.reply_info(uuid) to anon, authenticated;
grant execute on function public.reply_action(uuid,text,int) to anon, authenticated;
