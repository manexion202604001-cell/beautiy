-- Salon Management System Database Schema (Cloudflare D1 / SQLite)
-- 完全なスキーマ（migration-*.sql をすべて適用済みの状態）。新規環境はこのファイルだけで構築できる。
-- 既存DBの更新には migration-*.sql を使う。スキーマを変更したら両方を更新すること。
-- 生成: 旧 schema.sql + 全マイグレーションを適用したDBの sqlite_master から出力

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,   -- 会員番号の接頭辞（例: "A01"）
    name TEXT NOT NULL,          -- 表示名（例: "fein."）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    group_id TEXT REFERENCES groups(id),
    name TEXT NOT NULL,
    postal_code TEXT,
    address TEXT,
    phone TEXT,
    email TEXT,
    line_channel_id TEXT,
    line_channel_secret TEXT,
    line_access_token TEXT,
    line_liff_id TEXT,
    -- Hot Pepper Beauty (Salonboard) integration
    salonboard_id TEXT,
    salonboard_password TEXT,
    salonboard_enabled INTEGER DEFAULT 0,
    hpb_email TEXT,
    -- Minimo integration
    minimo_id TEXT,
    minimo_password TEXT,
    minimo_email TEXT,
    -- LiME integration
    lime_id TEXT,
    lime_password TEXT,
    -- Seat capacity alert
    seat_limit INTEGER DEFAULT 0,
    enable_seat_alert INTEGER DEFAULT 0,
    -- Booking period settings (受付期間設定)
    booking_cutoff_type TEXT DEFAULT 'same_day',        -- 'same_day' | 'days_before'
    booking_cutoff_days_before INTEGER DEFAULT 0,       -- N日前（days_before時）
    booking_cutoff_time TEXT,                            -- 締切時刻（例: '18:00'）
    booking_cutoff_same_day_minutes INTEGER DEFAULT 60,  -- 当日締切（分）0=直前,30=30分前,60=1時間前
    booking_calc_method TEXT DEFAULT 'calendar',         -- 'calendar' | 'business_days'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    line_friend_url TEXT,
    advance_booking_days INTEGER DEFAULT 365,
    advance_booking_months INTEGER DEFAULT 4,
    same_day_cutoff_hours INTEGER DEFAULT 1,
    max_concurrent INTEGER DEFAULT 1,
    accept_same_start_time INTEGER DEFAULT 0,
    accept_outside_hours INTEGER DEFAULT 0,
    holiday_hours_enabled INTEGER DEFAULT 0,
    salonboard_restart_requested INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS business_hours (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL,  -- 0=日, 1=月, ..., 6=土, 7=祝日
    open_time TEXT,
    close_time TEXT,
    is_closed INTEGER DEFAULT 0,
    max_concurrent INTEGER,  -- 曜日別受付可能数（NULLの場合はストア設定を使用）
    UNIQUE(store_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    nickname TEXT,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('system_admin', 'owner', 'manager', 'staff')),
    avatar_url TEXT,
    notify_push INTEGER DEFAULT 1,
    notify_email INTEGER DEFAULT 0,
    notify_line INTEGER DEFAULT 0,
    line_notify_token TEXT,
    staff_code TEXT UNIQUE,
    salonboard_staff_id TEXT,
    lime_name TEXT,
    minimo_name TEXT,
    email_verified INTEGER DEFAULT 0,
    verification_token TEXT,
    verification_token_expires_at TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    line_user_id TEXT,
    totp_secret TEXT,
    password_reset_token TEXT,
    password_reset_token_expires_at TEXT,
    salonboard_name TEXT,
    owner_type TEXT DEFAULT NULL,
    company_name TEXT DEFAULT NULL,
    company_postal_code TEXT DEFAULT NULL,
    company_phone TEXT DEFAULT NULL,
    company_address TEXT DEFAULT NULL,
    company_email TEXT DEFAULT NULL,
    login_id TEXT DEFAULT NULL,
    must_change_password INTEGER DEFAULT 0,
    onboarding_completed INTEGER DEFAULT 1,
    staff_line_channel_id TEXT,
    staff_line_channel_secret TEXT,
    staff_line_access_token TEXT,
    retired_at TEXT,
    is_visible_to_customer INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS staff_stores (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    is_primary INTEGER DEFAULT 0,  -- 主要店舗フラグ
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), is_visible_to_customer INTEGER DEFAULT 1,
    UNIQUE(staff_id, store_id)
);

