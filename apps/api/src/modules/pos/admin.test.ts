import { describe, expect, it } from 'vitest';
import { asSystem, createStaffUser, createTenant } from '../../test/helpers.js';
import { book, createProduct, key, openRegister, posSetup as setup, quickSale, setPosSettings, year } from './test-utils.js';

describe('register sessions (レジ開局・締め)', () => {
  it('computes expected cash, difference and summary at close', async () => {
    const { t, stylist } = await setup();
    const reception = await createStaffUser(t, 'reception');
    expect((await stylist.api.post('/v1/register-sessions/open', { shopId: t.shopId, openingCash: 10000 })).status).toBe(403);
    const reg = await openRegister(reception.api, t.shopId, 10000);
    const dup = await reception.api.post('/v1/register-sessions/open', { shopId: t.shopId, openingCash: 0 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('REGISTER_ALREADY_OPEN');

    const cashSale = await quickSale(reception.api, t.shopId, [{ type: 'service', name: 'カット', unitPrice: 3000 }], { staffId: stylist.staffId, tendered: 5000 });
    await quickSale(reception.api, t.shopId, [{ type: 'service', name: 'カラー', unitPrice: 2000 }], { staffId: stylist.staffId, method: 'card' });
    expect((await reception.api.post(`/v1/register-sessions/${reg.id}/cash-movements`, { type: 'pay_in', amount: 2000, reason: '両替' })).status).toBe(201);
    expect((await reception.api.post(`/v1/register-sessions/${reg.id}/cash-movements`, { type: 'pay_out', amount: 500, reason: '消耗品購入' })).status).toBe(201);
    const refund = await t.owner.post(`/v1/transactions/${cashSale.id}/refunds`, { amount: 1000, reason: '一部返金', idempotencyKey: key() });
    expect(refund.status).toBe(200);

    const current = await reception.api.get('/v1/register-sessions/current', { shopId: t.shopId });
    expect(current.body.session.expected_cash).toBe(10000 + 3000 + 2000 - 500 - 1000);
    expect(current.body.session.summary.byMethod).toEqual({ cash: 3000, card: 2000 });

    const mismatch = await reception.api.post(`/v1/register-sessions/${reg.id}/close`, { countedCash: 13000, cashBreakdown: { '10000': 1, '1000': 3, '500': 1 } });
    expect(mismatch.status).toBe(400);
    const closed = await reception.api.post(`/v1/register-sessions/${reg.id}/close`, { cashBreakdown: { '10000': 1, '1000': 3 } });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', expected_cash: 13500, counted_cash: 13000, difference: -500 });
    expect(closed.body.summary).toMatchObject({ openingCash: 10000, cashSales: 3000, cashRefunds: 1000, payIn: 2000, payOut: 500, transactionCount: 2, sales: 5000 });
    expect(closed.body.summary.byStaff).toEqual([expect.objectContaining({ staffId: stylist.staffId, amount: 5000, transactions: 2 })]);

    expect((await reception.api.post(`/v1/register-sessions/${reg.id}/close`, { countedCash: 0 })).body.error.code).toBe('REGISTER_CLOSED');
    expect((await reception.api.post(`/v1/register-sessions/${reg.id}/cash-movements`, { type: 'pay_in', amount: 1, reason: 'x' })).body.error.code).toBe('REGISTER_CLOSED');
    expect((await reception.api.get('/v1/register-sessions/current', { shopId: t.shopId })).body.session).toBeNull();
    const list = await reception.api.get('/v1/register-sessions', { shopId: t.shopId });
    expect(list.body.items.map((s: any) => s.id)).toEqual([reg.id]);
  });

  it('records a cash pay-out in the current session when voiding a sale from a closed session', async () => {
    const { t } = await setup();
    const a = await openRegister(t.owner, t.shopId, 0);
    const sale = await quickSale(t.owner, t.shopId, [{ type: 'service', name: 'カット', unitPrice: 4400 }]);
    await t.owner.post(`/v1/register-sessions/${a.id}/close`, { countedCash: 4400 });
    const b = await openRegister(t.owner, t.shopId, 4400);
    const v = await t.owner.post(`/v1/transactions/${sale.id}/void`, { reason: '取消' });
    expect(v.status).toBe(200);
    const cur = await t.owner.get('/v1/register-sessions/current', { shopId: t.shopId });
    expect(cur.body.session.id).toBe(b.id);
    expect(cur.body.session.summary.payOut).toBe(4400);
    expect(cur.body.session.expected_cash).toBe(0);
    const closedA = await t.owner.get(`/v1/register-sessions/${a.id}`);
    expect(closedA.body.difference).toBe(0); // closed snapshot unchanged
  });
});

describe('numbering & receipts', () => {
  it('assigns gapless per-shop transaction numbers, also under concurrency', async () => {
    const { t, menu } = await setup();
    await openRegister(t.owner, t.shopId);
    const first = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }]);
    expect(first.transaction_number).toBe(`${year}-000001`);
    // a failed completion does not consume a number
    const unpaid = (await t.owner.post('/v1/transactions', { shopId: t.shopId })).body;
    await t.owner.put(`/v1/transactions/${unpaid.id}/items`, { version: unpaid.version, items: [{ type: 'service', menuId: menu.id }] });
    expect((await t.owner.post(`/v1/transactions/${unpaid.id}/complete`)).status).toBe(422);
    const drafts = await Promise.all(Array.from({ length: 5 }, () => quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { complete: false })));
    const done = await Promise.all(drafts.map((d) => t.owner.post(`/v1/transactions/${d.id}/complete`)));
    expect(done.every((r) => r.status === 200)).toBe(true);
    const numbers = done.map((r) => r.body.transaction_number).sort();
    expect(numbers).toEqual([2, 3, 4, 5, 6].map((n) => `${year}-${String(n).padStart(6, '0')}`));
    // another shop has its own sequence
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `pos2-${Date.now()}` })).body;
    await setPosSettings({ ...t, shopId: shop2.id }, { requireOpenRegister: false });
    const other = await quickSale(t.owner, shop2.id, [{ type: 'service', name: 'カット', unitPrice: 1000 }]);
    expect(other.transaction_number).toBe(`${year}-000001`);
  });

  it('issues receipts / 領収書 with invoice details, reissue chain and printable HTML', async () => {
    const { t, menu } = await setup();
    await t.owner.patch('/v1/organization', { invoiceRegistrationNumber: 'T1234567890123' });
    await setPosSettings(t, { requireOpenRegister: false, receiptFooter: 'またのご来店をお待ちしております' });
    const tea = await createProduct(t, { name: 'ハーブティー', price: 1080, taxRateBp: 800, stock: 5 });
    const draft = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }, { type: 'product', productId: tea.id }], { complete: false, tendered: 10000 });
    expect((await t.owner.post(`/v1/transactions/${draft.id}/receipts`, { type: 'receipt' })).body.error.code).toBe('RECEIPT_NOT_AVAILABLE');
    await t.owner.post(`/v1/transactions/${draft.id}/complete`);

    const r1 = await t.owner.post(`/v1/transactions/${draft.id}/receipts`, { type: 'receipt' });
    expect(r1.status).toBe(201);
    expect(r1.body.receipt_number).toBe(`R${year}-000001`);
    const c = r1.body.content;
    expect(c.issuer.invoiceRegistrationNumber).toBe('T1234567890123');
    expect(c.taxBreakdown).toEqual([
      { rateBp: 1000, label: '10%', taxable: 5500, tax: 500 },
      { rateBp: 800, label: '8%(軽減税率)', taxable: 1080, tax: 80 },
    ]);
    expect(c.items.find((i: any) => i.name === 'ハーブティー').reducedRate).toBe(true);
    expect(c.payments).toEqual([expect.objectContaining({ method: 'cash', label: '現金', amount: 6580, tendered: 10000, change: 3420 })]);
    expect(c.footer).toBe('またのご来店をお待ちしております');
    expect(c.reissue).toBe(false);

    const inv = await t.owner.post(`/v1/transactions/${draft.id}/receipts`, { type: 'invoice', addressee: '株式会社テスト 御中', proviso: '施術代として' });
    expect(inv.body.receipt_number).toBe(`R${year}-000002`);
    expect(inv.body.reissue_of).toBeNull();
    const re = await t.owner.post(`/v1/transactions/${draft.id}/receipts`, { type: 'receipt' });
    expect(re.body.receipt_number).toBe(`R${year}-000003`);
    expect(re.body.reissue_of).toBe(r1.body.id);
    expect(re.body.content.reissue).toBe(true);

    const html = await t.owner.get(`/v1/receipts/${inv.body.id}/html`);
    expect(html.status).toBe(200);
    expect(String(html.headers['content-type'])).toContain('text/html');
    expect(html.body).toContain('領収書');
    expect(html.body).toContain('登録番号 T1234567890123');
    expect(html.body).toContain('株式会社テスト 御中');
    expect(html.body).toContain('8%(軽減税率)対象');
    expect(html.body).toContain('※');
    const reHtml = await t.owner.get(`/v1/receipts/${re.body.id}/html`);
    expect(reHtml.body).toContain('再発行');

    const detail = await t.owner.get(`/v1/transactions/${draft.id}`);
    expect(detail.body.receipts).toHaveLength(3);
    expect((await t.owner.get(`/v1/receipts/${r1.body.id}`)).body.receipt_number).toBe(`R${year}-000001`);
  });
});

