export type Bindings = {
  DB: D1Database;
  IMAGES: R2Bucket;
  AI: Ai;
  CUSTOMER_APP_URL: string;
  ADMIN_APP_URL: string;
  STAFF_APP_URL: string;
  JWT_SECRET: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  RESEND_API_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  RPI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

export type AuditContext = {
  action?: string;
  entityType?: string;
  entityId?: string;
  summary?: Record<string, unknown>;
};

export type Variables = {
  staff?: Staff;
  customer?: Customer;
  auditContext?: AuditContext;
};

// Database types
export type Staff = {
  id: string;
  store_id: string | null;
  name: string;
  nickname: string | null;
  email: string;
  password_hash: string;
  role: 'system_admin' | 'owner' | 'manager' | 'staff';
  avatar_url: string | null;
  notify_push: number;
  notify_email: number;
  notify_line: number;
  line_notify_token: string | null;
  line_user_id: string | null;
  staff_line_channel_id: string | null;
  staff_line_channel_secret: string | null;
  staff_line_access_token: string | null;
  staff_code: string | null;
  salonboard_staff_id: string | null;
  salonboard_name: string | null;
  lime_name: string | null;
  minimo_name: string | null;
  email_verified: number;
  verification_token: string | null;
  verification_token_expires_at: string | null;
  password_reset_token: string | null;
  password_reset_token_expires_at: string | null;
  login_id: string | null;
  must_change_password: number;
  onboarding_completed: number;
  owner_type: string | null;
  company_name: string | null;
  company_postal_code: string | null;
  company_phone: string | null;
  company_address: string | null;
  company_email: string | null;
  is_active: number;
  is_visible_to_customer: number;
  totp_secret: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Store = {
  id: string;
  name: string;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  line_channel_id: string | null;
  line_channel_secret: string | null;
  line_access_token: string | null;
  line_liff_id: string | null;
  // Hot Pepper Beauty (Salonboard) integration
  salonboard_id: string | null;
  salonboard_password: string | null;
  salonboard_enabled: number;
  hpb_email: string | null;
  // Minimo integration
  minimo_id: string | null;
  minimo_password: string | null;
  minimo_email: string | null;
  // LiME integration
  lime_id: string | null;
  lime_password: string | null;
  // Reservation settings (store-level defaults)
  advance_booking_days: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: number;
  accept_outside_hours: number;
  // Booking period settings (受付期間設定)
  booking_cutoff_type: string;
  booking_cutoff_days_before: number;
  booking_cutoff_time: string | null;
  booking_cutoff_same_day_minutes: number;
  booking_calc_method: string;
  created_at: string;
  updated_at: string;
};

export type Customer = {
  id: string;
  store_id: string;
  staff_id: string | null;
  name: string;
  name_kana: string | null;
  phone: string | null;
  email: string | null;
  password_hash: string | null;
  auth_method: 'line' | 'email' | 'both' | null;
  gender: 'male' | 'female' | 'other' | null;
  birthday: string | null;
  occupation: string | null;
  postal_code: string | null;
  address: string | null;
  memo: string | null;
  first_visit_at: string | null;
  last_visit_at: string | null;
  visit_count: number;
  origin: 'staff' | 'store';
  master_id: string | null;
  created_at: string;
  updated_at: string;
};

export type MenuCategory = {
  id: string;
  store_id: string;
  name: string;
  color: string;
  sort_order: number;
  parent_id: string | null;
  salonboard_equipment_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Menu = {
  id: string;
  store_id: string;
  category: string;
  name: string;
  description: string | null;
  image_url: string | null;
  duration: number;
  price: number;
  price_new: number | null;
  sort_order: number;
  coupon_type: 'new' | 'repeat' | 'all' | null;
  is_active: number;
  sub_categories: string | null;
  price_tilde: number;
  created_at: string;
  updated_at: string;
};

export type Reservation = {
  id: string;
  store_id: string;
  customer_id: string;
  staff_id: string;
  menu_id: string;
  start_at: string;
  end_at: string;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'noshow';
  memo: string | null;
  cancel_reason: string | null;
  reminder_sent_at: string | null;
  source: 'web' | 'line' | 'phone' | 'walk-in' | 'hotpepper' | 'minimo';
  hotpepper_id: string | null; // Hot Pepper Beauty reservation ID
  minimo_id: string | null; // Minimo reservation ID
  salonboard_synced: number; // 0=not synced, 1=synced, -1=error
  salonboard_synced_at: string | null;
  salonboard_sync_error: string | null;
  created_at: string;
  updated_at: string;
};

export type Karute = {
  id: string;
  store_id: string;
  customer_id: string;
  reservation_id: string | null;
  staff_id: string;
  visit_date: string;
  menu_content: string | null;
  hair_condition: string | null;
  color_formula: string | null;
  perm_info: string | null;
  styling_notes: string | null;
  customer_feedback: string | null;
  next_suggestion: string | null;
  internal_memo: string | null;
  face_drawing: string | null;
  memo: string | null;
  assistant_memo: string | null;
  is_shared_to_customer: number;
  shared_at: string | null;
  created_at: string;
  updated_at: string;
};

export type KaruteMenu = {
  id: string;
  karute_id: string;
  menu_id: string | null;
  menu_name: string;
  price: number;
  sort_order: number;
  created_at: string;
};

export type KaruteImage = {
  id: string;
  karute_id: string;
  image_url: string;
  image_type: 'before' | 'after' | 'other';
  caption: string | null;
  sort_order: number;
  created_at: string;
};

export type Message = {
  id: string;
  store_id: string;
  customer_id: string;
  staff_id: string | null;
  direction: 'incoming' | 'outgoing';
  message_type: 'text' | 'image' | 'sticker' | 'audio' | 'video' | 'file' | 'location';
  content: string | null;
  line_message_id: string | null;
  source: 'line' | 'web';
  is_read: number;
  sent_at: string;
  created_at: string;
};

export type BusinessHours = {
  id: string;
  store_id: string;
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: number;
  max_concurrent: number | null;
};

export type Notification = {
  id: string;
  staff_id: string;
  type: 'new_message' | 'new_reservation' | 'reservation_cancelled' | 'reminder' | 'system';
  title: string;
  body: string | null;
  link_url: string | null;
  is_read: number;
  created_at: string;
};

export type StaffStore = {
  id: string;
  staff_id: string;
  store_id: string;
  is_primary: number;
  created_at: string;
};

export type StaffBusinessHours = {
  id: string;
  staff_id: string;
  store_id: string;
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: number;
};

export type StaffReservationSettings = {
  id: string;
  staff_id: string;
  store_id: string;
  advance_booking_days: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: number;
  accept_outside_hours: number;
  // Booking period settings (NULL = store fallback)
  booking_cutoff_type: string | null;
  booking_cutoff_days_before: number | null;
  booking_cutoff_time: string | null;
  booking_cutoff_same_day_minutes: number | null;
  booking_calc_method: string | null;
  created_at: string;
  updated_at: string;
};

export type StoreClosure = {
  id: string;
  store_id: string;
  date: string;
  reason: string | null;
  created_at: string;
};

export type Equipment = {
  id: string;
  store_id: string;
  name: string;
  quantity: number;
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type MenuEquipment = {
  id: string;
  menu_id: string;
  equipment_id: string;
  created_at: string;
};

export type StaffBlock = {
  id: string;
  staff_id: string;
  store_id: string | null;
  date: string;
  is_all_day: number;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
};
