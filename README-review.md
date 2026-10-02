# ソースコード提供パッケージ（レビュー用）

サロン管理アプリ「SALOGIC」のアプリケーションソースコードです。

## 収録内容
- api/       … バックエンドAPI（Hono / Cloudflare Workers）
- staff/     … スタッフ向けアプリ（Next.js。カルテ・顧客管理・予約）
- customer/  … お客様向けアプリ（Next.js。予約・受付・会員連携）
- admin/     … 管理ダッシュボード（Next.js）
- karute-entry/ … カルテ記入用静的ページ

## 注意事項
- インフラ関連の識別子（クラウドアカウントID・データベースID・ドメイン・
  メールアドレス・LINEチャネル/LIFF ID等）は、すべてプレースホルダー
  （example.com / CF_ACCOUNT_ID_PLACEHOLDER / 0000000000-XXXXXXXX 等）に
  置換しています。
- APIキー・パスワード等の秘密情報は元より含まれていません。
- 本番運用スクリプト・外部サービス連携の運用コードは収録対象外です。
