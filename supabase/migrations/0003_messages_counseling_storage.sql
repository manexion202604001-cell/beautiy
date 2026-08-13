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
