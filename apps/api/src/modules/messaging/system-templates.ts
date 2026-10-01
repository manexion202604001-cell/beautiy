/**
 * Default (system) message templates seeded for every organization.
 * Variables: {{customer.name}} {{customer.lastName}} {{customer.firstName}} {{shop.name}} {{shop.phone}} {{shop.bookingUrl}}
 *            {{appointment.start}} {{appointment.date}} {{appointment.time}} {{appointment.menus}} {{appointment.staff}}
 *            {{appointment.reference}} {{appointment.manageUrl}} {{appointment.previousStart}} {{cancel.reason}} {{review.url}}
 * Sections:  {{#path}}…{{/path}} renders only when the value is present, {{^path}}…{{/path}} only when it is absent.
 */
export type TemplateCategory = 'transactional' | 'marketing' | 'followup' | 'review' | 'other';

export interface SystemTemplateDef {
  key: string;
  name: string;
  category: TemplateCategory;
  line: string;
  email: { subject: string; body: string };
  /** seeded status (welcome is off by default: LINE OA has its own greeting message) */
  status?: 'active' | 'inactive';
}

const SIGNATURE = `{{shop.name}}{{#shop.phone}}
TEL：{{shop.phone}}{{/shop.phone}}`;

const DETAILS = `■日時：{{appointment.start}}
■メニュー：{{appointment.menus}}
■担当：{{appointment.staff}}
■予約番号：{{appointment.reference}}`;

const MANAGE = `{{#appointment.manageUrl}}
ご予約の確認・変更・キャンセルはこちら
{{appointment.manageUrl}}
{{/appointment.manageUrl}}`;

const BOOK_AGAIN = `{{#shop.bookingUrl}}
ご予約はこちらから
{{shop.bookingUrl}}
{{/shop.bookingUrl}}`;

function both(key: string, name: string, category: TemplateCategory, subject: string, body: string, status?: 'active' | 'inactive'): SystemTemplateDef {
  return { key, name, category, line: body, email: { subject: `【{{shop.name}}】${subject}`, body }, status };
}

export const SYSTEM_TEMPLATES: SystemTemplateDef[] = [
  both(
    'booking_confirmed',
    '予約確定',
    'transactional',
    'ご予約確定のお知らせ',
    `{{customer.name}}様

ご予約ありがとうございます。
以下の内容でご予約が確定しました。

${DETAILS}
${MANAGE}
ご来店を心よりお待ちしております。

${SIGNATURE}`,
  ),
  both(
    'booking_tentative',
    '仮予約受付',
    'transactional',
    'ご予約リクエスト受付のお知らせ',
    `{{customer.name}}様

ご予約リクエストを受け付けました。
店舗にて内容を確認のうえ、確定のご連絡をいたします。

${DETAILS}
${MANAGE}
${SIGNATURE}`,
  ),
  both(
    'booking_changed',
    '予約変更',
    'transactional',
    'ご予約変更のお知らせ',
    `{{customer.name}}様

ご予約内容が変更されました。
変更後のご予約内容は以下の通りです。

${DETAILS}
{{#appointment.previousStart}}（変更前の日時：{{appointment.previousStart}}）
{{/appointment.previousStart}}${MANAGE}
ご来店を心よりお待ちしております。

${SIGNATURE}`,
  ),
  both(
    'booking_cancelled',
    '予約キャンセル',
    'transactional',
    'ご予約キャンセルのお知らせ',
    `{{customer.name}}様

{{#cancel.byCustomer}}以下のご予約のキャンセルを承りました。{{/cancel.byCustomer}}{{^cancel.byCustomer}}以下のご予約はキャンセルとなりました。{{/cancel.byCustomer}}

■日時：{{appointment.start}}
■メニュー：{{appointment.menus}}
■予約番号：{{appointment.reference}}

またのご来店をお待ちしております。
${BOOK_AGAIN}
${SIGNATURE}`,
  ),
  both(
    'reminder_day_before',
    '前日リマインド',
    'transactional',
    '明日のご予約のお知らせ',
    `{{customer.name}}様

明日のご予約のお知らせです。

${DETAILS}
${MANAGE}
お気をつけてお越しください。

${SIGNATURE}`,
  ),
  both(
    'reminder_same_day',
    '当日リマインド',
    'transactional',
    '本日のご予約のお知らせ',
    `{{customer.name}}様

本日{{appointment.time}}からのご予約をお待ちしております。

■メニュー：{{appointment.menus}}
■担当：{{appointment.staff}}

遅れる場合はお手数ですが店舗までご連絡ください。

${SIGNATURE}`,
  ),
  both(
    'review_request',
    '口コミ依頼',
    'review',
    'ご来店ありがとうございました',
    `{{customer.name}}様

本日はご来店いただきありがとうございました。
よろしければ、サービスのご感想をお聞かせください。
{{#review.url}}
{{review.url}}
{{/review.url}}
今後のサービス向上に役立てさせていただきます。

${SIGNATURE}`,
  ),
  both(
    'followup_after_visit',
    '来店後フォロー',
    'followup',
    '先日はご来店ありがとうございました',
    `{{customer.name}}様

先日はご来店いただきありがとうございました。
その後、仕上がりはいかがでしょうか？
気になる点がございましたら、お気軽にこのメッセージへご返信ください。

${SIGNATURE}`,
  ),
  both(
    'dormant_followup',
    '休眠フォロー',
    'marketing',
    'お久しぶりです',
    `{{customer.name}}様

最後のご来店から少し時間が経ちましたが、お変わりありませんか？
そろそろメンテナンスの時期かもしれません。
またお会いできるのをスタッフ一同楽しみにしております。
${BOOK_AGAIN}
${SIGNATURE}`,
  ),
  both(
    'first_visit_followup',
    '初回来店フォロー',
    'followup',
    '初めてのご来店ありがとうございました',
    `{{customer.name}}様

先日は初めてのご来店ありがとうございました。
スタイルの持ちやお手入れで気になることがあれば、いつでもご相談ください。
次回のご来店もお待ちしております。
${BOOK_AGAIN}
${SIGNATURE}`,
  ),
  both(
    'birthday',
    '誕生日',
    'marketing',
    'お誕生日おめでとうございます',
    `{{customer.name}}様

お誕生日おめでとうございます！
素敵な一年になりますように。
お誕生月のご来店を心よりお待ちしております。
${BOOK_AGAIN}
${SIGNATURE}`,
  ),
  both(
    'welcome',
    '友だち追加あいさつ',
    'other',
    'ご登録ありがとうございます',
    `友だち追加ありがとうございます！
{{shop.name}}です。

LINEからご予約・お問い合わせを受け付けています。
${BOOK_AGAIN}
${SIGNATURE}`,
    'inactive',
  ),
];

/** Appended to marketing e-mails (特定電子メール法: 配信停止の導線) */
export const EMAIL_UNSUBSCRIBE_FOOTER = `

――――――――――
配信停止をご希望の方はこちら
{{unsubscribeUrl}}`;
