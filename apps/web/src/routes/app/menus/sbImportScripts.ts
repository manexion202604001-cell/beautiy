/**
 * サロンボードから取込: the scripts the owner copies from the メニュー screens and runs in the browser
 * console on a SALON BOARD page. SALON BOARD has no export, so each script reads the page that is open,
 * copies the result as JSON to the clipboard and reports what it found; the owner pastes the JSON back
 * into Salon OS (SbImportDialogs.tsx).
 *
 * The scripts are plain JavaScript strings — exactly what the owner pastes is what the unit tests run
 * against saved copies of the SALON BOARD markup (sbImportScripts.test.ts). They only read the page and
 * write to the clipboard: nothing is sent anywhere and nothing on SALON BOARD is changed.
 */

/** Small helpers every script starts with */
const HELPERS = String.raw`
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
const val = (el) => {
  if (!el) return '';
  if (el.tagName === 'SELECT') {
    const o = el.options[el.selectedIndex];
    return o ? (o.text || '').trim() : '';
  }
  return String(el.value || '').trim();
};
const num = (s, fallback) => {
  const m = String(s || '').replace(/[,，]/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : fallback;
};
const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const isPhoto = (src) => !!src && !/no(ne)?_?image/i.test(src);
const finish = (data, summary) => {
  const json = JSON.stringify(data);
  let copied = false;
  try {
    if (typeof copy === 'function') {
      copy(json);
      copied = true;
    }
  } catch (e) {}
  if (!copied) {
    const ta = document.createElement('textarea');
    ta.value = json;
    document.body.appendChild(ta);
    ta.select();
    try {
      copied = document.execCommand('copy');
    } catch (e) {}
    ta.remove();
  }
  if (!copied) console.log(json);
  alert((copied ? 'コピーしました' : 'コピーできませんでした。コンソールに表示された内容をコピーしてください') + summary);
};
/** SALON BOARD's search category table: heading = parent, list items = children */
const searchCategories = (checkedOnly) => {
  const box = $('#TagIN_COUPON_CATEGORY');
  if (!box) return null;
  const out = [];
  $$('tr', box).forEach((tr) => {
    const th = $('th', tr);
    const td = $('td', tr);
    if (!th || !td) return;
    const parent = txt(th);
    const children = [];
    $$('li', td).forEach((li) => {
      const cb = $('input[type="checkbox"]', li);
      if (checkedOnly && !(cb && cb.checked)) return;
      const name = txt(li);
      if (name) children.push(name);
    });
    if (parent) out.push({ parent, children });
  });
  return out;
};
/** the form control in the same row as a heading cell that reads label */
const byLabel = (label) => {
  for (const cell of $$('th, td')) {
    const t = txt(cell);
    if (!t.startsWith(label) || t.length > label.length + 12) continue;
    const row = cell.closest('tr');
    if (!row) continue;
    for (const td of $$('td', row)) {
      if (td === cell) continue;
      const el = $('select, textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])', td);
      if (el) return el;
    }
  }
  return null;
};
`;

const script = (body: string) => `(() => {\n${HELPERS}\n${body.trim()}\n})();`;

/**
 * 一覧「SB取込」・メニュー: SALON BOARD's menu edit page (every menu of the salon is a numbered row of
 * MENU_SET_*_NAME_001, _002, …): category 「ジャンル：カテゴリ」, name, description, price, time, 「～」, 掲載.
 */
export const SB_MENU_SCRIPT = script(String.raw`
const items = [];
$$('[id^="MENU_SET_NAME_NAME_"]').forEach((nameEl) => {
  const no = nameEl.id.slice('MENU_SET_NAME_NAME_'.length);
  if (!/^\d+$/.test(no)) return;
  const field = (key) => document.getElementById('MENU_SET_' + key + '_NAME_' + no);
  const name = val(nameEl);
  if (!name) return;
  const genre = val(field('GENRE'));
  const category = val(field('MENU_CATEGORY'));
  const tilde = field('TILDE_FLG');
  const listed = document.getElementById('MENU_SET_PRESENT_FLG_NAME_' + no + '_PRESENT');
  items.push({
    category: genre && category ? genre + '：' + category : genre || category,
    name,
    description: oneLine(val(field('EXPLANATION'))),
    price: num(val(field('PRICE')), 0),
    durationMin: num(val(field('TIME')), 60),
    priceTilde: !!(tilde && tilde.checked),
    listed: listed ? !!listed.checked : true,
  });
});
if (!items.length) {
  alert('メニューが見つかりません');
  return;
}
finish(items, '（' + items.length + '件）');
`);

