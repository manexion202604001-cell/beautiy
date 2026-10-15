# 本番公開とサロンボード連携の手順（表参道店から）

Salon OS をインターネットに公開し、サロンボード（ホットペッパービューティー）の予約を自動で取り込むまでの手順です。
1店舗ずつ進めます。最初は表参道店です。

**この手順のあいだ、SALOGIC は止まりません**。サロンボードの「予約お知らせメール」は送り先を10件まで登録でき、
表参道店は3枠が空いています。Salon OS の受信アドレスを空き枠に**追加**するので、SALOGIC にも今までどおり届きます。

## 全体の形

```
サロンボード ──予約お知らせメール──▶ hpb-omotesando@in.<ドメイン>
                                         │  Cloudflare Email Routing
                                         ▼
                              Cloudflare Email Worker（infra/cloudflare-email-worker）
                                         │  POST（JSON）
                                         ▼
                 https://app.<ドメイン>/v1/webhooks/inbound_email/<表参道の連携トークン>
                                         │
                                         ▼
                              Salon OS（Render）: 予約を作成・変更・キャンセル

Salon OS で受けた予約 ──▶ 「媒体の枠止め」にタスク ──▶ スタッフがサロンボードで枠を止めて「対応済み」
```

- サロンボードへの自動ログインはしません（[ADR 0010](adr/0010-mail-based-booking-media-sync.md)）。サロンボードのログイン画面は自動操作を見分ける仕組み（Akamai）を使っており、Salon OS はその回避をしません。
- サロンボードの ID・パスワードは Salon OS に保存しません。

## 費用の目安

金額は各社の料金ページで最新を確認してください。

| もの | 内容 |
|---|---|
| ドメイン | `.com` を Cloudflare で取得（年額。Cloudflare は原価で販売）。`.jp` は Cloudflare では買えないため、別の会社で買って Cloudflare に移す |
| Cloudflare | メール受信（Email Routing）と Email Worker は無料枠で足ります |
| Render | API・ワーカー・Web・DB。ワーカーとデプロイ前コマンドに有料プランが必要（[deploy.md](deploy.md)） |

## A. ご本人の操作（アカウント作成・支払い）

規則上、アカウント作成・支払い・ログインは Claude が代わりにできません。ここだけお願いします。

1. **Cloudflare のアカウントを作る**: https://dash.cloudflare.com/sign-up
2. **ドメインを買う**: Cloudflare ダッシュボード → **Domain Registration → Register Domains**。
   例: `fein-salon.com`（空いている名前を選んでください）。購入後、自動で Cloudflare の DNS に入ります。
3. **Render のアカウントを作る**: https://render.com （GitHub アカウントでログインし、このリポジトリへのアクセスを許可）

ここまで済んだら Claude に「できた」と伝えてください。B 以降は Claude が手順を案内しながら進めます
（ダッシュボードの操作やログインが必要な場面では、その都度お願いします）。

## B. Salon OS を公開する（Render）

1. Render → **New → Blueprint** → このリポジトリ、ブランチ `claude/strange-sutherland-bd1f27` → `render.yaml` を読み込み → **Apply**。
2. `salon-os-web` → **Settings → Custom Domains** に `app.<ドメイン>` を追加。表示された CNAME を Cloudflare の DNS に登録（プロキシはオフ＝DNS only）。
3. **Environment Groups → `salon-os-shared`** を本番の URL に合わせる:
   `API_BASE_URL=https://app.<ドメイン>`、`WEB_BASE_URL=https://app.<ドメイン>`、`CORS_ORIGINS=https://app.<ドメイン>`。
   `salon-os-api` と `salon-os-worker` を再デプロイ。
4. 写真の保存先: Cloudflare R2 にバケットを作り、`STORAGE_DRIVER=s3` ほか（[deploy.md](deploy.md) 5章）を設定。設定しないとデプロイのたびに写真が消えます。

## C. 表参道店のデータを本番に入れる

