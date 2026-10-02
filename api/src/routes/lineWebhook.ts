import { Hono } from 'hono';
import type { Bindings, Variables, Customer, Menu, MenuCategory, Staff, Reservation, Store } from '../types';
import { LineNotifyService, StaffLineNotificationService, getStoreLineAccessToken, buildWeeklyCalendarFlexMessage, buildMenuSelectionFlexMessage, buildStaffSelectionFlexMessage, TimeSlotStatus } from '../services/lineService';
import { generatePublicToken } from '../utils/publicToken';
import { isJapaneseHoliday } from '../services/japaneseHolidays';
import { insertReservationLog } from '../services/reservationLogService';

export const lineWebhookRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// LINE event types
type LINEEvent = {
  type: 'message' | 'postback' | 'follow' | 'unfollow';
  replyToken: string;
  source: {
    type: 'user' | 'group' | 'room';
    userId: string;
  };
  timestamp: number;
  message?: {
    type: 'text' | 'image' | 'sticker';
    id: string;
    text?: string;
  };
  postback?: {
    data: string;
  };
};

type LINEWebhookBody = {
  destination: string;
  events: LINEEvent[];
};

// Session type
type LineSession = {
  storeId: string;
  step: 'staff' | 'menu_request' | 'menu' | 'date' | 'time' | 'confirm';
  customerType?: 'new' | 'repeat';
  menuId?: string;
  staffId?: string;
  date?: string;
  time?: string;
};

// D1-backed session helpers
async function getSession(db: D1Database, lineUserId: string): Promise<LineSession | null> {
  const row = await db.prepare(
    'SELECT * FROM line_sessions WHERE line_user_id = ?'
  ).bind(lineUserId).first<{
    store_id: string; step: string; staff_id: string | null;
    menu_id: string | null; customer_type: string | null;
    date: string | null; time: string | null;
  }>();
  if (!row) return null;
  return {
    storeId: row.store_id,
    step: row.step as LineSession['step'],
    staffId: row.staff_id || undefined,
    menuId: row.menu_id || undefined,
    customerType: row.customer_type as 'new' | 'repeat' | undefined,
    date: row.date || undefined,
    time: row.time || undefined,
  };
}

async function setSession(db: D1Database, lineUserId: string, session: LineSession): Promise<void> {
  await db.prepare(`
    INSERT INTO line_sessions (line_user_id, store_id, step, staff_id, menu_id, customer_type, date, time, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(line_user_id) DO UPDATE SET
      store_id = excluded.store_id, step = excluded.step, staff_id = excluded.staff_id,
      menu_id = excluded.menu_id, customer_type = excluded.customer_type,
      date = excluded.date, time = excluded.time, updated_at = datetime('now')
  `).bind(
    lineUserId, session.storeId, session.step,
    session.staffId || null, session.menuId || null,
    session.customerType || null, session.date || null, session.time || null
  ).run();
}

// Verify LINE signature
async function verifySignature(body: string, signature: string, channelSecret: string): Promise<boolean> {
  // Web Crypto rejects zero-length HMAC keys; an empty secret can never be a valid match
  if (!channelSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return signature === expectedSignature;
}

// API base URL: API_URL if set, otherwise derived from CUSTOMER_APP_URL
// Production: https://example.com → https://api.example.com
// Dev: https://dev.example.com → https://dev-api.example.com
export function getApiBaseUrl(env: Bindings): string {
  if (env.API_URL) return env.API_URL.replace(/\/$/, '');
  const customerUrl = env.CUSTOMER_APP_URL || '';
  try {
    const url = new URL(customerUrl);
    const host = url.hostname;
    if (host.startsWith('dev.')) {
      return `${url.protocol}//dev-api.${host.replace('dev.', '')}`;
    }
    return `${url.protocol}//api.${host}`;
  } catch {
    return 'https://api.example.com';
  }
}

// Build customer-facing URL, using LIFF format if the store has a LIFF ID
export function buildCustomerUrl(
  baseUrl: string,
  path: string,
  queryParams: Record<string, string>,
  liffId?: string | null
): string {
  const queryString = new URLSearchParams(queryParams).toString();
  const fullPath = queryString ? `${path}?${queryString}` : path;

  if (liffId) {
    return `https://liff.line.me/${liffId}${fullPath}`;
  }
  return `${baseUrl}${fullPath}`;
}

// Send LINE reply message
async function replyMessage(replyToken: string, messages: object[], accessToken: string): Promise<void> {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    console.error('[replyMessage] LINE API error:', res.status, errorBody);
  }
}

// Send LINE push message
export async function pushMessage(userId: string, messages: object[], accessToken: string): Promise<void> {
  console.log('[pushMessage] Sending to:', userId, 'messages:', messages.length);
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      to: userId,
      messages,
    }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    console.error('[pushMessage] LINE API error:', res.status, errorBody);
  } else {
    console.log('[pushMessage] Success');
  }
}

// Get store by LINE channel ID (destination)
async function getStoreByLineChannel(db: D1Database, channelId: string): Promise<Store | null> {
  return db.prepare('SELECT * FROM stores WHERE line_channel_id = ?').bind(channelId).first<Store>();
}

// Get staff by their personal LINE channel ID (destination)
async function getStaffByLineChannel(db: D1Database, channelId: string): Promise<Staff | null> {
  return db.prepare('SELECT * FROM staff WHERE staff_line_channel_id = ? AND is_active = 1').bind(channelId).first<Staff>();
}

// Resolved webhook context after destination lookup
type WebhookContext = {
  store: Store;
  accessToken: string;
  channelSecret: string;
  staffOverride?: Staff; // Set when the webhook came from a staff's personal LINE account
};

// Get customer by LINE user ID
async function getCustomerByLineUserId(db: D1Database, lineUserId: string): Promise<Customer | null> {
  const result = await db.prepare(`
    SELECT c.* FROM customers c
    JOIN customer_line cl ON c.id = cl.customer_id
    WHERE cl.line_user_id = ?
  `).bind(lineUserId).first<Customer>();
  return result;
}

// Build registration welcome Flex Message
export function buildRegistrationWelcomeMessage(
  storeName: string,
  liffId?: string | null,
  storeId?: string,
): object {
  // If LIFF is configured, use LIFF URL buttons (web form registration)
  if (liffId && storeId) {
    const returningUrl = `https://liff.line.me/${liffId}/register?type=returning&store_id=${storeId}`;
    const newUrl = `https://liff.line.me/${liffId}/register?type=new&store_id=${storeId}`;
    return {
      type: 'flex',
      altText: 'お客様情報の連携のお願い',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            {
              type: 'text',
              text: 'お客様情報の連携のお願い',
              weight: 'bold',
              size: 'lg',
              wrap: true,
            },
            {
              type: 'text',
              text: `この度、${storeName}の予約システムが新しくなりました。\nお客様のこれまでの情報を連携させていただくため、ご協力をお願いいたします。`,
              wrap: true,
              size: 'sm',
              color: '#666666',
            },
            { type: 'separator' },
            {
              type: 'text',
              text: '▼ 以前ご利用いただいた方',
              weight: 'bold',
              size: 'sm',
            },
            {
              type: 'text',
              text: 'お名前とお電話番号をご登録いただくと、以前のカルテ情報を連携いたします。',
              wrap: true,
              size: 'sm',
              color: '#666666',
            },
            { type: 'separator' },
            {
              type: 'text',
              text: '▼ 初めてのご利用の方',
              weight: 'bold',
              size: 'sm',
            },
            {
              type: 'text',
              text: 'お名前をご登録いただくと、スムーズにご予約が行えます。',
              wrap: true,
              size: 'sm',
              color: '#666666',
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              action: {
                type: 'uri',
                label: 'リピーター（情報連携）',
                uri: returningUrl,
              },
              style: 'primary',
              color: '#b8936a',
            },
            {
              type: 'button',
              action: {
                type: 'uri',
                label: '初めての登録',
                uri: newUrl,
              },
              style: 'primary',
              color: '#b8936a',
            },
            {
              type: 'button',
              action: {
                type: 'postback',
                label: 'スキップ',
                data: 'action=registration&step=skip',
                displayText: 'スキップ',
              },
              style: 'secondary',
            },
          ],
        },
      },
    };
  }

  // Fallback: text-based registration (no LIFF configured)
  return {
    type: 'flex',
    altText: 'お客様情報の連携のお願い',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: 'お客様情報の連携のお願い',
            weight: 'bold',
            size: 'lg',
            wrap: true,
          },
          {
            type: 'text',
            text: `この度、${storeName}の予約システムが新しくなりました。\nお客様のこれまでの情報を連携させていただくため、ご協力をお願いいたします。`,
            wrap: true,
            size: 'sm',
            color: '#666666',
          },
          { type: 'separator' },
          {
            type: 'text',
            text: '▼ 以前ご利用いただいた方',
            weight: 'bold',
            size: 'sm',
          },
          {
            type: 'text',
            text: 'お名前をメッセージでご入力ください。\n（例：山田 花子）',
            wrap: true,
            size: 'sm',
            color: '#666666',
          },
          { type: 'separator' },
          {
            type: 'text',
            text: '▼ 初めてのご利用の方',
            weight: 'bold',
            size: 'sm',
          },
          {
            type: 'text',
            text: '下のボタンを押してください。',
            size: 'sm',
            color: '#666666',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'postback',
              label: '初めてのご利用',
              data: 'action=registration&step=first_time',
              displayText: '初めてのご利用',
            },
            style: 'primary',
            color: '#b8936a',
          },
        ],
      },
    },
  };
}

