# 本番デプロイ手順（Render）

リポジトリ直下の [`render.yaml`](../render.yaml)（Render Blueprint）で、DB・API・ワーカー・Web をまとめて作成します。
公開URLは Web の1つだけで、ホットペッパー / LiME の受信URLもこのドメインで発行されます。

```
https://<Web の URL>/v1/webhooks/inbound_email/<連携ごとのトークン>
```

| サービス | 内容 |
|---|---|
| `salon-os-web` | nginx。画面（SPA）を配信し、`/v1` を API へ Render のプライベートネットワークで中継（`API_HOSTPORT`） |
| `salon-os-api` | API。デプロイ前に `node dist/db/migrate.js` でマイグレーションを自動実行 |
| `salon-os-worker` | ジョブワーカー + 定期実行（メール取り込み・枠止め依頼・配信・集計） |
| `salon-os-db` | PostgreSQL 16 |

> 費用: ワーカーと API のデプロイ前コマンドは Render の有料プランが必要です。プラン・リージョンは作成画面で変更できます。料金は Render の料金ページで確認してください。

## 1. Blueprint を作成する

1. Render にログインし、GitHub の本リポジトリへのアクセスを許可する。
2. **New → Blueprint** → リポジトリとブランチを選択 → `render.yaml` が読み込まれる → **Apply**。
3. 4つのサービスが作成され、初回デプロイが走る（数分）。`JWT_SECRET` / `TOKEN_SECRET` / `ENCRYPTION_KEY` は自動生成される。

## 2. 公開URLを確認する

`salon-os-web` の画面上部に表示される URL（例: `https://salon-os-web.onrender.com`）を開き、ログイン画面が出ることを確認する。

URL が `https://salon-os-web.onrender.com` と違う場合（名前が既に使われていると末尾に文字が付く）や独自ドメインを使う場合は、
**Environment Groups → `salon-os-shared`** の `API_BASE_URL` / `WEB_BASE_URL` / `CORS_ORIGINS` を実際の URL に書き換え、
`salon-os-api` と `salon-os-worker` を再デプロイする（受信URL・メール内リンクがこの値で作られる）。

## 3. 初期設定

1. `https://<Web の URL>/signup` で法人・店舗・オーナーを登録する。
2. メニュー・スタッフ・営業時間・シフトを登録する。
3. 外部連携 → **連携を追加** →「ホットペッパービューティー（予約通知メール連携）」「LiME（予約通知メール連携）」を作成する。
   保存すると **設定手順と受信URL** が表示される（これが発行されたURL）。

## 4. 予約通知メールを受信URLへ届ける

受信URLはメールアドレスではなく Webhook なので、メールを Webhook に変換するサービスを1つ使う（どれでも可、JSON・フォーム・multipart を受け付ける）。

| サービス | 設定の要点 |
|---|---|
| SendGrid Inbound Parse | 受信用サブドメイン（例: `in.your-salon.jp`）の MX を SendGrid に向け、Destination URL に受信URLを登録 |
| Mailgun Routes | Route の forward 先に受信URL。連携設定の `mailgunSigningKey` を入れると署名も検証 |
| Postmark Inbound | Inbound Webhook URL に受信URL |

その後、SALON BOARD / LiME の通知メールを受信用アドレス（例: `hpb@in.your-salon.jp`）へ自動転送する
（媒体側の通知先に追加するか、普段のメールアドレスの自動転送フィルタを使う）。
届いたメールを画面の「解析テスト」に貼り付け、日時・スタッフ・メニューが正しく読めるか確認する。

## 5. 本番化チェックリスト

| 項目 | 設定（`salon-os-shared`） |
|---|---|
| 枠止め依頼・予約確認メールを実際に送る | `EMAIL_DRIVER=smtp`、`SMTP_URL=smtp://user:pass@host:587`、`MAIL_FROM` を追加 |
| 写真・カルテ画像・CSV出力を保存する | `STORAGE_DRIVER=s3`、`S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT`（Cloudflare R2 等）/ `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`。`local` のままだとデプロイのたびに消える |
| LINE 公式アカウント | `LINE_DRIVER=live` + 画面の「LINE公式アカウント」でチャネル登録 |
| オンライン決済 | `PAYMENT_PROVIDER=stripe`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`（Webhook: `https://<Web の URL>/v1/webhooks/stripe`） |
| AI 下書き | `ANTHROPIC_API_KEY`（未設定時はルールベース） |
| バックアップ | DB のバックアップ設定・復元手順を確認（[operations.md](operations.md)） |

`ENCRYPTION_KEY` は作成後に変更しないこと（保存済みの連携認証情報が復号できなくなる）。

## 他の環境へ

同じ構成（Postgres + API コンテナ + ワーカーコンテナ + Web コンテナ）であればどこでも動きます。
API と Web のイメージはそれぞれ `apps/api/Dockerfile` / `apps/web/Dockerfile`。Web は `API_UPSTREAM=http://<API>:<port>`
（または `API_HOSTPORT=<host>:<port>`）で中継先を指定します。ローカルでの一式起動は `infra/docker-compose.yml`。
