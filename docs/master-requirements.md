# 美容サロン統合管理SaaS マスター要件定義書 v1.0

## 0. 本書の目的

本システムは、美容室・理容室・ネイル・アイラッシュ・エステ・整体・リラクゼーション等の店舗型サービス事業者向けに提供する統合型Vertical SaaSである。

単なる予約管理システムではなく、顧客管理 / 電子カルテ / 予約管理 / オンライン予約 / LINE予約 / メッセージ / CRM / POS / 決済 / 売上管理 / 外部予約サイト連携 / Google Business Profile連携 / SNS予約導線 / レビュー / スタッフ管理 / 多店舗管理 / LTV分析 / 店販EC / 回数券 / クーポン / ポイント / 顧客とのカルテ共有 を1つの顧客IDを中心として統合する。

最重要設計思想は以下。

> 「予約」「カルテ」「売上」「メッセージ」を別々のシステムとして作らず、すべてCustomerを中心として関連付けること。

```
Customer → Reservation → Visit → Karte → Transaction → Review → Message → Next Reservation → LTV
```

この一連の顧客ライフサイクルを同一システム上で管理する。

## 1. システム利用者

### 1-1. System Admin
サービス運営会社。権限: 全Organization閲覧 / 契約管理 / サポート / 障害調査 / 利用停止 / プラン変更 / Integration状態確認 / 操作ログ確認。
原則として顧客の機密カルテを通常業務では閲覧しない。

### 1-2. Organization Owner
サロン法人・事業主。権限: 全店舗管理 / 店舗追加 / スタッフ追加 / 権限管理 / 全店舗売上確認 / 全顧客確認 / 全予約確認 / メニュー管理 / 決済設定 / LINE設定 / 外部サービス設定 / レポート確認 / CSV出力。

### 1-3. Shop Manager
店長。自店舗について 顧客 / 予約 / カルテ / 売上 / スタッフ / レジ / レポート / LINE / 外部連携 を管理可能。

### 1-4. Staff / Stylist
美容師等。基本権限: 自分の予約 / 自分の顧客 / 自分のカルテ / 顧客メッセージ / 自分の売上 / プライベート予定 / 顧客プロフィール。
店舗設定により「店舗全顧客閲覧」を許可できる。

### 1-5. Assistant
アシスタント。権限を個別設定可能。例: カルテ閲覧 / カルテメモ追加 / 予約閲覧 / 会計補助。
顧客個人情報や売上情報は必要に応じ制限する。

### 1-6. Customer
来店顧客。専用アプリのインストールを必須にしない。
利用経路: LINE / Web予約 / SNS / Google / 公開プロフィール / QRコード。

## 2. システム全体構造

推奨構造: Customer Web / LINE → API Gateway → Application API → Domain Services → Database / Storage → External Integration

主要ドメイン: 1.Authentication 2.Organization 3.Shop 4.Staff 5.Customer 6.Reservation 7.Karte 8.Messaging 9.POS 10.Payment 11.CRM 12.Review 13.Analytics 14.EC 15.Integration

## 3. マルチテナント要件

本システムはマルチテナントSaaSとする。

```
Organization
└ Shop
   ├ Staff
   ├ Customer
   ├ Reservation
   ├ Karte
   └ Transaction
```

- すべての業務データに最低限 `organization_id` を保持する。店舗単位データには `shop_id` を保持する。
- API側で organization_id をクライアントから信用してはならない。ログインユーザーの Access Token から organization_id を確定する。
- 他Organizationデータへのアクセスは絶対に許可しない。

## 4. 認証機能

- **AUTH-001 アカウント登録**: 氏名 / メール / パスワード / 電話番号 / 利用規約同意 / プライバシーポリシー同意。メール認証必須。
- **AUTH-002 ログイン**: Email+Password / Google / Apple / LINE LOGIN。将来的なSocial Login追加を想定。
- **AUTH-003 パスワード再設定**: EmailへワンタイムURL送信。有効期限30分推奨。使用済みTokenは再利用不可。
- **AUTH-004 二要素認証**: Owner / Manager / System Adminは2FA推奨。方式: Email OTP / Authenticator。
- **AUTH-005 セッション**: Access Tokenは短時間有効。Refresh Tokenはローテーション方式。ログアウト時はRefresh Tokenを失効。
- **AUTH-006 ログイン履歴**: user_id / IP / user_agent / device / login_at / success・failure を保存。

## 5. Organization管理

**ORG-001 Organization作成**: organization_id / organization_name / corporate_name / owner_user_id / phone / email / postal_code / address / contract_plan / timezone / currency / status。
status: trial / active / suspended / cancelled。

## 6. 店舗管理

