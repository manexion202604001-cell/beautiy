// LINE Messaging API Service
export class LineService {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  // Send push message
  async pushMessage(userId: string, messages: object[]): Promise<void> {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('LINE push message failed:', error);
      throw new Error(`LINE push message failed: ${response.status}`);
    }
  }

  // Send text message
  async sendTextMessage(userId: string, text: string): Promise<void> {
    await this.pushMessage(userId, [{ type: 'text', text }]);
  }

  // Send reservation confirmation (with optional counseling sheet button)
  async sendReservationConfirmation(
    userId: string,
    reservation: {
      date: string;
      time: string;
      menuName: string;
      staffName: string;
      price: number;
      duration: number;
    },
    counselingUrl?: string
  ): Promise<void> {
    const flexMessage = {
      type: 'flex',
      altText: '✅ 予約が確定しました！',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '✅ 予約が確定しました！',
              weight: 'bold',
              size: 'lg',
            },
            {
              type: 'separator',
              margin: 'lg',
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'lg',
              spacing: 'sm',
              contents: [
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '📅 日時', size: 'sm', color: '#999999', flex: 0 },
                  { type: 'text', text: `${reservation.date} ${reservation.time}`, size: 'sm', align: 'end' },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '💇 メニュー', size: 'sm', color: '#999999', flex: 0 },
                  { type: 'text', text: reservation.menuName, size: 'sm', align: 'end', wrap: true },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '👤 担当', size: 'sm', color: '#999999', flex: 0 },
                  { type: 'text', text: reservation.staffName, size: 'sm', align: 'end' },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '💰 料金', size: 'sm', color: '#999999', flex: 0 },
                  { type: 'text', text: `¥${reservation.price.toLocaleString()}`, size: 'sm', align: 'end' },
                ]},
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '⏱ 所要時間', size: 'sm', color: '#999999', flex: 0 },
                  { type: 'text', text: `${reservation.duration}分`, size: 'sm', align: 'end' },
                ]},
              ],
            },
            {
              type: 'text',
              text: 'ご来店をお待ちしております！',
              size: 'sm',
              color: '#666666',
              margin: 'lg',
            },
            ...(counselingUrl ? [
              {
                type: 'separator',
                margin: 'lg',
              },
              {
                type: 'text',
                text: '📋 事前にカウンセリングシートをご記入いただくと、当日スムーズに施術を始められます。',
                size: 'xs',
                color: '#999999',
                wrap: true,
                margin: 'lg',
              },
            ] : []),
          ],
          paddingAll: '20px',
        },
        ...(counselingUrl ? {
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#b8936a',
                action: {
                  type: 'uri',
                  label: 'カウンセリングシートを記入する',
                  uri: counselingUrl,
                },
              },
            ],
            paddingAll: '12px',
          },
        } : {}),
      },
    };

    await this.pushMessage(userId, [flexMessage]);
  }

  // Send reservation cancellation notice
  async sendReservationCancellation(
    userId: string,
    reservation: {
      date: string;
      time: string;
      menuName: string;
      reason?: string;
    }
  ): Promise<void> {
    let message = `❌ 予約がキャンセルされました

📅 ${reservation.date} ${reservation.time}
💇 ${reservation.menuName}`;

    if (reservation.reason) {
      message += `\n\n理由: ${reservation.reason}`;
    }

    message += '\n\n新しい予約は「予約」と送信してください。';

    await this.sendTextMessage(userId, message);
  }

  // Send reminder (day before)
  async sendReservationReminder(
    userId: string,
    reservation: {
      date: string;
      time: string;
      menuName: string;
      staffName: string;
    }
  ): Promise<void> {
    const message = `🔔 明日のご予約リマインダー

📅 ${reservation.date} ${reservation.time}
💇 ${reservation.menuName}
👤 ${reservation.staffName}

ご来店をお待ちしております！`;

    await this.sendTextMessage(userId, message);
  }

  // Send reminder (one week before)
  async sendReservationReminderWeek(
    userId: string,
    reservation: {
      date: string;
      time: string;
      menuName: string;
      staffName: string;
    }
  ): Promise<void> {
    const message = `📅 1週間後のご予約リマインダー

📅 ${reservation.date} ${reservation.time}
💇 ${reservation.menuName}
👤 ${reservation.staffName}

ご来店をお待ちしております！
変更やキャンセルがありましたらお早めにご連絡ください。`;

    await this.sendTextMessage(userId, message);
  }

  // Send reservation time change notification
  async sendReservationTimeChange(
    userId: string,
    reservation: {
      date: string;
      time: string;
      menuName: string;
      staffName: string;
    }
  ): Promise<void> {
    const message = `📝 ご予約の日時が変更されました

📅 ${reservation.date} ${reservation.time}
💇 ${reservation.menuName}
👤 ${reservation.staffName}

ご来店をお待ちしております！
ご不明な点がございましたらお気軽にご連絡ください。`;

    await this.sendTextMessage(userId, message);
  }

  // Send counseling sheet prompt
  async sendCounselingSheetPrompt(userId: string, counselingUrl: string): Promise<void> {
    const flexMessage = {
      type: 'flex',
      altText: '📋 カウンセリングシートのご記入をお願いします',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '📋 カウンセリングシート',
              weight: 'bold',
              size: 'md',
            },
            {
              type: 'text',
              text: '事前にカウンセリングシートをご記入いただくと、当日スムーズに施術を始められます。',
              size: 'sm',
              color: '#666666',
              wrap: true,
              margin: 'md',
            },
            {
              type: 'text',
              text: 'アレルギーやご希望などを事前にお伝えいただけます。',
              size: 'xs',
              color: '#999999',
              wrap: true,
              margin: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#b8936a',
              action: {
                type: 'uri',
                label: 'カウンセリングシートを記入する',
                uri: counselingUrl,
              },
            },
          ],
          paddingAll: '12px',
        },
      },
    };

    await this.pushMessage(userId, [flexMessage]);
  }
}