describe('permissions & isolation', () => {
  it('enforces role permissions and shop boundaries', async () => {
    const { t, stylist, menu } = await setup();
    const assistant = await createStaffUser(t, 'assistant');
    const create = await assistant.api.post('/v1/transactions', { shopId: t.shopId });
    expect(create.status).toBe(403);
    await openRegister(t.owner, t.shopId);
    const sale = await quickSale(stylist.api, t.shopId, [{ type: 'service', menuId: menu.id }]);
    expect(sale.status).toBe('completed');
    expect((await assistant.api.get(`/v1/transactions/${sale.id}`)).status).toBe(200); // pos.read
    expect((await assistant.api.post(`/v1/transactions/${sale.id}/receipts`, {})).status).toBe(403);
    expect((await stylist.api.post(`/v1/transactions/${sale.id}/void`, { reason: 'x' })).status).toBe(403);
    expect((await stylist.api.get('/v1/transactions/export.csv')).status).toBe(403);

    // shop boundary
    const shop2 = (await t.owner.post('/v1/shops', { name: '別店舗', slug: `pos-b-${Date.now()}` })).body;
    await setPosSettings({ ...t, shopId: shop2.id }, { requireOpenRegister: false });
    const other = await quickSale(t.owner, shop2.id, [{ type: 'service', name: 'カット', unitPrice: 1000 }]);
    expect((await stylist.api.get(`/v1/transactions/${other.id}`)).status).toBe(403);
    expect((await stylist.api.post('/v1/transactions', { shopId: shop2.id })).status).toBe(403);
    const list = await stylist.api.get('/v1/transactions');
    expect(list.body.items.map((x: any) => x.id)).not.toContain(other.id);
  });

  it('isolates tenants', async () => {
    const { t, menu } = await setup();
    await openRegister(t.owner, t.shopId);
    const sale = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }]);
    const receipt = (await t.owner.post(`/v1/transactions/${sale.id}/receipts`, {})).body;
    const b = await createTenant('他社サロン');
    expect((await b.owner.get(`/v1/transactions/${sale.id}`)).status).toBe(404);
    expect((await b.owner.post(`/v1/transactions/${sale.id}/payments`, { method: 'cash', idempotencyKey: key() })).status).toBe(404);
    expect((await b.owner.post(`/v1/transactions/${sale.id}/void`, { reason: 'x' })).status).toBe(404);
    expect((await b.owner.get(`/v1/receipts/${receipt.id}`)).status).toBe(404);
    expect((await b.owner.get(`/v1/payments/${sale.payments[0].id}`)).status).toBe(404);
    expect((await b.owner.get('/v1/transactions')).body.items).toHaveLength(0);
    // another tenant's shop id cannot be used
    expect((await b.owner.post('/v1/transactions', { shopId: t.shopId })).status).toBe(404);
  });
});