ローカルで確認済みの取り込み（`apps/api/src/scripts/import-salogic.ts`）を本番 DB に対して実行します。
SALOGIC から書き出したデータと写真は、リポジトリの外（このMacの外付けHD `salogic-data/omotesando/`）にあります。

```bash
cd apps/api
DATABASE_URL='<Render の salon-os-db の External Database URL>' \
STORAGE_DRIVER=s3 S3_BUCKET=… S3_REGION=auto S3_ENDPOINT=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
FEIN_OWNER_EMAIL='<オーナーのログイン用メールアドレス>' FEIN_OWNER_PASSWORD='<10文字以上>' \
pnpm exec tsx src/scripts/import-salogic.ts \
  --file <salogic-data>/omotesando/export.json --images <salogic-data>/omotesando/images --slug fein-omotesando
```

- 組織「fein.」・表参道店・スタッフ・メニュー・写真・営業時間・受付設定と、ホットペッパー連携（枠止め依頼オン、SB スタッフ名11件の対応表）が作られます。
- 最初の実行でオーナーのログインが作られます。メールアドレスとパスワードはご本人が決めて入力してください。
- お客様・予約・メッセージは入りません。

## D. メール受信を作る（Cloudflare）

1. Cloudflare → ドメイン → **Email → Email Routing** を有効にする（MX レコードが自動で入る）。
   受信専用にするなら、サブドメイン `in.<ドメイン>` で有効にします。
2. Salon OS（本番）→ **外部連携 → ホットペッパービューティー → 設定手順・受信URL** で受信URLをコピー。
3. Email Worker を公開（このMacで実行。`wrangler login` でブラウザが開くので Cloudflare にログイン）:

   ```bash
   cd infra/cloudflare-email-worker
   npm install
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put ROUTES
   # 貼り付ける値: {"hpb-omotesando": "<2 でコピーした受信URL>"}
   ```

4. Email Routing → **Routing rules → Custom addresses** に `hpb-omotesando@in.<ドメイン>` を作り、Action を **Send to a Worker → salon-os-email** にする。

店舗を増やすときは `ROUTES` に `"hpb-aoyama": "…"` のように足し、アドレスを1つ作るだけです。

## E. サロンボードに受信アドレスを登録する

1. サロンボード → **設定 → 基本設定 → 予約お知らせメール一覧 → 予約お知らせメールを設定する**。
2. 空いている枠（表参道店は 5・9・10 番）に `hpb-omotesando@in.<ドメイン>` を入れ、配信する にして設定する。
   **既存の枠（SALOGIC・LiME・スタッフのアドレス）は変えないでください。**
3. 認証メールが届く → Salon OS の **外部連携 → 受信したメール** に「予約以外のメール」として表示される → 本文のリンクを開いて認証する。
4. 一覧の「認証状況」が認証済みになれば完了。

## F. 動作確認

1. 次にサロンボード経由で予約が入ったら、**受信したメール**に「取り込み済み」で表示され、予約カレンダーに「HPB」バッジ付きで出ることを確認。
2. 「読み取れませんでした」になった場合は、そのメールを **解析テスト** に貼り、ずれている項目を Claude に伝えてください（実物のメールに合わせて読み取りルールを直します）。
3. Salon OS で予約を入れると「媒体の枠止め」に依頼が出ることを確認（サロンボードで枠を止めて「対応済み」）。
4. 数日、SALOGIC と Salon OS の予約が一致することを確かめてから、スタッフの利用を Salon OS に切り替えます。

## 残るリスク

- メール配信の遅れ（サロンボード自身も「遅延や不達が発生する可能性」と案内しています）。
- Salon OS で受けた予約は、スタッフがサロンボードで枠を止めるまで、ホットペッパー側で同じ枠が売れる可能性があります。枠止め依頼はダッシュボードと「媒体の枠止め」に出ます。依頼をメールでも受け取るには SMTP の設定が必要です（[deploy.md](deploy.md) 5章）。