// Get LINE user ID for a customer at a specific store.
// LINE providers are per-store, so a merged customer holds one line_user_id per store;
// notifications must resolve the row for the store the event belongs to.
export async function getLineUserId(db: D1Database, customerId: string, storeId: string): Promise<string | null> {
  // Skip LINE notifications for minimo customers
  const customer = await db.prepare(
    'SELECT is_minimo FROM customers WHERE id = ?'
  ).bind(customerId).first<{ is_minimo: number }>();
  if (customer?.is_minimo) return null;

  const result = await db.prepare(
    "SELECT line_user_id FROM customer_line WHERE customer_id = ? AND store_id = ? AND line_user_id <> '' AND is_blocked = 0"
  ).bind(customerId, storeId).first<{ line_user_id: string }>();

  return result?.line_user_id || null;
}

// Get store's LINE access token
export async function getStoreLineAccessToken(db: D1Database, storeId: string): Promise<string | null> {
  const result = await db.prepare(
    'SELECT line_access_token FROM stores WHERE id = ?'
  ).bind(storeId).first<{ line_access_token: string | null }>();

  return result?.line_access_token || null;
}

// "M/D H:mm" in JST (Workers run in UTC)
function formatJstShort(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

// Staff LINE Notification Service (using Messaging API)
export class StaffLineNotificationService {
  // Send push message to staff via Messaging API
  static async sendMessage(accessToken: string, userId: string, message: string): Promise<boolean> {
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          to: userId,
          messages: [{ type: 'text', text: message }],
        }),
      });

      if (!response.ok) {
        console.error('LINE push message to staff failed:', await response.text());
        return false;
      }
      return true;
    } catch (error) {
      console.error('LINE push message error:', error);
      return false;
    }
  }

  // Send new reservation notification to staff
  static async notifyNewReservation(
    db: D1Database,
    staffId: string,
    storeId: string,
    reservation: {
      customerName: string;
      menuName: string;
      date: Date;
      source: string;
      staffAppUrl?: string;
    }
  ): Promise<boolean> {
    // Get staff's LINE user ID and notification setting
    const staff = await db.prepare(
      'SELECT line_user_id, notify_line FROM staff WHERE id = ?'
    ).bind(staffId).first<{ line_user_id: string | null; notify_line: number }>();

    if (!staff?.line_user_id || !staff.notify_line) {
      return false;
    }

    // Get store's LINE access token
    const accessToken = await getStoreLineAccessToken(db, storeId);
    if (!accessToken) {
      return false;
    }

    const dateStr = formatJstShort(reservation.date);
    const sourceLabel = reservation.source === 'line' ? 'LINE' : reservation.source === 'web' ? 'Web' : reservation.source;

    let message = `🆕 新規予約が入りました

📅 ${dateStr}
👤 ${reservation.customerName}
💇 ${reservation.menuName}
📱 経由: ${sourceLabel}`;

    if (reservation.staffAppUrl) {
      message += `\n\n管理画面で確認:\n${reservation.staffAppUrl}/reservations`;
    }

    return this.sendMessage(accessToken, staff.line_user_id, message);
  }

  // Send new reservation notification to all staff in a store
  static async notifyNewReservationToAllStoreStaff(
    db: D1Database,
    storeId: string,
    reservation: {
      customerName: string;
      menuName: string;
      date: Date;
      source: string;
    }
  ): Promise<{ sent: number; failed: number }> {
    const storeStaff = await db.prepare(
      'SELECT staff_id FROM staff_stores WHERE store_id = ?'
    ).bind(storeId).all<{ staff_id: string }>();

    let sent = 0;
    let failed = 0;
    for (const s of storeStaff.results || []) {
      const result = await this.notifyNewReservation(db, s.staff_id, storeId, reservation);
      if (result) sent++;
      else failed++;
    }
    return { sent, failed };
  }

  // Send reservation cancellation notification to staff
  static async notifyReservationCancelled(
    db: D1Database,
    staffId: string,
    storeId: string,
    reservation: {
      customerName: string;
      menuName: string;
      date: Date;
      reason?: string;
      staffAppUrl?: string;
    }
  ): Promise<boolean> {
    const staff = await db.prepare(
      'SELECT line_user_id, notify_line FROM staff WHERE id = ?'
    ).bind(staffId).first<{ line_user_id: string | null; notify_line: number }>();

    if (!staff?.line_user_id || !staff.notify_line) {
      return false;
    }

    const accessToken = await getStoreLineAccessToken(db, storeId);
    if (!accessToken) {
      return false;
    }

    const dateStr = formatJstShort(reservation.date);

    let message = `❌ 予約がキャンセルされました

📅 ${dateStr}
👤 ${reservation.customerName}
💇 ${reservation.menuName}`;

    if (reservation.reason) {
      message += `\n📝 理由: ${reservation.reason}`;
    }

    if (reservation.staffAppUrl) {
      message += `\n\n管理画面で確認:\n${reservation.staffAppUrl}/reservations`;
    }

    return this.sendMessage(accessToken, staff.line_user_id, message);
  }
}