// Build phone number request Flex Message
function buildPhoneRequestMessage(): object {
  return {
    type: 'flex',
    altText: '電話番号のご入力のお願い',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: 'ありがとうございます！',
            weight: 'bold',
            size: 'md',
          },
          {
            type: 'text',
            text: '電話番号もご入力いただけると、より正確にお客様情報を連携できます。\n\n電話番号をメッセージでご入力ください。\n（例：09012345678）\n\n不要な場合は「スキップ」を押してください。',
            wrap: true,
            size: 'sm',
            color: '#666666',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'postback',
              label: 'スキップ',
              data: 'action=registration&step=skip_phone',
              displayText: 'スキップ',
            },
            style: 'secondary',
          },
        ],
      },
    },
  };
}

// Handle registration flow for new LINE users
async function handleRegistrationFlow(
  db: D1Database,
  event: LINEEvent,
  customer: Customer,
  registrationStatus: string,
  accessToken: string,
  store: Store,
): Promise<void> {
  if (registrationStatus === 'pending_name') {
    // Check for postback actions (first_time or skip)
    if (event.type === 'postback' && event.postback?.data) {
      const params = new URLSearchParams(event.postback.data);
      const step = params.get('step');
      if (params.get('action') === 'registration' && (step === 'first_time' || step === 'skip')) {
        // Skip or first-time — complete registration without name/phone
        await db.prepare("UPDATE customer_line SET registration_status = 'completed' WHERE customer_id = ? AND store_id = ?")
          .bind(customer.id, store.id).run();
        await replyMessage(event.replyToken, [
          { type: 'text', text: 'ご登録ありがとうございます！\nスタッフが確認してご連絡いたします。' },
        ], accessToken);
        return;
      }
    }

    // Handle name input via text message
    if (event.type === 'message' && event.message?.type === 'text') {
      const name = (event.message.text || '').trim();
      // Validate 1: name should be 12 chars or less and not contain newlines
      const tooLong = name.length > 12 || name.includes('\n');
      // Validate 2: reject common greeting/phrase patterns
      const greetingPatterns = [
        'よろしく', 'ありがとう', 'こんにちは', 'こんばんは', 'おはよう',
        'はじめまして', 'お願いします', 'よろしくお願', 'ありがとうございます',
        'すみません', 'おつかれ', 'お疲れ', 'なるほど', 'わかりました',
        'かしこまり', 'ご連絡', 'よかった', 'たのしみ', '楽しみ',
      ];
      const isGreeting = greetingPatterns.some(p => name.includes(p));
      if (tooLong || isGreeting) {
        await replyMessage(event.replyToken, [
          { type: 'text', text: 'お名前をフルネームでご入力ください。\n（例：山田 花子）' },
        ], accessToken);
        return;
      }
      // Update customer name with user input
      await db.prepare("UPDATE customers SET name = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(name, customer.id).run();
      // Move to phone step
      await db.prepare("UPDATE customer_line SET registration_status = 'pending_phone' WHERE customer_id = ? AND store_id = ?")
        .bind(customer.id, store.id).run();
      await replyMessage(event.replyToken, [buildPhoneRequestMessage()], accessToken);
      return;
    }

    // For other message types (image, sticker), remind
    await replyMessage(event.replyToken, [
      { type: 'text', text: 'お名前をメッセージでご入力ください。\n初めてのご利用の方は、上のメッセージの「初めてのご利用」ボタンを押してください。' },
    ], accessToken);
    return;
  }

  if (registrationStatus === 'pending_phone') {
    // Check for "skip phone" postback
    if (event.type === 'postback' && event.postback?.data) {
      const params = new URLSearchParams(event.postback.data);
      if (params.get('action') === 'registration' && params.get('step') === 'skip_phone') {
        await completeRegistration(db, customer, store, accessToken, event.replyToken);
        return;
      }
    }

    // Handle phone input via text message
    if (event.type === 'message' && event.message?.type === 'text') {
      const phone = (event.message.text || '').trim().replace(/[-\s]/g, '');
      // Validate: phone should be digits only (with optional leading +), max 15 chars
      if (!/^\+?\d{7,15}$/.test(phone)) {
        await replyMessage(event.replyToken, [
          { type: 'text', text: '電話番号を数字でご入力ください。\n（例：09012345678）\n\nスキップする場合は、上のメッセージの「スキップ」ボタンを押してください。' },
        ], accessToken);
        return;
      }
      // Store with original formatting
      const formattedPhone = (event.message.text || '').trim();
      await db.prepare("UPDATE customers SET phone = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(formattedPhone, customer.id).run();
      await completeRegistration(db, customer, store, accessToken, event.replyToken);
      return;
    }

    // For other message types, remind
    await replyMessage(event.replyToken, [
      { type: 'text', text: '電話番号をメッセージでご入力ください。\nスキップする場合は、上のメッセージの「スキップ」ボタンを押してください。' },
    ], accessToken);
    return;
  }
}

// Search for merge candidates by name, phone, and LINE display name
export async function searchAndCreateMergeCandidates(
  db: D1Database,
  customerId: string,
  customerName: string,
  customerPhone: string | null,
  storeId: string,
  lineDisplayName: string | null,
): Promise<number> {
  const conditions: string[] = [];
  const bindings: (string | null)[] = [storeId, customerId];

  // Strip spaces (half-width and full-width) for name comparison
  const stripSpaces = (s: string) => s.replace(/[ 　]/g, '');
  const stripSql = "REPLACE(REPLACE(name, ' ', ''), '　', '')";
  const stripSqlKana = "REPLACE(REPLACE(name_kana, ' ', ''), '　', '')";

  if (customerName && customerName !== 'LINE ユーザー') {
    const stripped = stripSpaces(customerName);
    conditions.push(`${stripSql} LIKE ?`);
    bindings.push(`%${stripped}%`);
    conditions.push(`${stripSqlKana} LIKE ?`);
    bindings.push(`%${stripped}%`);
  }
  if (customerPhone) {
    conditions.push('phone = ?');
    bindings.push(customerPhone);
  }
  if (lineDisplayName) {
    const stripped = stripSpaces(lineDisplayName);
    conditions.push(`${stripSql} LIKE ?`);
    bindings.push(`%${stripped}%`);
    conditions.push(`${stripSqlKana} LIKE ?`);
    bindings.push(`%${stripped}%`);
  }

  if (conditions.length === 0) return 0;

  const query = `SELECT id, name, name_kana, phone FROM customers WHERE store_id = ? AND id != ? AND (${conditions.join(' OR ')}) LIMIT 10`;
  const existingMatches = await db.prepare(query).bind(...bindings)
    .all<{ id: string; name: string; name_kana: string | null; phone: string | null }>();

  let created = 0;
  for (const match of existingMatches.results) {
    let matchType = 'name';
    if (customerPhone && match.phone === customerPhone) {
      matchType = 'phone';
    } else if (match.name_kana) {
      const kanaStripped = stripSpaces(match.name_kana);
      if (
        (customerName && kanaStripped.includes(stripSpaces(customerName))) ||
        (lineDisplayName && kanaStripped.includes(stripSpaces(lineDisplayName)))
      ) {
        matchType = 'name_kana';
      }
    }
    await db.prepare(`
      INSERT OR IGNORE INTO customer_merge_candidates
        (id, store_id, line_customer_id, existing_customer_id, line_display_name, match_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(), storeId, customerId, match.id,
      lineDisplayName || null, matchType,
    ).run();
    created++;
  }

  // グループ横断の候補: 電話番号の完全一致に限り、同一グループの他店舗の顧客も候補にする。
  // 統合済みのお客様が別店舗の公式LINEを友だち追加したケース（顧客レコードはkeeper店舗にしか
  // 無い）を拾うため。誤ヒット防止のため名前マッチは同一店舗のみ、跨ぎは電話一致だけ。
  if (customerPhone) {
    const crossMatches = await db.prepare(
      `SELECT c.id FROM customers c
       JOIN stores s ON s.id = c.store_id
       WHERE c.id != ?1 AND c.store_id != ?2 AND c.phone = ?3
         AND s.group_id IS NOT NULL
         AND s.group_id = (SELECT group_id FROM stores WHERE id = ?2)
       LIMIT 10`
    ).bind(customerId, storeId, customerPhone)
      .all<{ id: string }>();
    for (const match of crossMatches.results) {
      await db.prepare(`
        INSERT OR IGNORE INTO customer_merge_candidates
          (id, store_id, line_customer_id, existing_customer_id, line_display_name, match_type, created_at)
        VALUES (?, ?, ?, ?, ?, 'phone', datetime('now'))
      `).bind(crypto.randomUUID(), storeId, customerId, match.id, lineDisplayName || null).run();
      created++;
    }
  }

  if (created > 0) {
    console.log(`[searchAndCreateMergeCandidates] Created ${created} merge candidate(s) for customer: ${customerName}`);
  }
  return created;
}

// Complete registration and search for merge candidates
async function completeRegistration(
  db: D1Database,
  customer: Customer,
  store: Store,
  accessToken: string,
  replyToken: string,
): Promise<void> {
  // Mark registration as completed
  await db.prepare("UPDATE customer_line SET registration_status = 'completed' WHERE customer_id = ? AND store_id = ?")
    .bind(customer.id, store.id).run();

  // Re-fetch updated customer data (name/phone may have been updated)
  const updatedCustomer = await db.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(customer.id).first<Customer>();
  if (!updatedCustomer) return;

  // Get LINE display name
  const lineInfo = await db.prepare('SELECT display_name FROM customer_line WHERE customer_id = ? AND store_id = ?')
    .bind(customer.id, store.id).first<{ display_name: string | null }>();

  try {
    await searchAndCreateMergeCandidates(
      db, customer.id, updatedCustomer.name, updatedCustomer.phone,
      store.id, lineInfo?.display_name || null,
    );
  } catch (err) {
    console.error('[completeRegistration] Failed to search merge candidates:', err);
  }

  await replyMessage(replyToken, [
    { type: 'text', text: 'ご登録ありがとうございます！\nスタッフが確認してご連絡いたします。' },
  ], accessToken);
}

// Get weekly availability for calendar display
async function getWeeklyAvailability(
  db: D1Database,
  storeId: string,
  staffId: string | null,
  menuDuration: number
): Promise<{
  date: string;
  displayDate: string;
  slots: { time: string; hour: number; minute: number; status: TimeSlotStatus }[];
}[]> {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekData: {
    date: string;
    displayDate: string;
    slots: { time: string; hour: number; minute: number; status: TimeSlotStatus }[];
  }[] = [];

  // Get current time in JST
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const nowJst = new Date(now.getTime() + jstOffset);
  const currentHour = nowJst.getUTCHours();
  const currentMinute = nowJst.getUTCMinutes();

  // Get same-day cutoff hours from staff settings or store settings
  let sameDayCutoffHours = 0;
  if (staffId) {
    const staffCutoff = await db.prepare(
      'SELECT same_day_cutoff_hours FROM staff_reservation_settings WHERE staff_id = ? AND store_id = ?'
    ).bind(staffId, storeId).first<{ same_day_cutoff_hours: number }>();
    if (staffCutoff) {
      sameDayCutoffHours = staffCutoff.same_day_cutoff_hours;
    }
  }
  let storeAdvanceMonths = 4;
  if (sameDayCutoffHours === 0) {
    const storeSetting = await db.prepare(
      'SELECT same_day_cutoff_hours, advance_booking_months FROM stores WHERE id = ?'
    ).bind(storeId).first<{ same_day_cutoff_hours: number; advance_booking_months: number }>();
    if (storeSetting) {
      sameDayCutoffHours = storeSetting.same_day_cutoff_hours;
      storeAdvanceMonths = storeSetting.advance_booking_months ?? 4;
    }
  } else {
    const storeSetting = await db.prepare(
      'SELECT advance_booking_months FROM stores WHERE id = ?'
    ).bind(storeId).first<{ advance_booking_months: number }>();
    if (storeSetting) {
      storeAdvanceMonths = storeSetting.advance_booking_months ?? 4;
    }
  }

  // Calculate max booking date (last day of current month + N months)
  const jstYear = nowJst.getUTCFullYear();
  const jstMonth = nowJst.getUTCMonth();
  const maxDateObj = new Date(Date.UTC(jstYear, jstMonth + storeAdvanceMonths, 0));
  const maxBookingDateStr = `${maxDateObj.getUTCFullYear()}-${String(maxDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(maxDateObj.getUTCDate()).padStart(2, '0')}`;

  // Generate 7 days of availability
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dateJst = new Date(nowJst);
    dateJst.setUTCDate(dateJst.getUTCDate() + dayOffset);

    const year = dateJst.getUTCFullYear();
    const month = dateJst.getUTCMonth() + 1;
    const day = dateJst.getUTCDate();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const displayDate = `${month}/${day}(${weekdays[dateJst.getUTCDay()]})`;

    // Skip dates beyond advance booking limit
    if (dateStr > maxBookingDateStr) {
      weekData.push({ date: dateStr, displayDate, slots: [] });
      continue;
    }

    // Get existing reservations for this date (for specific staff or all staff)
    let reservationsQuery;
    if (staffId) {
      reservationsQuery = db.prepare(`
        SELECT start_at, end_at FROM reservations
        WHERE store_id = ? AND staff_id = ?
          AND date(start_at) = ?
          AND status NOT IN ('cancelled', 'noshow')
      `).bind(storeId, staffId, dateStr);
    } else {
      // For "指名なし", get all reservations grouped by staff
      reservationsQuery = db.prepare(`
        SELECT start_at, end_at, staff_id FROM reservations
        WHERE store_id = ?
          AND date(start_at) = ?
          AND status NOT IN ('cancelled', 'noshow')
      `).bind(storeId, dateStr);
    }

    const reservations = await reservationsQuery.all<{ start_at: string; end_at: string; staff_id?: string }>();

    // Get all active staff count for "指名なし" availability calculation
    let totalStaffCount = 1;
    if (!staffId) {
      const staffCount = await db.prepare(
        'SELECT COUNT(*) as count FROM staff WHERE store_id = ? AND is_active = 1'
      ).bind(storeId).first<{ count: number }>();
      totalStaffCount = staffCount?.count || 1;
    }

    // Determine effective day_of_week (use 7 for holidays if enabled)
    const dayOfWeek = dateJst.getUTCDay();
    const storeHolidayFlag = await db.prepare(
      'SELECT holiday_hours_enabled FROM stores WHERE id = ?'
    ).bind(storeId).first<{ holiday_hours_enabled: number }>();
    const holidayHoursEnabled = !!(storeHolidayFlag?.holiday_hours_enabled);
    const dateIsHoliday = isJapaneseHoliday(dateStr);
    const effectiveDayOfWeek = (holidayHoursEnabled && dateIsHoliday) ? 7 : dayOfWeek;

    // Get business hours for this day
    const bh = await db.prepare(
      'SELECT open_time, close_time, is_closed FROM business_hours WHERE store_id = ? AND day_of_week = ?'
    ).bind(storeId, effectiveDayOfWeek).first<{ open_time: string; close_time: string; is_closed: number }>();

    // Check store_closures for this date
    const closure = await db.prepare(
      'SELECT id FROM store_closures WHERE store_id = ? AND date = ?'
    ).bind(storeId, dateStr).first();

    if (closure || (bh && bh.is_closed)) {
      weekData.push({ date: dateStr, displayDate, slots: [] });
      continue;
    }

    const openTime = bh?.open_time || '09:00';
    const closeTime = bh?.close_time || '19:00';
    const [openH, openM] = openTime.split(':').map(Number);
    const [closeH, closeM] = closeTime.split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;

    // Generate time slots based on business hours
    const slots: { time: string; hour: number; minute: number; status: TimeSlotStatus }[] = [];
    for (let totalMin = openMinutes; totalMin < closeMinutes; totalMin += 30) {
      const hour = Math.floor(totalMin / 60);
      const minute = totalMin % 60;

        const timeStr = `${hour}:${String(minute).padStart(2, '0')}`;

        // Check if this time slot is in the past or within cutoff (for today)
        if (dayOffset === 0) {
          const cutoffMinutes = currentHour * 60 + currentMinute + sameDayCutoffHours * 60;
          const slotMinutes = hour * 60 + minute;
          if (slotMinutes <= cutoffMinutes) {
            slots.push({ time: timeStr, hour, minute, status: 'unavailable' });
            continue;
          }
        }

        // Create start/end time for this slot in JST
        const slotStartJst = new Date(Date.UTC(year, month - 1, day, hour - 9, minute)); // Convert JST to UTC
        const slotEndJst = new Date(slotStartJst.getTime() + menuDuration * 60000);

        // Check for conflicts
        let conflictCount = 0;
        for (const res of reservations.results || []) {
          const resStart = new Date(res.start_at);
          const resEnd = new Date(res.end_at);

          // Check if time ranges overlap
          if (slotStartJst < resEnd && slotEndJst > resStart) {
            conflictCount++;
          }
        }

        let status: TimeSlotStatus;
        if (staffId) {
          // For specific staff, any conflict means unavailable
          status = conflictCount > 0 ? 'unavailable' : 'available';
        } else {
          // For "指名なし", calculate based on staff availability
          const availableStaff = totalStaffCount - conflictCount;
          if (availableStaff <= 0) {
            status = 'unavailable';
          } else if (availableStaff === 1) {
            status = 'limited';
          } else {
            status = 'available';
          }
        }

        slots.push({ time: timeStr, hour, minute, status });
    }

    weekData.push({ date: dateStr, displayDate, slots });
  }

  return weekData;
}

// LINE Webhook endpoint
lineWebhookRoutes.post('/', async (c) => {
  console.log('[LINE Webhook] Received request');

  const signature = c.req.header('x-line-signature');
  if (!signature) {
    console.log('[LINE Webhook] Missing signature');
    return c.json({ error: 'Missing signature' }, 401);
  }

  const bodyText = await c.req.text();
  console.log('[LINE Webhook] Body:', bodyText.substring(0, 500));

  const body: LINEWebhookBody = JSON.parse(bodyText);
  console.log('[LINE Webhook] Events count:', body.events.length, 'destination:', body.destination);

  // Resolve destination to store or staff LINE account
  const db = c.env.DB;
  let ctx: WebhookContext | null = null;

  // 1. Try store lookup by destination (line_channel_id)
  const store = await getStoreByLineChannel(db, body.destination);
  if (store && store.line_access_token && store.line_channel_secret) {
    ctx = {
      store,
      accessToken: store.line_access_token,
      channelSecret: store.line_channel_secret,
    };
    console.log('[LINE Webhook] Resolved to store:', store.id);
  }

  // 2. If not found in stores, try staff personal LINE account
  if (!ctx) {
    const staff = await getStaffByLineChannel(db, body.destination);
    if (staff && staff.staff_line_access_token && staff.staff_line_channel_secret) {
      // Get the staff's primary store
      const staffStore = await db.prepare(`
        SELECT s.* FROM stores s
        JOIN staff_stores ss ON s.id = ss.store_id
        WHERE ss.staff_id = ? AND ss.is_primary = 1
        LIMIT 1
      `).bind(staff.id).first<Store>();

      if (staffStore) {
        ctx = {
          store: staffStore,
          accessToken: staff.staff_line_access_token,
          channelSecret: staff.staff_line_channel_secret,
          staffOverride: staff,
        };
        console.log('[LINE Webhook] Resolved to staff:', staff.id, 'store:', staffStore.id);
      }
    }
  }

  // 3. Fallback: try all stores' channel secrets to find the matching one
  //    (destination is the bot's User ID, not the channel ID number,
  //     so direct lookup by line_channel_id may fail)
  if (!ctx) {
    const allStores = await db.prepare(
      'SELECT * FROM stores WHERE line_access_token IS NOT NULL AND line_channel_secret IS NOT NULL'
    ).all<Store>();
    for (const s of allStores.results) {
      const valid = await verifySignature(bodyText, signature, s.line_channel_secret!);
      if (valid) {
        ctx = {
          store: s,
          accessToken: s.line_access_token!,
          channelSecret: s.line_channel_secret!,
        };
        console.log('[LINE Webhook] Resolved by signature match to store:', s.id, s.name);
        break;
      }
    }
  }

  if (!ctx) {
    console.log('[LINE Webhook] No LINE account found for destination:', body.destination);
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Verify signature for stores resolved by direct lookup (steps 1-2)
  // Step 3 (signature match) already verified during lookup
  if (ctx.channelSecret) {
    const isValid = await verifySignature(bodyText, signature, ctx.channelSecret);
    if (!isValid) {
      console.log('[LINE Webhook] Invalid signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  for (const event of body.events) {
    console.log('[LINE Webhook] Processing event:', event.type, 'from user:', event.source.userId);
    try {
      await handleEvent(db, event, c.env, ctx);
      console.log('[LINE Webhook] Event processed successfully');
    } catch (error) {
      console.error('[LINE Webhook] Error handling event:', error);
    }
  }

  return c.json({ success: true });
});

async function handleEvent(db: D1Database, event: LINEEvent, env: Bindings, ctx: WebhookContext): Promise<void> {
  const lineUserId = event.source.userId;
  const { store, accessToken, staffOverride } = ctx;
  console.log('[handleEvent] Starting for user:', lineUserId, 'store:', store.id, 'staffOverride:', staffOverride?.id || 'none');

  // Get customer linked to this LINE user
  let customer = await getCustomerByLineUserId(db, lineUserId);
  console.log('[handleEvent] Customer found:', customer?.id || 'null');

  // If customer not linked, auto-create and link
  if (!customer) {
    console.log('[handleEvent] No customer found, creating new customer and customer_line');
    const customerId = crypto.randomUUID();
    const customerLineId = crypto.randomUUID();

    // Fetch LINE profile to get display name and picture
    let lineDisplayName: string | null = null;
    let linePictureUrl: string | null = null;
    try {
      const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json() as { displayName?: string; pictureUrl?: string };
        lineDisplayName = profile.displayName || null;
        linePictureUrl = profile.pictureUrl || null;
        console.log('[handleEvent] LINE profile fetched:', lineDisplayName);
      } else {
        console.log('[handleEvent] LINE profile fetch failed:', profileRes.status, await profileRes.text());
      }
    } catch (err) {
      console.error('[handleEvent] Failed to fetch LINE profile:', err);
    }

    const customerName = lineDisplayName || 'LINE ユーザー';

    try {
      const initialStaffId = staffOverride?.id || null;
      await db.prepare(`
        INSERT INTO customers (id, store_id, name, staff_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(customerId, store.id, customerName, initialStaffId).run();
      // Sync to customer_staff junction table
      if (initialStaffId) {
        await db.prepare(
          'INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)'
        ).bind(crypto.randomUUID(), customerId, initialStaffId).run();
      }
      console.log('[handleEvent] Customer created:', customerId, customerName);
    } catch (err) {
      console.error('[handleEvent] Failed to create customer:', err);
      throw err;
    }

    // For follow events (new friend), mark registration as completed and send consent/counseling
    // For other events (existing friend using rich menu for first time), use registration flow
    const isFollowEvent = event.type === 'follow';
    const initialStatus = isFollowEvent ? 'completed' : 'pending_name';

    try {
      await db.prepare(`
        INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status, linked_at, updated_at)
        VALUES (?, ?, (SELECT store_id FROM customers WHERE id = ?), ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(customerLineId, customerId, customerId, lineUserId, lineDisplayName, linePictureUrl, initialStatus).run();
      console.log('[handleEvent] customer_line created:', customerLineId, 'status:', initialStatus);
    } catch (err) {
      console.error('[handleEvent] Failed to create customer_line:', err);
      throw err;
    }

    customer = await db.prepare('SELECT * FROM customers WHERE id = ?')
      .bind(customerId)
      .first<Customer>();

    if (!customer) {
      console.error('[handleEvent] Failed to re-fetch created customer');
      return;
    }

    if (isFollowEvent) {
      // Check for pending intake session (from QR → LIFF flow)
      const pendingIntake = await db.prepare(
        `SELECT * FROM intake_sessions WHERE line_user_id = ? AND store_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
      ).bind(lineUserId, store.id).first<{ id: string; staff_id: string | null }>();

      if (pendingIntake) {
        // Link customer to intake session
        await db.prepare("UPDATE intake_sessions SET customer_id = ?, status = 'name_input', updated_at = datetime('now') WHERE id = ?")
          .bind(customerId, pendingIntake.id).run();
        // Assign staff from intake session
        if (pendingIntake.staff_id) {
          await db.prepare("UPDATE customers SET staff_id = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(pendingIntake.staff_id, customerId).run();
          await db.prepare(
            'INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)'
          ).bind(crypto.randomUUID(), customerId, pendingIntake.staff_id).run();
        }
        console.log('[handleEvent] Intake session linked:', pendingIntake.id, 'staff:', pendingIntake.staff_id);
        // Don't send welcome message — LIFF handles the flow
        return;
      }

      // New friend: send consent form + counseling sheet link
      const customerUrl = env.CUSTOMER_APP_URL || 'https://example.com';
      const consentTemplate = await db.prepare(
        `SELECT id FROM consent_templates WHERE store_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`
      ).bind(store.id).first<{ id: string }>();

      // Use direct URL (no LIFF) — consent/counseling pages don't need LINE auth
      const tokenResource = consentTemplate ? consentTemplate.id : store.id;
      const publicToken = await generatePublicToken(tokenResource, env.JWT_SECRET);
      const formUrl = consentTemplate
        ? buildCustomerUrl(customerUrl, '/consent', { id: consentTemplate.id, token: publicToken })
        : buildCustomerUrl(customerUrl, '/counseling', { store_id: store.id, token: publicToken });

      const welcomeName = staffOverride ? staffOverride.name : store.name;

      try {
        await replyMessage(event.replyToken, [
          {
            type: 'text',
            text: `${welcomeName}をご利用いただきありがとうございます！\nご来店前に以下のご記入をお願いいたします。`,
          },
          {
            type: 'flex',
            altText: 'ご来店前のご準備',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'text',
                    text: 'ご来店前のご準備',
                    weight: 'bold',
                    size: 'md',
                  },
                  {
                    type: 'text',
                    text: '以下のフォームにご記入ください',
                    size: 'sm',
                    color: '#888888',
                    margin: 'sm',
                  },
                ],
              },
              footer: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#b8936a',
                    action: {
                      type: 'uri',
                      label: consentTemplate ? '同意書・カウンセリングシートに記入' : 'カウンセリングシートに記入',
                      uri: formUrl,
                    },
                  },
                ],
              },
            },
          },
        ], accessToken);
        console.log(`[handleEvent] Sent consent/counseling message for new friend: ${lineDisplayName || lineUserId}`);
      } catch (err) {
        console.error('[handleEvent] Failed to send consent message:', err);
      }
    } else {
      // Existing friend using rich menu: send registration flow
      try {
        await replyMessage(event.replyToken, [buildRegistrationWelcomeMessage(store.name, store.line_liff_id, store.id)], accessToken);
        console.log(`[handleEvent] Sent registration welcome message for new LINE user: ${lineDisplayName || lineUserId}`);
      } catch (err) {
        console.error('[handleEvent] Failed to send registration welcome message:', err);
      }
    }
    return;
  }

  // Auto-assign staff to customer if staffOverride is set and customer has no assigned staff
  if (staffOverride && !customer.staff_id) {
    await db.prepare(
      'UPDATE customers SET staff_id = ?, updated_at = datetime(\'now\') WHERE id = ? AND staff_id IS NULL'
    ).bind(staffOverride.id, customer.id).run();
    await db.prepare(
      'INSERT OR IGNORE INTO customer_staff (id, customer_id, staff_id, is_primary) VALUES (?, ?, ?, 1)'
    ).bind(crypto.randomUUID(), customer.id, staffOverride.id).run();
  }

  // Check if customer is in registration flow
  const regStatus = await db.prepare('SELECT registration_status FROM customer_line WHERE customer_id = ? AND store_id = ?')
    .bind(customer.id, store.id).first<{ registration_status: string }>();
  if (regStatus && regStatus.registration_status !== 'completed') {
    await handleRegistrationFlow(db, event, customer, regStatus.registration_status, accessToken, store);
    return;
  }

  if (event.type === 'message' && event.message?.type === 'text') {
    await handleTextMessage(db, event, customer, store, accessToken, env, staffOverride);
  } else if (event.type === 'postback') {
    await handlePostback(db, event, customer, store, accessToken, env, staffOverride);
  } else if (event.type === 'follow') {
    // User followed - send welcome message with consent form, counseling sheet, and reservation link
    const welcomeName = staffOverride ? staffOverride.name : store.name;
    const customerUrl = env.CUSTOMER_APP_URL || 'https://example.com';
    const reserveParams: Record<string, string> = { store_id: store.id };
    if (staffOverride) reserveParams.staff_id = staffOverride.id;
    const reserveUrl = buildCustomerUrl(customerUrl, '/reserve', reserveParams, store.line_liff_id);

    // Check if the store has an active consent template
    const consentTemplate = await db.prepare(
      `SELECT id FROM consent_templates WHERE store_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`
    ).bind(store.id).first<{ id: string }>();

    // Consent form URL (flows into counseling sheet after submission)
    const consentTokenResource = consentTemplate ? consentTemplate.id : store.id;
    const consentPublicToken = await generatePublicToken(consentTokenResource, env.JWT_SECRET);
    const formUrl = consentTemplate
      ? buildCustomerUrl(customerUrl, '/consent', { id: consentTemplate.id, token: consentPublicToken }, store.line_liff_id)
      : buildCustomerUrl(customerUrl, '/counseling', { store_id: store.id, token: consentPublicToken }, store.line_liff_id);

    // Build footer buttons
    const footerButtons: Array<Record<string, unknown>> = [];
    footerButtons.push({
      type: 'button',
      style: 'primary',
      color: '#b8936a',
      action: {
        type: 'uri',
        label: consentTemplate ? '同意書・カウンセリングシートに記入' : 'カウンセリングシートに記入',
        uri: formUrl,
      },
    });
    footerButtons.push({
      type: 'button',
      style: 'link',
      action: {
        type: 'uri',
        label: '予約する',
        uri: reserveUrl,
      },
    });

    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: `${welcomeName}をご利用いただきありがとうございます！\nご来店前に以下のご記入をお願いいたします。`,
      },
      {
        type: 'flex',
        altText: 'ご来店前のご準備',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: 'ご来店前のご準備',
                weight: 'bold',
                size: 'md',
              },
              {
                type: 'text',
                text: '以下のフォームにご記入ください',
                size: 'sm',
                color: '#888888',
                margin: 'sm',
              },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: footerButtons,
          },
        },
      },
    ], accessToken);
  }
}

