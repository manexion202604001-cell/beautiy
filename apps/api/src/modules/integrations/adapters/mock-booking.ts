import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withSystem, withTenant } from '../../../db/tenant.js';
import { registerAdapter } from './registry.js';
import { AdapterError, type AdapterAccount, type BookingProviderAdapter, type ExternalBooking, type FetchResult } from './types.js';

/**
 * "mock_booking": a simulated booking medium (HotPepper-like). Real media generally have no public
 * API (要件 0.2), so this adapter is the reference implementation of the extension point and the
 * test double for the sync engine. Its "remote" datastore is the mock_provider_* tables; payloads are
 * kept in a provider-native shape and normalized here only.
 */
export const MOCK_PROVIDER = 'mock_booking';

/** provider-native booking payload */
interface MockNativeBooking {
  reserveId: string;
  reserveStatus: 'RESERVED' | 'CHANGED' | 'CANCELED';
  startDateTime: string;
  endDateTime: string;
  stylistCode: string | null;
  menuCodes: string[];
  guest: { nameKanji?: string | null; nameKana?: string | null; tel?: string | null; mail?: string | null; memberNo?: string | null };
  memo: string | null;
  lastModified: string;
}

const STATUS_MAP: Record<MockNativeBooking['reserveStatus'], ExternalBooking['status']> = {
  RESERVED: 'booked',
  CHANGED: 'changed',
  CANCELED: 'cancelled',
};

const PAGE_SIZE = 500;

function normalize(native: MockNativeBooking): ExternalBooking {
  return {
    externalId: native.reserveId,
    status: STATUS_MAP[native.reserveStatus] ?? 'booked',
    start: new Date(native.startDateTime),
    end: new Date(native.endDateTime),
    staffExternalId: native.stylistCode ?? null,
    menuExternalIds: native.menuCodes ?? [],
    customer: {
      name: native.guest?.nameKanji ?? null,
      kana: native.guest?.nameKana ?? null,
      phone: native.guest?.tel ?? null,
      email: native.guest?.mail ?? null,
      externalMemberId: native.guest?.memberNo ?? null,
    },
    note: native.memo ?? null,
    updatedAt: new Date(native.lastModified),
    raw: native,
  };
}

/** Consume one simulated failure for the operation, if configured (committed independently) */
async function simulateOutage(account: AdapterAccount, op: 'fetch' | 'push'): Promise<void> {
  const fail = await withTenant(account.organizationId, async (trx) => {
    const state = await trx.selectFrom('mock_provider_state').selectAll().where('integration_account_id', '=', account.id).forUpdate().executeTakeFirst();
    if (!state) return false;
    const remaining = op === 'fetch' ? state.fail_fetch : state.fail_push;
    if (remaining === 0) return false;
    if (remaining > 0) {
      await trx
        .updateTable('mock_provider_state')
        .set(op === 'fetch' ? { fail_fetch: remaining - 1, updated_at: new Date() } : { fail_push: remaining - 1, updated_at: new Date() })
        .where('integration_account_id', '=', account.id)
        .execute();
    }
    return true;
  });
  if (fail) throw new AdapterError(MOCK_PROVIDER, '外部予約媒体に接続できません (503 Service Unavailable)');
}