describe('listing, reports & exports', () => {
  it('lists with filters and cursor pagination', async () => {
    const { t, stylist, menu, customer } = await setup();
    await openRegister(t.owner, t.shopId);
    const a = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { customerId: customer.id, staffId: stylist.staffId });
    const b = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }]);
    const draft = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { complete: false });
    const all = await t.owner.get('/v1/transactions', { shopId: t.shopId });
    expect(all.body.items.map((x: any) => x.id)).toEqual([draft.id, b.id, a.id]);
    expect((await t.owner.get('/v1/transactions', { status: 'draft' })).body.items.map((x: any) => x.id)).toEqual([draft.id]);
    expect((await t.owner.get('/v1/transactions', { customerId: customer.id })).body.items.map((x: any) => x.id)).toEqual([a.id]);
    expect((await t.owner.get('/v1/transactions', { staffId: stylist.staffId })).body.items.map((x: any) => x.id)).toEqual([a.id]);
    const p1 = await t.owner.get('/v1/transactions', { limit: 2 });
    const p2 = await t.owner.get('/v1/transactions', { limit: 2, cursor: p1.body.nextCursor });
    expect([...p1.body.items, ...p2.body.items].map((x: any) => x.id)).toEqual([draft.id, b.id, a.id]);
    expect(p2.body.nextCursor).toBeNull();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    expect((await t.owner.get('/v1/transactions', { shopId: t.shopId, from: today, to: today })).body.items).toHaveLength(3);
    expect((await t.owner.get('/v1/transactions', { shopId: t.shopId, from: '2000-01-01', to: '2000-01-02' })).body.items).toHaveLength(0);
  });

  it('builds the daily report (shop scope for managers, own scope for stylists)', async () => {
    const { t, stylist, menu, customer } = await setup();
    const other = await createStaffUser(t, 'stylist', { displayName: '別スタイリスト' });
    await openRegister(t.owner, t.shopId);
    const appt = await book(t, { staffId: stylist.staffId, customerId: customer.id, menuIds: [menu.id] });
    const d = (await t.owner.post('/v1/transactions', { shopId: t.shopId, appointmentId: appt.id })).body; // 5500 + 指名料1100
    await t.owner.post(`/v1/transactions/${d.id}/payments`, { method: 'card', idempotencyKey: key() });
    await t.owner.post(`/v1/transactions/${d.id}/complete`);
    const walkIn = await quickSale(t.owner, t.shopId, [{ type: 'service', name: 'シャンプー', unitPrice: 2200 }, { type: 'discount', amount: 200 }], { staffId: other.staffId });
    await t.owner.post(`/v1/transactions/${walkIn.id}/refunds`, { amount: 500, reason: '一部返金', idempotencyKey: key() });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const rep = await t.owner.get('/v1/pos/daily-report', { shopId: t.shopId, date: today });
    expect(rep.status).toBe(200);
    expect(rep.body.scope).toBe('shop');
    expect(rep.body.totals).toMatchObject({ transactionCount: 2, grossSales: 6600 + 2000, discountTotal: 200, refundTotal: 500, netSales: 8100 });
    expect(rep.body.customers).toMatchObject({ new: 1, repeat: 0, walkIn: 1, nominated: 1 });
    expect(rep.body.byMethod).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'card', amount: 6600 }), expect.objectContaining({ method: 'cash', amount: 2000 })]));
    expect(rep.body.taxByRate['1000']).toEqual({ taxable: 8600, tax: 600 + 181 });
    const mine = rep.body.byStaff.find((s: any) => s.staffId === stylist.staffId);
    expect(mine).toMatchObject({ sales: 6600, nominatedCount: 1, transactions: 1, newCustomers: 1 });
    expect(rep.body.byStaff.find((s: any) => s.staffId === other.staffId)).toMatchObject({ sales: 2000, nominatedCount: 0 });
    expect(rep.body.register).toHaveLength(1);

    const own = await stylist.api.get('/v1/pos/daily-report', { shopId: t.shopId, date: today });
    expect(own.status).toBe(200);
    expect(own.body.scope).toBe('own');
    expect(own.body.totals).toBeUndefined();
    expect(own.body.byStaff).toEqual([expect.objectContaining({ staffId: stylist.staffId, sales: 6600 })]);
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.get('/v1/pos/daily-report', { shopId: t.shopId, date: today })).status).toBe(403);
  });

  it('exports transactions and items as CSV with an audit log', async () => {
    const { t, stylist, menu } = await setup();
    await openRegister(t.owner, t.shopId);
    const sale = await quickSale(t.owner, t.shopId, [{ type: 'service', menuId: menu.id }], { staffId: stylist.staffId });
    const csv = await t.owner.get('/v1/transactions/export.csv', { shopId: t.shopId });
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    const text = String(csv.body);
    expect(text.split('\r\n')[0]).toContain('会計番号');
    expect(text).toContain(sale.transaction_number);
    expect(text).toContain('5500');
    const items = await t.owner.get('/v1/transaction-items/export.csv', { shopId: t.shopId });
    expect(String(items.body)).toContain('指名スタイリスト');
    const audits = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select(['action', 'metadata']).where('action', '=', 'export.csv').execute());
    expect(audits).toHaveLength(2);
    const accountant = await createStaffUser(t, 'accountant');
    expect((await accountant.api.get('/v1/transactions/export.csv')).status).toBe(200);
  });
});
