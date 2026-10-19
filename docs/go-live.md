# 本番公開とサロンボード連携の手順（表参道店から）

Salon OS を Render で公開し、サロンボード（ホットペッパービューティー）の予約を自動で取り込むまでの手順です。
1店舗ずつ進めます。最初は表参道店です。**独自ドメインは使いません**（公開URLは Render の `…onrender.com`、メール受信は Gmail）。

**この手順のあいだ、SALOGIC は止まりません**。サロンボードの「予約お知らせメール」は送り先を10件まで登録でき、
表参道店は3枠が空いています。Salon OS 用のアドレスを空き枠に**追加**するので、SALOGIC にも今までどおり届きます。

## 全体の形

```
サロンボード ──予約お知らせメール──▶ 予約受付専用 Gmail（例: fein.yoyaku+omotesando@gmail.com）
                                         │  Google Apps Script（infra/gmail-apps-script、1分ごと）
                                         ▼
                 https://salon-os-web.onrender.com/v1/webhooks/inbound_email/<表参道の連携トークン>
                                         │
                                         ▼
                              Salon OS（Render）: 予約を作成・変更・キャンセル

Salon OS で受けた予約 ──▶ 「媒体の枠止め」にタスク ──▶ スタッフがサロンボードで枠を止めて「対応済み」
```

- 1つの Gmail で全店舗をまかないます。店舗はアドレスの「+」以降で見分けます（`+omotesando`、`+aoyama` …）。
  サロンボードは「+」付きのアドレスを登録できます（表参道店の一覧にも「+」付きのアドレスが認証済みで並んでいます）。
- 取り込みは最大1分ほど遅れます。
- サロンボードへの自動ログインはしません（[ADR 0010](adr/0010-mail-based-booking-media-sync.md)）。ID・パスワードも Salon OS に保存しません。
- 写真はデータベースに保存します（`STORAGE_DRIVER=db`）。写真のために別の契約はいりません。

## 費用の目安

| もの | 内容 |
|---|---|
| Render | Web・API・ワーカー（各 starter）＋ PostgreSQL（basic-256mb）。月額は Render の料金ページで確認してください |
| Gmail・Apps Script | 無料 |

## A. ご本人の操作

アカウント作成・支払い・ログインは Claude が代わりにできません。ここだけお願いします。

1. **予約受付専用の Gmail を作る**（例: `fein.yoyaku@gmail.com`。普段使いと分けると、他のメールが混ざりません）。
2. **Render のアカウントを作る**: https://render.com → GitHub でログインし、このリポジトリへのアクセスを許可 → 支払い方法を登録。

## B. Salon OS を公開する（Render）

1. Render → **New → Blueprint** → このリポジトリ、ブランチ `claude/strange-sutherland-bd1f27` → `render.yaml` を読み込み → **Apply**。
   DB・API・ワーカー・Web の4つが作られ、初回デプロイが走ります（数分）。
2. `salon-os-web` の URL を確認。`https://salon-os-web.onrender.com` と違う場合（名前が使われていると末尾に文字が付く）は、
   **Environment Groups → `salon-os-shared`** の `API_BASE_URL` / `WEB_BASE_URL` / `CORS_ORIGINS` を実際の URL にして、
   `salon-os-api` と `salon-os-worker` を再デプロイ。
3. URL を開いてログイン画面が出れば公開完了（まだ誰もログインできません。次の C で作ります）。

## C. 表参道店のデータを本番に入れる

ローカルで確認済みの取り込み（`apps/api/src/scripts/import-salogic.ts`）を、このMacから本番 DB に対して実行します。
SALOGIC から書き出したデータと写真は、リポジトリの外（このMacの外付けHD `salogic-data/omotesando/`）にあります。

```bash
cd apps/api
DATABASE_URL='<Render → salon-os-db → Connect → External Database URL>?sslmode=require' STORAGE_DRIVER=db \
FEIN_OWNER_EMAIL='<オーナーのログイン用メールアドレス>' FEIN_OWNER_PASSWORD='<10文字以上>' \
pnpm exec tsx src/scripts/import-salogic.ts \
  --file <salogic-data>/omotesando/export.json --images <salogic-data>/omotesando/images --slug fein-omotesando
```