// Legacy alias for backward compatibility
export const LineNotifyService = StaffLineNotificationService;

// Menu Selection Flex Message Builder (Table with prices and images)
export function buildMenuSelectionFlexMessage(
  menus: {
    id: string;
    name: string;
    price: number;
    duration: number;
    category?: string;
    image_url?: string | null;
    description?: string | null;
  }[],
  imageBaseUrl: string,
  categoryColors: Record<string, string> = {}
): object {
  // Always use carousel format with images and descriptions (LINE carousel max: 12 bubbles)
  const bubbles: object[] = menus.slice(0, 12).map((menu) => {
    const imageUrl = menu.image_url
      ? `${imageBaseUrl}${menu.image_url}`
      : null;

    const categoryColor = (menu.category && categoryColors[menu.category]) || '#1DB446';

    const bodyContents: object[] = [
      {
        type: 'text',
        text: menu.category || 'メニュー',
        size: 'xxs',
        color: categoryColor,
        weight: 'bold',
      },
      {
        type: 'text',
        text: menu.name,
        size: 'md',
        weight: 'bold',
        color: '#333333',
        wrap: true,
        maxLines: 2,
        margin: 'xs',
      },
    ];

    // Add description if available
    if (menu.description) {
      bodyContents.push({
        type: 'text',
        text: menu.description,
        size: 'xs',
        color: '#888888',
        wrap: true,
        maxLines: 3,
        margin: 'sm',
      });
    }

    // Price and duration row
    bodyContents.push({
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: `${menu.duration}分`,
          size: 'xs',
          color: '#888888',
          flex: 1,
        },
        {
          type: 'text',
          text: `¥${menu.price.toLocaleString()}`,
          size: 'md',
          color: '#333333',
          weight: 'bold',
          align: 'end',
          flex: 1,
        },
      ],
      margin: 'md',
    });

    const bubble: Record<string, unknown> = {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents,
        paddingAll: 'lg',
        action: {
          type: 'postback',
          data: `action=select_menu&menu_id=${menu.id}`,
          displayText: menu.name,
        },
      },
    };

    // Add hero image if available
    if (imageUrl) {
      bubble.hero = {
        type: 'image',
        url: imageUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
      };
    }

    return bubble;
  });

  if (bubbles.length > 0) {
    return {
      type: 'flex',
      altText: 'メニューを選択してください（スワイプして選択）',
      contents: {
        type: 'carousel',
        contents: bubbles,
      },
    };
  }

  // No images - use table format
  // Group menus by category
  const menusByCategory = new Map<string, typeof menus>();
  for (const menu of menus) {
    const category = menu.category || 'メニュー';
    if (!menusByCategory.has(category)) {
      menusByCategory.set(category, []);
    }
    menusByCategory.get(category)!.push(menu);
  }

  // Build menu items
  const contents: object[] = [];

  for (const [category, categoryMenus] of menusByCategory) {
    const categoryColor = categoryColors[category] || '#1DB446';
    // Category header
    contents.push({
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              contents: [],
              width: '4px',
              height: '16px',
              backgroundColor: categoryColor,
              cornerRadius: 'md',
            },
            {
              type: 'text',
              text: category,
              weight: 'bold',
              size: 'sm',
              color: '#333333',
              margin: 'sm',
            },
          ],
          alignItems: 'center',
        },
      ],
      paddingTop: contents.length > 0 ? 'lg' : 'none',
      paddingBottom: 'sm',
    });

    // Menu items in this category
    for (const menu of categoryMenus) {
      contents.push({
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: menu.name,
                size: 'sm',
                color: '#333333',
                wrap: true,
              },
              {
                type: 'text',
                text: `${menu.duration}分`,
                size: 'xs',
                color: '#888888',
              },
            ],
            flex: 3,
          },
          {
            type: 'text',
            text: `¥${menu.price.toLocaleString()}`,
            size: 'sm',
            color: '#333333',
            align: 'end',
            flex: 1,
            gravity: 'center',
          },
        ],
        action: {
          type: 'postback',
          data: `action=select_menu&menu_id=${menu.id}`,
          displayText: menu.name,
        },
        backgroundColor: '#F8F8F8',
        cornerRadius: 'md',
        paddingAll: 'md',
        margin: 'sm',
      });
    }
  }

  return {
    type: 'flex',
    altText: 'メニューを選択してください',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'メニュー選択',
            weight: 'bold',
            size: 'lg',
            color: '#333333',
          },
          {
            type: 'text',
            text: 'ご希望のメニューをタップしてください',
            size: 'xs',
            color: '#888888',
            margin: 'sm',
          },
        ],
        backgroundColor: '#FAFAFA',
        paddingAll: 'lg',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents,
        paddingAll: 'lg',
      },
    },
  };
}

