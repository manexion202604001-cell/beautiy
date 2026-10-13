import { describe, expect, it } from 'vitest';
import {
  parseAmount,
  parseDate,
  parseDateTime,
  parseDuration,
  parseGender,
  parseTime,
  parseYesNo,
  splitList,
  splitName,
  suggestMapping,
} from './fields.js';

describe('migration value parsers', () => {
  it('reads the date formats other salon systems export', () => {
    expect(parseDate('2026/10/9')).toBe('2026-10-09');
    expect(parseDate('2026-10-09')).toBe('2026-10-09');
    expect(parseDate('２０２６年１０月９日（金）')).toBe('2026-10-09');
    expect(parseDate('20261009')).toBe('2026-10-09');
    expect(parseDate('2026/10/09 14:30')).toBe('2026-10-09');
    expect(parseDate('昭和50年1月2日')).toBe('1975-01-02');
    expect(parseDate('S50.1.2')).toBe('1975-01-02');
    expect(parseDate('平成元年3月4日')).toBe('1989-03-04');
    expect(parseDate('R2/5/6')).toBe('2020-05-06');
    expect(parseDate('45000')).toBe('2023-03-15'); // Excel serial
    expect(parseDate('2026/2/30')).toBeNull();
    expect(parseDate('不明')).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('reads times, date-times, durations and amounts', () => {
    expect(parseTime('14:00')).toBe(840);
    expect(parseTime('9時30分')).toBe(570);
    expect(parseTime('1400')).toBe(840);
    expect(parseTime('午後2時')).toBe(840);
    expect(parseTime('2:30PM')).toBe(870);
    expect(parseTime('0.5')).toBe(720);
    expect(parseTime('25:00')).toBeNull();
    expect(parseDateTime('2026/10/09 14:30')).toEqual({ date: '2026-10-09', minutes: 870 });
    expect(parseDateTime('2026-10-09T09:05:00')).toEqual({ date: '2026-10-09', minutes: 545 });
    expect(parseDateTime('2026年10月9日(金) 10時')).toEqual({ date: '2026-10-09', minutes: 600 });
    expect(parseDateTime('2026/10/09')).toEqual({ date: '2026-10-09', minutes: null });
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('1時間30分')).toBe(90);
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('1.5時間')).toBe(90);
    expect(parseAmount('¥12,000')).toBe(12000);
    expect(parseAmount('１２，０００円')).toBe(12000);
    expect(parseAmount('-500')).toBe(-500);
    expect(parseAmount('なし')).toBeNull();
  });

  it('reads gender, yes/no, names and lists', () => {
    expect(parseGender('女性')).toBe('female');
    expect(parseGender('M')).toBe('male');
    expect(parseGender('?')).toBeNull();
    expect(parseYesNo('可')).toBe(true);
    expect(parseYesNo('不可')).toBe(false);
    expect(parseYesNo('○')).toBe(true);
    expect(parseYesNo('×')).toBe(false);
    expect(parseYesNo('どちらでも')).toBeNull();
    expect(splitName('山田　花子 様')).toEqual(['山田', '花子']);
    expect(splitName('山田花子')).toEqual(['山田花子', '']);
    expect(splitList('VIP|新規、紹介')).toEqual(['VIP', '新規', '紹介']);
  });

  it('suggests a column mapping from typical headings', () => {
    const header = ['会員番号', 'お客様名', 'フリガナ', '携帯電話', '電話番号2', '生年月日', '性別', '都道府県', '住所1', 'DM可否', '来店回数', '累計売上', '最終来店日', '担当者', '謎の列'];
    const m = suggestMapping('customers', header);
    expect(m.customerNumber).toEqual([0]);
    expect(m.fullName).toEqual([1]);
    expect(m.fullKana).toEqual([2]);
    expect(m.phone).toEqual([3]);
    expect(m.phone2).toEqual([4]);
    expect(m.birthday).toEqual([5]);
    expect(m.gender).toEqual([6]);
    expect(m.address).toEqual([7, 8]);
    expect(m.marketingOptIn).toEqual([9]);
    expect(m.visitCount).toEqual([10]);
    expect(m.totalSales).toEqual([11]);
    expect(m.lastVisit).toEqual([12]);
    expect(m.staffName).toEqual([13]);
    expect(Object.values(m).flat()).not.toContain(14);

    const r = suggestMapping('reservations', ['予約番号', '予約日', '開始時刻', '終了時刻', 'お客様名', '電話番号', 'スタッフ', 'メニュー', 'ID']);
    expect(r).toMatchObject({ reservationNo: [0], date: [1], time: [2], endTime: [3], fullName: [4], phone: [5], menu: [7] });
    // a bare "ID" in a reservation export is the reservation's id, not the customer's
    expect(r.customerNumber).toBeUndefined();
    expect(r.staffName).toEqual([6]);
  });

  it('maps the field names SALOGIC shows on its screens', () => {
    const c = suggestMapping('customers', ['会員番号', '姓', '名', 'セイ', 'メイ', '性別', '誕生日', 'ご職業', '電話番号', 'メールアドレス', '郵便番号', '住所', '集客元', '最近の担当', '来店回数', '最終来店', 'メモ']);
    expect(c).toEqual({
      customerNumber: [0], lastName: [1], firstName: [2], lastNameKana: [3], firstNameKana: [4], gender: [5], birthday: [6], occupation: [7],
      phone: [8], email: [9], postalCode: [10], address: [11], acquisitionSource: [12], staffName: [13], visitCount: [14], lastVisit: [15], memo: [16],
    });
    expect(suggestMapping('customers', ['名前', 'よみがな', 'ご来店のきっかけ', '担当スタッフ'])).toEqual({ fullName: [0], fullKana: [1], acquisitionSource: [2], staffName: [3] });

    const r = suggestMapping('reservations', ['開始日時', '終了時間', 'お客様', 'スタッフ', 'メニュー', 'ステータス', '予約経路', 'メモ']);
    expect(r).toEqual({ datetime: [0], endTime: [1], fullName: [2], staffName: [3], menu: [4], status: [5], route: [6], memo: [7] });

    const v = suggestMapping('visits', ['来店日時', 'お客様', '担当', 'メニュー', '料金']);
    expect(v).toEqual({ datetime: [0], fullName: [1], staffName: [2], menu: [3], amount: [4] });
  });

  it('does not let a generic heading claim a longer, unrelated one', () => {
    const c = suggestMapping('customers', ['お客様メモ', 'スタッフメモ', 'お客様番号', 'お客様']);
    expect(c.customerNumber).toEqual([2]);
    expect(c.fullName).toEqual([3]);
    expect(c.staffName).toBeUndefined();
    expect(Object.values(c).flat()).not.toContain(0);
    expect(Object.values(c).flat()).not.toContain(1);
    expect(suggestMapping('visits', ['料金プラン', '金額'])).toEqual({ amount: [1] });
  });
});
