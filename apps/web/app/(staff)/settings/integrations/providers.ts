// Integration provider catalogue for the settings UI (config keys match the adapters
// in lib/server/{line,payments/*,adapters/*,sync}.ts).
export interface ConfigField { key: string; label: string; secret?: boolean; kind?: 'text' | 'json' | 'select'; options?: { value: string; label: string }[]; hint?: string; placeholder?: string }
export interface ProviderDef {
  provider: string;
  label: string;
  group: 'messaging' | 'payment' | 'listing' | 'booking';
  description: string;
  fields: ConfigField[];
  /** path appended to APP_URL, {key} → webhookKey */
  webhookPath?: string;
  testable?: boolean;
  /** allow per-shop rows (otherwise org-wide only) */
  perShop: boolean;
  multiple?: boolean;
}

const bookingFields: ConfigField[] = [
  { key: 'webhookSecret', label: 'Webhook署名シークレット', secret: true, hint: '送信側で X-Salonos-Signature: sha256=<HMAC-SHA256(secret, body)> を付与します。空欄なら自動生成できます。' },
  { key: 'staffMap', label: 'スタッフ対応表（JSON）', kind: 'json', placeholder: '{ "外部スタッフID": "スタッフのユーザーID" }', hint: '外部サイトのスタッフIDをこのシステムのスタッフに対応付けます。未設定のスタッフは「指名なし」で登録されます。' },
  { key: 'shopMap', label: '店舗対応表（JSON・全店舗共通の連携のみ）', kind: 'json', placeholder: '{ "外部店舗ID": "店舗ID" }', hint: '連携を店舗に紐付けない場合、booking.shop_id から店舗を判定します。' },
];

