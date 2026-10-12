create table if not exists settings(k text primary key, v text);
create table if not exists plans(id bigint generated always as identity primary key, name text not null, price numeric(10,2) not null);
create table if not exists keys(id bigint generated always as identity primary key, plan_id bigint, key text not null, used boolean default false, order_id text, created_at timestamptz default now());
create table if not exists orders(id text primary key, email text, plan_id bigint, plan_name text, amount numeric(10,2), mp_id text, status text, key text, created_at timestamptz default now());
alter table settings enable row level security;
alter table plans enable row level security;
alter table keys enable row level security;
alter table orders enable row level security;
insert into settings(k,v) values
('name','CYBER MENU'),
('desc','Mod menu com acesso liberado na hora. Pagou, recebeu a key e o APK.'),
('image',''),('whatsapp',''),('apk',''),('soldout','false')
on conflict (k) do nothing;
insert into plans(name,price) values ('Diário (24h)',11),('Semanal (7 dias)',22),('Mensal (30 dias)',44);
