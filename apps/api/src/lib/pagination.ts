import { z } from 'zod';
import { Errors } from './errors.js';

/**
 * Cursor pagination (要件 8.1). Cursor is an opaque base64url JSON of the last row's sort key(s).
 * Usage: ORDER BY <sortCol> DESC, id DESC and WHERE (sortCol, id) < (cursor.v, cursor.id)
 */
export const paginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type CursorValue = { v: string | number | null; id: string };

export function encodeCursor(v: CursorValue['v'] | Date, id: string): string {
  const value = v instanceof Date ? v.toISOString() : v;
  return Buffer.from(JSON.stringify({ v: value, id })).toString('base64url');
}

export function decodeCursor(cursor?: string): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorValue;
    if (typeof parsed.id !== 'string') throw new Error('bad cursor');
    return parsed;
  } catch {
    throw Errors.validation('cursorが不正です');
  }
}

/** Given limit+1 fetched rows, return page + next cursor */
export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortKey: (row: T) => CursorValue['v'] | Date,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(sortKey(last), last.id) : null };
}

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