export const PROVIDERS: ProviderDef[] = [
  {
    provider: 'LINE', label: 'LINE公式アカウント', group: 'messaging', perShop: true, testable: true,
    description: '予約確認・リマインド・1対1トーク・一斉配信。LINE Developers の Messaging API チャネル情報を入力し、Webhook URL を登録してください。',
    webhookPath: '/api/webhooks/line/{key}',
    fields: [
      { key: 'channelId', label: 'チャネルID' },
      { key: 'channelSecret', label: 'チャネルシークレット', secret: true },
      { key: 'channelAccessToken', label: 'チャネルアクセストークン（長期）', secret: true },
    ],
  },
  {
    provider: 'STRIPE', label: 'Stripe（オンライン決済）', group: 'payment', perShop: true, testable: true,
    description: 'オンライン決済・店販ECの決済。Stripe ダッシュボードで Webhook エンドポイントを作成し、署名シークレットを入力してください。',
    webhookPath: '/api/webhooks/stripe?k={key}',
    fields: [
      { key: 'secretKey', label: 'シークレットキー（sk_...）', secret: true },
      { key: 'webhookSecret', label: 'Webhook署名シークレット（whsec_...）', secret: true },
    ],
  },
  {
    provider: 'SQUARE', label: 'Square（店頭カード決済）', group: 'payment', perShop: true, testable: true,
    description: 'Square 端末でのカード決済。Square Developer でアプリを作成し、Webhook サブスクリプションを登録してください。',
    webhookPath: '/api/webhooks/square?k={key}',
    fields: [
      { key: 'accessToken', label: 'アクセストークン', secret: true },
      { key: 'signatureKey', label: 'Webhook署名キー', secret: true },
      { key: 'locationId', label: 'ロケーションID' },
      { key: 'deviceId', label: '端末ID（Terminal API・任意）' },
      { key: 'environment', label: '環境', kind: 'select', options: [{ value: 'production', label: '本番' }, { value: 'sandbox', label: 'サンドボックス' }] },
    ],
  },
  {
    provider: 'GOOGLE', label: 'Googleビジネスプロフィール', group: 'listing', perShop: true,
    description: 'Google の口コミを取り込み、返信を同期します。Google Cloud で OAuth クライアントを作成し、business.manage スコープで取得したトークンを入力してください（OAuth 連携画面は今後提供予定）。',
    fields: [
      { key: 'accountId', label: 'アカウントID（accounts/...）' },
      { key: 'locationId', label: 'ロケーションID（locations/...）' },
      { key: 'clientId', label: 'OAuth クライアントID' },
      { key: 'clientSecret', label: 'OAuth クライアントシークレット', secret: true },
      { key: 'accessToken', label: 'アクセストークン', secret: true },
      { key: 'refreshToken', label: 'リフレッシュトークン', secret: true },
    ],
  },
  {
    provider: 'INSTAGRAM', label: 'Instagram', group: 'listing', perShop: true,
    description: 'プロフィールのリンクや「予約する」ボタンにネット予約URLを設定すると、Instagram 経由の予約として集計されます。',
    fields: [{ key: 'handle', label: 'Instagram アカウント名（@なし）', placeholder: 'manexion_salon' }],
  },
  {
    provider: 'HOTPEPPER', label: 'ホットペッパービューティー', group: 'booking', perShop: true, multiple: true, webhookPath: '/api/webhooks/booking/{key}',
    description: '公開APIがないため、連携パートナー／中継ツールから下記の共通JSON形式で予約を送信します（プレースホルダ連携）。', fields: bookingFields,
  },
  {
    provider: 'MINIMO', label: 'minimo', group: 'booking', perShop: true, multiple: true, webhookPath: '/api/webhooks/booking/{key}',
    description: '中継ツールから共通JSON形式で予約を送信します（プレースホルダ連携）。', fields: bookingFields,
  },
  {
    provider: 'RAKUTEN', label: '楽天ビューティ', group: 'booking', perShop: true, multiple: true, webhookPath: '/api/webhooks/booking/{key}',
    description: '中継ツールから共通JSON形式で予約を送信します（プレースホルダ連携）。', fields: bookingFields,
  },
  {
    provider: 'GENERIC', label: '汎用Webhook（自社サイト等）', group: 'booking', perShop: true, multiple: true, webhookPath: '/api/webhooks/booking/{key}',
    description: '自社サイトや他システムから共通JSON形式で予約を受信します。', fields: bookingFields,
  },
  {
    provider: 'OTHER', label: 'その他の予約サイト', group: 'booking', perShop: true, multiple: true, webhookPath: '/api/webhooks/booking/{key}',
    description: 'その他の予約サイトからの予約を共通JSON形式で受信します。', fields: bookingFields,
  },
];

export const PROVIDER_BY_KEY = Object.fromEntries(PROVIDERS.map((p) => [p.provider, p]));

export const GROUP_LABEL: Record<ProviderDef['group'], string> = {
  messaging: 'メッセージ', payment: '決済', listing: '集客・口コミ', booking: '外部予約サイト',
};

export const GENERIC_EXAMPLE = `POST {url}
Content-Type: application/json
X-Salonos-Signature: sha256=<HMAC-SHA256(シークレット, リクエスト本文)の16進数>

{
  "event_id": "evt_20260925_0001",      // 一意なイベントID（再送時も同じ値）
  "type": "booking.upsert",
  "booking": {
    "id": "RSV-123456",                  // 予約サイト側の予約ID
    "version": 3,                        // 更新ごとに増える番号（古い通知は破棄）
    "status": "confirmed",               // confirmed | cancelled
    "shop_id": "shop-a",                 // 任意（店舗対応表を使う場合）
    "staff_id": "stylist-01",            // 任意（スタッフ対応表で変換）
    "start_at": "2026-10-01T10:00:00+09:00",
    "end_at": "2026-10-01T11:30:00+09:00",
    "customer": { "name": "山田 花子", "kana": "ヤマダ ハナコ", "phone": "090-1234-5678", "email": "hanako@example.com", "id": "cust-987" },
    "menus": ["カット", "トリートメント"],
    "price": 8800,
    "note": "前髪短め希望"
  }
}`;
