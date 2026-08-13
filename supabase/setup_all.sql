-- BEAUTIY 一括セットアップSQL（Supabaseダッシュボード → SQL Editor に貼り付けて実行）
-- 生成元: supabase/migrations/0001〜0004 + seed.sql

-- ============================================================
-- supabase/migrations/0001_phase1a_foundation.sql
-- ============================================================
-- Phase 1-A: 基盤スキーマ
-- テナント分離 / カルテ所有権 / ロール別アクセス / 監査ログ / 予約排他制御
-- CLAUDE.md ルール: 全テーブル RLS 有効・tenant_id 強制・EXCLUDE USING gist

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- テナント / 店舗
-- ---------------------------------------------------------------
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'standard',
  created_at timestamptz not null default now()
);

create table salons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  open_time time not null default '10:00',
  close_time time not null default '20:00',
  closed_weekdays smallint[] not null default '{}',
  invoice_number text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- スタッフ（auth.users と 1:1）
-- ---------------------------------------------------------------
create type staff_role as enum ('owner', 'manager', 'stylist', 'assistant', 'freelance');

create table staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  auth_user_id uuid unique references auth.users(id),
  name text not null,
  name_kana text not null default '',
  role staff_role not null default 'stylist',
  color text not null default '#C8A96A',
  accept_start time,
  accept_end time,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 顧客（所有権モデル: salon | staff）
-- ---------------------------------------------------------------
create type owner_type as enum ('salon', 'staff');

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  owner_type owner_type not null default 'salon',
  owner_staff_id uuid references staff(id),
  name text not null,
  name_kana text not null default '',
  phone text,
  email text,
  birthday date,
  gender text,
  line_user_id text,
  address text,
  occupation text,
  channel text,
  tags text[] not null default '{}',
  warnings text[] not null default '{}',
  visit_cycle_days int,
  note text not null default '',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_owner_requires_staff
    check (owner_type <> 'staff' or owner_staff_id is not null)
);

create index customers_search_idx on customers (tenant_id, name_kana, phone);

-- ---------------------------------------------------------------
-- メニュー / 設備リソース
-- ---------------------------------------------------------------
create table menus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  category text not null default '',
  name text not null,
  duration_min int not null,
  price int not null, -- 円（整数）
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  name text not null, -- セット面 / シャンプー台等
  capacity int not null default 1
);

-- ---------------------------------------------------------------
-- 予約（排他制御: 受け入れ基準 10-1）
-- ---------------------------------------------------------------
-- マスター要件 §63 の8状態（deleted は行の deleted_at で表現するため enum に含めない）
create type reservation_status as enum
  ('requested', 'confirmed', 'checked_in', 'in_service', 'completed', 'cancelled', 'no_show');

create table reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  customer_id uuid references customers(id),
  customer_name text not null default '',
  staff_id uuid not null references staff(id),
  resource_id uuid references resources(id),
  menu_ids uuid[] not null default '{}',
  time_range tstzrange not null,
  nominated boolean not null default false,
  status reservation_status not null default 'confirmed',
  source text not null default 'app',
  note text not null default '',
  created_at timestamptz not null default now(),
  -- 同一スタッフの時間帯重複をDB層でブロック（キャンセル系は対象外）
  constraint reservations_staff_no_overlap
    exclude using gist (
      staff_id with =,
      time_range with &&
    ) where (status in ('requested', 'confirmed', 'checked_in', 'in_service', 'completed')),
  -- 同一設備の時間帯重複もブロック
  constraint reservations_resource_no_overlap
    exclude using gist (
      resource_id with =,
      time_range with &&
    ) where (resource_id is not null
             and status in ('requested', 'confirmed', 'checked_in', 'in_service', 'completed'))
);

create index reservations_range_idx on reservations using gist (tenant_id, time_range);

-- ---------------------------------------------------------------
-- 監査ログ
-- ---------------------------------------------------------------
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  actor_staff_id uuid references staff(id),
  action text not null, -- karte_view / karte_edit / export / payment_fix / payment_reverse ...
  target_type text not null,
  target_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_logs_tenant_idx on audit_logs (tenant_id, created_at desc);

-- ---------------------------------------------------------------
-- RLS ヘルパー
-- ---------------------------------------------------------------
create or replace function current_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from staff where auth_user_id = auth.uid()
$$;

