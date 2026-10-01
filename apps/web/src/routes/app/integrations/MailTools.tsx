import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  MAIL_KIND_LABEL,
  MATCH_VIA_LABEL,
  OUTCOME_LABEL,
  integrationKeys,
  integrationsApi,
  useManualBlocks,
  type CsvImportResult,
  type Integration,
  type MailParseResult,
  type ManualBlock,
} from '../../../api/integrations';
import { copyText } from '../../../components/QrCode';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineLoading,
  Input,
  KeyValue,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  Textarea,
  useToast,
  type Tone,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime, formatTime, formatYen } from '../../../lib/format';

/**
 * Hot Pepper Beauty (SALON BOARD) / LiME e-mail connectors.
 * Neither medium offers a public booking API, so:
 *   inbound  = booking-notification mails forwarded to a per-account webhook (near real time)
 *   outbound = "stop this slot on the medium" tasks for staff (+ e-mail notice)
 *   backfill = CSV import of existing bookings
 */

const MEDIUM: Record<string, { name: string; mailFrom: string; adminScreen: string }> = {
  hotpepper_mail: {
    name: 'ホットペッパービューティー',
    mailFrom: 'SALON BOARD からの「予約連絡」「予約変更連絡」「予約キャンセル連絡」メール',
    adminScreen: 'SALON BOARD のスケジュール画面で該当スタッフの枠を「受付停止（予定ブロック）」に',
  },
  lime_mail: {
    name: 'LiME',
    mailFrom: 'LiME からの予約受付・変更・キャンセルの通知メール',
    adminScreen: 'LiME の予約台帳で該当スタッフの枠を「予定（受付不可）」に',
  },
};

export function mediumName(provider: string) {
  return MEDIUM[provider]?.name ?? provider;
}

export function InboundUrl({ integration }: { integration: Integration }) {
  const toast = useToast();
  const url = integration.inboundEmail?.webhookUrl;
  if (!url) return null;
  return (
    <div className="rounded-xl bg-surface-2 p-3 text-[13px]">
      <p className="text-xs text-muted">
        受信用Webhook URL（第三者に知られないよう管理してください）
      </p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-xs">{url}</code>
        <IconButton
          icon="copy"
          label="受信用URLをコピー"
          size="sm"
          onClick={() =>
            void copyText(url).then((ok) =>
              ok ? toast.success('コピーしました') : toast.error('コピーできませんでした'),
            )
          }
        />
      </div>
    </div>
  );
}

/** 設定手順: how to get the medium's notification mails into the inbound webhook */
export function MailSetupGuide({ integration }: { integration: Integration }) {
  const m = MEDIUM[integration.provider] ?? MEDIUM.hotpepper_mail!;
  return (
    <div className="space-y-3 text-[13px]">
      <InboundUrl integration={integration} />
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          メール受信サービス（SendGrid Inbound Parse / Mailgun Routes / Postmark Inbound /
          Cloudflare Email Routing など）で受信専用アドレス （例:{' '}
          <code className="text-xs">hpb@in.your-salon.jp</code>）を作り、転送先（Webhook）に上の URL
          を登録します。 JSON・フォーム・multipart のどの形式でも受け付けます。
        </li>
        <li>
          {m.mailFrom}を、そのアドレスへ自動転送します。{m.name}
          側の通知先に追加するか、普段受け取っているメールアドレス（Gmail
          など）の自動転送フィルタを使ってください。
        </li>
        <li>
          届いた通知メールを「解析テスト」に貼り付け、日時・スタッフ・メニューが正しく読み取れるか確認します。読み取れない名前は対応表か既定メニューで補えます。
        </li>
        <li>
          自社の予約（Web・LINE・電話・他媒体）が入ると「媒体の枠止め」に依頼が表示され、通知メールも届きます。
          {m.adminScreen}
          して「対応済み」を押してください。
        </li>
        <li>
          連携開始前からある予約は、媒体の予約一覧をCSVで書き出して「CSV取り込み」から一括登録できます。
        </li>
      </ol>
      <Alert tone="info" title="この連携でできること・できないこと">
        通知メールの到着後、数秒〜数十秒で予約台帳へ反映されます（新規・変更・キャンセル）。{m.name}
        は外部から予約枠を書き換える公開APIを提供していないため、自社予約による枠止めはスタッフの操作が必要です（ログイン情報を預かる自動操作は行いません）。
      </Alert>
    </div>
  );
}