async function handleTextMessage(
  db: D1Database,
  event: LINEEvent,
  customer: Customer,
  store: Store,
  accessToken: string,
  env: Bindings,
  staffOverride?: Staff
): Promise<void> {
  const text = event.message?.text || '';

  if (text === 'ID確認' || text === 'id確認' || text.toLowerCase() === 'myid') {
    // Return LINE User ID for staff notification setup
    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: `あなたのLINE User ID:\n\n${event.source.userId}\n\nこのIDを管理画面のスタッフ設定で使用してください。`,
      },
    ], accessToken);
  } else {
    // Save as a message to the staff the customer last chatted with
    const messageId = crypto.randomUUID();

    // Determine primary target: customer's assigned staff → last conversation staff → null
    const lastConversation = await db.prepare(
      `SELECT staff_id FROM messages
       WHERE customer_id = ? AND staff_id IS NOT NULL
       ORDER BY sent_at DESC LIMIT 1`
    ).bind(customer.id).first<{ staff_id: string }>();

    const targetStaffId = staffOverride?.id || customer.staff_id || lastConversation?.staff_id || null;

    // Find the most recent proxy sender (sent_by_staff_id) who is different from targetStaffId
    const lastProxySender = await db.prepare(
      `SELECT sent_by_staff_id FROM messages
       WHERE customer_id = ? AND direction = 'outgoing' AND sent_by_staff_id IS NOT NULL
       ORDER BY sent_at DESC LIMIT 1`
    ).bind(customer.id).first<{ sent_by_staff_id: string }>();

    const proxyStaffId = lastProxySender?.sent_by_staff_id || null;

    await db.prepare(
      `INSERT INTO messages (id, store_id, customer_id, staff_id, direction, message_type, content, line_message_id, source, sent_at)
       VALUES (?, ?, ?, ?, 'incoming', 'text', ?, ?, 'line', datetime('now'))`
    ).bind(
      messageId, store.id, customer.id, targetStaffId,
      text, event.message?.id || null
    ).run();

    // Collect unique staff IDs to notify (assigned staff + proxy sender)
    const notifyStaffIds = new Set<string>();
    if (targetStaffId) notifyStaffIds.add(targetStaffId);
    if (proxyStaffId && proxyStaffId !== targetStaffId) notifyStaffIds.add(proxyStaffId);

    // Notify via Web Push only (LINE push removed to save message quota)
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      try {
        const { PushNotificationService } = await import('../services/pushService');
        const pushPayload = {
          title: `${customer.name}さんからメッセージ`,
          body: text.substring(0, 100),
          url: '/messages',
          tag: `message-${customer.id}`,
        };
        if (notifyStaffIds.size > 0) {
          for (const notifyId of notifyStaffIds) {
            await PushNotificationService.notifyStaff(
              db, notifyId, pushPayload, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
          }
        } else {
          await PushNotificationService.notifyAllStoreStaff(
              db, store.id, pushPayload, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
        }
      } catch (error) {
        console.error('Failed to send push notification:', error);
      }
    }

    // No auto-reply — staff will reply manually
  }
}