// Staff Selection Flex Message Builder (Carousel with avatar photos)
export function buildStaffSelectionFlexMessage(
  staffList: {
    id: string;
    name: string;
    nickname?: string | null;
    avatar_url?: string | null;
  }[],
  imageBaseUrl: string
): object {
  const bubbles: object[] = [];

  // "指名なし" bubble (no photo)
  bubbles.push({
    type: 'bubble',
    size: 'micro',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '✂️',
              size: 'xxl',
              align: 'center',
            },
          ],
          height: '80px',
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: '#F0F0F0',
          cornerRadius: 'md',
        },
        {
          type: 'text',
          text: '指名なし',
          size: 'sm',
          weight: 'bold',
          color: '#333333',
          align: 'center',
          margin: 'md',
        },
        {
          type: 'text',
          text: 'おまかせ',
          size: 'xs',
          color: '#888888',
          align: 'center',
          margin: 'xs',
        },
      ],
      paddingAll: 'md',
      action: {
        type: 'postback',
        data: 'action=select_staff&staff_id=any',
        displayText: '指名なし',
      },
    },
  });

  // Staff bubbles with avatar
  for (const staff of staffList.slice(0, 9)) {
    const imageUrl = staff.avatar_url
      ? `${imageBaseUrl}${staff.avatar_url}`
      : null;

    const bubble: Record<string, unknown> = {
      type: 'bubble',
      size: 'micro',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: staff.nickname || staff.name,
            size: 'sm',
            weight: 'bold',
            color: '#333333',
            align: 'center',
            margin: 'md',
          },
        ],
        paddingAll: 'md',
        action: {
          type: 'postback',
          data: `action=select_staff&staff_id=${staff.id}`,
          displayText: staff.nickname || staff.name,
        },
      },
    };

    if (imageUrl) {
      bubble.hero = {
        type: 'image',
        url: imageUrl,
        size: 'full',
        aspectRatio: '1:1',
        aspectMode: 'cover',
      };
    } else {
      // No avatar — show placeholder icon
      const body = bubble.body as Record<string, unknown>;
      const contents = body.contents as object[];
      contents.unshift({
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '👤',
            size: 'xxl',
            align: 'center',
          },
        ],
        height: '80px',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#F0F0F0',
        cornerRadius: 'md',
      });
    }

    bubbles.push(bubble);
  }

  return {
    type: 'flex',
    altText: 'スタッフを選択してください（スワイプして選択）',
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

// Weekly Calendar Flex Message Builder
export type TimeSlotStatus = 'available' | 'limited' | 'unavailable';

export function buildWeeklyCalendarFlexMessage(
  weekData: {
    date: string; // YYYY-MM-DD
    displayDate: string; // M/D(曜)
    slots: { time: string; hour: number; minute: number; status: TimeSlotStatus }[];
  }[],
  menuId: string,
  staffId: string
): object {
  // Build carousel with one bubble per day
  const bubbles: object[] = [];

  for (const day of weekData) {
    // Build time slot buttons for this day (only available/limited slots)
    const slotButtons: object[] = [];

    for (const slot of day.slots) {
      if (slot.status === 'unavailable') continue;

      const isAvailable = slot.status === 'available';
      slotButtons.push({
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: slot.time,
            size: 'sm',
            color: '#333333',
            flex: 2,
          },
          {
            type: 'text',
            text: isAvailable ? '○' : '△',
            size: 'sm',
            color: isAvailable ? '#06C755' : '#FFA000',
            align: 'center',
            flex: 1,
          },
        ],
        action: {
          type: 'postback',
          data: `action=select_time&time=${slot.time}&date=${day.date}&menu_id=${menuId}&staff_id=${staffId}`,
        },
        backgroundColor: isAvailable ? '#E8F5E9' : '#FFF8E1',
        cornerRadius: 'md',
        paddingAll: 'md',
        margin: 'sm',
      });
    }

    // If no available slots, show message
    if (slotButtons.length === 0) {
      slotButtons.push({
        type: 'text',
        text: '空きがありません',
        size: 'sm',
        color: '#999999',
        align: 'center',
        margin: 'lg',
      });
    }

    bubbles.push({
      type: 'bubble',
      size: 'micro',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: day.displayDate,
            weight: 'bold',
            size: 'lg',
            color: '#333333',
            align: 'center',
          },
        ],
        backgroundColor: '#FAFAFA',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: slotButtons.slice(0, 10), // Limit to 10 slots per day
        paddingAll: 'sm',
      },
    });
  }

  return {
    type: 'flex',
    altText: '日時を選択してください（スワイプして日付を選択）',
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

// Build Flex Message for staff message notification to customer
export function buildStaffMessageFlexMessage(params: {
  staffName: string;
  staffAvatarUrl?: string | null;
  content: string;
  messagesUrl: string;
}): object {
  const { staffName, staffAvatarUrl, content, messagesUrl } = params;
  const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;

  // Use uploaded avatar or generate initial avatar
  const avatarUrl = staffAvatarUrl
    || `https://ui-avatars.com/api/?name=${encodeURIComponent(staffName)}&background=b8936a&color=fff&size=200&bold=true`;

  return {
    type: 'flex',
    altText: `${staffName}さんからメッセージが届きました`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          // Staff info row: avatar + name
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'image',
                url: avatarUrl,
                size: 'xxs',
                aspectRatio: '1:1',
                aspectMode: 'cover',
                flex: 0,
              },
              {
                type: 'text',
                text: `${staffName}さんからメッセージが届きました`,
                weight: 'bold',
                size: 'sm',
                wrap: true,
                flex: 1,
                gravity: 'center',
              },
            ],
            spacing: 'md',
            alignItems: 'center',
          },
          // Message preview
          {
            type: 'text',
            text: preview,
            size: 'sm',
            color: '#666666',
            wrap: true,
            margin: 'lg',
          },
        ],
        paddingAll: '20px',
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
              label: 'メッセージを確認/返信する',
              uri: messagesUrl,
            },
          },
        ],
        paddingAll: '12px',
      },
    },
  };
}
