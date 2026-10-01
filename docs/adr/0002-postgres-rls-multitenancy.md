# ADR 0002: PostgreSQL 共有スキーマ + RLS によるマルチテナント分離

- 状態: 承認（Accepted）
- 日付: 2026-10-01
- 関連: requirements.md 2.1 / 2.4 / 10.6、architecture.md 4章、`db/tenant.ts`、`0090_row_level_security.sql`

## Context（背景）

- 個人美容師から多店舗法人まで同一基盤で運用するマルチテナント SaaS（要件 0.1）。想定は数千法人規模。
- 要件 2.1 は「すべての主要テーブルに organization_id を持たせ、テナント境界を強制する」。
- 顧客の個人情報・要配慮情報（カウンセリング）を扱い、テナント間漏えいは致命的。アプリの WHERE 句の付け忘れという典型的なバグに対して多層防御が必要。
- 法人横断の処理（ログイン時の所属解決、公開予約のスラッグ解決、Webhook の振り分け、ジョブ取得）も存在する。

## Decision（決定）

1. **共有データベース・共有スキーマ** とし、全業務テーブルに `organization_id` を持たせる。
2. `0090_row_level_security.sql` で `organization_id` 列を持つ全テーブルに `ENABLE` + **`FORCE ROW LEVEL SECURITY`** とポリシー `USING / WITH CHECK (app_bypass_rls() OR organization_id = app_current_org())` を適用する。システム既定行を持つ `roles` / `role_permissions` / `feature_flags` は NULL 行の読取を許可、`organizations` は `id = app_current_org()`。
3. テナントコンテキストはトランザクションローカルの GUC で渡す: `withTenant(orgId)` が `set_config('app.organization_id', orgId, true)`（あわせて `app.user_id` / `app.trace_id`）を設定する。リクエストは `req.tx()`、ジョブは `jc.tx()`、公開 API は `publicTx()` を使う。
4. 法人横断が必要な処理だけ `withSystem()`（`app.bypass_rls = on`）を使う。用途は認証・公開スラッグ解決・署名付きトークン解決・Webhook ルーティング・ジョブ取得/終了・スケジューラ・マイグレーションに限定し、リクエストハンドラから直接使わない。
5. RLS は最後の防御線であり、アプリ層の認可（`requirePermission` / `assertShopAccess` / `assertCustomerAccess`）を置き換えない。
6. 新しいテーブルは追加マイグレーション内で同形式のポリシーを作成する（0090 は作成時点のテーブルにのみ適用）。

## Consequences（結果）

**良い点**
- アプリのクエリで `organization_id` 条件を忘れても他テナントの行は返らない／書けない（`WITH CHECK`）。テストでも RLS を有効にしたまま実行できる。
- 単一スキーマのためマイグレーションは1回で全テナントに適用され、集計・運用が容易。
- GUC はトランザクションローカルのため、コネクションプール（PgBouncer transaction mode を含む）でテナントが混ざらない。

**悪い点・リスク**
- `app.bypass_rls` は GUC であり、アプリと同じ DB ロールで任意 SQL を実行できれば設定可能。RLS は SQL インジェクションへの防御にはならない → パラメータ化の徹底、`withSystem` 使用箇所のレビュー必須化。
- 本番では DB ロール分離が必要: マイグレーション用（所有者・DDL）とアプリ用（DML のみ、`NOBYPASSRLS`、`TRUNCATE`/`ALTER` なし）。将来はシステム処理を `SECURITY DEFINER` 関数に寄せ、バイパス GUC を廃止する選択肢を検討する。
- すべてのクエリにポリシー条件が付くため、`organization_id` を含むインデックス設計が性能上重要。
- ノイジーネイバー（大規模法人の負荷）は同一 DB に影響する → 分析のレプリカ化・ジョブキュー分離で緩和。

## Alternatives（検討した代替案）

| 案 | 不採用理由 |
|---|---|
| テナントごとのデータベース | 数千 DB のマイグレーション・接続管理・横断運用が困難。小規模テナントにコスト過大 |
| テナントごとのスキーマ | スキーマ数増大でマイグレーション・カタログ肥大化、接続ごとの search_path 管理が必要 |
| アプリ層の WHERE 句のみ | 1か所の付け忘れで漏えいする。多層防御にならない |
| RLS + セッション変数（`SET` 非ローカル） | プール接続でテナントが残留する危険。トランザクションローカル（`set_config(..., true)`）を採用 |