CREATE TABLE IF NOT EXISTS store_invitations (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    invited_by TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
    role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('owner', 'manager', 'staff')),
    responded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    name_kana TEXT,
    phone TEXT,
    email TEXT,
    password_hash TEXT,
    auth_method TEXT CHECK(auth_method IN ('line', 'email', 'both')),
    gender TEXT CHECK(gender IN ('male', 'female', 'other')),
    birthday TEXT,
    occupation TEXT,
    postal_code TEXT,
    address TEXT,
    memo TEXT,
    first_visit_at TEXT,
    last_visit_at TEXT,
    visit_count INTEGER DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'store' CHECK(origin IN ('staff', 'store')),
    master_id TEXT REFERENCES customer_master(id) ON DELETE SET NULL,  -- 店舗跨ぎ会員番号（人物マスタ）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_minimo INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_master (
    id TEXT PRIMARY KEY,                  -- UUID（customers.master_id のFKターゲット）
    group_id TEXT NOT NULL REFERENCES groups(id),
    seq INTEGER NOT NULL,                 -- グループ内連番（member_no の元）
    member_no TEXT NOT NULL,              -- 例: "A01-M-0000123"
    -- 統合で廃番になった番号は削除せず、統合先マスタを指して残す。旧番号でSalonboardに
    -- 登録済みの顧客を引き当て直せるようにするため（番号の再発行も防ぐ）。
    merged_into TEXT REFERENCES customer_master(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, seq),
    UNIQUE(member_no)
);

CREATE TABLE IF NOT EXISTS sb_member_no_updates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT,
    customer_name TEXT,
    old_member_no TEXT NOT NULL,
    new_member_no TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at TEXT
);

CREATE TABLE IF NOT EXISTS customer_master_seq (
    group_id TEXT PRIMARY KEY REFERENCES groups(id),
    next_val INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_staff (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    is_primary INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(customer_id, staff_id)
);

CREATE TABLE IF NOT EXISTS customer_line (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,  -- どの店舗（プロバイダー）のLINE連携か
    line_user_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    picture_url TEXT,
    is_blocked INTEGER DEFAULT 0,
    linked_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    registration_status TEXT NOT NULL DEFAULT 'completed',
    UNIQUE(customer_id, store_id)  -- 1顧客・1店舗につきLINEは1つ
);

CREATE TABLE IF NOT EXISTS menu_categories (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6B7280',
    sort_order INTEGER DEFAULT 0,
    parent_id TEXT,  -- NULL=親カテゴリ, 値あり=子カテゴリ
    salonboard_equipment_id TEXT, -- HPB設備ID (e.g. EQ00000000231713)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(store_id, name)
);

CREATE TABLE IF NOT EXISTS menus (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    duration INTEGER NOT NULL,
    price INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0,
    coupon_type TEXT,
    is_active INTEGER DEFAULT 1,
    menu_type TEXT DEFAULT 'regular',
    presentation_condition TEXT,
    usage_condition TEXT,
    expiry_date TEXT,
    is_bookable INTEGER DEFAULT 1,
    sub_categories TEXT,  -- JSON array of all selected category names
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    price_new INTEGER,
    price_tilde INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_staff (
    id TEXT PRIMARY KEY,
    menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(menu_id, staff_id)
);

CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    menu_id TEXT REFERENCES menus(id) ON DELETE SET NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'completed', 'cancelled', 'noshow')),
    memo TEXT,
    cancel_reason TEXT,
    reminder_sent_at TEXT,
    source TEXT DEFAULT 'web' CHECK(source IN ('web', 'line', 'phone', 'walk-in', 'hotpepper', 'minimo')),
    hotpepper_id TEXT, -- Hot Pepper Beauty reservation ID
    salonboard_synced INTEGER DEFAULT 0, -- 0=not synced, 1=synced, -1=error
    salonboard_synced_at TEXT,
    salonboard_sync_error TEXT,
    salonboard_synced_staff_id TEXT, -- staff_id at last sync, for staff-change detection
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    hpb_staff_check INTEGER NOT NULL DEFAULT 0,
    is_new_customer INTEGER,
    lime_menu_name TEXT,
    minimo_id TEXT,
    salonboard_route TEXT,
    week_reminder_sent_at TEXT,
    is_nominated INTEGER NOT NULL DEFAULT 0,
    reviewed_at TEXT,
    salonboard_cancel_synced INTEGER DEFAULT 0,
    salonboard_synced_menu_names TEXT,
    salonboard_reserve_id TEXT,
    salonboard_synced_start_at TEXT,
    salonboard_synced_end_at TEXT
);

