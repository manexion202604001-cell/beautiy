/** Response/request types mirroring apps/api (snake_case rows are passed through as-is by the API). */

export type Page<T> = { items: T[]; nextCursor: string | null };

// ---------------------------------------------------------------- auth / org
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  organizationId: string;
  staffId: string;
}

export interface OrgRef {
  id: string;
  name: string;
  slug: string;
}

export type LoginResult =
  | ({ status: 'authenticated' } & TokenPair)
  | { status: 'organization_required'; organizations: OrgRef[] }
  | {
      status: 'mfa_required';
      challengeId: string;
      channel: 'email';
      destination: string;
      devCode?: string;
    };

export interface Me {
  user: {
    id: string;
    email: string;
    display_name: string | null;
    mfa_enabled: boolean;
    last_login_at: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    timezone: string;
    currency: string;
  };
  staff: {
    id: string;
    display_name: string;
    color: string;
    title: string | null;
    role_id: string;
    role_key: string;
    role_name: string;
  };
  organizations: OrgRef[];
  permissions: string[];
  shopIds: string[];
  allShops: boolean;
}

export interface BookingSettings {
  slotIntervalMin: number;
  leadTimeMin: number;
  horizonDays: number;
  cancelDeadlineHours: number;
  allowStaffSelection: boolean;
  requireApproval: boolean;
  maxServicesPerBooking: number;
  autoAssignFree: boolean;
}

export interface ShopSettings {
  booking: BookingSettings;
  reminders: {
    enabled: boolean;
    confirmation: boolean;
    dayBeforeHour: number;
    sameDayHoursBefore: number;
  };
  pos: {
    pointRateBp: number;
    pointExpiryDays: number;
    roundingMode: 'floor' | 'round' | 'ceil';
    receiptFooter: string;
    requireOpenRegister: boolean;
  };
  review: { autoRequest: boolean; requestDelayHours: number; googleReviewUrl?: string };
}