- **SHOP-001 店舗作成**: shop_id / organization_id / name / description / postal_code / prefecture / city / address / latitude / longitude / phone / email / website / timezone / opening_hours / booking_policy / cancellation_policy。
- **SHOP-002 営業時間**: 曜日ごとに設定（例: Monday 10:00-20:00）。休業日設定可能。
- **SHOP-003 特別営業時間**: 臨時休業 / 年末年始 / 短縮営業 / 特別営業。
- **SHOP-004 席・設備**: Resource登録（セット面 / シャンプー台 / ネイル席 / 個室 / ベッド / 機器）。予約時にResource Capacityを考慮可能にする。

## 7. スタッフ管理

- **STAFF-001 スタッフ登録**: staff_id / user_id / organization_id / shop_id / display_name / legal_name / email / phone / role / title / profile_image / introduction / skill / employment_status / joined_at / left_at。
- **STAFF-002 複数店舗所属**: staff_shop_relations を使用。
- **STAFF-003 勤務時間**: 出勤 / 退勤 / 休憩 / 休日。予約可能時間計算に使用。
- **STAFF-004 プライベート予定**: 種類（休憩 / 外出 / 会議 / 個人予定 / その他）、開始・終了時刻 / 色 / 繰り返し / 店舗スタッフへの公開・非公開。

## 8. 権限管理

RBAC + Resource Based Authorizationを採用。
代表Role: SYSTEM_ADMIN / OWNER / MANAGER / STAFF / ASSISTANT / ACCOUNTANT / READ_ONLY。
権限例: customer.read / customer.edit / karte.read / karte.edit / reservation.read / reservation.edit / sales.read / sales.edit / staff.manage / integration.manage / report.export。

## 9. 顧客管理 CRM

- **CUSTOMER-001 顧客登録**: customer_id / organization_id / primary_shop_id / first_name / last_name / first_name_kana / last_name_kana / nickname / gender / birthday / phone / email / postal_code / address / occupation / memo / acquisition_source / first_visit_at / latest_visit_at / next_visit_at / primary_staff_id。
- **CUSTOMER-002 顧客検索**: 氏名 / カナ / 電話番号 / メール / 顧客番号 / LINE表示名。部分一致対応。
- **CUSTOMER-003 タグ**: VIP / 新規 / 常連 / 休眠 / カラー顧客 / 商品購入者 等。複数タグ設定可能。
- **CUSTOMER-004 お気に入り**: スタッフ単位で顧客をお気に入り登録可能。
- **CUSTOMER-005 顧客名寄せ**: 重複候補判定は電話番号 / Email / LINE user ID / 氏名 / 生年月日。完全自動統合は禁止。候補提示→スタッフ確認→統合。
- **CUSTOMER-006 顧客統合**: A→Bへ統合。対象: 予約 / カルテ / 売上 / LINE / メッセージ / レビュー / ポイント / 回数券。統合履歴をAudit Logへ保存。
- **CUSTOMER-007 顧客所有区分**: ownership_type = SHOP / STAFF / SHARED。店舗資産顧客とスタッフ個人顧客を区別可能とする。

## 10. カルテ管理

- **KARTE-001 カルテ作成**: VisitまたはReservationに関連付ける。karte_id / customer_id / reservation_id / shop_id / staff_id / visit_date / note / treatment_note / next_recommendation。
- **KARTE-002 施術メニュー記録**: 複数メニュー登録可能。
- **KARTE-003 薬剤情報**: product_name / manufacturer / color / ratio / volume / processing_time / memo。
- **KARTE-004 写真**: Before/After、複数画像。保存先はObject Storage。DBにはURLではなくStorage Keyを保持。
- **KARTE-005 写真加工**: Crop / Rotate / Drawing / Annotation。
- **KARTE-006 スケッチ**: 自由描画キャンバス。PNG + optional vector JSON。
- **KARTE-007 アシスタントメモ**: 担当者以外も権限に応じて追加可能。作成者を必ず保持。
- **KARTE-008 テンプレート**: 店舗単位・スタッフ単位で作成可能。
- **KARTE-009 音声入力**: OS標準音声入力またはSpeech-to-Text。
- **KARTE-010 カウンセリングシート**: 顧客自身がスマホから入力可能。質問形式: TEXT / TEXTAREA / RADIO / CHECKBOX / SELECT / NUMBER / DATE / SIGNATURE。
- **KARTE-011 同意書**: 電子署名対応。同意文書version / signed_at / signature / customer_id を保存。
- **KARTE-012 過去カルテ複製**: 過去施術内容を新しいカルテへコピー可能。

## 11. 顧客へのカルテ共有

