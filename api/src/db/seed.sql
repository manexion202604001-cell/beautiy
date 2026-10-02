-- Seed data for development

-- Create a store
INSERT INTO stores (id, name, address, phone, email) VALUES
('store-1', 'ビューティーサロン 渋谷店', '東京都渋谷区渋谷1-1-1', '03-1234-5678', 'shibuya@salon.example.com');

-- Create business hours for the store
INSERT INTO business_hours (id, store_id, day_of_week, open_time, close_time, is_closed) VALUES
('bh-1', 'store-1', 0, NULL, NULL, 1),  -- Sunday (closed)
('bh-2', 'store-1', 1, '09:00', '19:00', 0),
('bh-3', 'store-1', 2, '09:00', '19:00', 0),
('bh-4', 'store-1', 3, '09:00', '19:00', 0),
('bh-5', 'store-1', 4, '09:00', '19:00', 0),
('bh-6', 'store-1', 5, '09:00', '19:00', 0),
('bh-7', 'store-1', 6, '10:00', '18:00', 0);  -- Saturday (shorter hours)

-- Create staff (password is 'password123' hashed with SHA-256)
-- Note: In production, use bcrypt or argon2
INSERT INTO staff (id, store_id, name, email, password_hash, role, staff_code, email_verified) VALUES
('staff-admin', NULL, 'システム管理者', 'admin@example.com', 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'system_admin', '100001', 1),
('staff-owner', 'store-1', '鈴木 オーナー', 'owner@example.com', 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'owner', '100002', 1),
('staff-manager', 'store-1', '田中 店長', 'manager@example.com', 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'manager', '100003', 1),
('staff-1', 'store-1', '佐藤 美容師', 'sato@example.com', 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'staff', '100004', 1),
('staff-2', 'store-1', '山田 美容師', 'yamada@example.com', 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', 'staff', '100005', 1);

-- Create menus
INSERT INTO menus (id, store_id, category, name, description, duration, price, sort_order) VALUES
('menu-1', 'store-1', 'カット', 'カット', 'シャンプー・ブロー込み', 60, 4500, 1),
('menu-2', 'store-1', 'カット', 'カット（学生）', 'シャンプー・ブロー込み', 60, 3500, 2),
('menu-3', 'store-1', 'カラー', 'カラー（リタッチ）', '根元のカラーリング', 90, 5000, 1),
('menu-4', 'store-1', 'カラー', 'カラー（フル）', '全体カラーリング', 120, 7000, 2),
('menu-5', 'store-1', 'パーマ', 'パーマ', 'カット込み', 150, 12000, 1),
('menu-6', 'store-1', 'パーマ', 'デジタルパーマ', 'カット込み', 180, 15000, 2),
('menu-7', 'store-1', 'トリートメント', 'トリートメント', '髪質改善トリートメント', 30, 3000, 1),
('menu-8', 'store-1', 'セット', 'ヘアセット', '特別な日のスタイリング', 45, 4000, 1);

-- Create customers (password is 'customer123' hashed with SHA-256)
INSERT INTO customers (id, store_id, staff_id, name, name_kana, phone, email, gender, visit_count, password_hash, auth_method) VALUES
('customer-1', 'store-1', 'staff-1', '山本 花子', 'ヤマモト ハナコ', '090-1111-2222', 'hanako@example.com', 'female', 5, 'b041c0aeb35bb0fa4aa668ca5a920b590196fdaf9a00eb852c9b7f4d123cc6d6', 'email'),
('customer-2', 'store-1', 'staff-1', '伊藤 太郎', 'イトウ タロウ', '090-3333-4444', 'taro@example.com', 'male', 3, 'b041c0aeb35bb0fa4aa668ca5a920b590196fdaf9a00eb852c9b7f4d123cc6d6', 'email'),
('customer-3', 'store-1', 'staff-2', '高橋 美咲', 'タカハシ ミサキ', '090-5555-6666', 'misaki@example.com', 'female', 8, 'b041c0aeb35bb0fa4aa668ca5a920b590196fdaf9a00eb852c9b7f4d123cc6d6', 'email'),
('customer-4', 'store-1', NULL, '新規 顧客', 'シンキ コキャク', '090-7777-8888', NULL, NULL, 0, NULL, NULL);  -- Unassigned customer

-- Create some reservations
INSERT INTO reservations (id, store_id, customer_id, staff_id, menu_id, start_at, end_at, status, source) VALUES
('res-1', 'store-1', 'customer-1', 'staff-1', 'menu-1', datetime('now', '+1 day', 'start of day', '+10 hours'), datetime('now', '+1 day', 'start of day', '+11 hours'), 'confirmed', 'web'),
('res-2', 'store-1', 'customer-2', 'staff-1', 'menu-4', datetime('now', '+1 day', 'start of day', '+13 hours'), datetime('now', '+1 day', 'start of day', '+15 hours'), 'pending', 'line'),
('res-3', 'store-1', 'customer-3', 'staff-2', 'menu-5', datetime('now', '+2 days', 'start of day', '+11 hours'), datetime('now', '+2 days', 'start of day', '+13 hours', '+30 minutes'), 'confirmed', 'phone');

-- Create karutes
INSERT INTO karutes (id, store_id, customer_id, staff_id, visit_date, menu_content, hair_condition, color_formula, customer_feedback, next_suggestion, is_shared_to_customer) VALUES
('karute-1', 'store-1', 'customer-1', 'staff-1', date('now', '-7 days'), 'カット・カラー', '少しパサつきあり', '8トーン ナチュラルブラウン + 3%オキシ', '明るくなって満足', '次回はトリートメントも', 1),
('karute-2', 'store-1', 'customer-3', 'staff-2', date('now', '-14 days'), 'デジタルパーマ', '硬めの髪質', 'ロッド：17mm〜23mm', 'ウェーブが綺麗に出た', '2ヶ月後にリタッチパーマ', 1);

-- Create messages
INSERT INTO messages (id, store_id, customer_id, staff_id, direction, message_type, content, source, is_read, sent_at) VALUES
('msg-1', 'store-1', 'customer-1', NULL, 'incoming', 'text', '明日の予約をお願いします', 'line', 1, datetime('now', '-2 days')),
('msg-2', 'store-1', 'customer-1', 'staff-1', 'outgoing', 'text', '承知しました。10時からでよろしいでしょうか？', 'web', 0, datetime('now', '-2 days', '+30 minutes')),
('msg-3', 'store-1', 'customer-1', NULL, 'incoming', 'text', 'はい、お願いします！', 'line', 1, datetime('now', '-2 days', '+1 hour'));

-- Create message templates
INSERT INTO message_templates (id, store_id, name, category, content) VALUES
('tpl-1', 'store-1', '予約確定', 'reminder', '{{customer_name}}様

ご予約が確定しました。

📅 {{reservation_date}}（{{day_of_week}}）{{reservation_time}}
💇 {{menu_name}}
👤 担当：{{staff_name}}

ご来店お待ちしております！
{{store_name}}'),
('tpl-2', 'store-1', '前日リマインド', 'reminder', '{{customer_name}}様

明日のご予約のリマインドです。

📅 {{reservation_date}}（{{day_of_week}}）{{reservation_time}}
💇 {{menu_name}}
👤 担当：{{staff_name}}

ご来店お待ちしております！'),
('tpl-3', 'store-1', 'ご来店お礼', 'thanks', '{{customer_name}}様

本日はご来店いただきありがとうございました！

またのご来店を心よりお待ちしております。
{{store_name}}');