CREATE TABLE IF NOT EXISTS karutes (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    visit_date TEXT NOT NULL,
    menu_content TEXT,
    hair_condition TEXT,
    color_formula TEXT,
    perm_info TEXT,
    styling_notes TEXT,
    customer_feedback TEXT,
    next_suggestion TEXT,
    internal_memo TEXT,
    is_shared_to_customer INTEGER DEFAULT 0,
    shared_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    memo TEXT,
    assistant_memo TEXT,
    face_drawing TEXT
);

CREATE TABLE IF NOT EXISTS karute_images (
    id TEXT PRIMARY KEY,
    karute_id TEXT NOT NULL REFERENCES karutes(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    image_type TEXT NOT NULL CHECK(image_type IN ('before', 'after', 'other')),
    caption TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_templates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('reminder', 'thanks', 'campaign', 'birthday', 'other')),
    content TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('new_message', 'new_reservation', 'reservation_cancelled', 'reminder', 'system')),
    title TEXT NOT NULL,
    body TEXT,
    link_url TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    subscription_json TEXT NOT NULL,
    user_agent TEXT,
    device_name TEXT,
    is_active INTEGER DEFAULT 1,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(staff_id, endpoint)
);

CREATE TABLE IF NOT EXISTS staff_business_hours (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL,  -- 0=日, 1=月, ..., 6=土
    open_time TEXT,
    close_time TEXT,
    is_closed INTEGER DEFAULT 0,
    UNIQUE(staff_id, store_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS staff_reservation_settings (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    advance_booking_days INTEGER DEFAULT 365,
    same_day_cutoff_hours INTEGER DEFAULT 1,
    max_concurrent INTEGER DEFAULT 1,
    accept_same_start_time INTEGER DEFAULT 0,
    accept_outside_hours INTEGER DEFAULT 0,
    -- Booking period settings (NULL = 店舗設定にフォールバック)
    booking_cutoff_type TEXT,
    booking_cutoff_days_before INTEGER,
    booking_cutoff_time TEXT,
    booking_cutoff_same_day_minutes INTEGER,
    booking_calc_method TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(staff_id, store_id)
);

CREATE TABLE IF NOT EXISTS equipment (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(store_id, name)
);

CREATE TABLE IF NOT EXISTS menu_equipment (
    id TEXT PRIMARY KEY,
    menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(menu_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS staff_blocks (
    id TEXT PRIMARY KEY,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,  -- NULLなら全店舗に適用
    date TEXT NOT NULL,           -- YYYY-MM-DD
    is_all_day INTEGER DEFAULT 1,
    start_time TEXT,              -- HH:MM (is_all_day=1の場合はNULL)
    end_time TEXT,                -- HH:MM (is_all_day=1の場合はNULL)
    reason TEXT,
    salonboard_synced INTEGER DEFAULT 0,        -- 0=未連携, 1=連携済, -1=エラー, 3=変更待ち, 4=削除待ち
    salonboard_sync_error TEXT,
    salonboard_synced_at TEXT,
    salonboard_synced_date TEXT,                -- SBに登録した日付(YYYY-MM-DD)。変更/削除時の検索に使う
    salonboard_synced_start_time TEXT,          -- SBに登録した開始時刻(HH:MM)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS store_closures (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    date TEXT NOT NULL,           -- YYYY-MM-DD
    reason TEXT,                  -- 理由（任意）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(store_id, date)
);

CREATE TABLE IF NOT EXISTS counseling_sheets (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(store_id, customer_id)
);

CREATE TABLE IF NOT EXISTS walkin_intakes (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,   -- QRに紐づくスタッフ
    consent_record_id TEXT REFERENCES consent_records(id),
    customer_name TEXT NOT NULL DEFAULT '',
    customer_name_kana TEXT,
    customer_phone TEXT,
    customer_birthday TEXT,
    customer_gender TEXT CHECK(customer_gender IN ('male','female','other')),
    counseling_data TEXT,                 -- JSON、カウンセリング提出までNULL
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','linked','created','discarded')),
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,  -- resolve時に設定
    consent_submitted_at TEXT,
    counseling_submitted_at TEXT,
    resolved_at TEXT,
    resolved_by TEXT REFERENCES staff(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_merge_candidates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    line_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    existing_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    line_display_name TEXT,
    match_type TEXT NOT NULL CHECK(match_type IN ('name', 'phone', 'name_kana')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'merged', 'skipped')),
    resolved_by TEXT REFERENCES staff(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(line_customer_id, existing_customer_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    staff_name TEXT,
    staff_role TEXT,
    store_id TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    route_pattern TEXT,
    action TEXT,
    entity_type TEXT,
    entity_id TEXT,
    status_code INTEGER NOT NULL,
    request_summary TEXT,
    ip_address TEXT,
    user_agent TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hpb_emails (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body_text TEXT,
    body_html TEXT,
    store_id TEXT,
    is_read INTEGER DEFAULT 0,
    process_status TEXT,
    process_error TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reservation_logs (
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('staff', 'customer', 'system')),
    actor_id TEXT,
    actor_name TEXT,
    description TEXT NOT NULL,
    changes TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS name_duplicate_dismissed (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    dismissed_by TEXT NOT NULL,
    dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (store_id) REFERENCES stores(id),
    FOREIGN KEY (dismissed_by) REFERENCES staff(id)
);

CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    email TEXT,
    staff_id TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    reason TEXT,            -- success | retired_or_inactive_account | no_account | wrong_password
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing', 'system')),
    message_type TEXT NOT NULL CHECK(message_type IN ('text', 'image', 'sticker', 'audio', 'video', 'file', 'location')),
    content TEXT,
    line_message_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('line', 'web')) DEFAULT 'line',
    is_read INTEGER DEFAULT 0,
    sent_by_staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL,
    sent_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consent_templates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    sections TEXT NOT NULL,
    form_fields TEXT,
    version TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consent_records (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES consent_templates(id),
    store_id TEXT NOT NULL REFERENCES stores(id),
    customer_name TEXT NOT NULL,
    customer_birthday TEXT,
    customer_phone TEXT,
    customer_occupation TEXT,
    customer_visit_reason TEXT,
    template_snapshot TEXT NOT NULL,
    agreed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reservation_id TEXT REFERENCES reservations(id)
);

CREATE TABLE IF NOT EXISTS intake_sessions (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id),
    staff_id TEXT REFERENCES staff(id),
    line_user_id TEXT NOT NULL,
    customer_id TEXT REFERENCES customers(id),
    session_type TEXT CHECK(session_type IN ('new', 'returning')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'name_input', 'consent', 'counseling', 'completed')),
    name TEXT,
    name_kana TEXT,
    gender TEXT CHECK(gender IN ('male', 'female', 'other')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS karute_menus (
    id TEXT PRIMARY KEY,
    karute_id TEXT NOT NULL REFERENCES karutes(id) ON DELETE CASCADE,
    menu_id TEXT REFERENCES menus(id) ON DELETE SET NULL,
    menu_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS line_sessions (
    line_user_id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    staff_id TEXT,
    menu_id TEXT,
    customer_type TEXT,
    date TEXT,
    time TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservation_menus (
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    menu_id TEXT REFERENCES menus(id) ON DELETE SET NULL,
    menu_name TEXT NOT NULL,
    duration INTEGER NOT NULL,
    price INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff_menus (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL,
  price INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);


CREATE INDEX IF NOT EXISTS idx_stores_group ON stores(group_id);

CREATE INDEX IF NOT EXISTS idx_staff_store ON staff(store_id);
CREATE INDEX IF NOT EXISTS idx_staff_email ON staff(email);

CREATE INDEX IF NOT EXISTS idx_staff_stores_staff ON staff_stores(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_stores_store ON staff_stores(store_id);

CREATE INDEX IF NOT EXISTS idx_store_invitations_staff ON store_invitations(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_store_invitations_store ON store_invitations(store_id);

CREATE INDEX IF NOT EXISTS idx_customers_store ON customers(store_id);
CREATE INDEX IF NOT EXISTS idx_customers_staff ON customers(staff_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name_kana ON customers(name_kana);
CREATE INDEX IF NOT EXISTS idx_customers_master ON customers(master_id);
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(updated_at);

CREATE INDEX IF NOT EXISTS idx_customer_master_merged ON customer_master(merged_into);

CREATE INDEX IF NOT EXISTS idx_sb_member_no_pending ON sb_member_no_updates(store_id) WHERE status = 0;

CREATE INDEX IF NOT EXISTS idx_customer_staff_customer ON customer_staff(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_staff_staff ON customer_staff(staff_id);

CREATE INDEX IF NOT EXISTS idx_customer_line_user ON customer_line(line_user_id);
CREATE INDEX IF NOT EXISTS idx_customer_line_customer_store ON customer_line(customer_id, store_id);

CREATE INDEX IF NOT EXISTS idx_menu_categories_store ON menu_categories(store_id);

CREATE INDEX IF NOT EXISTS idx_menus_store ON menus(store_id);
CREATE INDEX IF NOT EXISTS idx_menus_category ON menus(store_id, category);

CREATE INDEX IF NOT EXISTS idx_menu_staff_menu ON menu_staff(menu_id);
CREATE INDEX IF NOT EXISTS idx_menu_staff_staff ON menu_staff(staff_id);

CREATE INDEX IF NOT EXISTS idx_reservations_store_date ON reservations(store_id, start_at);
CREATE INDEX IF NOT EXISTS idx_reservations_staff_date ON reservations(staff_id, start_at);
CREATE INDEX IF NOT EXISTS idx_reservations_customer ON reservations(customer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_r_sb_pending_reg ON reservations(store_id)
  WHERE salonboard_synced = 0;
CREATE INDEX IF NOT EXISTS idx_r_sb_pending_verify ON reservations(store_id)
  WHERE salonboard_synced = 2 AND status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_r_sb_stale_err ON reservations(store_id)
  WHERE salonboard_synced = 1 AND salonboard_sync_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_karutes_customer ON karutes(customer_id);
CREATE INDEX IF NOT EXISTS idx_karutes_store_date ON karutes(store_id, visit_date);

CREATE INDEX IF NOT EXISTS idx_karute_images_karute ON karute_images(karute_id);

CREATE INDEX IF NOT EXISTS idx_message_templates_store ON message_templates(store_id);

CREATE INDEX IF NOT EXISTS idx_notifications_staff ON notifications(staff_id, is_read, created_at);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_staff ON push_subscriptions(staff_id);

CREATE INDEX IF NOT EXISTS idx_staff_bh_staff_store ON staff_business_hours(staff_id, store_id);
CREATE INDEX IF NOT EXISTS idx_staff_bh_store ON staff_business_hours(store_id);

CREATE INDEX IF NOT EXISTS idx_staff_rs_staff_store ON staff_reservation_settings(staff_id, store_id);

CREATE INDEX IF NOT EXISTS idx_equipment_store ON equipment(store_id);

CREATE INDEX IF NOT EXISTS idx_menu_equipment_menu ON menu_equipment(menu_id);
CREATE INDEX IF NOT EXISTS idx_menu_equipment_equipment ON menu_equipment(equipment_id);

CREATE INDEX IF NOT EXISTS idx_staff_blocks_staff_date ON staff_blocks(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_staff_blocks_store_date ON staff_blocks(store_id, date);

CREATE INDEX IF NOT EXISTS idx_store_closures_store_date ON store_closures(store_id, date);

CREATE INDEX IF NOT EXISTS idx_counseling_sheets_customer ON counseling_sheets(customer_id);
CREATE INDEX IF NOT EXISTS idx_counseling_sheets_store ON counseling_sheets(store_id);

CREATE INDEX IF NOT EXISTS idx_walkin_store_status ON walkin_intakes(store_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_walkin_name ON walkin_intakes(customer_name);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_store_status
  ON customer_merge_candidates(store_id, status);

CREATE INDEX IF NOT EXISTS idx_audit_logs_staff ON audit_logs(staff_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_store ON audit_logs(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_hpb_emails_recipient ON hpb_emails(recipient);
CREATE INDEX IF NOT EXISTS idx_hpb_emails_received ON hpb_emails(received_at);

CREATE INDEX IF NOT EXISTS idx_reservation_logs_reservation ON reservation_logs(reservation_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_name_dup_dismissed_store_name ON name_duplicate_dismissed(store_id, normalized_name);

CREATE INDEX IF NOT EXISTS idx_login_attempts_staff ON login_attempts(staff_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at);

CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_store_date ON messages(store_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_customer_staff ON messages(customer_id, staff_id, sent_at);

CREATE INDEX IF NOT EXISTS idx_consent_templates_store ON consent_templates(store_id, is_active);

CREATE INDEX IF NOT EXISTS idx_consent_records_template ON consent_records(template_id);
CREATE INDEX IF NOT EXISTS idx_consent_records_store ON consent_records(store_id, agreed_at);

CREATE INDEX IF NOT EXISTS idx_intake_sessions_line_user ON intake_sessions(line_user_id, store_id);
CREATE INDEX IF NOT EXISTS idx_intake_sessions_status ON intake_sessions(status, store_id);

CREATE INDEX IF NOT EXISTS idx_karute_menus_karute ON karute_menus(karute_id);

CREATE INDEX IF NOT EXISTS idx_reservations_minimo_id ON reservations(minimo_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_login_id ON staff(login_id) WHERE login_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rate_limits_key_timestamp ON rate_limits (key, timestamp);

CREATE INDEX IF NOT EXISTS idx_reservation_menus_reservation ON reservation_menus(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_menus_menu ON reservation_menus(menu_id);

CREATE INDEX IF NOT EXISTS idx_staff_menus_staff ON staff_menus(staff_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_code ON staff(staff_code);

CREATE INDEX IF NOT EXISTS idx_r_sb_pending_cancel ON reservations(store_id)
  WHERE salonboard_synced = 1 AND salonboard_reserve_id IS NOT NULL
    AND salonboard_cancel_synced = 0 AND status = 'cancelled';
CREATE INDEX IF NOT EXISTS idx_r_sb_pending_timechg ON reservations(store_id)
  WHERE salonboard_synced = 1 AND salonboard_reserve_id IS NOT NULL
    AND salonboard_cancel_synced = 0 AND salonboard_sync_error IS NULL
    AND (start_at <> salonboard_synced_start_at OR end_at <> salonboard_synced_end_at);
CREATE INDEX IF NOT EXISTS idx_r_sb_pending_staffchg ON reservations(store_id)
  WHERE salonboard_cancel_synced = 0 AND status <> 'cancelled'
    AND salonboard_synced_staff_id IS NOT NULL
    AND staff_id <> salonboard_synced_staff_id
    AND salonboard_sync_error IS NULL;

CREATE INDEX IF NOT EXISTS idx_consent_records_reservation ON consent_records(reservation_id);
