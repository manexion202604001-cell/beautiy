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
  });
});