create or replace function current_staff() returns staff
language sql stable security definer set search_path = public as $$
  select * from staff where auth_user_id = auth.uid()
$$;

-- ---------------------------------------------------------------
-- RLS: 全テーブル有効化 + テナント分離（受け入れ基準 10-6）
-- ---------------------------------------------------------------
alter table tenants enable row level security;
alter table salons enable row level security;
alter table staff enable row level security;
alter table customers enable row level security;
alter table menus enable row level security;
alter table resources enable row level security;
alter table reservations enable row level security;
alter table audit_logs enable row level security;

create policy tenant_isolation_tenants on tenants
  for select using (id = current_tenant_id());

create policy tenant_isolation_salons on salons
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_staff on staff
  for all using (tenant_id = current_tenant_id());

-- 顧客: テナント分離 + 所有権分離（受け入れ基準 10-3）
-- staff 個人所有顧客は、所有者本人・オーナー・店長のみ参照可
create policy customers_select on customers
  for select using (
    tenant_id = current_tenant_id()
    and (
      owner_type = 'salon'
      or owner_staff_id = (current_staff()).id
      or (current_staff()).role in ('owner', 'manager')
    )
  );

create policy customers_write on customers
  for all using (
    tenant_id = current_tenant_id()
    and (
      owner_type = 'salon'
      or owner_staff_id = (current_staff()).id
      or (current_staff()).role in ('owner', 'manager')
    )
  );

create policy tenant_isolation_menus on menus
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_resources on resources
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_reservations on reservations
  for all using (tenant_id = current_tenant_id());

-- 監査ログ: 追記は全スタッフ、閲覧はオーナーのみ
create policy audit_logs_insert on audit_logs
  for insert with check (tenant_id = current_tenant_id());

create policy audit_logs_select on audit_logs
  for select using (
    tenant_id = current_tenant_id() and (current_staff()).role = 'owner'
  );

-- ============================================================
-- supabase/migrations/0002_karte_payment.sql
-- ============================================================
-- Phase 1-B/1-D: カルテ・会計スキーマ
-- 会計は確定後 UPDATE 禁止（打消し伝票方式）。カルテ写真は非公開バケット + 署名付きURL。

-- ---------------------------------------------------------------
-- カルテ
-- ---------------------------------------------------------------
create table kartes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  customer_id uuid not null references customers(id),
  staff_id uuid not null references staff(id),
  visit_date date not null,
  menu_names text[] not null default '{}',
  duration_min int not null default 0,
  amount int not null default 0, -- 円（整数）
  recipe jsonb not null default '[]', -- [{brand, product, ratio, minutes}]
  recipe_note text not null default '',
  memo text not null default '',
  created_at timestamptz not null default now()
);

create index kartes_customer_idx on kartes (customer_id, visit_date desc);

create table karte_photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  karte_id uuid not null references kartes(id) on delete cascade,
  storage_path text not null, -- 非公開バケット。配信は署名付きURL（1時間）のみ
  kind text not null default 'after', -- before | after
  created_at timestamptz not null default now(),
  constraint max_photos_per_karte check (true) -- 上限20枚はアプリ層 + トリガーで担保
);

create or replace function check_karte_photo_limit() returns trigger
language plpgsql as $$
begin
  if (select count(*) from karte_photos where karte_id = new.karte_id) >= 20 then
    raise exception 'karte photo limit (20) exceeded';
  end if;
  return new;
end $$;

create trigger karte_photo_limit before insert on karte_photos
  for each row execute function check_karte_photo_limit();

create table karte_memos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  customer_id uuid not null references customers(id),
  staff_id uuid not null references staff(id),
  body text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 会計（確定後不変・打消し伝票方式）
-- ---------------------------------------------------------------
create type payment_status as enum ('draft', 'fixed', 'voided');

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  customer_id uuid references customers(id),
  customer_name text not null default '',
  items jsonb not null default '[]',   -- [{name, kind, price, quantity, staff_id, nominated}]
  tenders jsonb not null default '[]', -- [{kind, label, amount}]
  status payment_status not null default 'draft',
  fixed_at timestamptz,
  reversal_of uuid references payments(id),
  created_at timestamptz not null default now()
);