共有対象: 施術写真 / ヘアスタイル / ホームケア情報 / スタッフコメント。
共有手段: LINE / URL。
非公開情報: 内部メモ / 原価 / スタッフ評価 / 管理者メモ。

## 12. メニュー管理

- **MENU-001 メニュー**: menu_id / shop_id / name / description / category / price / duration / tax_type / active。
- **MENU-002 スタッフ別対応メニュー**: staff_menu_relations。
- **MENU-003 スタッフ別料金**: 同一メニューでも担当者によって価格変更可能。
- **MENU-004 所要時間**: 施術60分+準備15分+後処理15分 → booking_duration = 90分として扱える。

## 13. クーポン

**COUPON-001**: coupon_id / name / code / discount_type / discount_value / start_at / end_at / minimum_amount / usage_limit / customer_usage_limit / target_menu / target_customer_segment。
discount_type: PERCENT / FIXED。

## 14. 予約管理

予約は本システムの中心機能とする。

- **RESERVATION-001 予約作成**: customer / shop / staff / menus / start_at / memo / booking_source。
- **RESERVATION-002 予約状態**: REQUESTED / CONFIRMED / CHECKED_IN / IN_SERVICE / COMPLETED / CANCELLED / NO_SHOW / DELETED。
- **RESERVATION-003 予約元**: STAFF / PHONE / WEB / LINE / INSTAGRAM / GOOGLE / EXTERNAL / WALK_IN / OTHER。
- **RESERVATION-004 予約競合判定**: スタッフ空き時間 / 店舗営業時間 / スタッフ勤務時間 / 既存予約 / 休憩 / プライベート予定 / 必要設備 / 席数。
- **RESERVATION-005 同時予約対策**: 予約確定処理はDB Transaction内。Reservation Slotに排他制御。同時予約でも二重確定しないこと。
- **RESERVATION-006 カレンダー**: DAY / 3 DAYS / WEEK / STAFF / SHOP。
- **RESERVATION-007 ドラッグ変更**: Web管理画面でDrag & Dropで開始時間・スタッフを変更可能。変更時に再度Availability Check。
- **RESERVATION-008 予約変更**: reservation_history（before / after / changed_by / changed_at）を保存。
- **RESERVATION-009 キャンセル**: 理由 = CUSTOMER_REQUEST / SHOP_REQUEST / NO_SHOW / DUPLICATE / OTHER。
- **RESERVATION-010 プライベート予定との競合**: private_scheduleは予約不可時間として扱う。

## 15. オンライン予約

- **BOOKING-001 公開予約URL**: 店舗単位 `/booking/{shopSlug}`、スタッフ単位 `/booking/{shopSlug}/{staffSlug}`。
- **BOOKING-002 予約ステップ**: 店舗→スタッフ→メニュー→日時→顧客情報→確認→完了。設定によりメニュー→スタッフ順にも変更可能。
- **BOOKING-003 担当者指定なし**: 「担当者おまかせ」選択可能。予約確定時に空きスタッフを割り当てる。
- **BOOKING-004 相談予約**: メニュー未確定で予約可能（consultation = true）。
- **BOOKING-005 空き枠**: Availability APIから計算。キャッシュ可能だが予約確定前に必ず再検証する。

## 16. LINE予約

- **LINE-001 LINE公式アカウント接続**: OAuth等LINE提供方式に従い連携。line_channel_id / connection_status / token / token_expired_at を保存。Tokenは暗号化保存。
- **LINE-002 リッチメニュー**: 予約ボタン設定可能。
- **LINE-003 会員登録不要予約**: LINE IdentityとCustomerを紐付け。line_identities: customer_id / line_user_id / display_name / picture_url / linked_at。
- **LINE-004 予約完了通知**: 予約店舗 / 日時 / 担当者 / メニュー / 変更URL / キャンセルURL を通知。
- **LINE-005 リマインド**: 7日前 / 3日前 / 1日前 / 当日。店舗単位でON/OFF可能。
- **LINE-006 LINE予約入口**: LINE / Instagram / Webサイト / QR / SNSプロフィール から同一予約URLを利用可能。

## 17. メッセージ

- **MSG-001 1対1メッセージ**: message_id / customer_id / staff_id / channel / body / status / sent_at。
- **MSG-002 テンプレート**: 予約確認 / 来店お礼 / 次回来店案内 / 誕生日 / 休眠顧客。
- **MSG-003 画像送信**: カルテ写真等を送信可能。
- **MSG-004 配信状態**: QUEUED / SENT / DELIVERED / FAILED。

## 18. CRM自動配信