- 組織「fein.」・表参道店・スタッフ（写真つき）・メニュー（画像つき）・営業時間・受付設定と、ホットペッパー連携
  （枠止め依頼オン、サロンボードのスタッフ名11件の対応表）が作られます。
- オーナーのログイン用メールアドレスとパスワードは、ご本人が決めてこのコマンドに入れてください（Claude は入力しません）。
- お客様・予約・メッセージは入りません。
- Render の DB は外部からの接続に暗号化（`sslmode=require`）が必要です。接続を許可する IP の設定があれば、このMacの IP を許可してください。

## D. メール受信を作る（Gmail + Apps Script）

1. 本番の Salon OS にオーナーでログイン → **外部連携 → ホットペッパービューティー → 設定手順・受信URL** で受信URLをコピー。
2. 予約受付専用 Gmail でログインした状態で https://script.google.com → **新しいプロジェクト**。
   名前を「Salon OS メール取り込み」にし、`コード.gs` の中身を [`infra/gmail-apps-script/Code.gs`](../infra/gmail-apps-script/Code.gs) に置き換えて保存。
3. **プロジェクトの設定（歯車）→ スクリプト プロパティ** に追加:
   - プロパティ `ROUTES`、値 `{"omotesando": "<1 でコピーした受信URL>"}`
4. エディタ上部の関数で **setup** を選んで **実行** → Google の権限確認（Gmail の読み取り・外部への送信・トリガー）を許可。
   これで1分ごとの取り込みが動き始めます。

迷惑メールフォルダに入った通知も取り込みます。受信トレイでも見たい場合は、Gmail の **設定 → フィルタ** で
「To: `fein.yoyaku+*`」（または「From: salonboard.com」）に **迷惑メールにしない** を付けてください。

店舗を増やすときは `ROUTES` に `"aoyama": "<青山の受信URL>"` を足し、サロンボードには `fein.yoyaku+aoyama@gmail.com` を登録するだけです。

## E. サロンボードにアドレスを登録する

1. サロンボード → **設定 → 基本設定 → 予約お知らせメール一覧 → 予約お知らせメールを設定する**。
2. 空いている枠（表参道店は 5・9・10 番）に `fein.yoyaku+omotesando@gmail.com` を入れ、「配信する」にして設定する。
   **既存の枠（SALOGIC・LiME・スタッフのアドレス）は変えないでください。**
3. 認証メールが予約受付専用 Gmail に届く → 本文のリンクを開いて認証する
   （Salon OS の **外部連携 → 受信したメール** にも「予約以外のメール」として表示されます）。
4. 一覧の「認証状況」が認証済みになれば完了。

## F. 動作確認

1. 次にサロンボード経由で予約が入ったら、**受信したメール**に「取り込み済み」で表示され、予約カレンダーに「HPB」バッジ付きで出ることを確認。
2. 「読み取れませんでした」になった場合は、そのメールを **解析テスト** に貼り、ずれている項目を Claude に伝えてください（実物のメールに合わせて読み取りルールを直します）。
3. Salon OS で予約を入れると「媒体の枠止め」に依頼が出ることを確認（サロンボードで枠を止めて「対応済み」）。
4. 数日、SALOGIC と Salon OS の予約が一致することを確かめてから、スタッフの利用を Salon OS に切り替えます。

## 残るリスク

- メール配信の遅れ（サロンボード自身も「遅延や不達が発生する可能性」と案内しています）と、Apps Script の最大1分の遅れ。
- Salon OS で受けた予約は、スタッフがサロンボードで枠を止めるまで、ホットペッパー側で同じ枠が売れる可能性があります。
  枠止め依頼はダッシュボードと「媒体の枠止め」に出ます。メールでも受け取るには SMTP の設定が必要です（[deploy.md](deploy.md) 5章）。
- Gmail・Apps Script には Google の無料枠の上限があります（1日の外部送信回数など）。6店舗の予約数なら十分収まる見込みです。

## 付録: 独自ドメインを使う場合

あとでドメインを取得したら、Gmail の代わりに Cloudflare Email Routing と [`infra/cloudflare-email-worker`](../infra/cloudflare-email-worker) で受信できます
（取り込みの遅れがなくなります）。設定は `wrangler deploy` と secret `ROUTES`（`{"hpb-omotesando": "<受信URL>"}`）です。