-- 確定済み伝票の改変禁止（status: fixed→voided の遷移のみ許可）
create or replace function forbid_fixed_payment_update() returns trigger
language plpgsql as $$
begin
  if old.status = 'fixed' then
    if new.status = 'voided'
       and new.items = old.items
       and new.tenders = old.tenders
       and new.fixed_at = old.fixed_at then
      return new; -- 打消し処理による取消マークのみ許可
    end if;
    raise exception 'fixed payments are immutable; use reversal slips';
  end if;
  return new;
end $$;

create trigger payments_immutable before update on payments
  for each row execute function forbid_fixed_payment_update();

create table cashier_closings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  closing_date date not null,
  theoretical_cash int not null,
  counted_cash int not null,
  closed_by uuid not null references staff(id),
  closed_at timestamptz not null default now(),
  unique (salon_id, closing_date)
);

-- ---------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------
alter table kartes enable row level security;
alter table karte_photos enable row level security;
alter table karte_memos enable row level security;
alter table payments enable row level security;
alter table cashier_closings enable row level security;

-- カルテは顧客の所有権に追従（個人所有顧客のカルテは所有者とオーナー/店長のみ）
create policy kartes_access on kartes
  for all using (
    tenant_id = current_tenant_id()
    and exists (
      select 1 from customers c
      where c.id = kartes.customer_id
        and (
          c.owner_type = 'salon'
          or c.owner_staff_id = (current_staff()).id
          or (current_staff()).role in ('owner', 'manager')
        )
    )
  );

create policy karte_photos_access on karte_photos
  for all using (tenant_id = current_tenant_id());

create policy karte_memos_access on karte_memos
  for all using (tenant_id = current_tenant_id());

create policy payments_access on payments
  for all using (tenant_id = current_tenant_id());

-- レジ締めの作成はオーナー / 店長のみ
create policy closings_select on cashier_closings
  for select using (tenant_id = current_tenant_id());

create policy closings_insert on cashier_closings
  for insert with check (
    tenant_id = current_tenant_id()
    and (current_staff()).role in ('owner', 'manager')
  );

-- ============================================================
-- supabase/migrations/0003_messages_counseling_storage.sql
-- ============================================================
-- Phase 1-B/1-D: メッセージ履歴・カウンセリングシート・写真ストレージ

-- ---------------------------------------------------------------
-- メッセージ（LINE送受信はn8n側。本システムは履歴の保存・表示）
-- ---------------------------------------------------------------
create table message_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  customer_id uuid not null references customers(id),
  channel text not null default 'line', -- line | app | mail
  last_message_at timestamptz not null default now(),
  unread int not null default 0
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  thread_id uuid not null references message_threads(id) on delete cascade,
  sender text not null, -- salon | customer | auto
  body text not null,
  sent_at timestamptz not null default now(),
  read boolean not null default false
);

create index messages_thread_idx on messages (thread_id, sent_at);

-- ---------------------------------------------------------------
-- カウンセリングシート（項目はサロン側カスタマイズ / 顧客事前記入）
-- ---------------------------------------------------------------
create table counseling_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  salon_id uuid not null references salons(id),
  title text not null default 'カウンセリングシート',
  -- [{key, label, type: 'text'|'textarea'|'multi', options?: []}]
  fields jsonb not null default '[]',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table counseling_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  form_id uuid not null references counseling_forms(id),
  customer_id uuid references customers(id),
  reservation_id uuid references reservations(id),
  answers jsonb not null default '{}',
  submitted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------
alter table message_threads enable row level security;
alter table messages enable row level security;
alter table counseling_forms enable row level security;
alter table counseling_responses enable row level security;

create policy tenant_isolation_threads on message_threads
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_messages on messages
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_counseling_forms on counseling_forms
  for all using (tenant_id = current_tenant_id());

create policy tenant_isolation_counseling_responses on counseling_responses
  for all using (tenant_id = current_tenant_id());

-- 顧客事前記入は匿名アクセスが必要 → 公開フォームは Edge Function 経由で
-- service_role により書き込む（anon への insert 権限は与えない）

-- ---------------------------------------------------------------
-- カルテ写真ストレージ（非公開バケット。配信は署名付きURL 1時間のみ）
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('karte-photos', 'karte-photos', false)
on conflict (id) do nothing;

-- 認証済みスタッフのみ自テナントのパス（<tenant_id>/...）にアクセス可
create policy karte_photos_read on storage.objects
  for select using (
    bucket_id = 'karte-photos'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  );