export const mockBookingAdapter: BookingProviderAdapter = {
  name: MOCK_PROVIDER,

  async fetchChanges(account, cursor): Promise<FetchResult> {
    await simulateOutage(account, 'fetch');
    const after = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const rows = await withTenant(account.organizationId, (trx) =>
      trx
        .selectFrom('mock_provider_bookings')
        .select(['payload', 'change_seq'])
        .where('integration_account_id', '=', account.id)
        .where('change_seq', '>', after)
        .orderBy('change_seq')
        .limit(PAGE_SIZE)
        .execute(),
    );
    const last = rows[rows.length - 1];
    return { bookings: rows.map((r) => normalize(r.payload as unknown as MockNativeBooking)), nextCursor: last ? String(last.change_seq) : (cursor ?? null) };
  },

  async fetchAll(account, range): Promise<FetchResult> {
    await simulateOutage(account, 'fetch');
    return withTenant(account.organizationId, async (trx) => {
      const rows = await trx
        .selectFrom('mock_provider_bookings')
        .select(['payload'])
        .where('integration_account_id', '=', account.id)
        .where('start_at', '>=', range.from)
        .where('start_at', '<', range.to)
        .orderBy('start_at')
        .execute();
      const max = await trx
        .selectFrom('mock_provider_bookings')
        .select(sql<string | null>`max(change_seq)::text`.as('seq'))
        .where('integration_account_id', '=', account.id)
        .executeTakeFirst();
      return { bookings: rows.map((r) => normalize(r.payload as unknown as MockNativeBooking)), nextCursor: max?.seq ?? null };
    });
  },

  async pushBlock(account, block): Promise<string> {
    await simulateOutage(account, 'push');
    const id = `blk_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await withTenant(account.organizationId, (trx) =>
      trx
        .insertInto('mock_provider_blocks')
        .values({
          id,
          organization_id: account.organizationId,
          integration_account_id: account.id,
          payload: JSON.stringify({ stylistCode: block.staffExternalId, startDateTime: block.start.toISOString(), endDateTime: block.end.toISOString(), ref: block.appointmentId }),
        })
        .execute(),
    );
    return id;
  },

  async removeBlock(account, externalBlockId): Promise<void> {
    await simulateOutage(account, 'push');
    await withTenant(account.organizationId, (trx) =>
      trx.updateTable('mock_provider_blocks').set({ removed_at: new Date() }).where('id', '=', externalBlockId).where('integration_account_id', '=', account.id).where('removed_at', 'is', null).execute(),
    );
  },

  async health(account) {
    const started = Date.now();
    const state = await withTenant(account.organizationId, (trx) =>
      trx.selectFrom('mock_provider_state').select(['fail_fetch']).where('integration_account_id', '=', account.id).executeTakeFirst(),
    );
    if (state && state.fail_fetch !== 0) return { ok: false, message: '外部予約媒体が応答しません', latencyMs: Date.now() - started };
    if (!account.credentials.apiKey) return { ok: false, message: '認証情報(apiKey)が未設定です', latencyMs: Date.now() - started };
    return { ok: true, latencyMs: Date.now() - started };
  },
};

registerAdapter(mockBookingAdapter);

// ------------------------------------------------------------------ provider-side hooks
// Used by tests and the demo console to play the role of the booking medium.

export interface MockBookingInput {
  reserveId: string;
  start: string | Date;
  end: string | Date;
  stylistCode?: string | null;
  menuCodes?: string[];
  guest?: MockNativeBooking['guest'];
  memo?: string | null;
  status?: MockNativeBooking['reserveStatus'];
  /** override provider-side modification time (to simulate out-of-order deliveries) */
  lastModified?: string | Date;
}

async function accountOrg(accountId: string): Promise<string> {
  const row = await withSystem((trx) => trx.selectFrom('integration_accounts').select('organization_id').where('id', '=', accountId).executeTakeFirst());
  if (!row) throw new Error(`integration account not found: ${accountId}`);
  return row.organization_id;
}

const iso = (v: string | Date) => (typeof v === 'string' ? new Date(v) : v).toISOString();

export const mockBookingProvider = {
  /** create or modify a booking on the provider side (appends to the change feed) */
  async putBooking(accountId: string, input: MockBookingInput): Promise<MockNativeBooking> {
    const orgId = await accountOrg(accountId);
    return withSystem(async (trx) => {
      const existing = await trx
        .selectFrom('mock_provider_bookings')
        .select(['payload'])
        .where('integration_account_id', '=', accountId)
        .where('reserve_id', '=', input.reserveId)
        .executeTakeFirst();
      const prev = existing?.payload as unknown as MockNativeBooking | undefined;
      const native: MockNativeBooking = {
        reserveId: input.reserveId,
        reserveStatus: input.status ?? (prev ? 'CHANGED' : 'RESERVED'),
        startDateTime: iso(input.start),
        endDateTime: iso(input.end),
        stylistCode: input.stylistCode === undefined ? (prev?.stylistCode ?? null) : input.stylistCode,
        menuCodes: input.menuCodes ?? prev?.menuCodes ?? [],
        guest: input.guest ?? prev?.guest ?? {},
        memo: input.memo === undefined ? (prev?.memo ?? null) : input.memo,
        lastModified: iso(input.lastModified ?? new Date()),
      };
      await trx
        .insertInto('mock_provider_bookings')
        .values({ organization_id: orgId, integration_account_id: accountId, reserve_id: input.reserveId, payload: JSON.stringify(native), start_at: new Date(native.startDateTime) })
        .onConflict((oc) =>
          oc.columns(['integration_account_id', 'reserve_id']).doUpdateSet({
            payload: JSON.stringify(native),
            start_at: new Date(native.startDateTime),
            change_seq: sql`nextval('mock_provider_seq')`,
            updated_at: new Date(),
          }),
        )
        .execute();
      return native;
    });
  },

  async cancelBooking(accountId: string, reserveId: string, at: Date = new Date()): Promise<void> {
    await withSystem(async (trx) => {
      const row = await trx.selectFrom('mock_provider_bookings').select(['payload']).where('integration_account_id', '=', accountId).where('reserve_id', '=', reserveId).executeTakeFirstOrThrow();
      const native = { ...(row.payload as unknown as MockNativeBooking), reserveStatus: 'CANCELED', lastModified: at.toISOString() };
      await trx
        .updateTable('mock_provider_bookings')
        .set({ payload: JSON.stringify(native), change_seq: sql`nextval('mock_provider_seq')`, updated_at: new Date() })
        .where('integration_account_id', '=', accountId)
        .where('reserve_id', '=', reserveId)
        .execute();
    });
  },

  /** simulate an outage: number of upcoming calls to fail (-1 = until cleared, 0 = healthy) */
  async setOutage(accountId: string, opts: { fetch?: number; push?: number }): Promise<void> {
    const orgId = await accountOrg(accountId);
    await withSystem((trx) =>
      trx
        .insertInto('mock_provider_state')
        .values({ integration_account_id: accountId, organization_id: orgId, fail_fetch: opts.fetch ?? 0, fail_push: opts.push ?? 0 })
        .onConflict((oc) =>
          oc.column('integration_account_id').doUpdateSet({
            ...(opts.fetch !== undefined ? { fail_fetch: opts.fetch } : {}),
            ...(opts.push !== undefined ? { fail_push: opts.push } : {}),
            updated_at: new Date(),
          }),
        )
        .execute(),
    );
  },

  async listBlocks(accountId: string, opts: { activeOnly?: boolean } = {}) {
    return withSystem((trx) =>
      trx
        .selectFrom('mock_provider_blocks')
        .select(['id', 'payload', 'created_at', 'removed_at'])
        .where('integration_account_id', '=', accountId)
        .$if(!!opts.activeOnly, (q) => q.where('removed_at', 'is', null))
        .orderBy('created_at')
        .execute(),
    ).then((rows) => rows.map((r) => ({ ...r, payload: r.payload as { stylistCode: string | null; startDateTime: string; endDateTime: string; ref: string } })));
  },
};
