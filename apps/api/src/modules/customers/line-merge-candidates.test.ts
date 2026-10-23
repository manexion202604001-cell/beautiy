import { beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  asSystem,
  createCustomer,
  createLineChannel,
  createStaffUser,
  createTenant,
  daysAgo,
  lineFollower,
  lineUserId,
  updateCustomer,
  type Tenant,
} from '../../test/helpers.js';
import { lineMock } from '../messaging/providers/line.js';

beforeEach(() => lineMock.reset());

type Candidate = {
  id: string;
  match_type: string;
  line_customer_id: string;
  line_customer_name: string;
  line_display_name: string | null;
  existing_customer_id: string;
  existing_customer_name: string;
  existing_customer_name_kana: string | null;
  existing_customer_phone: string | null;
  existing_customer_visit_count: number;
  existing_customer_staff_name: string | null;
};

const list = async (t: Tenant, query: Record<string, unknown> = { shopId: t.shopId }) => {
  const res = await t.owner.get('/v1/customers/line-merge-candidates', query);
  expect(res.status).toBe(200);
  return res.body as { candidates: Candidate[]; total: number };
};
const pairOf = (body: { candidates: Candidate[] }, lineId: string) =>
  body.candidates.filter((c) => c.line_customer_id === lineId);

/** a LINE friend whose record staff (or the customer) completed */
async function lineCustomer(
  t: Tenant,
  ch: Awaited<ReturnType<typeof createLineChannel>>,
  patch: Record<string, unknown>,
) {
  const f = await lineFollower(t, ch);
  await updateCustomer(t, f.customerId, patch);
  return f.customerId;
}

