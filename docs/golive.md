# 店舗導入手順書（Go-Live Runbook）

このシステムを実店舗で使い始めるための手順です。**2つの運用モード**があります。

## モードA: スタンドアロン運用（今すぐ・無料・1端末）

サーバー不要。データは端末（ブラウザ）内に自動保存されます。

**向いている店舗**: 1人サロン、レジ横のタブレット1台で完結する運用、トライアル期間

1. デモURL（GitHub Pages）またはローカルビルドをタブレット/スマホで開く
2. スマホなら「ホーム画面に追加」でアプリのように起動できる（PWA対応済み）
3. 設定 → データ管理 で「保存データあり」になっていれば永続化が効いている

**制限**: 端末をまたいだ共有不可 / ブラウザのデータ消去で消える（定期的に顧客CSVをエクスポートしてバックアップすること）/ Web予約は同一端末内でのみ反映

## モードB: Supabase 本番運用（複数端末・Web予約公開・LINE連携）

**所要目安**: 半日〜1日（LINE/n8n連携を除く）

### 1. Supabase プロジェクト作成（15分）

1. https://supabase.com で新規プロジェクト作成（リージョン: Tokyo `ap-northeast-1`）
2. Settings → API から **Project URL** と **anon key** を控える

### 2. スキーマ適用（15分）

```bash
npm install -g supabase
supabase login
supabase link --project-ref <プロジェクトID>
supabase db push          # supabase/migrations/ の 0001〜0003 を適用
```

適用されるもの:
- 全テーブル + RLS（テナント分離・顧客所有権 salon/staff・ロール別アクセス）
- 予約の排他制約 `EXCLUDE USING gist`（ダブルブッキングをDB層でブロック）
- 会計の確定後UPDATE禁止トリガー（打消し伝票方式を強制）
- カルテ写真の非公開バケット `karte-photos`

### 3. 初期データ投入（15分）

`supabase/seed.sql` の店舗名・営業時間・インボイス番号・メニューを自店舗の値に書き換えて、SQL Editor で実行。

### 4. スタッフアカウント作成（15分）

1. Authentication → Users でスタッフのメールアドレスを招待
2. 発行された `auth.users.id` を使って staff テーブルに INSERT（seed.sql 末尾の例を参照）
3. オーナーは Authentication → MFA の有効化を推奨

### 5. フロントエンド接続・デプロイ（30分）

```bash
cp .env.example .env.local   # URL / anon key を記入
```

`src/lib/api/` のモック実装を supabase-js 実装へ差し替え（リポジトリ層のインターフェースは同一。
**この差し替え作業は未実装のため、Supabase認証情報の支給後に開発チーム（本セッション）が実施する**）。

デプロイは Vercel 推奨（`vercel --prod`、環境変数に上記2つを設定）。独自ドメインもここで設定。

### 6. n8n / LINE 連携（別途半日）

1. `supabase secrets set N8N_GATEWAY_KEY=<ランダムな長い文字列>`
2. `supabase functions deploy n8n-gateway --no-verify-jwt`
3. n8n（manexion.app.n8n.cloud）側で LINE Messaging API 資格情報を設定し、
   受信メッセージ → `POST /functions/v1/n8n-gateway`（`x-api-key` ヘッダ付き）で保存
4. リマインド送信は Supabase Database Webhooks（reservations INSERT/UPDATE）→ n8n Webhook で駆動

### 7. 開店前チェックリスト

- [ ] 2端末から同一スタッフ・同時刻に予約を入れて片方がエラーになる（受け入れ基準10-1）
- [ ] スタイリスト権限でログインし、他スタッフの個人顧客が見えない（10-3）
- [ ] 会計確定 → 取消が打消し伝票になり、監査ログに残る（10-2）
- [ ] カルテ写真のURLが1時間で失効する（10-7）
- [ ] レジ締めがオーナー/店長のみ実行できる
- [ ] 顧客CSVエクスポートが文字化けせず開ける（Excel）
- [ ] Web予約ページから予約→カレンダーに即時反映
- [ ] 領収書にインボイス番号が印字される

## 法令・運用上の注意

- **個人情報保護法**: プライバシーポリシーを用意し、Web予約ページに掲示すること
- **インボイス制度**: `salons.invoice_number` に自店の適格請求書発行事業者番号を設定
- **会計データ**: 確定伝票は7年保存が目安。顧客を削除してもカルテ・会計は匿名化保持される設計
- **バックアップ**: Supabase Pro プラン以上で日次バックアップ + PITR を有効化推奨
