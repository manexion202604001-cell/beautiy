import { describe, expect, it } from 'vitest';
import { api, asSystem, createCustomer, createMenu, createStaffUser, createTenant, jstDate, nextWeekday, runJobs, type Tenant } from '../../test/helpers.js';

const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\r\n');

async function runImport(t: Tenant, body: Record<string, unknown>) {
  const res = await t.owner.post('/v1/migration/imports', { shopId: t.shopId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await runJobs();
  const job = await t.owner.get(`/v1/migration/imports/${res.body.id}`);
  expect(job.body.status).toBe('completed');
  return job.body;
}

const customersCsv = csv([
  ['会員番号', 'お客様名', 'フリガナ', '携帯電話', 'メール', '生年月日', '性別', '都道府県', '住所1', 'DM可否', '来店回数', '累計売上', '初回来店日', '最終来店日', '担当者', '顧客区分', '備考', 'ポイント'],
  ['C001', '山田 花子', 'ヤマダ ハナコ', '090-1111-0001', 'hanako@example.com', 'S60.4.1', '女', '東京都', '渋谷区1-1', '可', '12', '¥98,000', '2022/01/10', '2026/09/20', '佐藤', 'VIP|紹介', 'カラーで頭皮がしみやすい', '1200'],
  ['C002', '山田 太郎', 'ヤマダ タロウ', '090-1111-0001', '', '不明', '男', '', '', '', '3', '15000', '', '2026/08/01', '', '', '', ''],
  ['C003', '鈴木 一郎', 'スズキ イチロウ', '080-2222-0002', 'ichiro@example', '1990/2/3', '', '', '', '不可', '', '', '', '', '', '', '', ''],
  ['C004', '', '', '070-3333-0003', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
]);

describe('data migration', () => {
  it('previews a customer export: suggested mapping, problems, nothing written', async () => {
    const t = await createTenant();
    const res = await t.owner.post('/v1/migration/preview', { kind: 'customers', csv: customersCsv, shopId: t.shopId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body;
    expect(p.mapping).toMatchObject({ customerNumber: [0], fullName: [1], fullKana: [2], phone: [3], email: [4], birthday: [5], address: [7, 8], marketingOptIn: [9] });
    expect(p.mapping.points).toEqual([17]);
    expect(p.unmappedColumns).toEqual([]);
    expect(p.counts).toMatchObject({ total: 4, ready: 3, errors: 1 });
    expect(p.amountTotal).toBe(113000);
    const byRow = Object.fromEntries(p.problems.map((x: { rowNo: number }) => [x.rowNo, x]));
    expect(byRow[3].warnings.join()).toContain('生年月日「不明」');
    expect(byRow[4].warnings.join()).toContain('メールアドレス「ichiro@example」');
    expect(byRow[5].errors.join()).toContain('氏名');
    const list = await t.owner.get('/v1/customers');
    expect(list.body.items).toHaveLength(0);
  });

  it('imports customers with their history, keeps families apart and never duplicates on re-import', async () => {
    const t = await createTenant();
    const sato = await createStaffUser(t, 'stylist', { displayName: '佐藤 美咲' });
    // already registered in Salon OS (e.g. booked online during the trial): must be completed, not duplicated
    const existing = await createCustomer(t, { lastName: '鈴木', firstName: '一郎', phone: '080-2222-0002', email: 'suzuki@salon.example' });

    const job = await runImport(t, { kind: 'customers', csv: customersCsv, fileName: 'salogic-customers.csv', sourceLabel: 'SALOGIC' });
    expect(job.summary).toEqual({ created: 2, updated: 1, error: 1 });
    expect(job.totals).toMatchObject({ fileRows: 4, fileAmount: 113000, importedAmount: 113000 });
    expect(job.problems.find((p: { row_no: number }) => p.row_no === 5).message).toContain('氏名');

    const list = (await t.owner.get('/v1/customers', { sort: 'name' })).body.items as Record<string, any>[];
    expect(list).toHaveLength(3);
    const hanako = list.find((c) => c.first_name === '花子')!;
    const taro = list.find((c) => c.first_name === '太郎')!;
    // same phone, different people → two customers
    expect(hanako.id).not.toBe(taro.id);
    const detail = (await t.owner.get(`/v1/customers/${hanako.id}`)).body;
    expect(detail).toMatchObject({
      customer_number: 'C001',
      last_name_kana: 'ヤマダ',
      birthday: '1985-04-01',
      gender: 'female',
      address: '東京都 渋谷区1-1',
      marketing_opt_in: true,
      visit_count: 12,
      total_sales: 98000,
      primary_staff_id: sato.staffId,
    });
    expect(detail.attributes.legacy).toMatchObject({ source: 'SALOGIC', customerNumber: 'C001' });
    expect(detail.point_balance).toBe(1200);
    expect(detail.tags.map((x: { name: string }) => x.name).sort()).toEqual(['VIP', '紹介']);
    const memos = (await t.owner.get(`/v1/customers/${hanako.id}/memos`)).body;
    expect(memos[0].body).toContain('頭皮がしみやすい');
    // no DM column value → not opted in (consent must be explicit)
    expect((await t.owner.get(`/v1/customers/${taro.id}`)).body.marketing_opt_in).toBe(false);

    const suzuki = (await t.owner.get(`/v1/customers/${existing.id}`)).body;
    expect(suzuki.email).toBe('suzuki@salon.example'); // not overwritten
    expect(suzuki.birthday).toBe('1990-02-03'); // filled
    expect(suzuki.last_name_kana).toBe('スズキ');

    // same file again: nothing new
    const again = await runImport(t, { kind: 'customers', csv: customersCsv });
    expect(again.summary.created ?? 0).toBe(0);
    expect((await t.owner.get('/v1/customers')).body.items).toHaveLength(3);
    // points are carried over once
    expect((await t.owner.get(`/v1/customers/${hanako.id}`)).body.point_balance).toBe(1200);

    // rows that failed, ready to fix in Excel
    const errs = await t.owner.get(`/v1/migration/imports/${job.id}/errors.csv`);
    expect(errs.status).toBe(200);
    expect(String(errs.body)).toContain('氏名・フリガナがありません');
    expect(String(errs.body)).toContain('070-3333-0003');
  });

  it('imports visit history linked by customer number; counts and dates continue in Salon OS', async () => {
    const t = await createTenant();
    await runImport(t, { kind: 'customers', csv: customersCsv });
    const visits = csv([
      ['伝票番号', '会員番号', 'お客様名', '来店日', '担当', 'メニュー', '合計金額', 'カルテ'],
      ['S-1', 'C001', '山田 花子', '2026/09/20', '佐藤', 'カット+カラー', '12,100', '6Lv ブラウン'],
      ['S-2', 'C001', '山田 花子', '2026/07/02', '佐藤', 'カット', '5,500', ''],
      ['S-3', 'X999', '知らない 人', '2026/06/01', '', 'カット', '5,500', ''],
    ]);
    const prev = await t.owner.post('/v1/migration/preview', { kind: 'visits', csv: visits, shopId: t.shopId });
    expect(prev.body.counts).toMatchObject({ total: 3, ready: 2, errors: 1 });
    expect(prev.body.amountTotal).toBe(17600);

    const job = await runImport(t, { kind: 'visits', csv: visits });
    expect(job.summary).toEqual({ created: 2, error: 1 });
    expect(job.totals).toMatchObject({ importedRows: 2, importedAmount: 17600 });
    const hanako = (await t.owner.get('/v1/customers', { q: 'C001' })).body.items[0];
    const lv = (await t.owner.get(`/v1/customers/${hanako.id}/legacy-visits`)).body;
    expect(lv).toHaveLength(2);
    expect(lv[0]).toMatchObject({ menu_text: 'カット+カラー', amount: 12100, memo: '6Lv ブラウン', staff_name: '佐藤', source_label: '旧システム' });
    // the customer export said 12 visits / 98,000 yen; the 2 imported rows are part of that history
    const detail = (await t.owner.get(`/v1/customers/${hanako.id}`)).body;
    expect(detail.visit_count).toBe(12);
    expect(detail.total_sales).toBe(98000);
    const timeline = (await t.owner.get(`/v1/customers/${hanako.id}/timeline`)).body;
    expect(timeline.filter((e: { kind: string }) => e.kind === 'legacy_visit')).toHaveLength(2);

    // re-import is idempotent (slip numbers); unmatched customers can be created on request
    const again = await runImport(t, { kind: 'visits', csv: visits, options: { createMissingCustomers: true } });
    expect(again.summary).toEqual({ skipped: 2, created: 1 });
    expect((await t.owner.get('/v1/customers', { q: '知らない' })).body.items).toHaveLength(1);
  });

  it('imports future reservations without messaging customers or creating slot-block tasks', async () => {
    const t = await createTenant();
    await t.owner.patch(`/v1/staff/${t.ownerStaffId}`, { isBookable: false });
    const sato = await createStaffUser(t, 'stylist', { displayName: '佐藤 美咲' });
    const cut = await createMenu(t, { name: 'カット', durationMin: 60 });
    await createMenu(t, { name: 'カラー', durationMin: 90 });
    await t.owner.post('/v1/integrations', { provider: 'lime_mail', shopId: t.shopId, displayName: 'LiME', config: { pushBlocks: true } });
    await runImport(t, { kind: 'customers', csv: customersCsv });
    const day = nextWeekday(3, 5);
    const rows = csv([
      ['予約番号', '予約日', '開始時刻', '終了時刻', '会員番号', 'お客様名', '電話番号', '担当', 'メニュー', '備考'],
      ['R-1', day, '10:00', '12:00', 'C001', '山田 花子', '', '佐藤', 'カット', '前髪短め'],
      ['R-2', day, '11:00', '', '', '新規 さん', '090-9999-0000', '佐藤', 'カット', ''],
      ['R-3', day, '15:00', '', '', '新規 次郎', '090-9999-0001', '辞めた人', 'パーマ', ''],
      ['R-4', jstDate(-3), '10:00', '', 'C002', '山田 太郎', '', '佐藤', 'カット', ''],
      ['R-5', day, '16:00', '', 'C002', '山田 太郎', '', '', 'カラー', ''],
    ]);
    const prev = await t.owner.post('/v1/migration/preview', { kind: 'reservations', csv: rows, shopId: t.shopId });
    expect(prev.body.counts).toMatchObject({ total: 5, past: 1 });
    expect(prev.body.unknownMenus).toEqual([{ name: 'パーマ', rows: 1 }]);
    expect(prev.body.unknownStaff).toEqual([{ name: '辞めた人', rows: 1 }]);

    const job = await runImport(t, { kind: 'reservations', csv: rows });
    const byRow = Object.fromEntries(job.problems.map((p: { row_no: number }) => [p.row_no, p]));
    expect(job.summary).toEqual({ created: 2, error: 3 });
    expect(byRow[3].message).toContain('既に予約'); // 11:00 overlaps R-1 (10:00-12:00)
    expect(byRow[4].message).toContain('パーマ');
    expect(byRow[5].message).toContain('過去');

    const appts = (await t.owner.get('/v1/appointments', { shopId: t.shopId, date: day })).body as Record<string, any>[];
    expect(appts).toHaveLength(2);
    const r1 = appts.find((a) => a.staff_note?.includes('前髪短め'))!;
    expect(r1).toMatchObject({ source: 'import', staff_id: sato.staffId });
    // old system's end time (2h) kept although the menu is 1h
    expect(new Date(r1.end_at).getTime() - new Date(r1.start_at).getTime()).toBe(120 * 60_000);
    expect(appts.find((a) => a !== r1)!.staff_id).toBe(sato.staffId); // フリー → assigned

    await runJobs();
    const side = await asSystem(t.organizationId, async (ctx) => ({
      messages: await ctx.trx.selectFrom('messages').select('id').execute(),
      blocks: await ctx.trx.selectFrom('external_slot_blocks').select('id').execute(),
    }));
    expect(side.messages).toHaveLength(0);
    expect(side.blocks).toHaveLength(0);

    // undo: untouched reservations go away
    const undo = await t.owner.post(`/v1/migration/imports/${job.id}/undo`);
    expect(undo.body).toMatchObject({ removed: 2 });
    expect((await t.owner.get('/v1/appointments', { shopId: t.shopId, date: day })).body.filter((a: { status: string }) => a.status !== 'cancelled')).toHaveLength(0);
    expect((await t.owner.post(`/v1/migration/imports/${job.id}/undo`)).status).toBe(422);
    void cut;
  });

  it('undoes a customer import but keeps customers that were used afterwards', async () => {
    const t = await createTenant();
    await createMenu(t);
    const existing = await createCustomer(t, { lastName: '鈴木', firstName: '一郎', phone: '080-2222-0002' });
    const job = await runImport(t, { kind: 'customers', csv: customersCsv });
    const hanako = (await t.owner.get('/v1/customers', { q: 'C001' })).body.items[0];
    await t.owner.post(`/v1/customers/${hanako.id}/memos`, { body: '移行後に追加したメモ' });

    const undo = await t.owner.post(`/v1/migration/imports/${job.id}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.body.restored).toBe(1);
    expect(undo.body.kept).toHaveLength(1);
    expect(undo.body.kept[0].reason).toContain('メモ');
    const left = (await t.owner.get('/v1/customers')).body.items.map((c: { id: string }) => c.id).sort();
    expect(left).toEqual([existing.id, hanako.id].sort());
    const suzuki = (await t.owner.get(`/v1/customers/${existing.id}`)).body;
    expect(suzuki.birthday).toBeNull();
    expect(suzuki.email).toBeNull();
  });

  it('carries point balances over once and takes them back on undo', async () => {
    const t = await createTenant();
    const existing = await createCustomer(t, { lastName: '佐々木', firstName: '舞', phone: '090-5555-0001' });
    const file = csv([
      ['顧客番号', '氏名', '電話番号', '保有ポイント', 'ポイント有効期限'],
      ['P1', '佐々木 舞', '090-5555-0001', '800', '2027/03/31'],
    ]);
    const job = await runImport(t, { kind: 'customers', csv: file });
    expect(job.summary).toEqual({ updated: 1 });
    expect((await t.owner.get(`/v1/customers/${existing.id}`)).body.point_balance).toBe(800);
    await runImport(t, { kind: 'customers', csv: file });
    expect((await t.owner.get(`/v1/customers/${existing.id}`)).body.point_balance).toBe(800);
    const ledger = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('point_ledger').select(['reason', 'expires_at']).where('customer_id', '=', existing.id).execute());
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reason).toBe('earn');
    expect((await t.owner.post(`/v1/migration/imports/${job.id}/undo`)).status).toBe(200);
    expect((await t.owner.get(`/v1/customers/${existing.id}`)).body.point_balance).toBe(0);
  });

  it('merging customers keeps the history carried over from both', async () => {
    const t = await createTenant();
    await runImport(t, { kind: 'customers', csv: customersCsv });
    const items = (await t.owner.get('/v1/customers')).body.items as Record<string, any>[];
    const hanako = items.find((c) => c.first_name === '花子')!;
    const taro = items.find((c) => c.first_name === '太郎')!;
    const merged = await t.owner.post(`/v1/customers/${hanako.id}/merge`, { sourceCustomerId: taro.id });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect((await t.owner.get(`/v1/customers/${hanako.id}`)).body).toMatchObject({ visit_count: 15, total_sales: 113000 });
  });

  it('is limited to managers', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const res = await stylist.api.post('/v1/migration/preview', { kind: 'customers', csv: customersCsv, shopId: t.shopId });
    expect(res.status).toBe(403);
    expect((await api().get('/v1/migration/imports')).status).toBe(401);
  });
});