describe('統合候補 (LINE customer ↔ existing customer)', () => {
  it('pairs LINE customers with existing customers of the shop by phone, name and reading', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const shop = { primaryShopId: t.shopId };

    const byName = await lineCustomer(t, ch, { last_name: '山田', first_name: '花子' });
    const yamada = await createCustomer(t, {
      lastName: '山田',
      firstName: '花子',
      lastNameKana: 'ヤマダ',
      firstNameKana: 'ハナコ',
      phone: '090-1000-0001',
      ...shop,
    });

    const byPhone = await lineCustomer(t, ch, {
      phone: '090-2000-0002',
      phone_normalized: '+819020000002',
    });
    const phoneOwner = await createCustomer(t, {
      lastName: '電話',
      firstName: '一致',
      phone: '090-2000-0002',
      ...shop,
    });

    // display name written in kana = the existing customer's reading
    const byKanaName = await lineCustomer(t, ch, { last_name: '', first_name: 'さとう はなこ' });
    const sato = await createCustomer(t, {
      lastName: '佐藤',
      firstName: '花子',
      lastNameKana: 'サトウ',
      firstNameKana: 'ハナコ',
      ...shop,
    });
    // フリガナ entered on the LINE record
    const byKana = await lineCustomer(t, ch, {
      last_name: 'すずき',
      first_name: 'じろー',
      last_name_kana: 'スズキ',
      first_name_kana: 'ジロウ',
    });
    const suzuki = await createCustomer(t, {
      lastName: '鈴木',
      firstName: '次郎',
      lastNameKana: 'すずき',
      firstNameKana: 'じろう',
      ...shop,
    });

    // not candidates: two records without LINE (they stay in 名前重複 / 重複候補), a LINE friend without a match
    await createCustomer(t, {
      lastName: '重複',
      firstName: '電話',
      phone: '090-3000-0003',
      ...shop,
    });
    await createCustomer(t, {
      lastName: '重複',
      firstName: '電話',
      phone: '090-3000-0003',
      ...shop,
    });
    await lineFollower(t, ch);

    const body = await list(t);
    expect(body.total).toBe(4);
    expect(pairOf(body, byName)).toMatchObject([
      {
        existing_customer_id: yamada.id,
        match_type: 'name',
        line_customer_name: '山田 花子',
        existing_customer_name_kana: 'ヤマダ ハナコ',
        existing_customer_phone: '090-1000-0001',
        existing_customer_visit_count: 0,
      },
    ]);
    expect(pairOf(body, byName)[0]!.line_display_name).toMatch(/^LINEユーザー/);
    expect(pairOf(body, byName)[0]!.id).toBe(`${byName}:${yamada.id}`);
    expect(pairOf(body, byPhone)).toMatchObject([
      { existing_customer_id: phoneOwner.id, match_type: 'phone' },
    ]);
    expect(pairOf(body, byKanaName)).toMatchObject([
      { existing_customer_id: sato.id, match_type: 'name_kana' },
    ]);
    expect(pairOf(body, byKana)).toMatchObject([
      { existing_customer_id: suzuki.id, match_type: 'name_kana' },
    ]);

    // one LINE customer (予約詳細)
    const one = await list(t, { shopId: t.shopId, customerId: byPhone });
    expect(one.total).toBe(1);
    expect(one.candidates[0]!.existing_customer_id).toBe(phoneOwner.id);
  });

  it('prefers the phone label, follows the shop and leaves records linked to LINE later alone', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `lm2-${Date.now()}` }))
      .body as { id: string };

    const lineId = await lineCustomer(t, ch, {
      last_name: '高橋',
      first_name: '愛',
      phone: '090-4000-0004',
      phone_normalized: '+819040000004',
    });
    const both = await createCustomer(t, {
      lastName: '高橋',
      firstName: '愛',
      phone: '090-4000-0004',
      primaryShopId: t.shopId,
    });
    const other = await createCustomer(t, {
      lastName: '高橋',
      firstName: '愛',
      primaryShopId: shop2.id,
    });

    const main = await list(t);
    expect(pairOf(main, lineId)).toMatchObject([
      { existing_customer_id: both.id, match_type: 'phone' },
    ]);
    // the LINE record is not tied to a shop yet (organization account) → offered to every shop
    expect(pairOf(await list(t, { shopId: shop2.id }), lineId)).toMatchObject([
      { existing_customer_id: other.id, match_type: 'name' },
    ]);

    // a customer the salon already had, linked to LINE afterwards (LINE連携 QR), is an existing customer
    const linkedLater = await createCustomer(t, {
      lastName: '後日',
      firstName: '連携',
      primaryShopId: t.shopId,
    });
    await updateCustomer(t, linkedLater.id, { created_at: daysAgo(30) });
    const issued = await t.owner.post(`/v1/customers/${linkedLater.id}/line-link-token`, {});
    expect(
      (
        await api().post('/v1/public/line-link', {
          token: issued.body.token,
          idToken: `mock:${lineUserId()}`,
        })
      ).status,
    ).toBe(200);
    await createCustomer(t, { lastName: '後日', firstName: '連携', primaryShopId: t.shopId });
    expect(pairOf(await list(t), linkedLater.id)).toEqual([]);
  });

  it('スキップ dismisses the pair and 統合する merges the LINE record into the existing one', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const skipped = await lineCustomer(t, ch, { last_name: '伊藤', first_name: '舞' });
    const ito = await createCustomer(t, {
      lastName: '伊藤',
      firstName: '舞',
      primaryShopId: t.shopId,
    });
    const merged = await lineCustomer(t, ch, { last_name: '渡辺', first_name: '咲' });
    const watanabe = await createCustomer(t, {
      lastName: '渡辺',
      firstName: '咲',
      primaryShopId: t.shopId,
    });
    expect((await list(t)).total).toBe(2);

    expect(
      (
        await t.owner.post('/v1/customers/duplicates/dismiss', {
          customerIdA: skipped,
          customerIdB: ito.id,
        })
      ).status,
    ).toBe(204);
    expect(
      (await t.owner.post(`/v1/customers/${watanabe.id}/merge`, { sourceCustomerId: merged }))
        .status,
    ).toBe(200);
    const after = await list(t);
    expect(after.total).toBe(0);
    // the existing record now has the LINE link, and is not offered as a LINE customer itself
    const identities = await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .selectFrom('customer_identities')
        .select('customer_id')
        .where('provider', '=', 'line')
        .where('customer_id', '=', watanabe.id)
        .execute(),
    );
    expect(identities).toHaveLength(1);
    await createCustomer(t, { lastName: '渡辺', firstName: '咲', primaryShopId: t.shopId });
    expect((await list(t)).total).toBe(0);
  });

  it('requires customer.merge', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    expect(
      (await stylist.api.get('/v1/customers/line-merge-candidates', { shopId: t.shopId })).status,
    ).toBe(403);
  });
});