- **CRM-001 セグメント**: 来店回数 / 最終来店日 / 担当者 / メニュー / 売上 / LTV / 商品購入 / 誕生日 / 店舗 / タグ。
- **CRM-002 自動配信**: 例）最終来店から45日 → 対象顧客抽出 → LINE送信。
- **CRM-003 配信停止**: 顧客単位でマーケティング配信拒否を保持。transactional / marketing メッセージを区別する。

## 19. 自動おすすめメニュー

過去施術 / 来店周期 / 担当者 / 購入履歴 を元に次回候補メニューを提示。初期版はRule Basedでよい。
例: 過去3回のうち2回以上カラー → カラーを優先表示。

## 20. 予約日程自動提案

平均来店周期を計算する。例: 過去来店 35日 / 42日 / 39日 → 平均38.7日 → 前回来店日+39日を次回予約推奨日として表示する。

## 21. POS

- **POS-001 会計開始**: 予約情報から顧客 / 担当者 / メニュー / 価格を自動取得。
- **POS-002 会計明細**: transaction_items = SERVICE / PRODUCT / TICKET / OTHER。
- **POS-003 値引き**: ITEM_DISCOUNT / TRANSACTION_DISCOUNT。
- **POS-004 税**: 税率を商品単位で保持。税込/税抜設定可能。
- **POS-005 支払方法**: CASH / CARD / E_MONEY / QR / POINT / TICKET / OTHER。複数支払併用可能。
- **POS-006 店舗独自支払方法**: Managerが追加可能（社内商品券 / 福利厚生券 等）。
- **POS-007 会計下書き**: DRAFT → PAID → REFUNDED。
- **POS-008 返金**: 全額・一部対応。元Transactionを変更せずRefund Transactionとして記録。

## 22. レジ締め

- **REGISTER-001 レジ開始**: open_balance登録。
- **REGISTER-002 現金集計**: expected_cash / actual_cash / difference。
- **REGISTER-003 レジ締め**: close_at / closed_by を記録。締め後データの直接編集禁止。修正履歴を残す。

## 23. 決済

Payment Providerを抽象化する: `interface PaymentProvider { createPayment(); capturePayment(); refundPayment(); getPayment(); }`

- **PAYMENT-001 カード決済**: カード情報は自システムに保存しない。PCI DSS対象縮小のためProvider Hosted UI等を利用。
- **PAYMENT-002 Square連携**: Square POS / Payment APIとの連携層。transaction_idとprovider_payment_idを紐付け。
- **PAYMENT-003 Webhook**: 署名検証必須。再送を想定し event_id で冪等性を保証。

## 24. ポイント

- **POINT-001 付与**: 例）100円=1ポイント。店舗設定可能。
- **POINT-002 利用**: 会計時に利用。
- **POINT-003 台帳**: point_ledger方式（ADD / USE / EXPIRE / ADJUST / REFUND）。履歴を削除しない。

## 25. 回数券

- **TICKET-001 回数券商品**: name / price / total_count / valid_days / target_menu。
- **TICKET-002 顧客回数券**: customer_ticket = purchased_at / expires_at / remaining_count / status。
- **TICKET-003 使用**: 会計または施術完了時に1回消費。履歴保存。
- **TICKET-004 取消**: 誤操作時は履歴を残したまま回数を戻す。

## 26. 外部予約サイト連携

Provider Adapter方式: `ExternalBookingProvider { fetchBookings(); createBooking(); updateBooking(); cancelBooking(); fetchAvailability(); updateAvailability(); }` — サービス差異はAdapter内部で吸収。

- **EXTBOOK-001 外部予約取込**: 外部予約 → Webhook/Polling → Normalize → Idempotency Check → Customer Matching → Availability Check → Reservation Save。
- **EXTBOOK-002 ID管理**: external_booking_mappings = provider / external_booking_id / reservation_id / last_synced_at。
- **EXTBOOK-003 双方向同期**: 自システム変更を外部へ通知、外部変更を自システムへ反映。
- **EXTBOOK-004 同期エラー**: FAILED状態を保持。1分/5分/15分/1時間等のExponential BackoffでRetry。最終失敗時は管理者通知。
- **EXTBOOK-005 重複防止**: Idempotency Key = provider + external_booking_id。
- **EXTBOOK-006 外部サービス制約**: Hot Pepper Beauty等は公式API・契約仕様・利用規約上利用可能な連携方式を採用。利用許可のないスクレイピング等を前提としない。Providerごとに DIRECT_API / PARTNER_API / IMPORT / MANUAL 等の連携方式を設定可能にする。

## 27. Instagram予約

SNSプロフィールから公開予約ページへ誘導。予約完了後は通常Reservationとして保存。booking_source = INSTAGRAM。

## 28. Google Business Profile連携