/**
 * 一覧「SB取込」・クーポン: SALON BOARD's coupon list (one table.couponTbl per coupon): 種別 from the
 * first column, name, price, 「～」, time, description and picture.
 */
export const SB_COUPON_LIST_SCRIPT = script(String.raw`
const tables = $$('table.couponTbl');
if (!tables.length) {
  alert('クーポンテーブルが見つかりません');
  return;
}
const items = [];
tables.forEach((table) => {
  const row = $('tbody tr', table) || $('tr', table);
  const cells = row ? $$(':scope > td', row) : [];
  if (cells.length < 2) return;
  const nameEl = $('.couponMenuName', table);
  const name = txt(nameEl);
  if (!name) return;
  const head = txt(cells[0]);
  const couponType = head.includes('新規') ? 'new' : head.includes('再来') ? 'repeat' : 'all';
  const info = cells.length > 2 ? txt(cells[2]) : '';
  const yen = info.match(/[¥￥]\s*([\d,]+)/) || info.match(/([\d,]+)\s*円/);
  const minutes = info.match(/(\d+)\s*分/);
  const body = cells[1].cloneNode(true);
  body.querySelectorAll('.couponMenuName').forEach((el) => el.remove());
  let description = txt(body);
  const priceAt = description.search(/[¥￥]\s*\d/);
  if (priceAt >= 0) description = description.slice(0, priceAt).trim();
  const img = $('img[name="couponPhoto"], img.couponImgSize, img[src*="imgbp"]', table);
  const item = {
    name,
    couponType,
    price: yen ? num(yen[1], 0) : 0,
    durationMin: minutes ? parseInt(minutes[1], 10) : 60,
    priceTilde: /[～〜]/.test(info),
    description,
    category: '',
  };
  if (img && isPhoto(img.src)) item.imageUrl = img.src;
  items.push(item);
});
if (!items.length) {
  alert('データが見つかりません');
  return;
}
finish(items, '（' + items.length + '件、画像' + items.filter((i) => i.imageUrl).length + '件）');
`);

/**
 * 「SB取込（個別）」: one SALON BOARD coupon listing-edit page → a one-item array (the owner runs it on
 * several pages and joins the arrays). 種別 from the 種別 select, else from the 利用条件 text; the
 * picture at 600×600.
 */
export const SB_COUPON_PAGE_SCRIPT = script(String.raw`
const first = (...els) => els.find(Boolean) || null;
const name = val(first($('#TagTA_NM_COUPON_NAME_01'), byLabel('クーポン名')));
if (!name) {
  alert('クーポン名が見つかりません');
  return;
}
const price = num(val(first($('#TagIN_NM_PRICE_01'), byLabel('価格'))), 0);
const durationEl = first($('#TagSL_NM_SEJYUTSU_AIM_TIME_01'), byLabel('所要目安時間'));
const durationMin = num(durationEl && durationEl.tagName === 'SELECT' ? durationEl.value : val(durationEl), 60);
const usageCondition = oneLine(val(first($('#TagIN_NM_USE_CONDITION_01'), byLabel('利用条件'))));
const presentationCondition = val(first($('#TagSL_NM_COUPON_CONDITION_CD_01'), byLabel('提示条件')));
const description = oneLine(val(first($('#TagTA_NM_CONTENT_EXPLANATION_01'), byLabel('クーポン内容'))));
const typeEl = $('#TagSL_NM_COUPON_TYPE_CD_01');
const types = { CT01: 'all', CT02: 'new', CT03: 'repeat' };
const couponType = typeEl && types[typeEl.value] ? types[typeEl.value] : usageCondition.includes('新規') ? 'new' : usageCondition.includes('再来') ? 'repeat' : 'all';
const categoryEl = byLabel('検索用カテゴリ');
let category = categoryEl && categoryEl.tagName === 'SELECT' ? val(categoryEl) : '';
if (!category) {
  const ticked = (searchCategories(true) || []).find((g) => g.children.length);
  if (ticked) category = ticked.parent + '：' + ticked.children[0];
}
const tilde = $('#TagIN_NM_TILDE_FLG_01');
const img = first($('#TagImgCouponPoto'), $('img[name$="couponPhoto_IMG"]'), $('img[src*="imgbp.salonboard"]'));
const item = { name, couponType, price, durationMin, priceTilde: !!(tilde && tilde.checked), category, description, usageCondition, presentationCondition };
if (img && isPhoto(img.src)) item.imageUrl = img.src.replace(/([?&])w=\d+/, '$1w=600').replace(/([?&])h=\d+/, '$1h=600');
finish([item], ': ' + name + '\n' + price + '円 / ' + durationMin + '分 / ' + couponType + (item.imageUrl ? ' / 画像あり' : '') + '\n提示:' + presentationCondition + ' / 利用:' + usageCondition);
`);