// AI-powered menu filtering based on customer's free text request
async function handleMenuRequest(
  db: D1Database,
  event: LINEEvent,
  store: Store,
  accessToken: string,
  env: Bindings,
  session: { storeId: string; step: string; staffId?: string }
): Promise<void> {
  const userMessage = event.message?.text || '';
  const lineUserId = event.source.userId;
  console.log('[handleMenuRequest] Start - user:', lineUserId, 'message:', userMessage);

  try {
    const resolvedStaffId = session.staffId || null;

    // Get all available menus
    let menus;
    if (resolvedStaffId) {
      menus = await db.prepare(`
        SELECT DISTINCT m.* FROM menus m
        LEFT JOIN menu_staff ms ON m.id = ms.menu_id
        WHERE m.store_id = ? AND m.is_active = 1
          AND (ms.staff_id = ? OR ms.id IS NULL)
        ORDER BY m.category, m.sort_order
      `).bind(store.id, resolvedStaffId).all<Menu>();
    } else {
      menus = await db.prepare(
        'SELECT * FROM menus WHERE store_id = ? AND is_active = 1 ORDER BY category, sort_order'
      ).bind(store.id).all<Menu>();
    }
    console.log('[handleMenuRequest] Menus found:', menus.results.length);

    if (menus.results.length === 0) {
      await pushMessage(lineUserId, [
        { type: 'text', text: '申し訳ありません。現在予約可能なメニューがありません。' },
      ], accessToken);
      return;
    }

    // Use compact index-based format for AI prompt (UUIDs + descriptions are too large for 100+ menus)
    const menuList = menus.results.map((m, i) =>
      `${i + 1}. ${m.category || ''} - ${m.name}`
    ).join('\n');

    // Use Workers AI to match customer request to menus
    let matchedMenuIds: string[] = [];
    try {
      console.log('[handleMenuRequest] Calling Workers AI with', menus.results.length, 'menus...');
      const aiResponse = await (env.AI as any).run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: `美容サロンのメニュー案内。お客様の希望に合うメニュー番号を選んでください。
複数該当する場合は全て選んでください。該当がない場合は空配列を返してください。

メニュー:
${menuList}

回答はJSON形式のみ: {"nums":[1,2,3]}`
          },
          {
            role: 'user',
            content: userMessage,
          },
        ],
      });
      console.log('[handleMenuRequest] AI call completed');

      // Parse AI response
      const responseText = typeof aiResponse === 'object' && aiResponse !== null && 'response' in aiResponse
        ? (aiResponse as { response: string }).response
        : String(aiResponse);
      console.log('[handleMenuRequest] AI response:', responseText?.substring(0, 200));

      // Extract JSON from response
      try {
        const jsonStart = responseText.indexOf('{');
        const jsonEnd = responseText.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          const parsed = JSON.parse(responseText.substring(jsonStart, jsonEnd + 1));
          const nums: number[] = Array.isArray(parsed.nums) ? parsed.nums : [];
          matchedMenuIds = nums
            .filter((n) => n >= 1 && n <= menus.results.length)
            .map((n) => menus.results[n - 1].id);
        }
      } catch (parseError) {
        console.error('[handleMenuRequest] JSON parse error:', parseError, 'response:', responseText?.substring(0, 300));
      }
      console.log('[handleMenuRequest] AI matched menu IDs:', matchedMenuIds.length);
    } catch (aiError) {
      console.error('[handleMenuRequest] AI error:', aiError);
      // On AI error, fall through to text-based matching
    }

    // Fallback: text-based matching if AI returned no results
    if (matchedMenuIds.length === 0 && userMessage.length >= 2) {
      // Normalize Japanese text for matching (katakana→hiragana, common aliases)
      const normalize = (s: string) => s.toLowerCase().replace(/[\u30A1-\u30F6]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0x60)
      );
      const keyword = normalize(userMessage);
      const textMatched = menus.results.filter((m) => {
        const target = normalize(`${m.name} ${m.category || ''} ${m.description || ''}`);
        return target.includes(keyword);
      });
      if (textMatched.length > 0) {
        matchedMenuIds = textMatched.map((m) => m.id);
        console.log('[handleMenuRequest] Text fallback matched:', matchedMenuIds.length);
      }
    }

    // Filter menus or show all if no matches
    const filteredMenus = matchedMenuIds.length > 0
      ? menus.results.filter((m) => matchedMenuIds.includes(m.id))
      : menus.results;

    // Update session
    await setSession(db, lineUserId, { ...session, step: 'menu' } as LineSession);
    console.log('[handleMenuRequest] Session updated to menu step');

    // If too many menus to show in carousel, show category selection instead
    const allCategories = [...new Set(menus.results.map((m) => m.category).filter(Boolean))] as string[];
    const filteredCategories = [...new Set(filteredMenus.map((m) => m.category).filter(Boolean))] as string[];
    if (filteredMenus.length > 12 && (filteredCategories.length > 1 || allCategories.length > 1)) {
      // Use filtered categories if AI matched, otherwise all categories
      const catsToShow = matchedMenuIds.length > 0 && filteredCategories.length > 1
        ? filteredCategories : allCategories;
      const menuPool = matchedMenuIds.length > 0 ? filteredMenus : menus.results;

      const catItems: object[] = [];
      for (const cat of catsToShow) {
        if (catItems.length >= 13) break;
        const count = menuPool.filter((m) => m.category === cat).length;
        catItems.push({
          type: 'action',
          action: {
            type: 'postback',
            label: `${cat}(${count})`,
            data: `action=show_category_menus&category=${encodeURIComponent(cat)}`,
            displayText: `${cat}メニュー`,
          },
        });
      }

      const categoryList = catsToShow.map((cat) => {
        const count = menuPool.filter((m) => m.category === cat).length;
        return `・${cat}（${count}件）`;
      }).join('\n');

      const headerText = matchedMenuIds.length > 0
        ? `「${userMessage}」に合うメニューが${filteredMenus.length}件あります。\nカテゴリを選択してください：\n\n${categoryList}`
        : `メニューが${menus.results.length}件あります。\nカテゴリを選択してください：\n\n${categoryList}`;

      await pushMessage(lineUserId, [
        {
          type: 'text',
          text: headerText,
          quickReply: { items: catItems },
        },
      ], accessToken);
      console.log('[handleMenuRequest] Category selection sent (too many menus)');
      return;
    }

    const categoriesResult = await db.prepare(
      'SELECT name, color FROM menu_categories WHERE store_id = ?'
    ).bind(store.id).all<{ name: string; color: string }>();
    const categoryColors: Record<string, string> = {};
    for (const cat of categoriesResult.results) {
      categoryColors[cat.name] = cat.color;
    }

    const apiBaseUrl = getApiBaseUrl(env);
    const menuFlexMessage = buildMenuSelectionFlexMessage(
      filteredMenus.map((menu) => ({
        id: menu.id,
        name: menu.name,
        price: menu.price || 0,
        duration: menu.duration || 60,
        category: menu.category || undefined,
        image_url: menu.image_url || undefined,
        description: menu.description || undefined,
      })),
      apiBaseUrl,
      categoryColors
    );
    console.log('[handleMenuRequest] Flex message built');

    const headerText = matchedMenuIds.length > 0
      ? `「${userMessage}」に合うメニューはこちらです：`
      : 'メニューを選択してください：';

    // Build category quick reply buttons
    const categories = [...new Set(menus.results.map((m) => m.category).filter(Boolean))] as string[];
    const quickReplyItems: object[] = [];

    // "全メニューを見る" button (always show when filtered)
    if (matchedMenuIds.length > 0 && matchedMenuIds.length < menus.results.length) {
      quickReplyItems.push({
        type: 'action',
        action: {
          type: 'postback',
          label: '全メニューを見る',
          data: 'action=show_all_menus',
          displayText: '全メニューを見る',
        },
      });
    }

    // Category filter buttons (up to 12 remaining slots in quickReply)
    for (const cat of categories) {
      if (quickReplyItems.length >= 13) break;
      // Skip if all menus of this category are already shown
      const catMenus = menus.results.filter((m) => m.category === cat);
      const shownCatMenus = filteredMenus.filter((m) => m.category === cat);
      if (shownCatMenus.length === catMenus.length && matchedMenuIds.length > 0) continue;
      // Skip if only showing this category already
      if (filteredMenus.every((m) => m.category === cat)) continue;

      quickReplyItems.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `${cat}メニュー`,
          data: `action=show_category_menus&category=${encodeURIComponent(cat)}`,
          displayText: `${cat}メニュー`,
        },
      });
    }

    // LINE API: quickReply must be on the LAST message in the array
    const lastMessage = quickReplyItems.length > 0
      ? { ...menuFlexMessage, quickReply: { items: quickReplyItems } }
      : menuFlexMessage;
    const messages: object[] = [
      { type: 'text', text: headerText },
      lastMessage,
    ];

    // Use pushMessage instead of replyMessage to avoid token expiration after AI call
    await pushMessage(lineUserId, messages, accessToken);
    console.log('[handleMenuRequest] Menu message sent successfully');
  } catch (error) {
    console.error('[handleMenuRequest] Fatal error:', error);
    // Fallback: always send a response using pushMessage
    try {
      // Try to show all menus as fallback
      const allMenus = await db.prepare(
        'SELECT * FROM menus WHERE store_id = ? AND is_active = 1 ORDER BY category, sort_order'
      ).bind(store.id).all<Menu>();

      if (allMenus.results.length > 0) {
        await setSession(db, lineUserId, { ...session, step: 'menu' } as LineSession);
        const menuFlexMessage = buildMenuSelectionFlexMessage(
          allMenus.results.map((menu) => ({
            id: menu.id,
            name: menu.name,
            price: menu.price || 0,
            duration: menu.duration || 60,
            category: menu.category || undefined,
            image_url: menu.image_url || undefined,
            description: menu.description || undefined,
          })),
          getApiBaseUrl(env)
        );
        await pushMessage(lineUserId, [
          { type: 'text', text: 'メニューを選択してください：' },
          menuFlexMessage,
        ], accessToken);
      } else {
        await pushMessage(lineUserId, [
          { type: 'text', text: '申し訳ありません。エラーが発生しました。もう一度「予約」と送信してください。' },
        ], accessToken);
      }
    } catch (fallbackError) {
      console.error('[handleMenuRequest] Fallback error:', fallbackError);
      // Last resort
      try {
        await pushMessage(lineUserId, [
          { type: 'text', text: '申し訳ありません。エラーが発生しました。もう一度「予約」と送信してください。' },
        ], accessToken);
      } catch (e) {
        console.error('[handleMenuRequest] Could not send any message:', e);
      }
    }
  }
}