export function MailSetupDialog({
  integration,
  onClose,
}: {
  integration: Integration | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!integration}
      onClose={onClose}
      size="lg"
      title="メール連携の設定手順"
      description={integration?.display_name}
      footer={
        <Button variant="primary" onClick={onClose}>
          閉じる
        </Button>
      }
    >
      {integration ? <MailSetupGuide integration={integration} /> : null}
    </Dialog>
  );
}

const VIA_TONE: Record<string, Tone> = {
  map: 'success',
  auto: 'info',
  default: 'warning',
  none: 'danger',
};

export function ParseTestDialog({
  integration,
  onClose,
}: {
  integration: Integration | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const run = useMutation({
    mutationFn: () => integrationsApi.parseTest(integration!.id, { subject, text }),
    onError: (e) => toast.error(e),
  });
  const r: MailParseResult | undefined = run.data;
  const close = () => {
    run.reset();
    setSubject('');
    setText('');
    onClose();
  };
  return (
    <Dialog
      open={!!integration}
      onClose={close}
      size="xl"
      title="予約通知メールの解析テスト"
      description="届いたメールの件名と本文を貼り付けると、取り込まれる内容を確認できます（予約は作成されません）。"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            閉じる
          </Button>
          <Button
            variant="primary"
            loading={run.isPending}
            disabled={!subject.trim() && !text.trim()}
            onClick={() => run.mutate()}
          >
            解析する
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="件名">
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="例: 【SALON BOARD】予約連絡"
              maxLength={500}
            />
          </Field>
          <Field label="本文">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={16}
              className="font-mono text-xs"
              placeholder={'■予約番号\nBE12345678\n■来店日時\n2026年10月7日（水）14:00\n…'}
              spellCheck={false}
            />
          </Field>
        </div>
        <div className="min-w-0 space-y-3" aria-live="polite">
          {!r ? <EmptyState icon="mail" title="解析結果がここに表示されます" /> : null}
          {r ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    r.kind === 'unknown'
                      ? 'neutral'
                      : r.kind === 'cancelled'
                        ? 'warning'
                        : 'primary'
                  }
                >
                  {MAIL_KIND_LABEL[r.kind]}
                </Badge>
                <Badge tone={r.ready ? 'success' : 'danger'} dot>
                  {r.ready ? 'このまま取り込めます' : '取り込みに設定が必要です'}
                </Badge>
              </div>
              <KeyValue
                items={[
                  { label: '予約番号', value: r.externalId },
                  {
                    label: '日時',
                    value:
                      r.start && r.end
                        ? `${formatDateTime(r.start, tz)}〜${formatTime(r.end, tz)}`
                        : '—',
                  },
                  {
                    label: 'お客様',
                    value:
                      [r.customer.name, r.customer.kana && `（${r.customer.kana}）`]
                        .filter(Boolean)
                        .join('') || '—',
                  },
                  {
                    label: '連絡先',
                    value: [r.customer.phone, r.customer.email].filter(Boolean).join(' / ') || '—',
                  },
                  {
                    label: 'スタッフ',
                    value: r.staff.name ? (
                      <span>
                        {r.staff.name} → {r.staff.staffName ?? '未対応'}{' '}
                        <Badge tone={VIA_TONE[r.staff.via ?? 'none'] ?? 'neutral'}>
                          {MATCH_VIA_LABEL[r.staff.via ?? 'none']}
                        </Badge>
                      </span>
                    ) : (
                      '指名なし（空いているスタッフを自動割当）'
                    ),
                  },
                  {
                    label: 'メニュー',
                    value: r.menus.length ? (
                      <ul className="space-y-0.5">
                        {r.menus.map((m) => (
                          <li key={m.name}>
                            {m.name} → {m.menuName ?? '未対応'}{' '}
                            <Badge tone={VIA_TONE[m.via ?? 'none'] ?? 'neutral'}>
                              {MATCH_VIA_LABEL[m.via ?? 'none']}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      '—'
                    ),
                  },
                  { label: '金額', value: r.amount != null ? formatYen(r.amount) : '—' },
                  { label: '備考', value: r.note ?? '—' },
                ]}
              />
              {r.warnings.length ? (
                <Alert tone="warning" title="確認が必要な点">
                  <ul className="list-disc pl-4">
                    {r.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

export function CsvImportDialog({
  integration,
  onClose,
}: {
  integration: Integration | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const preview = useMutation({
    mutationFn: () => integrationsApi.importCsv(integration!.id, { csv, dryRun: true }),
    onError: (e) => toast.error(e),
  });
  const commit = useMutation({
    mutationFn: () => integrationsApi.importCsv(integration!.id, { csv, dryRun: false }, key),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
      void qc.invalidateQueries({ queryKey: ['appointments'] });
      toast.success('CSVを取り込みました', summaryText(r));
    },
    onError: (e) => toast.error(e),
  });
  const result: CsvImportResult | undefined = commit.data ?? preview.data;
  const close = () => {
    preview.reset();
    commit.reset();
    setCsv('');
    setFileName(null);
    setKey(newIdempotencyKey());
    onClose();
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const buf = await file.arrayBuffer();
    // exports from Japanese admin screens are often Shift_JIS
    let content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (content.includes('�')) content = new TextDecoder('shift_jis').decode(buf);
    setCsv(content);
    setFileName(file.name);
    preview.reset();
    commit.reset();
  };
  const unresolved = (preview.data?.results ?? []).filter(
    (r) => r.status !== 'error' && r.status !== 'cancelled' && r.menus.some((m) => !m.menuId),
  ).length;
  return (
    <Dialog
      open={!!integration}
      onClose={close}
      size="xl"
      title="既存予約のCSV取り込み"
      description="媒体の予約一覧をCSVで書き出して取り込みます。まず確認（ドライラン）してから本取り込みします。"
      dismissable={!commit.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={commit.isPending}>
            閉じる
          </Button>
          <Button
            loading={preview.isPending}
            disabled={!csv.trim() || commit.isPending}
            onClick={() => preview.mutate()}
          >
            内容を確認
          </Button>
          <Button
            variant="primary"
            loading={commit.isPending}
            disabled={!preview.data || !!commit.data}
            onClick={() => commit.mutate()}
          >
            取り込む
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 text-[13px] hover:bg-surface-2">
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            CSVファイルを選択
          </label>
          <span className="text-xs text-muted">{fileName ?? 'または下に貼り付け'}</span>
        </div>
        <Textarea
          aria-label="CSVの内容"
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            preview.reset();
            commit.reset();
          }}
          rows={5}
          className="font-mono text-xs"
          spellCheck={false}
          placeholder={
            '予約番号,来店日時,所要時間,お客様名,電話番号,スタッフ,メニュー,ステータス\nBE0001,2026/10/07 14:00,90,山田 花子,09012345678,佐藤,カット|カラー,予約'
          }
        />
        <p className="text-xs text-muted">
          必須列: 「来店日時」（または「来店日」+「開始時刻」）と「メニュー」。任意:
          予約番号・終了時刻・所要時間・お客様名・フリガナ・電話番号・メール・スタッフ・金額・備考・ステータス（キャンセルを含む行は取消として扱います）。最大2,000行。
        </p>
        {result ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={result.dryRun ? 'info' : 'success'}>
                {result.dryRun ? '確認結果（まだ取り込まれていません）' : '取り込み完了'}
              </Badge>
              <span>{summaryText(result)}</span>
            </div>
            {result.dryRun && unresolved ? (
              <Alert tone="warning">
                メニューを特定できない行が {unresolved}{' '}
                件あります。このまま取り込むと「競合キュー」に入ります。メニュー対応表か既定メニューを設定すると自動で登録されます。
              </Alert>
            ) : null}
            <div className="max-h-80 overflow-auto rounded-xl border border-border">
              <Table>
                <THead>
                  <Tr>
                    <Th>行</Th>
                    <Th>日時</Th>
                    <Th>お客様</Th>
                    <Th>スタッフ</Th>
                    <Th>メニュー</Th>
                    <Th>結果</Th>
                  </Tr>
                </THead>
                <TBody>
                  {result.results.map((r) => (
                    <Tr key={r.row}>
                      <Td className="tabular">{r.row}</Td>
                      <Td className="whitespace-nowrap">
                        {r.start ? formatDateTime(r.start, tz) : '—'}
                      </Td>
                      <Td>{r.customerName ?? '—'}</Td>
                      <Td>
                        {r.staff?.name
                          ? `${r.staff.name}${r.staff.staffName ? ` → ${r.staff.staffName}` : '（未対応）'}`
                          : '指名なし'}
                      </Td>
                      <Td>
                        {r.menus.map((m) => (
                          <span key={m.name} className={m.menuId ? '' : 'text-danger'}>
                            {m.menuName ?? `${m.name}（未対応）`}
                            <br />
                          </span>
                        ))}
                      </Td>
                      <Td>
                        {r.error ? (
                          <span className="text-danger">{r.error}</span>
                        ) : (
                          <>
                            {r.status === 'cancelled' ? <Badge tone="warning">取消</Badge> : null}{' '}
                            {OUTCOME_LABEL[r.outcome ?? 'preview'] ?? r.outcome}
                          </>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function summaryText(r: CsvImportResult) {
  return (
    `${r.total}件: ` +
    Object.entries(r.summary)
      .map(([k, v]) => `${OUTCOME_LABEL[k] ?? k} ${v}`)
      .join(' ・ ')
  );
}

const BLOCK_STATE: Record<string, { label: string; tone: Tone }> = {
  action_required: { label: '枠を止める', tone: 'danger' },
  remove_required: { label: '枠を再開する', tone: 'warning' },
  pushed: { label: '停止済み', tone: 'success' },
  removed: { label: '再開済み', tone: 'neutral' },
};

/** 媒体の枠止め依頼: slots staff must block / reopen by hand on Hot Pepper / LiME */
export function ManualBlockList({
  shopId,
  compact = false,
}: {
  shopId?: string;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone: tz, can } = useAuth();
  const [showAll, setShowAll] = useState(false);
  const q = useManualBlocks({ shopId, state: showAll ? 'all' : 'open' }, can('appointment.read'));
  const done = useMutation({
    mutationFn: (b: ManualBlock) => integrationsApi.completeManualBlock(b.id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: integrationKeys.all });
      toast.success(
        r.state === 'pushed' ? '枠止めを対応済みにしました' : '枠の再開を対応済みにしました',
      );
    },
    onError: (e) => toast.error(e),
  });
  const items = q.data ?? [];
  if (compact && !items.length) return null;
  return (
    <div className="space-y-3">
      {!compact ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            ホットペッパー・LiME
            には外部から枠を止める公開APIがないため、他の経路で入った予約の時間を各媒体の管理画面で止めてください。
          </p>
          <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '未対応のみ表示' : '対応済みも表示'}
          </Button>
        </div>
      ) : null}
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !items.length ? (
        <EmptyState
          icon="check"
          title="対応が必要な枠はありません"
          description="自社の予約が入ると、媒体側で止める枠がここに表示されます。"
        />
      ) : null}
      <ul className="space-y-2">
        {items.slice(0, compact ? 5 : undefined).map((b) => {
          const st = BLOCK_STATE[b.state] ?? { label: b.state, tone: 'neutral' as Tone };
          const open = b.state === 'action_required' || b.state === 'remove_required';
          return (
            <li
              key={b.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border p-3 text-[13px]"
            >
              <Badge tone={st.tone} dot>
                {st.label}
              </Badge>
              <span className="font-medium">{mediumName(b.provider)}</span>
              <span className="tabular">
                {formatDateTime(b.block_start_at, tz)}〜{formatTime(b.block_end_at, tz)}
              </span>
              <span className="text-muted">{b.staff_name ?? 'スタッフ未定'}</span>
              {!compact && b.customer_name ? (
                <span className="text-xs text-subtle">（{b.customer_name} 様）</span>
              ) : null}
              <span className="flex-1" />
              {open ? (
                <Button
                  size="xs"
                  variant="primary"
                  icon="check"
                  loading={done.isPending && done.variables?.id === b.id}
                  onClick={() => done.mutate(b)}
                >
                  対応済み
                </Button>
              ) : b.done_at ? (
                <span className="text-xs text-subtle">{formatDateTime(b.done_at, tz)} 対応</span>
              ) : null}
              {!compact && b.message ? (
                <p className="w-full text-xs text-muted">{b.message}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** ダッシュボード用: only rendered while some slot still has to be stopped / reopened on a medium */
export function ManualBlocksCard({ shopId }: { shopId?: string }) {
  const { can } = useAuth();
  const q = useManualBlocks({ shopId, state: 'open' }, can('appointment.read'));
  const n = q.data?.length ?? 0;
  if (!n) return null;
  return (
    <Alert tone="warning" title={`ホットペッパー・LiME で止める（再開する）枠が ${n} 件あります`}>
      <p className="mb-2 text-xs">
        他の経路で入った予約です。各媒体の管理画面で操作してから「対応済み」を押してください。
      </p>
      <ManualBlockList shopId={shopId} compact />
    </Alert>
  );
}