/**
 * 編集画面「SBから取込」: one SALON BOARD coupon edit page → the fields of the coupon form (not saved
 * until the owner presses 更新). Search categories come as 「親：子」.
 */
export const SB_COUPON_EDIT_SCRIPT = script(String.raw`
const name = val($('#TagTA_NM_COUPON_NAME_01'));
if (!name) {
  alert('クーポン名が見つかりません');
  return;
}
const types = { CT01: 'all', CT02: 'new', CT03: 'repeat' };
const typeEl = $('#TagSL_NM_COUPON_TYPE_CD_01');
const auto = $('#TagIN_NM_AUTO_SET_FLG_01');
let expiryDate = null;
if (!(auto && auto.checked)) {
  const part = (id, len) => {
    const el = $(id);
    const v = el ? String(el.value || '').trim() : '';
    return v ? v.padStart(len, '0') : '';
  };
  const y = part('#TagSL_NM_EXPIRATION_DATE_YYYY_01', 4);
  const m = part('#TagSL_NM_EXPIRATION_DATE_MM_01', 2);
  const d = part('#TagSL_NM_EXPIRATION_DATE_DD_01', 2);
  if (y && m && d) expiryDate = y + '-' + m + '-' + d;
}
const tilde = $('#TagIN_NM_TILDE_FLG_01');
const durationEl = $('#TagSL_NM_SEJYUTSU_AIM_TIME_01');
const img = $('#TagImgCouponPoto');
const categories = [];
(searchCategories(true) || []).forEach((g) => g.children.forEach((c) => categories.push(g.parent + '：' + c)));
const data = {
  couponType: typeEl ? types[typeEl.value] || null : null,
  name,
  description: val($('#TagTA_NM_CONTENT_EXPLANATION_01')),
  presentationCondition: val($('#TagSL_NM_COUPON_CONDITION_CD_01')),
  usageCondition: val($('#TagIN_NM_USE_CONDITION_01')),
  expiryDate,
  price: num(val($('#TagIN_NM_PRICE_01')), 0),
  priceTilde: !!(tilde && tilde.checked),
  durationMin: num(durationEl ? durationEl.value : '', 60),
  categories,
};
if (img && isPhoto(img.src)) data.imageUrl = img.src;
finish(data, ': ' + name);
`);

/**
 * 対応スタッフ表「SB取込」: SALON BOARD's 対応メニュー設定 (tbl1_*) or 対応クーポン設定 (tbl2_*) — menu names
 * on the left, a stylist per column on the right.
 */
export const SB_STAFF_TABLE_SCRIPT = script(String.raw`
const pairs = [['tbl1_1', 'tbl1_2', 'regular'], ['tbl2_1', 'tbl2_2', 'coupon']];
const pair = pairs.map(([l, r, kind]) => ({ left: document.getElementById(l), right: document.getElementById(r), kind })).find((p) => p.left && p.right);
if (!pair) {
  alert('テーブルが見つかりません');
  return;
}
const heads = $$('thead th', pair.right).map((th) => txt(th).replace(/すべて/g, '').trim());
const rowsOf = (table, body) => {
  const rows = $$('tbody.' + body + ' tr', table);
  return rows.length ? rows : $$('tbody tr', table);
};
const left = rowsOf(pair.left, 'jscMenu');
const right = rowsOf(pair.right, 'jscBody');
const assignments = [];
left.forEach((tr, j) => {
  const menuName = txt($('.menuTextDataHeight, .couponTextDataHeight', tr));
  if (!menuName) return;
  const none = $('input[name="staffNoLinkMenuId"], input[name="staffNoLinkStoreCouponId"]', tr);
  const assignedStaff = [];
  if (right[j]) {
    $$('td', right[j]).forEach((td, k) => {
      const cb = $('input[type="checkbox"]', td);
      if (cb && cb.checked && heads[k]) assignedStaff.push(heads[k]);
    });
  }
  assignments.push({ menuName, kind: pair.kind, noStaffNeeded: !!(none && none.checked), assignedStaff });
});
if (!assignments.length) {
  alert('データが見つかりません');
  return;
}
const staff = heads.filter(Boolean);
finish({ kind: pair.kind, staff, assignments }, '（' + assignments.length + '件）\nスタッフ(' + staff.length + '名): ' + staff.join(', '));
`);