- **GOOGLE-001 OAuth**: 店舗Googleアカウント接続。
- **GOOGLE-002 店舗情報同期**: 店舗名 / 営業時間 / 住所 / 電話番号 / プロフィール情報。
- **GOOGLE-003 レビューコンテンツ連携**: 外部APIで許可される範囲で連携。Provider仕様を必ず優先。
- **GOOGLE-004 予約導線**: Google側から公開予約URLへ誘導。booking_source = GOOGLE。

## 29. 公開プロフィールページ

- **PROFILE-001 スタッフ**: 名前 / 写真 / 自己紹介 / 得意メニュー / 施術写真 / 勤務店舗 / メニュー / 料金 / レビュー / 予約ボタン。
- **PROFILE-002 店舗**: 店舗写真 / 住所 / 地図 / 電話 / 営業時間 / スタッフ / メニュー / レビュー / 予約。
- **PROFILE-003 SEO**: SSRまたはSSG。metadata / OGP / structured data / canonical / sitemap を設定。

## 30. レビュー

- **REVIEW-001 レビュー依頼**: 施術完了後にLINE等から依頼可能。
- **REVIEW-002 内容**: rating / comment / photos / customer_id / staff_id / shop_id / reservation_id。
- **REVIEW-003 写真付き**: 複数画像対応。不適切画像対策。
- **REVIEW-004 返信**: 店舗またはスタッフから返信可能。
- **REVIEW-005 公開設定**: PENDING / PUBLISHED / HIDDEN。
- **REVIEW-006 SNS共有**: レビューをSNS投稿用画像として生成可能。

## 31. 売上レポート

- **REPORT-001 日別売上**: Gross Sales / Discount / Net Sales / Tax / Refund。
- **REPORT-002 スタッフ別売上**: 指名 / フリーを区別。
- **REPORT-003 メニュー売上**: 件数 / 売上 / 構成比。
- **REPORT-004 店販売上**: 商品別 / スタッフ別 / 店舗別。
- **REPORT-005 来店履歴**: COMPLETED / CANCELLED / NO_SHOW を区別。

## 32. LTV

基本式: LTV = 顧客の累計純売上。期間指定にも対応。

- **LTV-001 KPI**: 累計売上 / 平均客単価 / 来店回数 / 平均来店周期 / 最終来店日 / 初回来店日 / 商品購入額。
- **LTV-002 リピート率**: 新規顧客のうち指定期間以内に2回目来店した割合。期間定義変更可能。
- **LTV-003 失客候補**: average_visit_interval × threshold を超過した顧客を抽出（例: 平均40日 × 1.5 → 60日未回来店で失客候補）。

## 33. 店販EC

- **EC-001 商品**: name / description / brand / category / price / tax_rate / image / inventory_type / active。
- **EC-002 顧客専用商品URL**: スタッフが商品URLを顧客へ送信。tracking: customer_id / staff_id / campaign_id。
- **EC-003 注文**: PENDING / PAID / FULFILLING / SHIPPED / DELIVERED / CANCELLED / REFUNDED。
- **EC-004 定期購入**: subscription = interval / next_billing_at / status。
- **EC-005 売上帰属**: EC売上を店舗 / スタッフ / 顧客へ紐付け。

## 34. 多店舗管理

- **MULTI-001 店舗切替**: OwnerはWeb/Appから切替可能。
- **MULTI-002 顧客共有**: Organization設定で SHARED / SHOP_ISOLATED を選択可能。
- **MULTI-003 カルテ共有**: 店舗間カルテ閲覧を権限設定可能。
- **MULTI-004 全店舗予約**: Owner向け一覧。
- **MULTI-005 全店舗売上**: 売上 / 客数 / 客単価 / 再来率 / LTV の店舗比較。

## 35. CSV

EXPORT-001 顧客CSV / EXPORT-002 売上CSV / EXPORT-003 来店履歴CSV / EXPORT-004 会計CSV / EXPORT-005 税務用CSV。
大量CSVは非同期Jobで作成し、完成後にダウンロード通知。

## 36. 通知

Notification Serviceを独立させる。channel: IN_APP / LINE / EMAIL / SMS / PUSH。
通知イベント: RESERVATION_CREATED / RESERVATION_UPDATED / RESERVATION_CANCELLED / RESERVATION_REMINDER / PAYMENT_SUCCESS / PAYMENT_FAILED / REVIEW_RECEIVED / SYNC_FAILED。

## 37. データモデル

