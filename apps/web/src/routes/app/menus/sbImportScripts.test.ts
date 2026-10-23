import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SB_CATEGORY_SCRIPT,
  SB_COUPON_EDIT_SCRIPT,
  SB_COUPON_LIST_SCRIPT,
  SB_COUPON_PAGE_SCRIPT,
  SB_EQUIPMENT_TABLE_SCRIPT,
  SB_MENU_SCRIPT,
  SB_STAFF_TABLE_SCRIPT,
  parsePastedJson,
  toSbMenuItems,
} from './sbImportScripts';
import couponEdit from './__fixtures__/sb/coupon-edit.html?raw';
import couponList from './__fixtures__/sb/coupon-list.html?raw';
import couponPage from './__fixtures__/sb/coupon-page.html?raw';
import equipmentTable from './__fixtures__/sb/equipment-table.html?raw';
import menuEdit from './__fixtures__/sb/menu-edit.html?raw';
import staffTable from './__fixtures__/sb/staff-table.html?raw';

/** Saved shapes of the SALON BOARD pages (written for these tests, no real data) */
const FIXTURES: Record<string, string> = {
  'coupon-edit': couponEdit,
  'coupon-list': couponList,
  'coupon-page': couponPage,
  'equipment-table': equipmentTable,
  'menu-edit': menuEdit,
  'staff-table': staffTable,
};
const fixture = (name: string) => FIXTURES[name]!;

type Global = typeof globalThis & { copy?: (text: string) => void };

let copied: string[] = [];
let alerts: string[] = [];