create policy karte_photos_write on storage.objects
  for insert with check (
    bucket_id = 'karte-photos'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  );

create policy karte_photos_delete on storage.objects
  for delete using (
    bucket_id = 'karte-photos'
    and (storage.foldername(name))[1] = current_tenant_id()::text
  );

-- ============================================================
-- supabase/migrations/0004_reservation_state_machine.sql
-- ============================================================
-- マスター要件 §63 予約状態遷移 / RESERVATION-008 変更履歴 / RESERVATION-009 キャンセル理由
-- 遷移ルールはアプリ層に加えてDB層のトリガーでも強制する（不正遷移の最終防衛線）

create type cancel_reason as enum
  ('customer_request', 'shop_request', 'no_show', 'duplicate', 'other');

alter table reservations
  add column cancellation_reason cancel_reason;

-- ---------------------------------------------------------------
-- 変更履歴
-- ---------------------------------------------------------------
create table reservation_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  reservation_id uuid not null references reservations(id) on delete cascade,
  before_status reservation_status not null,
  after_status reservation_status not null,
  reason cancel_reason,
  changed_by uuid references staff(id),
  changed_at timestamptz not null default now()
);

create index reservation_history_idx on reservation_history (reservation_id, changed_at desc);

alter table reservation_history enable row level security;

create policy tenant_isolation_reservation_history on reservation_history
  for all using (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------
-- 遷移検証トリガー（§63）
-- 正常系: requested → confirmed → checked_in → in_service → completed
-- 代替系: requested/confirmed → cancelled、confirmed → no_show
-- completed → cancelled は遷移表に存在しないため必ず拒否される
-- ---------------------------------------------------------------
create or replace function check_reservation_transition() returns trigger
language plpgsql as $$
begin
  if old.status = new.status then
    return new;
  end if;
  if not (
    (old.status = 'requested'  and new.status in ('confirmed', 'cancelled')) or
    (old.status = 'confirmed'  and new.status in ('checked_in', 'cancelled', 'no_show')) or
    (old.status = 'checked_in' and new.status = 'in_service') or
    (old.status = 'in_service' and new.status = 'completed')
  ) then
    raise exception 'invalid reservation transition: % -> %', old.status, new.status;
  end if;
  -- 履歴を自動記録
  insert into reservation_history
    (tenant_id, reservation_id, before_status, after_status, reason)
  values
    (new.tenant_id, new.id, old.status, new.status, new.cancellation_reason);
  return new;
end $$;

create trigger reservations_transition before update of status on reservations
  for each row execute function check_reservation_transition();

-- ============================================================
-- supabase/seed.sql
-- ============================================================
-- 初期セットアップ用シード（開店時に1回だけ実行。値は店舗に合わせて書き換える）
-- 実行: supabase db push のあと、SQL Editor か `supabase db query < supabase/seed.sql`

with new_tenant as (
  insert into tenants (name) values ('MANEXION') returning id
),
new_salon as (
  insert into salons (tenant_id, name, open_time, close_time, closed_weekdays, invoice_number)
  select id, 'MAISON BEAUTIY 表参道', '10:00', '20:00', '{1}', 'T1234567890123'
  from new_tenant
  returning id, tenant_id
)
insert into menus (tenant_id, salon_id, category, name, duration_min, price)
select tenant_id, id, m.category, m.name, m.duration_min, m.price
from new_salon,
(values
  ('カット', 'デザインカット', 60, 8800),
  ('カット', '前髪カット', 20, 2200),
  ('カラー', 'フルカラー', 90, 12100),
  ('カラー', 'リタッチカラー', 60, 8250),
  ('パーマ', 'ニュアンスパーマ', 120, 15400),
  ('トリートメント', '髪質改善トリートメント', 60, 9900),
  ('スパ', 'ヘッドスパ 40分', 40, 6600)
) as m(category, name, duration_min, price);

-- スタッフは Supabase Auth でユーザー作成後、auth_user_id を紐付けて INSERT する
-- 例:
-- insert into staff (tenant_id, salon_id, auth_user_id, name, name_kana, role)
-- values ('<tenant_id>', '<salon_id>', '<auth.users.id>', '山田 太郎', 'ヤマダ タロウ', 'owner');