最低限以下のテーブルを実装する:
organizations, shops, users, staff, staff_shop_relations, roles, permissions, user_roles, customers, customer_shop_relations, customer_staff_relations, customer_tags, tags, line_identities, menus, menu_staff_relations, reservations, reservation_items, reservation_history, private_schedules, kartes, karte_items, karte_photos, karte_drugs, karte_memos, counseling_forms, counseling_answers, consents, transactions, transaction_items, payments, refunds, register_sessions, points_ledgers, coupons, customer_coupons, tickets, customer_tickets, ticket_usages, messages, message_templates, campaigns, campaign_targets, reviews, review_photos, products, orders, order_items, subscriptions, external_integrations, external_booking_mappings, webhook_events, notifications, audit_logs

## 38. 共通DBカラム

原則すべてのテーブルに id (UUID) / created_at / updated_at。論理削除対象には deleted_at。業務データでは organization_id を可能な限り保持。

## 39. API設計

REST APIを基本とする場合:
/api/v1/auth, /api/v1/organizations, /api/v1/shops, /api/v1/staff, /api/v1/customers, /api/v1/menus, /api/v1/reservations, /api/v1/availability, /api/v1/kartes, /api/v1/messages, /api/v1/campaigns, /api/v1/transactions, /api/v1/payments, /api/v1/reviews, /api/v1/products, /api/v1/orders, /api/v1/reports, /api/v1/integrations

## 40. APIレスポンス

成功: `{ "data": {}, "meta": {} }`
エラー: `{ "error": { "code": "RESERVATION_CONFLICT", "message": "指定時間は予約できません", "details": {} } }`
HTTP Statusを正しく使用する。

## 41. Idempotency

予約作成 / 決済 / 返金 / 外部予約 / Webhook / 注文作成 は Idempotency 対応必須。Header: `Idempotency-Key`。

## 42. Domain Event

重要処理はEventとして発行: CustomerCreated / ReservationCreated / ReservationConfirmed / ReservationCancelled / VisitCompleted / KarteCreated / PaymentCompleted / ReviewCreated / CustomerInactiveDetected。

## 43. Queue

Background Worker対象: LINE送信 / Email / SMS / 画像処理 / 外部予約同期 / Google同期 / レポート生成 / CSV生成 / LTV再計算 / EC処理。

## 44. キャッシュ

Redis等。対象: Availability / Session / Rate Limit / Short-lived Report。ただし予約確定はキャッシュ値だけで判断しない。

## 45. セキュリティ

通信: TLS 1.2以上。保存: 機密個人情報を暗号化。秘密情報: KMS / Secret Managerを利用。

## 46. 顧客情報暗号化

対象: 氏名 / 電話番号 / メール / 住所 / カルテ機密情報。必要に応じApplication Level Encryptionを採用。

## 47. Password

Argon2idまたはbcrypt。平文保存禁止。

## 48. Token

LINE / Google / Square 等のOAuth Tokenは暗号化保存。ログ出力禁止。

## 49. Audit Log

保存項目: actor_user_id / organization_id / action / resource_type / resource_id / before / after / ip / created_at。
対象: 顧客削除 / カルテ変更 / 売上修正 / 返金 / 権限変更 / 顧客統合 / CSV出力。

## 50. 個人情報削除

顧客削除要求への対応機能を用意。法令上保存義務のある会計情報との整合性を考慮し、必要な場合は個人情報を匿名化し会計データを維持する。

## 51. アカウント削除

Userから削除申請可能。Organization Ownerの場合は契約 / スタッフ / 会計 / データ所有権 を確認したうえで処理する。

## 52. Backup

Database: 自動バックアップ + Point In Time Recovery推奨。Object Storage: Versioning推奨。

## 53. Monitoring

API Error Rate / API Latency / DB Connections / Queue Backlog / Webhook Failure / External Sync Failure / Payment Failure / LINE Failure を監視。

## 54. Logging

Structured JSON Logging。PIIをログへ直接出力しない。

## 55. Rate Limit

Login / Public Booking / Review / Webhook / API に設定。

## 56. Webhook Security

署名検証 / Timestamp検証 / Replay Attack対策。同一event_idは再処理しない。

## 57. ファイルアップロード

許可: JPEG / PNG / WEBP / PDF。最大容量設定。MIME type検証。ファイル名を信用しない。

## 58. パフォーマンス

通常API: P95 500ms以下目標。Customer Search: P95 1秒以下。Booking Availability: P95 1秒以下。

## 59. 可用性

月間99.9%以上。決済・予約関連を最優先。

## 60. 時刻

DB: UTC。UI: 店舗Timezone。日本展開のみでも内部UTC推奨。

## 61. 金額

float使用禁止。integerで最小通貨単位を保持（日本円: 1000 = ¥1,000）。

## 62. 削除ポリシー

売上 / 決済 / ポイント / 回数券 は物理DELETEを極力行わない。取消レコードを追加するLedger型を採用。