beforeEach(() => {
  copied = [];
  alerts = [];
  // the browser console's copy() utility, and alert()
  (globalThis as Global).copy = (text: string) => void copied.push(text);
  vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => void alerts.push(String(m)));
});
afterEach(() => {
  delete (globalThis as Global).copy;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Runs a script exactly as pasted into the console of a page showing `html`; returns the copied JSON */
function run(script: string, html: string): unknown {
  document.body.innerHTML = html;
  new Function(script)();
  return copied.length ? JSON.parse(copied[copied.length - 1]!) : undefined;
}

describe('SALON BOARD scripts', () => {
  it('menu edit page → menus with 「ジャンル：カテゴリ」, price, time, 「～」 and 掲載', () => {
    const data = run(SB_MENU_SCRIPT, fixture('menu-edit'));
    expect(data).toEqual([
      {
        category: 'まつげ・メイクなど：まつげデザイン・ケア',
        name: 'パリジェンヌラッシュリフト',
        description: '自まつげを根元から 立ち上げます',
        price: 8000,
        durationMin: 60,
        priceTilde: true,
        listed: true,
      },
      {
        category: 'ネイル：ハンド',
        name: 'ワンカラー',
        description: '',
        price: 5500,
        durationMin: 90,
        priceTilde: false,
        listed: false,
      },
    ]);
    expect(alerts).toEqual(['コピーしました（2件）']);
  });

  it('coupon list → coupons with 種別, price, time, 「～」, description and picture', () => {
    const data = run(SB_COUPON_LIST_SCRIPT, fixture('coupon-list'));
    expect(data).toEqual([
      {
        name: '【ご新規様】まつげパーマ+トリートメント',
        couponType: 'new',
        price: 6600,
        durationMin: 75,
        priceTilde: true,
        description: '根元から自然に カールします',
        category: '',
        imageUrl: 'https://imgbp.salonboard.com/CLP/img/c1.jpg?impolicy=x&w=120&h=120',
      },
      {
        name: '【再来】ワンカラー',
        couponType: 'repeat',
        price: 4400,
        durationMin: 60,
        priceTilde: false,
        description: 'オフ込み',
        category: '',
      },
      {
        name: '【全員】眉スタイリング',
        couponType: 'all',
        price: 3300,
        durationMin: 60,
        priceTilde: false,
        description: '',
        category: '',
      },
    ]);
    expect(alerts).toEqual(['コピーしました（3件、画像1件）']);
  });

  it('coupon listing-edit page → one coupon, found by labels, picture at 600×600', () => {
    const data = run(SB_COUPON_PAGE_SCRIPT, fixture('coupon-page'));
    expect(data).toEqual([
      {
        name: '【再来】まつげパーマ',
        couponType: 'repeat',
        price: 5500,
        durationMin: 60,
        priceTilde: false,
        category: 'まつげ：まつげパーマ',
        description: '前回から2ヶ月以内の方 限定',
        usageCondition: '再来の方 平日限定',
        presentationCondition: '予約時',
        imageUrl: 'https://imgbp.salonboard.com/CLP/img/p.jpg?impolicy=x&w=600&h=600',
      },
    ]);
    expect(alerts[0]).toContain('コピーしました: 【再来】まつげパーマ');
  });

  it('coupon edit page → the coupon form fields, search categories as 「親：子」', () => {
    const data = run(SB_COUPON_EDIT_SCRIPT, fixture('coupon-edit'));
    expect(data).toEqual({
      couponType: 'new',
      name: '【ご新規様】ラッシュリフト',
      description: 'まつげを根元から立ち上げます。',
      presentationCondition: '来店時',
      usageCondition: '新規の方限定',
      expiryDate: '2026-03-31',
      price: 7700,
      priceTilde: true,
      durationMin: 90,
      categories: ['まつげ・メイクなど：まつげパーマ', 'ネイル：ハンド'],
      imageUrl: 'https://imgbp.salonboard.com/CLP/img/e.jpg?w=200&h=200',
    });
  });

  it('coupon edit page with an automatic expiry → no expiry date', () => {
    const html = fixture('coupon-edit').replace(
      'id="TagIN_NM_AUTO_SET_FLG_01"',
      'id="TagIN_NM_AUTO_SET_FLG_01" checked',
    );
    expect(run(SB_COUPON_EDIT_SCRIPT, html)).toMatchObject({ expiryDate: null });
  });

  it('search category table → parents with their children', () => {
    expect(run(SB_CATEGORY_SCRIPT, fixture('coupon-edit'))).toEqual([
      { parent: 'まつげ・メイクなど', children: ['まつげパーマ', 'まつげエクステ'] },
      { parent: 'ネイル', children: ['ハンド', 'フット'] },
      { parent: 'エステ', children: [] },
    ]);
    expect(alerts).toEqual(['コピーしました（3グループ）']);
  });

  it('対応クーポン設定 → per coupon the ticked stylists and スタッフ不要', () => {
    expect(run(SB_STAFF_TABLE_SCRIPT, fixture('staff-table'))).toEqual({
      kind: 'coupon',
      staff: ['スタイリストA', 'スタイリスト B', 'スタイリストC'],
      assignments: [
        {
          menuName: '【新規】まつげパーマ',
          kind: 'coupon',
          noStaffNeeded: false,
          assignedStaff: ['スタイリストA', 'スタイリストC'],
        },
        {
          menuName: '【全員】セルフホワイトニング',
          kind: 'coupon',
          noStaffNeeded: true,
          assignedStaff: [],
        },
        {
          menuName: '【再来】ワンカラー',
          kind: 'coupon',
          noStaffNeeded: false,
          assignedStaff: ['スタイリスト B'],
        },
      ],
    });
    expect(alerts[0]).toBe(
      'コピーしました（3件）\nスタッフ(3名): スタイリストA, スタイリスト B, スタイリストC',
    );
  });

  it('メニュー・設備設定 → per menu the ticked equipment, without 設備不要', () => {
    expect(run(SB_EQUIPMENT_TABLE_SCRIPT, fixture('equipment-table'))).toEqual({
      kind: 'regular',
      equipment: ['リクライニングソファ', 'ネイルデスク'],
      assignments: [
        { menuName: 'まつげパーマ', kind: 'regular', assignedEquipment: ['リクライニングソファ'] },
        { menuName: 'ジェルネイル', kind: 'regular', assignedEquipment: ['ネイルデスク'] },
      ],
    });
  });

  it('says so on the wrong page and copies nothing', () => {
    for (const [script, message] of [
      [SB_MENU_SCRIPT, 'メニューが見つかりません'],
      [SB_COUPON_LIST_SCRIPT, 'クーポンテーブルが見つかりません'],
      [SB_COUPON_PAGE_SCRIPT, 'クーポン名が見つかりません'],
      [SB_COUPON_EDIT_SCRIPT, 'クーポン名が見つかりません'],
      [SB_STAFF_TABLE_SCRIPT, 'テーブルが見つかりません'],
      [SB_EQUIPMENT_TABLE_SCRIPT, 'テーブルが見つかりません'],
      [SB_CATEGORY_SCRIPT, 'カテゴリテーブルが見つかりません'],
    ] as const) {
      alerts = [];
      expect(run(script, '<p>別のページ</p>')).toBeUndefined();
      expect(alerts).toEqual([message]);
    }
  });

  it('falls back to a selected textarea, then to the console, without copy()', () => {
    delete (globalThis as Global).copy;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    document.execCommand = vi.fn(() => false);
    run(SB_CATEGORY_SCRIPT, fixture('coupon-edit'));
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"parent":"ネイル"'));
    expect(alerts[0]).toMatch(/^コピーできませんでした/);
    // the temporary textarea is gone again (the page's own two remain)
    expect(document.querySelectorAll('textarea')).toHaveLength(2);
  });
});

describe('reading the pasted JSON', () => {
  it('joins arrays copied from several pages', () => {
    expect(parsePastedJson('[{"name":"a"}]\n[{"name":"b"}],[{"name":"c"}]')).toEqual([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ]);
    expect(parsePastedJson(' {"name":"a"} ')).toEqual({ name: 'a' });
    expect(() => parsePastedJson('{broken')).toThrow(SyntaxError);
  });

  it('keeps known fields of the right type', () => {
    expect(
      toSbMenuItems([
        {
          name: ' カット ',
          price: '8,000',
          durationMin: 60,
          priceTilde: 1,
          listed: false,
          couponType: 'new',
          imageUrl: '',
          extra: 'x',
        },
        'not an item',
        { name: 'b', couponType: 'other', price: -1 },
      ]),
    ).toEqual([
      {
        name: 'カット',
        price: 8000,
        durationMin: 60,
        priceTilde: true,
        listed: false,
        couponType: 'new',
      },
      { name: 'b' },
    ]);
  });
});
