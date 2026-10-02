type LogEntry = {
  reservationId: string;
  eventType: string;
  actorType: 'staff' | 'customer' | 'system';
  actorId?: string | null;
  actorName?: string | null;
  description: string;
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

export async function insertReservationLog(
  db: D1Database,
  entry: LogEntry
): Promise<void> {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO reservation_logs (id, reservation_id, event_type, actor_type, actor_id, actor_name, description, changes, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    entry.reservationId,
    entry.eventType,
    entry.actorType,
    entry.actorId || null,
    entry.actorName || null,
    entry.description,
    entry.changes ? JSON.stringify(entry.changes) : null,
    entry.metadata ? JSON.stringify(entry.metadata) : null
  ).run();
}