## 63. 予約状態遷移

REQUESTED → CONFIRMED → CHECKED_IN → IN_SERVICE → COMPLETED。
別ルート: REQUESTED→CANCELLED、CONFIRMED→CANCELLED、CONFIRMED→NO_SHOW。
COMPLETEDからCANCELLEDへの変更は禁止。

## 64. 決済状態遷移

PENDING → AUTHORIZED → CAPTURED（または PENDING → CAPTURED）。CAPTURED → PARTIALLY_REFUNDED → REFUNDED。

## 65. 予約同期優先ルール

内部ReservationをSingle Source of Truthとする。外部サービスが予約作成元の場合は external_booking_id を保持。競合時は自動上書きせず SYNC_CONFLICT として管理画面に表示。

## 66. 顧客統合ルール

電話番号一致だけで自動統合しない。LINE user ID完全一致のみ高確度候補。最終的な統合はスタッフ操作を基本とする。

## 67. LINE送信障害

LINE送信失敗によって予約そのものをRollbackしない。予約=成功、通知=FAILED として分離。

## 68. 決済障害

Payment API Timeout時に即座に失敗扱いして再課金してはいけない。ProviderへPayment Statusを問い合わせて確定する。

## 69. 外部予約障害

Provider障害時でも自システムは利用可能とする。UI: 「○○との同期に遅延が発生しています」表示。

## 70. Web管理画面

最低限: Dashboard / Calendar / Customers / Customer Detail / Karte / POS / Sales / Reports / Staff / Menus / Reviews / Messages / Campaigns / EC / Settings / Integrations。

## 71. Dashboard

今日の予約 / 本日の売上 / 今月売上 / 新規顧客 / 再来顧客 / キャンセル / 失客候補 / 外部連携エラー。

## 72. Customer Detail画面

1画面で 基本情報 / 予約履歴 / カルテ / 写真 / 売上 / メッセージ / ポイント / 回数券 / レビュー / LTV を閲覧できる。これはUX上非常に重要。

## 73. モバイルUI

主要Navigation: Home / Calendar / Customers / Messages / More。スタッフが片手で操作可能なUIを優先。

## 74. 顧客向けUI

ログイン強制を極力避ける。予約導線: URL → メニュー → 日時 → 情報 → 予約。入力項目を最小化。

## 75. システム管理画面

運営会社向け: Organizations / Subscriptions / Users / Integration Errors / System Logs / Support / Feature Flags。

## 76. Feature Flag

新機能を段階リリース可能にする。例: NEW_POS / NEW_BOOKING_UI / AI_RECOMMENDATION。

## 77. テスト

Unit Test（Domain Logic中心）、Integration Test（Database / Queue / External Adapter）、E2E必須シナリオ: 新規顧客予約 / LINE予約 / 予約変更 / カルテ作成 / 会計 / カード決済 / レビュー / 再予約。

## 78. 予約競合テスト

同一スタッフ・同一時間に100並列リクエストを送っても予約確定は許容数を超えないこと。

## 79. Payment Test

同一Idempotency Keyで複数リクエストしても二重課金されない。

## 80. 権限テスト

Shop A StaffがShop Bの許可されていないCustomerへアクセスできないこと。

## 81. セキュリティテスト

OWASP Top 10を基本基準とする: SQL Injection / XSS / CSRF / Broken Access Control / SSRF / File Upload Attack / Brute Force。

## 82. MVP開発範囲（Phase 1）

認証 / 店舗 / スタッフ / 顧客 / カルテ / メニュー / 予約 / Web予約 / 基本LINE / POS / 基本レポート。

## 83. Phase 2

LINE CRM / 決済 / Square / レビュー / プロフィール / ポイント / クーポン / 回数券。

## 84. Phase 3

外部予約サイト / Google / Instagram / 多店舗 / LTV / EC。

## 85. Phase 4

高度CRM / Marketing Automation / 顧客セグメント / レコメンド / 失客予測 / 高度分析。

## 86. 将来的AI機能用設計

初期実装にAIを必須としない。ただしCustomer Timelineを正規化しておく。
AIが利用するデータ: Customer / Reservation / Visit / Karte / Transaction / Message / Review / Product。
将来的機能: AIカルテ要約 / AIカルテ音声入力 / AI次回メニュー提案 / AI来店日予測 / AI失客予測 / AIメッセージ生成 / AI売上分析 / AIスタッフ分析 / AI予約コンシェルジュ。

## 87. 重要な設計原則

