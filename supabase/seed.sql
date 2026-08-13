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
