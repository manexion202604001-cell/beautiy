/**
 * Insert system messages into the conversation thread for reservation events.
 */

function formatJstDatetime(isoString: string): string {
  const d = new Date(isoString);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const hour = jst.getUTCHours();
  const minute = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

interface ReservationMessageParams {
  storeId: string;
  customerId: string;
  staffName: string;
  menuName: string;
  startAt: string;
}

async function insertSystemMessage(db: D1Database, storeId: string, customerId: string, content: string): Promise<void> {
  await db.prepare(
    `INSERT INTO messages (id, store_id, customer_id, staff_id, direction, message_type, content, source, is_read, sent_at)
     VALUES (?, ?, ?, NULL, 'system', 'text', ?, 'web', 1, datetime('now'))`
  ).bind(crypto.randomUUID(), storeId, customerId, content).run();
}

/**
 * Insert a "reservation confirmed" system message.
 */
export async function insertReservationConfirmedMessage(
  db: D1Database,
  params: ReservationMessageParams
): Promise<void> {
  const datetime = formatJstDatetime(params.startAt);
  const content = `予約が確定しました\n日時: ${datetime}\nメニュー: ${params.menuName}\n担当: ${params.staffName}`;
  await insertSystemMessage(db, params.storeId, params.customerId, content);
}

/**
 * Insert a system message for reservation changes.
 * Generates specific messages based on what changed.
 */
export async function insertReservationChangedMessage(
  db: D1Database,
  params: ReservationMessageParams & {
    oldStartAt?: string;
    oldMenuName?: string;
    oldStaffName?: string;
  }
): Promise<void> {
  const lines: string[] = [];

  // Determine what changed
  if (params.oldStartAt && params.oldStartAt !== params.startAt) {
    lines.push('日時が変更になりました');
    lines.push(`日時: ${formatJstDatetime(params.oldStartAt)} → ${formatJstDatetime(params.startAt)}`);
  }
  if (params.oldMenuName && params.oldMenuName !== params.menuName) {
    lines.push('メニューが変更になりました');
    lines.push(`メニュー: ${params.oldMenuName} → ${params.menuName}`);
  }
  if (params.oldStaffName && params.oldStaffName !== params.staffName) {
    lines.push('担当が変更になりました');
    lines.push(`担当: ${params.oldStaffName} → ${params.staffName}`);
  }

  if (lines.length === 0) return;

  // Add current reservation summary
  if (!params.oldStartAt || params.oldStartAt === params.startAt) {
    lines.push(`日時: ${formatJstDatetime(params.startAt)}`);
  }
  if (!params.oldMenuName || params.oldMenuName === params.menuName) {
    lines.push(`メニュー: ${params.menuName}`);
  }
  if (!params.oldStaffName || params.oldStaffName === params.staffName) {
    lines.push(`担当: ${params.staffName}`);
  }

  await insertSystemMessage(db, params.storeId, params.customerId, lines.join('\n'));
}

// Keep backward compat alias
export const insertReservationTimeChangedMessage = insertReservationChangedMessage;