/**
 * 対応設備表「SB取込」: SALON BOARD's menu (tbl3_*) or coupon (tbl4_*) × equipment table. The 設備不要
 * column is not an equipment.
 */
export const SB_EQUIPMENT_TABLE_SCRIPT = script(String.raw`
const pairs = [['tbl3_1', 'tbl3_2', 'regular'], ['tbl4_1', 'tbl4_2', 'coupon']];
const pair = pairs.map(([l, r, kind]) => ({ left: document.getElementById(l), right: document.getElementById(r), kind })).find((p) => p.left && p.right);
if (!pair) {
  alert('テーブルが見つかりません');
  return;
}
const heads = $$('thead th, thead td', pair.right).map((c) => txt(c).replace(/すべて/g, '').trim());
const isEquipment = (h) => !!h && !h.includes('設備不要');
const rowsOf = (table, body) => {
  const rows = $$('tbody.' + body + ' tr', table);
  return rows.length ? rows : $$('tbody tr', table);
};
const left = rowsOf(pair.left, 'jscMenu');
const right = rowsOf(pair.right, 'jscBody');
const assignments = [];
left.forEach((tr, j) => {
  const menuName = txt($('.menuTextDataHeight, .couponTextDataHeight, td.jscMenuText', tr) || $('td', tr));
  if (!menuName) return;
  const assignedEquipment = [];
  if (right[j]) {
    $$('td', right[j]).forEach((td, k) => {
      const cb = $('input[type="checkbox"]', td);
      if (cb && cb.checked && isEquipment(heads[k])) assignedEquipment.push(heads[k]);
    });
  }
  assignments.push({ menuName, kind: pair.kind, assignedEquipment });
});
if (!assignments.length) {
  alert('データが見つかりません');
  return;
}
const equipment = heads.filter(isEquipment);
finish({ kind: pair.kind, equipment, assignments }, '（' + assignments.length + '件）\n設備(' + equipment.length + '): ' + equipment.join(', '));
`);

/** カテゴリ管理「SBから取込」: the 検索カテゴリ table of a SALON BOARD coupon edit page → [{ parent, children }] */
export const SB_CATEGORY_SCRIPT = script(String.raw`
const groups = searchCategories(false);
if (!groups) {
  alert('カテゴリテーブルが見つかりません');
  return;
}
finish(groups, '（' + groups.length + 'グループ）');
`);

// ================================================================ reading what the owner pastes

/**
 * Parses the pasted JSON. Arrays copied from several SALON BOARD pages and pasted one after the other
 * (「[…][…]」) are joined into one.
 */
export function parsePastedJson(text: string): unknown {
  const s = text.trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    if (!/\]\s*,?\s*\[/.test(s)) throw e;
    return JSON.parse(`[${s.replace(/\]\s*,?\s*\[/g, '],[')}]`).flat();
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseInt(str(v).replace(/[,，]/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};
const bool = (v: unknown): boolean | undefined =>
  v === undefined || v === null ? undefined : v === true || v === 1 || v === '1' || v === 'true';
const couponTypeOf = (v: unknown) => (v === 'all' || v === 'new' || v === 'repeat' ? v : undefined);

/** A menu / coupon of the pasted data, in the shape the import API takes */
export interface SbMenuItem {
  name: string;
  category?: string;
  description?: string;
  price?: number;
  durationMin?: number;
  priceTilde?: boolean;
  listed?: boolean;
  couponType?: 'all' | 'new' | 'repeat';
  usageCondition?: string;
  presentationCondition?: string;
  imageUrl?: string;
}

/** Pasted menus / coupons → import items (wrong-shaped entries are dropped) */
export function toSbMenuItems(data: unknown): SbMenuItem[] {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => {
      const item: SbMenuItem = { name: str(x.name).trim() };
      const set = <K extends keyof SbMenuItem>(k: K, v: SbMenuItem[K] | undefined) => {
        if (v !== undefined && v !== '') item[k] = v;
      };
      set('category', str(x.category).trim() || undefined);
      set('description', str(x.description).trim() || undefined);
      set('price', int(x.price));
      set('durationMin', int(x.durationMin));
      set('priceTilde', bool(x.priceTilde));
      set('listed', bool(x.listed));
      set('couponType', couponTypeOf(x.couponType));
      set('usageCondition', str(x.usageCondition).trim() || undefined);
      set('presentationCondition', str(x.presentationCondition).trim() || undefined);
      set('imageUrl', str(x.imageUrl).trim() || undefined);
      return item;
    });
}