export interface Shop {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  phone: string | null;
  email: string | null;
  postal_code: string | null;
  prefecture: string | null;
  city: string | null;
  address_line: string | null;
  description: string | null;
  status: 'active' | 'inactive' | 'closed';
  public_booking_enabled: boolean;
  settings: ShopSettings;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  currency: string;
  timezone: string;
  invoice_registration_number: string | null;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface PublicProfile {
  bio?: string;
  specialties?: string[];
  instagram?: string;
  photoFileId?: string;
  yearsOfExperience?: number;
}

export interface Staff {
  id: string;
  user_id: string | null;
  role_id: string;
  display_name: string;
  display_name_kana: string | null;
  email: string | null;
  phone: string | null;
  employment_type: 'full_time' | 'part_time' | 'contractor' | 'owner';
  title: string | null;
  color: string;
  is_bookable: boolean;
  nomination_fee: number;
  public_profile: PublicProfile;
  public_slug: string | null;
  sort_order: number;
  status: 'invited' | 'active' | 'inactive' | 'retired';
  hired_on: string | null;
  retired_on: string | null;
  created_at: string;
  role: { id: string; key: string; name: string } | null;
  shops: { shop_id: string; is_primary: boolean; started_on: string | null }[];
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
}

export interface PermissionDef {
  key: string;
  label: string;
}

// ---------------------------------------------------------------- customers
export interface Tag {
  id: string;
  name: string;
  color: string;
  customer_count?: number;
}

export interface CustomerListItem {
  id: string;
  customer_number: string | null;
  last_name: string;
  first_name: string;
  last_name_kana: string;
  first_name_kana: string;
  gender: string | null;
  birthday: string | null;
  phone: string | null;
  email: string | null;
  primary_shop_id: string | null;
  primary_staff_id: string | null;
  first_visit_at: string | null;
  last_visit_at: string | null;
  visit_count: number;
  total_sales: number;
  avg_cycle_days: number | null;
  next_appointment_at: string | null;
  point_balance: number;
  status: string;
  marketing_opt_in: boolean;
  created_at: string;
  display_name: string;
  tags: Tag[];
}

export interface CustomerDetail extends CustomerListItem {
  postal_code: string | null;
  address: string | null;
  occupation: string | null;
  acquisition_source: string | null;
  attributes: Record<string, unknown>;
  merged_into_id: string | null;
  no_show_count: number;
  cancel_count: number;
  identities: {
    id: string;
    provider: string;
    provider_account_id: string;
    external_id: string;
    display_name: string | null;
    is_following: boolean;
    linked_at: string;
  }[];
  relations: {
    id: string;
    shop_id: string;
    staff_id: string | null;
    staff_name: string | null;
    relation_type: string;
    started_at: string;
  }[];
  score: Record<string, unknown> | null;
}

export interface DuplicateCandidate {
  customerId: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  lastVisitAt: string | null;
  visitCount: number;
  strength: 'exact' | 'similar';
  score: number;
  reasons: string[];
}

export interface DuplicatePairCustomer {
  id: string;
  last_name: string;
  first_name: string;
  last_name_kana: string;
  first_name_kana: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  last_visit_at: string | null;
  visit_count: number;
}

export interface DuplicatePair {
  a: DuplicatePairCustomer;
  b: DuplicatePairCustomer;
  strength: 'exact' | 'similar';
  score: number;
  reasons: string[];
}

export interface CustomerVisit {
  id: string;
  shop_id: string;
  shop_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  is_nominated: boolean;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source: string;
  estimated_total: number;
  services: { name: string; price: number; duration_min: number }[];
  transaction: { id: string; total: number; status: string; completed_at: string | null } | null;
}

export interface TimelineEntry {
  kind: 'appointment' | 'transaction' | 'karte' | 'message' | 'review' | 'form';
  id: string;
  at: string;
  summary: string;
  ref: Record<string, unknown>;
}

export interface Memo {
  id: string;
  body: string;
  visibility: 'shared' | 'private';
  pinned: boolean;
  staff_id: string;
  staff_name?: string;
  created_at: string;
  updated_at?: string;
}

export interface MergeLog {
  id: string;
  source_customer_id: string;
  target_customer_id: string;
  reason: string | null;
  match_rule: string | null;
  merged_by: string | null;
  merged_at: string;
  undone_at: string | null;
  undone_by: string | null;
}

export interface CustomerInput {
  customerNumber?: string | null;
  lastName?: string;
  firstName?: string;
  lastNameKana?: string;
  firstNameKana?: string;
  gender?: 'female' | 'male' | 'other' | 'unknown' | null;
  birthday?: string | null;
  phone?: string | null;
  email?: string | null;
  postalCode?: string | null;
  address?: string | null;
  occupation?: string | null;
  acquisitionSource?: string | null;
  primaryShopId?: string | null;
  primaryStaffId?: string | null;
  marketingOptIn?: boolean;
  tagIds?: string[];
  status?: 'active' | 'blocked';
}

// ---------------------------------------------------------------- catalog
export interface MenuCategory {
  id: string;
  shop_id: string | null;
  name: string;
  sort_order: number;
}

/** GET /menus?shopId= (effective menus, camelCase) */
export interface EffectiveMenu {
  id: string;
  shopId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  price: number;
  priceTaxIncluded: boolean;
  taxRateBp: number;
  isPublic: boolean;
  isConsultation: boolean;
  newCustomerOnly: boolean;
  sortOrder: number;
  status: 'active' | 'inactive' | 'unavailable';
  isOverridden: boolean;
  resourceRequirements: { resourceType: string; offsetMin: number; durationMin: number | null }[];
  staffIds: string[];
}

/** GET /menus/:id (raw row + relations) */
export interface MenuDetail {
  id: string;
  shop_id: string | null;
  category_id: string | null;
  name: string;
  description: string | null;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  price: number;
  price_tax_included: boolean;
  tax_rate_bp: number;
  is_public: boolean;
  is_consultation: boolean;
  new_customer_only: boolean;
  sort_order: number;
  status: 'active' | 'inactive';
  resourceRequirements: {
    resource_type: string;
    offset_min: number;
    duration_min: number | null;
  }[];
  staff: { staff_id: string; duration_min: number | null; price: number | null }[];
  overrides: {
    shop_id: string;
    price: number | null;
    duration_min: number | null;
    is_available: boolean;
  }[];
}

export interface MenuInput {
  shopId?: string | null;
  categoryId?: string | null;
  name?: string;
  description?: string | null;
  durationMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  price?: number;
  priceTaxIncluded?: boolean;
  taxRateBp?: number;
  isPublic?: boolean;
  isConsultation?: boolean;
  newCustomerOnly?: boolean;
  sortOrder?: number;
  resourceRequirements?: { resourceType: string; offsetMin: number; durationMin?: number | null }[];
  staffIds?: string[];
  status?: 'active' | 'inactive';
}

export interface Resource {
  id: string;
  shop_id: string;
  name: string;
  resource_type: string;
  sort_order: number;
  status: 'active' | 'inactive';
}

export interface Coupon {
  id: string;
  shop_id: string | null;
  code: string | null;
  name: string;
  description: string | null;
  discount_type: 'amount' | 'percent' | 'fixed_price';
  discount_value: number;
  applicable_menu_ids: string[];
  min_amount: number;
  valid_from: string | null;
  valid_until: string | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  new_customer_only: boolean;
  is_public: boolean;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface CouponInput {
  shopId?: string | null;
  code?: string | null;
  name?: string;
  description?: string | null;
  discountType?: 'amount' | 'percent' | 'fixed_price';
  discountValue?: number;
  applicableMenuIds?: string[];
  minAmount?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  newCustomerOnly?: boolean;
  isPublic?: boolean;
  status?: 'active' | 'inactive';
}

// ---------------------------------------------------------------- schedules
export interface BusinessHour {
  id: string;
  weekday: number;
  open_time: string;
  close_time: string;
}

export interface CalendarException {
  id: string;
  date: string;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
  note: string | null;
}

export interface WeeklyScheduleRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface Shift {
  id: string;
  staff_id: string;
  shop_id: string;
  date: string;
  shift_type: 'work' | 'off';
  start_time: string | null;
  end_time: string | null;
  note: string | null;
}

export interface ShiftInput {
  staffId: string;
  date: string;
  shiftType: 'work' | 'off';
  startTime?: string | null;
  endTime?: string | null;
  note?: string | null;
}

export interface Range {
  start: string;
  end: string;
}

export interface DayStaffSchedule {
  date: string;
  timezone: string;
  shopOpen: Range[];
  staff: { staffId: string; working: Range[] }[];
}

export interface ScheduleBlock {
  id: string;
  shop_id: string;
  staff_id: string | null;
  resource_id: string | null;
  start_at: string;
  end_at: string;
  reason: string | null;
  source: string;
}

// ---------------------------------------------------------------- appointments
export type AppointmentStatus =
  'tentative' | 'confirmed' | 'checked_in' | 'in_service' | 'completed' | 'cancelled' | 'no_show';
export type AppointmentSource = 'web' | 'line' | 'external' | 'phone' | 'walk_in' | 'staff';

export interface AppointmentListItem {
  id: string;
  shop_id: string;
  customer_id: string | null;
  staff_id: string | null;
  is_nominated: boolean;
  booking_reference: string;
  start_at: string;
  end_at: string;
  occupied_start_at: string;
  occupied_end_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  is_consultation: boolean;
  estimated_total: number;
  customer_note: string | null;
  staff_note: string | null;
  version: number;
  customer_name: string;
  customer_name_kana: string;
  customer_visit_count: number | null;
  staff_name: string | null;
  staff_color: string | null;
  is_new_customer: boolean | null;
  services: { menu_id: string | null; name: string; duration_min: number; price: number }[];
}

export interface AppointmentDetail {
  id: string;
  shop_id: string;
  customer_id: string | null;
  staff_id: string | null;
  is_nominated: boolean;
  booking_reference: string;
  start_at: string;
  end_at: string;
  occupied_start_at: string;
  occupied_end_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  source_detail: Record<string, unknown>;
  coupon_id: string | null;
  is_consultation: boolean;
  customer_note: string | null;
  staff_note: string | null;
  estimated_total: number;
  cancel_reason: string | null;
  cancelled_by_type: string | null;
  confirmed_at: string | null;
  checked_in_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  no_show_at: string | null;
  version: number;
  created_at: string;
  customer_last_name: string | null;
  customer_first_name: string | null;
  customer_last_name_kana: string | null;
  customer_first_name_kana: string | null;
  customer_phone: string | null;
  customer_visit_count: number | null;
  customer_name: string | null;
  is_new_customer: boolean | null;
  staff_name: string | null;
  staff_color: string | null;
  services: {
    id: string;
    menu_id: string | null;
    name: string;
    duration_min: number;
    price: number;
    tax_rate_bp: number;
    staff_id: string | null;
    start_offset_min: number;
  }[];
  resources: {
    resource_id: string;
    name: string;
    resource_type: string;
    start_at: string;
    end_at: string;
  }[];
}

export interface AppointmentEvent {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AttentionItem {
  id: string;
  start_at: string;
  customer_id: string | null;
  staff_id: string | null;
  source: AppointmentSource;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
  staffIds: string[];
}

export interface AvailabilityResult {
  shopId: string;
  timezone: string;
  slotIntervalMin: number;
  menus: { id: string; name: string; durationMin: number; price: number }[];
  days: { date: string; slots: AvailabilitySlot[] }[];
}

export interface CreateAppointmentInput {
  shopId: string;
  customerId?: string | null;
  staffId?: string | null;
  isNominated?: boolean;
  startAt: string;
  menuIds: string[];
  couponId?: string | null;
  source?: AppointmentSource;
  customerNote?: string | null;
  staffNote?: string | null;
  status?: 'tentative' | 'confirmed';
  allowOutsideSchedule?: boolean;
}

export interface UpdateAppointmentInput {
  version: number;
  staffId?: string | null;
  isNominated?: boolean;
  startAt?: string;
  menuIds?: string[];
  customerId?: string | null;
  couponId?: string | null;
  customerNote?: string | null;
  staffNote?: string | null;
  allowOutsideSchedule?: boolean;
}

// ---------------------------------------------------------------- public
export interface PublicShopInfo {
  shop: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    phone: string | null;
    postal_code: string | null;
    prefecture: string | null;
    city: string | null;
    address_line: string | null;
    description: string | null;
  };
  booking: Omit<BookingSettings, 'autoAssignFree'>;
  businessHours: BusinessHour[];
  exceptions: CalendarException[];
  staff: {
    id: string;
    display_name: string;
    title: string | null;
    nomination_fee: number;
    public_profile: PublicProfile;
    public_slug: string | null;
  }[];
  menus: {
    id: string;
    categoryId: string | null;
    categoryName: string | null;
    name: string;
    description: string | null;
    durationMin: number;
    price: number;
    isConsultation: boolean;
    newCustomerOnly: boolean;
    staffIds: string[];
  }[];
  coupons: {
    id: string;
    name: string;
    description: string | null;
    discountType: 'amount' | 'percent' | 'fixed_price';
    discountValue: number;
    applicableMenuIds: string[];
    minAmount: number;
    validUntil: string | null;
    newCustomerOnly: boolean;
  }[];
}

export interface PublicAppointment {
  id: string;
  bookingReference: string;
  shopId: string;
  shopName: string;
  staffId: string | null;
  staffName: string | null;
  isNominated: boolean;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  services: { menuId: string | null; name: string; durationMin: number; price: number }[];
  estimatedTotal: number;
  customerNote: string | null;
  version: number;
  cancelDeadline: string;
  canModify: boolean;
}

export interface PublicBookingInput {
  menuIds: string[];
  staffId?: string | null;
  startAt: string;
  couponId?: string | null;
  customerNote?: string | null;
  channel?: 'web' | 'line';
  clientRequestId?: string;
  utm?: Record<string, string>;
  referralCode?: string;
  customer?: {
    lastName: string;
    firstName: string;
    lastNameKana?: string;
    firstNameKana?: string;
    phone: string;
    email?: string | null;
  };
}

export interface PublicBookingResult {
  appointment: PublicAppointment;
  manageUrl: string | null;
  replayed: boolean;
}

export interface CustomerProfile {
  id: string;
  last_name: string;
  first_name: string;
  last_name_kana: string;
  first_name_kana: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  gender: string | null;
  point_balance: number;
  marketing_opt_in: boolean;
  visit_count: number;
  status: string;
}

export interface CustomerAuthResult {
  token: string;
  customerId: string;
  isNew: boolean;
  profileComplete?: boolean;
}
