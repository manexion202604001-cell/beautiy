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
    // the medium's account mails are not bookings even though they mention 予約
    expect(detectKind('【SALON BOARD】予約お知らせメールアドレス認証のお願い', '下記URLから認証してください')).toBe('unknown');
    expect(detectKind('【SALON BOARD】パスワード変更のお知らせ', '')).toBe('unknown');
    expect(detectKind('【SALON BOARD】予約お知らせメールアドレスの確認', '')).toBe('unknown');
    expect(detectKind('ミニモサロンツール 通知先メールアドレス追加のご案内', '')).toBe('unknown');
    expect(detectKind('【SALON BOARD】予約連絡', '')).toBe('booked');
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

  it('reads the real SALON BOARD layout: headings, coupon apart from the menu category, kana in parentheses', () => {
    const text = [
      'fein.テスト店様',
      '',
      'HOT PEPPER Beauty「SALON BOARD」にお客様から',
      'ご予約が入りました。',
      '',
      '◇ご予約内容',
      '■予約番号',
      '\u3000BF12345678',
      '■氏名',
      '\u3000山田 花子（ヤマダ ハナコ）',
      '■来店日時',
      '\u30002026年10月20日（火）15:30',
      '■指名スタッフ',
      '\u3000ai ka',
      '■メニュー',
      '\u3000まつエク＋その他まつげメニュー',
      '\u3000（所要時間目安：1時間）',
      '■ご利用クーポン',
      '\u3000[再来]',
      '\u3000【リピーター様】人気NO.1まつげパーマ・パリジェンヌラッシュリフト☆￥8000',
      '\u3000\u3000【次世代パーマ】カールの種類ご提案させていただきます♪【表参道】',
      '■合計金額',
      '\u3000予約時合計金額\u30008,000円',
      '\u3000お支払い予定金額\u30008,000円',
      '◇ご予約付加情報',
      '■ご要望・ご相談',
      '\u3000-',
    ].join('\n');
    const p = parseBookingMail({ subject: '【当日15時30分】直前予約が入りました', text, receivedAt: new Date('2026-10-20T04:00:00Z') });
    expect(p.kind).toBe('booked');
    expect(p.reservationNo).toBe('BF12345678');
    expect(p.start?.toISOString()).toBe('2026-10-20T06:30:00.000Z');
    expect(p.durationMin).toBe(60);
    expect(p.end?.toISOString()).toBe('2026-10-20T07:30:00.000Z');
    expect(p.staffName).toBe('ai ka');
    expect(p.menuNames).toEqual(['【リピーター様】人気NO.1まつげパーマ・パリジェンヌラッシュリフト☆']);
    expect(p.customer).toMatchObject({ name: '山田 花子', kana: 'ヤマダ ハナコ' });
    expect(p.amount).toBe(8000);

    // no coupon: the menu lines without the duration hint
    const plain = parseBookingMail({ subject: '予約連絡', text: text.replace(/■ご利用クーポン[\s\S]*?■合計金額/, '■合計金額'), receivedAt: new Date('2026-10-20T04:00:00Z') });
    expect(plain.menuNames).toEqual(['まつエク+その他まつげメニュー']);

    // several menus, each with a description indented one step deeper, and no coupon
    const menus = parseBookingMail({
      subject: '予約連絡',
      text: text.replace(
        /■メニュー[\s\S]*?■合計金額/,
        ['■メニュー', '\u3000【フラットラッシュ】120本', '\u3000\u3000【カール】J/C/D【長さ】8mm～14mm※オフがある方はオフメニューを', '\u3000LEDグルーに変更+1500円', '\u3000\u3000LEDライトを当てることで約2秒で完全硬化！', '\u3000（所要時間目安：1時間5分）', '■ご利用クーポン', '\u3000利用クーポンなし', '■合計金額'].join('\n'),
      ),
      receivedAt: new Date('2026-10-20T04:00:00Z'),
    });
    expect(menus.menuNames).toEqual(['【フラットラッシュ】120本', 'LEDグルーに変更+']);
    expect(menus.durationMin).toBe(65);
  });
});