「予約テーブル」「POSテーブル」「カルテテーブル」を独立した別サービスとして考えない。中心は常に **Customer** である。
Customer Timelineとして 予約 / 来店 / カルテ / 購入 / レビュー / LINE / 商品購入 / 再来店 を時系列で閲覧できるようにする。

## 88. Customer Timeline

timeline_event: CUSTOMER_CREATED / RESERVATION_CREATED / VISIT / KARTE / PAYMENT / MESSAGE / REVIEW / EC_ORDER / TICKET_PURCHASE / TICKET_USE を統一表示する。

## 89. 最重要KPI

店舗Dashboardでは最低限 Sales / Customer Count / Average Spend / Repeat Rate / Visit Frequency / LTV / Next Booking Rate / Cancellation Rate / No Show Rate を表示。

## 90. 非機能要件まとめ

レスポンシブ / スマホ最優先 / HTTPS必須 / Multi Tenant / RBAC / Audit Log / Encryption / Backup / Monitoring / Queue / Retry / Idempotency / API Versioning / Rate Limit / Feature Flag を初期設計から組み込む。

## 91. 開発禁止事項

1. 顧客・予約・売上を別々の非連携データとして管理する
2. organization_idをFrontendから受け取った値だけで信用する
3. 金額をfloatで保存する
4. 決済APIをRetryするだけの実装
5. 外部Webhookを冪等処理しない
6. 予約確定をAvailability Cacheだけで判定する
7. OAuth Tokenを平文保存する
8. 顧客PIIをApplication Logへそのまま出す
9. 売上をDELETEで取消する
10. 外部予約サイトの予約をexternal_booking_id無しで保存する

## 92. Done Definition

各機能は以下を満たして初めて「完成」とする:
UI完成 / API完成 / DB Migration完成 / 権限チェック完成 / Validation完成 / Error Handling完成 / Audit Log完成 / Unit Test完成 / Integration Test完成 / Loading状態完成 / Empty状態完成 / Error状態完成 / Mobile確認完成 / Logging完成 / Monitoring対象確認完成。

## 93. 最終的なサービス構造

Acquisition Layer（Google / Instagram / SNS / 公開プロフィール）
→ Booking Layer（Web予約 / LINE予約 / 外部予約サイト）
→ Customer Layer（Customer CRM）
→ Service Layer（Reservation / Karte / Counseling）
→ Commerce Layer（POS / Payment / Point / Ticket / EC）
→ Retention Layer（LINE / Messaging / CRM / Review / Next Booking）
→ Analytics Layer（Sales / Repeat / LTV / Customer Segment）
→ Management Layer（Staff / Shop / Multi Shop / Permissions）

## 94. 最重要ユーザーフロー

**【新規顧客】** Instagram/Google/LINE → 予約ページ → スタッフ・メニュー選択 → 空き時間選択 → 予約 → Customer生成 → LINE紐付け → Reservation生成 → 予約通知
**【来店】** Check In → カルテ確認 → 施術 → カルテ更新 → Before/After写真 → POS
**【会計】** Reservation → Transaction → Payment → Visit Completed → LTV更新
**【来店後】** お礼LINE → カルテ/写真共有 → レビュー依頼 → Review → Google/SNS
**【再来店】** 来店周期計算 → 顧客セグメント → LINE自動配信 → 予約日提案 → 再予約

この循環をシステムの中心とする。

## 95. 開発時の最優先順位

- **Priority S**: Customer / Reservation / Availability / Karte / Staff / Shop / Auth / Multi Tenant Security
- **Priority A**: LINE / POS / Payment / Reporting
- **Priority B**: External Booking / Review / Google / CRM Automation
- **Priority C**: EC / Advanced LTV / AI

## 96. 実装開始時に最初に作るもの

開発者はUIから作り始めないこと。以下の順で開始する:
1. Domain Model → 2. Database Schema → 3. Authentication → 4. Multi Tenant / Permission → 5. Customer → 6. Staff / Shop → 7. Menu → 8. Reservation / Availability Engine → 9. Karte → 10. POS → 11. Messaging → 12. External Integration → 13. UI

特にReservationとCustomerのデータモデルを途中で大幅変更すると全モジュールへ影響するため、初期設計を最重要とする。

## 97. 最終ゴール

店舗スタッフが顧客について「誰なのか」「いつ来るのか」「過去何をしたか」「何を購入したか」「いくら売上があるか」「いつ次回来店しそうか」「どんなメッセージを送ったか」「どんなレビューをしたか」を **Customer Detail一画面から確認できること**。

顧客側は、アプリを覚えたり複雑な会員登録をすることなく LINE / Instagram / Google / Web から、予約 / 通知 / カルテ確認 / 商品購入 / 再予約 まで完結できること。

これを本プロジェクトの最終完成条件とする。