async function handlePostback(
  db: D1Database,
  event: LINEEvent,
  customer: Customer,
  store: Store,
  accessToken: string,
  env: Bindings,
  staffOverride?: Staff
): Promise<void> {
  const data = event.postback?.data || '';
  const params = new URLSearchParams(data);
  const action = params.get('action');

  const session = await getSession(db, event.source.userId) || {
    storeId: store.id,
    step: 'staff' as const,
  };

  // Flow: Staff → Menu → Customer Type → Calendar → Time → Confirm

  if (action === 'select_staff') {
    // Step 1 → Step 1.5: Staff selected, ask for menu preference (AI filtering)
    const staffId = params.get('staff_id');
    if (!staffId) return;

    const resolvedStaffId = staffId === 'any' ? null : staffId;
    session.staffId = resolvedStaffId || undefined;
    session.step = 'menu_request';
    await setSession(db, event.source.userId, session);

    // Build quickReply with "全メニュー" + category buttons
    const menuCategories = await db.prepare(
      'SELECT DISTINCT category FROM menus WHERE store_id = ? AND is_active = 1 AND is_bookable = 1 AND category IS NOT NULL ORDER BY category'
    ).bind(store.id).all<{ category: string }>();

    const menuRequestItems: object[] = [{
      type: 'action',
      action: {
        type: 'postback',
        label: '全メニューを見る',
        data: 'action=show_all_menus',
        displayText: '全メニューを見る',
      },
    }];
    for (const c of menuCategories.results) {
      if (menuRequestItems.length >= 13) break;
      menuRequestItems.push({
        type: 'action',
        action: {
          type: 'postback',
          label: c.category,
          data: `action=show_category_menus&category=${encodeURIComponent(c.category)}`,
          displayText: `${c.category}メニュー`,
        },
      });
    }

    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: 'どのような施術をご希望ですか？💇\n\n例：「カットしたい」「カラーを変えたい」「トリートメントしたい」\n\nお気軽にメッセージしてください！',
        quickReply: { items: menuRequestItems },
      },
    ], accessToken);
  } else if (action === 'show_all_menus') {
    // Show all menus without AI filtering
    session.step = 'menu';
    await setSession(db, event.source.userId, session);

    const resolvedStaffId = session.staffId || null;
    let menus;
    if (resolvedStaffId) {
      menus = await db.prepare(`
        SELECT DISTINCT m.* FROM menus m
        LEFT JOIN menu_staff ms ON m.id = ms.menu_id
        WHERE m.store_id = ? AND m.is_active = 1
          AND (ms.staff_id = ? OR ms.id IS NULL)
        ORDER BY m.category, m.sort_order
      `).bind(store.id, resolvedStaffId).all<Menu>();
    } else {
      menus = await db.prepare(
        'SELECT * FROM menus WHERE store_id = ? AND is_active = 1 ORDER BY category, sort_order'
      ).bind(store.id).all<Menu>();
    }

    if (menus.results.length === 0) {
      await replyMessage(event.replyToken, [
        { type: 'text', text: '申し訳ありません。現在予約可能なメニューがありません。' },
      ], accessToken);
      return;
    }

    // Get categories
    const allCategories = [...new Set(menus.results.map((m) => m.category).filter(Boolean))] as string[];

    // If menus > 12, show category selection first (carousel limit is 12)
    if (menus.results.length > 12 && allCategories.length > 1) {
      const catItems: object[] = [];
      for (const cat of allCategories) {
        if (catItems.length >= 13) break;
        const count = menus.results.filter((m) => m.category === cat).length;
        catItems.push({
          type: 'action',
          action: {
            type: 'postback',
            label: `${cat}(${count})`,
            data: `action=show_category_menus&category=${encodeURIComponent(cat)}`,
            displayText: `${cat}メニュー`,
          },
        });
      }

      const categoryList = allCategories.map((cat) => {
        const count = menus.results.filter((m) => m.category === cat).length;
        return `・${cat}（${count}件）`;
      }).join('\n');

      await replyMessage(event.replyToken, [
        {
          type: 'text',
          text: `メニューが${menus.results.length}件あります。\nカテゴリを選択してください：\n\n${categoryList}`,
          quickReply: { items: catItems },
        },
      ], accessToken);
      return;
    }

    const categoriesResult = await db.prepare(
      'SELECT name, color FROM menu_categories WHERE store_id = ?'
    ).bind(store.id).all<{ name: string; color: string }>();
    const categoryColors: Record<string, string> = {};
    for (const cat of categoriesResult.results) {
      categoryColors[cat.name] = cat.color;
    }

    const menuFlexMessage = buildMenuSelectionFlexMessage(
      menus.results.map((menu) => ({
        id: menu.id,
        name: menu.name,
        price: menu.price || 0,
        duration: menu.duration || 60,
        category: menu.category || undefined,
        image_url: menu.image_url || undefined,
        description: menu.description || undefined,
      })),
      getApiBaseUrl(env),
      categoryColors
    );

    // Add category filter quick reply buttons
    const catQuickReplyItems: object[] = [];
    for (const cat of allCategories) {
      if (catQuickReplyItems.length >= 13) break;
      catQuickReplyItems.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `${cat}メニュー`,
          data: `action=show_category_menus&category=${encodeURIComponent(cat)}`,
          displayText: `${cat}メニュー`,
        },
      });
    }

    // LINE API: quickReply must be on the LAST message
    const lastMsg = catQuickReplyItems.length > 0
      ? { ...menuFlexMessage, quickReply: { items: catQuickReplyItems } }
      : menuFlexMessage;

    await replyMessage(event.replyToken, [
      { type: 'text', text: 'メニューを選択してください：' },
      lastMsg,
    ], accessToken);
  } else if (action === 'show_category_menus') {
    // Show menus filtered by category
    const category = params.get('category');
    if (!category) return;

    session.step = 'menu';
    await setSession(db, event.source.userId, session);

    const resolvedStaffId = session.staffId || null;
    let menus;
    if (resolvedStaffId) {
      menus = await db.prepare(`
        SELECT DISTINCT m.* FROM menus m
        LEFT JOIN menu_staff ms ON m.id = ms.menu_id
        WHERE m.store_id = ? AND m.is_active = 1 AND m.category = ?
          AND (ms.staff_id = ? OR ms.id IS NULL)
        ORDER BY m.sort_order
      `).bind(store.id, category, resolvedStaffId).all<Menu>();
    } else {
      menus = await db.prepare(
        'SELECT * FROM menus WHERE store_id = ? AND is_active = 1 AND category = ? ORDER BY sort_order'
      ).bind(store.id, category).all<Menu>();
    }

    if (menus.results.length === 0) {
      await replyMessage(event.replyToken, [
        { type: 'text', text: `${category}のメニューが見つかりません。` },
      ], accessToken);
      return;
    }

    const categoriesResult = await db.prepare(
      'SELECT name, color FROM menu_categories WHERE store_id = ?'
    ).bind(store.id).all<{ name: string; color: string }>();
    const categoryColors: Record<string, string> = {};
    for (const cat of categoriesResult.results) {
      categoryColors[cat.name] = cat.color;
    }

    const menuFlexMessage = buildMenuSelectionFlexMessage(
      menus.results.map((menu) => ({
        id: menu.id,
        name: menu.name,
        price: menu.price || 0,
        duration: menu.duration || 60,
        category: menu.category || undefined,
        image_url: menu.image_url || undefined,
        description: menu.description || undefined,
      })),
      getApiBaseUrl(env),
      categoryColors
    );

    // Quick reply: "全メニューを見る" + other categories
    const otherCategories = await db.prepare(
      'SELECT DISTINCT category FROM menus WHERE store_id = ? AND is_active = 1 AND category != ? ORDER BY category'
    ).bind(store.id, category).all<{ category: string }>();

    const catItems: object[] = [{
      type: 'action',
      action: {
        type: 'postback',
        label: '全メニューを見る',
        data: 'action=show_all_menus',
        displayText: '全メニューを見る',
      },
    }];
    for (const c of otherCategories.results) {
      if (catItems.length >= 13) break;
      catItems.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `${c.category}メニュー`,
          data: `action=show_category_menus&category=${encodeURIComponent(c.category)}`,
          displayText: `${c.category}メニュー`,
        },
      });
    }

    // LINE API: quickReply must be on the LAST message
    await replyMessage(event.replyToken, [
      { type: 'text', text: `${category}のメニュー：` },
      { ...menuFlexMessage, quickReply: { items: catItems } },
    ], accessToken);
  } else if (action === 'select_menu') {
    // Menu selected → directly show calendar (skip customer_type)
    const menuId = params.get('menu_id');
    if (!menuId) return;

    session.menuId = menuId;
    session.step = 'time';
    await setSession(db, event.source.userId, session);

    // Get menu duration for availability calculation
    const menu = await db.prepare('SELECT duration FROM menus WHERE id = ?')
      .bind(menuId)
      .first<{ duration: number }>();
    const menuDuration = menu?.duration || 60;

    // Get weekly availability
    const resolvedStaffId = session.staffId || null;
    const weekData = await getWeeklyAvailability(db, store.id, resolvedStaffId, menuDuration);
    const calendarMessage = buildWeeklyCalendarFlexMessage(
      weekData,
      menuId!,
      resolvedStaffId || ''
    );

    await replyMessage(event.replyToken, [
      { type: 'text', text: 'ご希望の日時を選択してください：' },
      calendarMessage,
    ], accessToken);
  } else if (action === 'select_date') {
    const date = params.get('date');
    const menuId = params.get('menu_id') || session.menuId;
    const staffIdParam = params.get('staff_id');
    const staffId = staffIdParam || session.staffId;
    if (!date) return;

    session.date = date;
    session.menuId = menuId;
    session.staffId = staffId;
    session.step = 'time';
    await setSession(db, event.source.userId, session);

    // Generate time slots (10:00 - 19:00)
    const quickReplyItems: object[] = [];
    for (let hour = 10; hour <= 18; hour++) {
      for (const min of ['00', '30']) {
        if (quickReplyItems.length >= 13) break;
        const timeStr = `${hour}:${min}`;
        quickReplyItems.push({
          type: 'action',
          action: {
            type: 'postback',
            label: timeStr,
            data: `action=select_time&time=${timeStr}&date=${date}&menu_id=${menuId}&staff_id=${staffId || ''}`,
            displayText: timeStr,
          },
        });
      }
    }

    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: '時間を選択してください：',
        quickReply: {
          items: quickReplyItems,
        },
      },
    ], accessToken);
  } else if (action === 'select_time') {
    const time = params.get('time');
    const dateFromParams = params.get('date') || session.date;
    const menuIdFromParams = params.get('menu_id') || session.menuId;
    const staffIdFromParams = params.get('staff_id') || session.staffId;

    if (!time) return;

    // Validate we have required data
    if (!menuIdFromParams) {
      console.error('select_time: menuId is missing');
      await replyMessage(event.replyToken, [
        { type: 'text', text: '予約情報が見つかりません。もう一度「予約」と送信してください。' },
      ], accessToken);
      await db.prepare('DELETE FROM line_sessions WHERE line_user_id = ?').bind(event.source.userId).run();
      return;
    }

    session.time = time;
    session.date = dateFromParams;
    session.menuId = menuIdFromParams;
    session.staffId = staffIdFromParams;
    session.step = 'confirm';
    await setSession(db, event.source.userId, session);

    // Get menu details
    const menu = await db.prepare('SELECT * FROM menus WHERE id = ?')
      .bind(menuIdFromParams)
      .first<Menu>();

    if (!menu) {
      console.error('select_time: menu not found for id:', menuIdFromParams);
      await replyMessage(event.replyToken, [
        { type: 'text', text: 'メニューが見つかりません。もう一度「予約」と送信してください。' },
      ], accessToken);
      await db.prepare('DELETE FROM line_sessions WHERE line_user_id = ?').bind(event.source.userId).run();
      return;
    }

    // Get or assign staff
    let staffId = staffIdFromParams;
    let staffName = '指名なし';
    if (staffId) {
      const staff = await db.prepare('SELECT * FROM staff WHERE id = ?')
        .bind(staffId)
        .first<Staff>();
      staffName = staff?.nickname || staff?.name || '指名なし';
    } else {
      // Pick first available staff
      const availableStaff = await db.prepare(
        'SELECT * FROM staff WHERE store_id = ? AND is_active = 1 LIMIT 1'
      ).bind(store.id).first<Staff>();
      if (availableStaff) {
        staffId = availableStaff.id;
        staffName = availableStaff.nickname || availableStaff.name;
        session.staffId = staffId;
        await setSession(db, event.source.userId, session);
      }
    }

    if (!staffId) {
      await replyMessage(event.replyToken, [
        { type: 'text', text: '担当スタッフが見つかりません。お店に直接お問い合わせください。' },
      ], accessToken);
      return;
    }

    // Show reservation summary + ask first visit question
    const summaryMessage = `【予約内容確認】\n\n📅 ${dateFromParams} ${time}\n💇 ${menu.name}\n👤 ${staffName}\n💰 ¥${(menu.price || 0).toLocaleString()}\n⏱ ${menu.duration || 0}分`;

    const visitTypeData = `menu_id=${menuIdFromParams}&staff_id=${staffId}&date=${dateFromParams}&time=${time}`;

    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: summaryMessage,
      },
      {
        type: 'text',
        text: '当店へのご来店は初めてですか？',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '初めてのご来店',
                data: `action=select_visit_type&type=new&${visitTypeData}`,
                displayText: '初めてのご来店',
              },
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '2回目以降のご来店',
                data: `action=select_visit_type&type=repeat&${visitTypeData}`,
                displayText: '2回目以降のご来店',
              },
            },
          ],
        },
      },
    ], accessToken);
  } else if (action === 'select_visit_type') {
    // First visit question answered → show notes + final confirm
    const visitType = params.get('type') as 'new' | 'repeat';
    const menuId = params.get('menu_id') || session.menuId;
    const staffId = params.get('staff_id') || session.staffId;
    const date = params.get('date') || session.date;
    const time = params.get('time') || session.time;

    session.customerType = visitType;
    await setSession(db, event.source.userId, session);

    // Get menu for price display
    const menu = await db.prepare('SELECT * FROM menus WHERE id = ?')
      .bind(menuId)
      .first<Menu>();
    const displayPrice = visitType === 'new' && menu?.price_new != null
      ? menu.price_new
      : menu?.price || 0;

    const staffInfo = await db.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?')
      .bind(staffId)
      .first<{ name: string }>();
    const staffName = staffInfo?.name || '指名なし';

    const visitLabel = visitType === 'new' ? '【新規】' : '【再来】';

    const notesMessage = `${visitLabel} ご来店に関する注意事項\n\n` +
      `📅 ${date} ${time}\n💇 ${menu?.name || ''}\n👤 ${staffName}\n💰 ¥${displayPrice.toLocaleString()}\n\n` +
      `・キャンセルポリシー\n` +
      `無断キャンセル 全額\n` +
      `当日キャンセル 80%\n` +
      `当日別日変更　3300円\n` +
      `当日時間変更(その日のうち来店) 1100円\n` +
      `10分以上のお遅刻 1100円\n` +
      `営業時間外の施術は＋1100円になります。5分以上遅れる場合施術工程が十分にできない場合がございます。15分以上ご連絡なくご来店されていない場合、無断キャンセルとなります。前日の営業時間を過ぎてからのキャンセル、変更は当日扱いとなります。\n\n` +
      `当日のメニュー変更、コースダウンは不可です。\n` +
      `メニューの追加は後ろにお時間がある場合のみ追加可能となります。\n\n` +
      `上記をご確認の上、予約を確定してください。`;

    const confirmData = `action=confirm_reservation&menu_id=${menuId}&staff_id=${staffId}&date=${date}&time=${time}&customer_type=${visitType}`;

    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: notesMessage,
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '予約を確定する',
                data: confirmData,
                displayText: '予約を確定する',
              },
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: 'キャンセル',
                data: 'action=cancel_reservation',
                displayText: 'キャンセル',
              },
            },
          ],
        },
      },
    ], accessToken);
  } else if (action === 'confirm_reservation') {
    // Get data from postback (more reliable than session in serverless)
    const menuId = params.get('menu_id') || session.menuId;
    const staffIdFromParams = params.get('staff_id') || session.staffId;
    const staffId = staffIdFromParams;
    const date = params.get('date') || session.date;
    const time = params.get('time') || session.time;
    const customerType = (params.get('customer_type') || session.customerType || 'repeat') as 'new' | 'repeat';

    if (!menuId || !date || !time || !staffId) {
      await replyMessage(event.replyToken, [
        { type: 'text', text: '予約情報が見つかりません。もう一度「予約」と送信してください。' },
      ], accessToken);
      return;
    }

    // Get menu for duration
    const menu = await db.prepare('SELECT * FROM menus WHERE id = ?')
      .bind(menuId)
      .first<Menu>();

    if (!menu) {
      await replyMessage(event.replyToken, [
        { type: 'text', text: 'メニューが見つかりません。もう一度お試しください。' },
      ], accessToken);
      return;
    }

    // Calculate start and end time (JST)
    // Store as ISO string with explicit JST offset to ensure correct timezone handling
    const [hour, minute] = time.split(':').map(Number);
    // Create date string with JST timezone offset (+09:00)
    const startAtStr = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
    const startAt = new Date(startAtStr);
    const endAt = new Date(startAt.getTime() + menu.duration * 60000);

    // Check for conflicts
    const conflict = await db.prepare(`
      SELECT id FROM reservations
      WHERE staff_id = ?
        AND status NOT IN ('cancelled', 'noshow')
        AND (
          (start_at <= ? AND end_at > ?)
          OR (start_at < ? AND end_at >= ?)
          OR (start_at >= ? AND end_at <= ?)
        )
      LIMIT 1
    `).bind(
      staffId,
      startAt.toISOString(), startAt.toISOString(),
      endAt.toISOString(), endAt.toISOString(),
      startAt.toISOString(), endAt.toISOString()
    ).first();

    if (conflict) {
      await replyMessage(event.replyToken, [
        { type: 'text', text: 'この時間は既に予約が入っています。別の時間をお選びください。\n\n「予約」と送信して再度お試しください。' },
      ], accessToken);
      await db.prepare('DELETE FROM line_sessions WHERE line_user_id = ?').bind(event.source.userId).run();
      return;
    }

    // Create reservation
    const reservationId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Determine is_new_customer at creation time
    const custRow = await db.prepare('SELECT visit_count FROM customers WHERE id = ?')
      .bind(customer.id).first<{ visit_count: number }>();
    const lineIsNew = custRow ? (custRow.visit_count === 0 ? 1 : 0) : null;

    console.log('[confirm_reservation] Creating reservation:', {
      id: reservationId,
      store_id: store.id,
      customer_id: customer.id,
      staff_id: staffId,
      menu_id: menuId,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
    });
    try {
      const result = await db.prepare(`
        INSERT INTO reservations (id, store_id, customer_id, staff_id, menu_id, start_at, end_at, status, source, is_new_customer, is_nominated, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'line', ?, ?, ?, ?)
      `).bind(
        reservationId,
        store.id,
        customer.id,
        staffId,
        menuId,
        startAt.toISOString(),
        endAt.toISOString(),
        lineIsNew,
        staffIdFromParams ? 1 : 0,
        now,
        now
      ).run();
      console.log('[confirm_reservation] Insert result:', JSON.stringify(result));

      await insertReservationLog(db, {
        reservationId,
        eventType: 'created',
        actorType: 'customer',
        actorId: customer.id,
        actorName: customer.name,
        description: 'LINEから予約が作成されました',
        metadata: { source: 'line' },
      });
    } catch (error) {
      console.error('[confirm_reservation] Failed to create reservation:', error);
      await replyMessage(event.replyToken, [
        { type: 'text', text: '予約の作成中にエラーが発生しました。\n\nもう一度「予約」と送信してお試しください。' },
      ], accessToken);
      await db.prepare('DELETE FROM line_sessions WHERE line_user_id = ?').bind(event.source.userId).run();
      return;
    }

    // Get staff name
    const staff = await db.prepare('SELECT COALESCE(nickname, name) as name FROM staff WHERE id = ?').bind(staffId).first<{ name: string }>();

    // Format date in JST for display
    // startAt was created with +09:00 offset, so internal UTC time is correct
    // To display in JST, we add 9 hours to the internal UTC time
    const displayTime = new Date(startAt.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = `${displayTime.getUTCMonth() + 1}/${displayTime.getUTCDate()} ${displayTime.getUTCHours()}:${String(displayTime.getUTCMinutes()).padStart(2, '0')}`;

    // Calculate final price based on customer type
    const finalPrice = customerType === 'new' && menu.price_new != null
      ? menu.price_new
      : menu.price;

    await replyMessage(event.replyToken, [
      {
        type: 'text',
        text: `✅ ご予約を受け付けました！\n\n📅 ${dateStr}\n💇 ${menu.name}\n👤 ${staff?.name || '---'}\n💰 ¥${finalPrice.toLocaleString()}\n\n※確定後、お店から確認のご連絡をいたします。\n\n予約の確認は「予約確認」と送信してください。`,
      },
    ], accessToken);

    // Notify staff via LINE Messaging API
    const reservationPayload = {
      customerName: customer.name,
      menuName: menu.name,
      date: startAt,
      source: 'line',
    };
    try {
      if (staffIdFromParams) {
        // 指名あり: 担当スタッフのみ通知
        await LineNotifyService.notifyNewReservation(db, staffId, store.id, reservationPayload);
      } else {
        // 指名なし: 店舗の全スタッフに通知
        await LineNotifyService.notifyNewReservationToAllStoreStaff(db, store.id, reservationPayload);
      }
    } catch (error) {
      console.error('Failed to notify staff:', error);
    }

    // Web Push notification to staff
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      try {
        const { PushNotificationService } = await import('../services/pushService');
        const pushDateStr = startAt.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
        const pushTimeStr = startAt.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
        const pushPayload = {
          title: '新しいLINE予約',
          body: `${customer.name}様 ${pushDateStr} ${pushTimeStr} ${menu.name}`,
          url: `/reservations/${reservationId}`,
          tag: `reservation-${reservationId}`,
        };
        if (staffIdFromParams) {
          // 指名あり: 担当スタッフのみ通知
          await PushNotificationService.notifyStaff(
            db, staffId, pushPayload,
            env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY
          );
        } else {
          // 指名なし: 店舗の全スタッフに通知
          await PushNotificationService.notifyAllStoreStaff(
            db, store.id, pushPayload,
            env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY
          );
        }
      } catch (error) {
        console.error('Failed to send reservation push:', error);
      }
    }

    // Clear session
    await db.prepare('DELETE FROM line_sessions WHERE line_user_id = ?').bind(event.source.userId).run();
  } else if (action === 'cancel_reservation') {
    await db.prepare('DELETE FROM line_sessions WHERE line_user_id = ?').bind(event.source.userId).run();

    await replyMessage(event.replyToken, [
      { type: 'text', text: '予約をキャンセルしました。\n\n予約するには「予約」と送信してください。' },
    ], accessToken);
  }
}

// Verify webhook for LINE setup
lineWebhookRoutes.get('/', (c) => {
  return c.text('OK');
});
