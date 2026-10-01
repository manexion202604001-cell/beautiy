import { describe, expect, it } from 'vitest';
import {
  detectKind,
  extractFields,
  mergeLabels,
  parseBookingMail,
  parseDurationMin,
  PROVIDER_PROFILES,
} from './parser.js';

const received = new Date('2026-10-01T03:00:00Z');
const labels = PROVIDER_PROFILES.hotpepper_mail!.labels;

describe('booking mail parser', () => {
  it('parses a colon-style new booking notification (full-width, menu lines, prices)', () => {
    const text = [
      'サロン名：Salon Demo 渋谷',
      '',
      '下記の内容で予約が入りました。',
      '',
      '予約番号：ＢＥ１２３４５６７８',
      '来店日時：２０２６年１０月１５日（木）１４：００',
      'お客様名：山田 花子 様',
      'フリガナ：ヤマダ ハナコ',
      '電話番号：090-1234-5678',
      '指名スタッフ：佐藤 美咲',
      'メニュー：',
      '【全員】カット＋カラー ¥12,000',
      'トリートメント（30分）',
      '所要時間：2時間30分',
      '合計金額：15,300円',
      'ご要望：前髪は短めでお願いします',
    ].join('\n');
    const p = parseBookingMail(
      { subject: '【SALON BOARD】予約連絡', text, receivedAt: received },
      labels,
    );
    expect(p.kind).toBe('booked');
    expect(p.reservationNo).toBe('BE12345678');
    expect(p.start?.toISOString()).toBe('2026-10-15T05:00:00.000Z');
    expect(p.durationMin).toBe(150);
    expect(p.end?.toISOString()).toBe('2026-10-15T07:30:00.000Z');
    expect(p.customer).toEqual({
      name: '山田 花子',
      kana: 'ヤマダ ハナコ',
      phone: '090-1234-5678',
      email: null,
    });
    expect(p.staffName).toBe('佐藤 美咲');
    expect(p.menuNames).toEqual(['カット+カラー', 'トリートメント']);
    expect(p.amount).toBe(15300);
    expect(p.note).toBe('前髪は短めでお願いします');
    expect(p.warnings).toEqual([]);
  });

  it('parses bracket labels with values on the next line and a time range', () => {
    const text = [
      '■予約番号',
      'L-998877',
      '■日時',
      '10/20(火) 10:00〜11:30',
      '■お名前',
      '鈴木 一郎',
      '■担当',
      '指名なし',
      '■メニュー',
      '・メンズカット',
      '・ヘッドスパ',
    ].join('\n');
    const p = parseBookingMail(
      { subject: 'ご予約が確定しました', text, receivedAt: received },
      PROVIDER_PROFILES.lime_mail!.labels,
    );
    expect(p.reservationNo).toBe('L-998877');
    expect(p.start?.toISOString()).toBe('2026-10-20T01:00:00.000Z');
    expect(p.end?.toISOString()).toBe('2026-10-20T02:30:00.000Z');
    expect(p.staffName).toBeNull();
    expect(p.menuNames).toEqual(['メンズカット', 'ヘッドスパ']);
  });

  it('detects changes and cancellations; cancellations may lack details', () => {
    expect(detectKind('【SALON BOARD】予約変更連絡', '')).toBe('changed');
    expect(detectKind('予約キャンセルのお知らせ', '')).toBe('cancelled');
    expect(detectKind('お知らせ', '下記のご予約がキャンセルされました。')).toBe('cancelled');
    expect(detectKind('メルマガ', 'セール情報')).toBe('unknown');
    const p = parseBookingMail(
      {
        subject: '予約キャンセル',
        text: '予約番号：BE12345678\nお客様名：山田 花子',
        receivedAt: received,
      },
      labels,
    );
    expect(p.kind).toBe('cancelled');
    expect(p.reservationNo).toBe('BE12345678');
    expect(p.warnings).toEqual([]);
  });

  it('reads HTML-only mails and infers the year for month/day dates', () => {
    const html =
      '<table><tr><td>予約番号</td><td>BE55</td></tr><tr><td>来店日時</td><td>1月5日 午後2時30分</td></tr><tr><td>メニュー</td><td>カット</td></tr></table>';
    const p = parseBookingMail(
      { subject: '予約連絡', html, receivedAt: new Date('2026-12-28T03:00:00Z') },
      labels,
    );
    expect(p.start?.toISOString()).toBe('2027-01-05T05:30:00.000Z'); // next January, 14:30 JST
    expect(p.menuNames).toEqual(['カット']);
  });

  it('supports per-account label overrides and durations', () => {
    const custom = mergeLabels(labels, { reservationNo: ['受付ID'] });
    expect(extractFields('受付ID：XY-1234', custom).reservationNo).toBe('XY-1234');
    expect(parseDurationMin('1時間')).toBe(60);
    expect(parseDurationMin('90分')).toBe(90);
    expect(parseDurationMin('1.5時間')).toBe(90);
  });
});
