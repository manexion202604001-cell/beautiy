import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMenus } from '../../../api/catalog';
import {
  KIND_LABEL,
  OUTCOME_LABEL,
  migrationApi,
  migrationKeys,
  useImportJob,
  useImportJobs,
  type ImportJob,
  type ImportKind,
  type ImportOptions,
  type Mapping,
  type PreviewResult,
  type PreviewRow,
} from '../../../api/migration';
import { Forbidden } from '../../../components/Forbidden';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  PageHeader,
  Segmented,
  Select,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useToast,
  type Tone,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { decodeTextFile } from '../../../lib/decode';
import { useAuth } from '../../../lib/auth';
import { formatDateTime, formatNumber, formatYen } from '../../../lib/format';

const KIND_HELP: Record<ImportKind, { step: string; text: string }> = {
  customers: {
    step: '①',
    text: '顧客台帳（氏名・連絡先・誕生日・来店回数・累計売上・担当・メモ）。最初に取り込みます。',
  },
  visits: {
    step: '②',
    text: '過去の来店・会計・カルテの記録。顧客番号（または氏名＋電話）で顧客に紐付けます。売上分析には含めません。',
  },
  reservations: {
    step: '③',
    text: '切り替え日以降の予約。お客様への確認メッセージは送りません。重なる予約は登録せず一覧に残します。',
  },
};

/** 旧システムからのデータ移行 */
export default function Migration() {
  const { can } = useAuth();
  const [kind, setKind] = useState<ImportKind>('customers');
  const [activeJob, setActiveJob] = useState<string | null>(null);
  if (!can('ops.manage')) return <Forbidden permission="ops.manage" />;
  return (
    <div className="space-y-5">
      <PageHeader
        title="データ移行"
        description="これまで使っていたシステムから書き出したCSVを取り込みます。取り込む前に内容と件数を確認でき、取り込み後も取り消せます。"
      />
      <Card>
        <ol className="grid gap-3 text-[13px] sm:grid-cols-3">
          {(Object.keys(KIND_HELP) as ImportKind[]).map((k) => (
            <li key={k} className="rounded-xl border border-border p-3">
              <p className="font-semibold">
                {KIND_HELP[k].step} {KIND_LABEL[k]}
              </p>
              <p className="mt-1 text-xs text-muted">{KIND_HELP[k].text}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted">
          同じファイルを何度取り込んでも重複しません（顧客番号・伝票番号・予約番号で判定）。まずは数十行の試しファイルで確認してから全件を取り込むと安心です。
        </p>
      </Card>
      {activeJob ? (
        <JobResult id={activeJob} onClose={() => setActiveJob(null)} />
      ) : (
        <>
          <Segmented
            label="取り込むデータ"
            value={kind}
            onChange={setKind}
            options={(Object.keys(KIND_LABEL) as ImportKind[]).map((k) => ({
              value: k,
              label: `${KIND_HELP[k].step} ${KIND_LABEL[k]}`,
            }))}
          />
          <ImportWizard key={kind} kind={kind} onStarted={setActiveJob} />
        </>
      )}
      <JobHistory onOpen={setActiveJob} />
    </div>
  );
}

async function readFile(file: File): Promise<string> {
  return decodeTextFile(await file.arrayBuffer());
}

function ImportWizard({ kind, onStarted }: { kind: ImportKind; onStarted: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops, currentShopId } = useAuth();
  const [shopId, setShopId] = useState(currentShopId ?? shops[0]?.id ?? '');
  const [sourceLabel, setSourceLabel] = useState('旧システム');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [options, setOptions] = useState<ImportOptions>(
    kind === 'customers'
      ? { onExisting: 'fill', defaultMarketingOptIn: false }
      : kind === 'visits'
        ? { createMissingCustomers: false }
        : { createMissingCustomers: true, sendReminders: false },
  );
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const menus = useMenus(kind === 'reservations' ? shopId : null);
  const fileRef = useRef<HTMLInputElement>(null);

  const request = useMemo(
    () => ({
      kind,
      csv,
      shopId,
      mapping: mapping ?? undefined,
      options,
      fileName: fileName ?? undefined,
      sourceLabel,
    }),
    [kind, csv, shopId, mapping, options, fileName, sourceLabel],
  );
  const preview = useMutation({
    mutationFn: () => migrationApi.preview(request),
    onError: (e) => toast.error(e),
  });
  const start = useMutation({
    mutationFn: () =>
      migrationApi.start({ ...request, mapping: mapping ?? preview.data?.mapping }, key),
    onSuccess: (job) => {
      void qc.invalidateQueries({ queryKey: migrationKeys.jobs });
      setConfirming(false);
      setKey(newIdempotencyKey());
      onStarted(job.id);
    },
    onError: (e) => toast.error(e),
  });

  // re-check whenever the file, the mapping or an option changes
  const previewMutate = preview.mutate;
  useEffect(() => {
    if (!csv.trim() || !shopId) return;
    const t = setTimeout(() => previewMutate(), 250);
    return () => clearTimeout(t);
  }, [csv, shopId, mapping, options, previewMutate]);

  const p = preview.data;
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setCsv(await readFile(f));
    setFileName(f.name);
    setMapping(null);
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="取り込み先の店舗" required>
            <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="移行元の名前" hint="カルテや履歴に「〇〇より移行」と表示されます">
            <Input
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              maxLength={50}
            />
          </Field>
          <Field label="CSVファイル" hint="Shift_JIS・UTF-8 どちらでも可（Excelは「CSV」で保存）">
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,.txt"
                className="sr-only"
                aria-label="CSVファイルを選択"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <Button icon="download" onClick={() => fileRef.current?.click()}>
                ファイルを選択
              </Button>
              <span className="min-w-0 truncate text-xs text-muted">{fileName ?? '未選択'}</span>
            </div>
          </Field>
        </div>
        <KindOptions
          kind={kind}
          options={options}
          onChange={setOptions}
          menus={(menus.data ?? []).map((m) => ({ id: m.id, name: m.name }))}
        />
      </Card>

      {preview.isPending && !p ? <InlineLoading label="内容を確認しています…" /> : null}
      {preview.error && !p ? (
        <ErrorState error={preview.error} onRetry={() => preview.mutate()} />
      ) : null}
      {p ? (
        <>
          <PreviewSummary p={p} kind={kind} />
          <MappingEditor p={p} onChange={(m) => setMapping(m)} />
          <ProblemList p={p} kind={kind} />
          <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-border bg-surface/95 p-3 shadow-card backdrop-blur">
            <p className="mr-auto text-[13px]">
              <span className="font-semibold">{formatNumber(p.counts.ready)}件</span>を取り込みます
              {p.counts.errors ? (
                <span className="text-danger">
                  （{formatNumber(p.counts.errors)}件は取り込めません）
                </span>
              ) : null}
            </p>
            {preview.isPending ? <InlineLoading label="再確認中…" /> : null}
            <Button
              variant="primary"
              disabled={!p.counts.ready || preview.isPending}
              onClick={() => setConfirming(true)}
            >
              取り込む
            </Button>
          </div>
        </>
      ) : !csv ? (
        <EmptyState
          icon="download"
          title="CSVファイルを選択してください"
          description="見出し行（1行目）から項目を自動で対応付けます。対応付けは後から変更できます。"
        />
      ) : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`${KIND_LABEL[kind]}を${formatNumber(p?.counts.ready ?? 0)}件取り込みますか？`}
        description={
          kind === 'reservations'
            ? 'お客様への確認メッセージは送りません。取り込み後に予約カレンダーで確認してください。旧システム側の予約は切り替えまで残しておいてください。'
            : '取り込み後も「取り消し」で元に戻せます（取り込み後に使われたデータは残ります）。'
        }
        confirmLabel="取り込む"
        loading={start.isPending}
        onConfirm={() => start.mutate()}
      />
    </div>
  );
}

function KindOptions({
  kind,
  options,
  onChange,
  menus,
}: {
  kind: ImportKind;
  options: ImportOptions;
  onChange: (o: ImportOptions) => void;
  menus: { id: string; name: string }[];
}) {
  const set = (patch: Partial<ImportOptions>) => onChange({ ...options, ...patch });
  if (kind === 'customers') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Switch
          checked={options.onExisting !== 'skip'}
          onChange={(v) => set({ onExisting: v ? 'fill' : 'skip' })}
          label="登録済みの顧客には空欄だけ補う"
          description="電話番号＋氏名・顧客番号で一致した顧客は、Salon OSで入力済みの項目を上書きせず、空欄だけ埋めます。オフにすると一致した顧客は変更しません。"
        />
        <Switch
          checked={!!options.defaultMarketingOptIn}
          onChange={(v) => set({ defaultMarketingOptIn: v })}
          label="DM可否の列がない顧客も配信対象にする"
          description="配信の同意が確認できない顧客は、既定では配信しない扱いにします（DM可否の列がある場合はその値を使います）。"
        />
      </div>
    );
  }
  if (kind === 'visits') {
    return (
      <Switch
        checked={!!options.createMissingCustomers}
        onChange={(v) => set({ createMissingCustomers: v })}
        label="見つからない顧客を新しく作成する"
        description="オフの場合、紐付く顧客が見つからない行は取り込まず一覧に残します（先に顧客を取り込むのがおすすめです）。"
      />
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Switch
        checked={options.createMissingCustomers !== false}
        onChange={(v) => set({ createMissingCustomers: v })}
        label="見つからない顧客を新しく作成する"
        description="予約を取りこぼさないよう既定でオンです。"
      />
      <Switch
        checked={!!options.sendReminders}
        onChange={(v) => set({ sendReminders: v })}
        label="移行した予約にもリマインドを送る"
        description="旧システムのリマインドを止めた場合だけオンにしてください（二重送信を防ぐため既定はオフ）。"
      />
      <Field
        label="メニューが見つからないとき"
        hint="名前が一致しないメニューをこのメニューとして登録します"
      >
        <Select
          value={options.defaultMenuId ?? ''}
          onChange={(e) => set({ defaultMenuId: e.target.value || undefined })}
        >
          <option value="">登録しない（一覧に残す）</option>
          {menus.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function PreviewSummary({ p, kind }: { p: PreviewResult; kind: ImportKind }) {
  const c = p.counts;
  const tiles: { label: string; value: string; tone?: Tone; sub?: string }[] = [
    { label: '行数', value: formatNumber(c.total) },
    { label: '取り込める', value: formatNumber(c.ready), tone: 'success' },
    { label: '取り込めない', value: formatNumber(c.errors), tone: c.errors ? 'danger' : undefined },
    {
      label: '注意あり',
      value: formatNumber(c.warnings),
      tone: c.warnings ? 'warning' : undefined,
      sub: '値を読めず空欄にした項目など',
    },
    {
      label: kind === 'customers' ? '登録済みの顧客と一致' : '顧客と紐付け',
      value: formatNumber(c.existing),
    },
    { label: '新しく作る顧客', value: formatNumber(c.newCustomers) },
  ];
  if (c.alreadyImported)
    tiles.push({
      label: '取り込み済み',
      value: formatNumber(c.alreadyImported),
      sub: '再取り込みでは重複しません',
    });
  if (c.duplicateInFile)
    tiles.push({
      label: 'ファイル内の重複',
      value: formatNumber(c.duplicateInFile),
      tone: 'warning',
    });
  if (kind !== 'reservations')
    tiles.push({
      label: kind === 'customers' ? '累計売上の合計' : '金額の合計',
      value: formatYen(p.amountTotal),
      sub: '旧システムの集計と照合してください',
    });
  return (
    <Card>
      <CardHeader
        title="確認結果"
        description="まだ何も登録されていません。件数と合計が旧システムと合っているか確認してください。"
      />
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted">{t.label}</p>
            <p
              className={`mt-0.5 text-lg font-semibold tabular ${t.tone === 'danger' ? 'text-danger' : t.tone === 'warning' ? 'text-warning' : t.tone === 'success' ? 'text-success' : ''}`}
            >
              {t.value}
            </p>
            {t.sub ? <p className="text-[11px] text-subtle">{t.sub}</p> : null}
          </div>
        ))}
      </div>
      {p.unknownStaff.length ? (
        <Alert tone="warning" className="mt-3" title="Salon OSに見つからないスタッフ名">
          {p.unknownStaff.map((s) => `${s.name}（${s.rows}件）`).join('、')}
          <span className="block text-xs">
            スタッフ画面で同じ名前のスタッフを登録すると自動で紐付きます。退職者は名前だけ記録されます
            {kind === 'reservations' ? '（予約は空いているスタッフに割り当てます）' : ''}。
          </span>
        </Alert>
      ) : null}
      {p.unknownMenus.length ? (
        <Alert tone="danger" className="mt-3" title="Salon OSに見つからないメニュー名">
          {p.unknownMenus.map((s) => `${s.name}（${s.rows}件）`).join('、')}
          <span className="block text-xs">
            メニュー画面で同じ名前のメニューを作るか、上の「メニューが見つからないとき」を選んでください。
          </span>
        </Alert>
      ) : null}
      {p.unmappedColumns.length ? (
        <p className="mt-3 text-xs text-muted">
          対応付けていない列: {p.unmappedColumns.join('、')}
          {kind === 'customers' ? '（顧客の「旧システムの項目」として保存され、失われません）' : ''}
        </p>
      ) : null}
    </Card>
  );
}

function MappingEditor({ p, onChange }: { p: PreviewResult; onChange: (m: Mapping) => void }) {
  const [open, setOpen] = useState(false);
  const firstRow = p.sample[0];
  const sampleOf = (cols: number[]) => {
    if (!firstRow) return '';
    // sample values come from the raw header order; show the column headings + the normalised value
    return cols.map((i) => p.header[i]).join(' + ');
  };
  const update = (key: string, cols: number[]) => {
    const next: Mapping = { ...p.mapping };
    if (cols.length) next[key] = cols;
    else delete next[key];
    onChange(next);
  };
  const mappedCount = Object.keys(p.mapping).length;
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardHeader
          title="項目の対応付け"
          description={`${mappedCount}項目を自動で対応付けました。違っていれば変更してください。`}
        />
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '閉じる' : '確認・変更する'}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 overflow-auto">
          <Table>
            <THead>
              <Tr>
                <Th>Salon OSの項目</Th>
                <Th>CSVの列</Th>
                <Th>1行目の値</Th>
              </Tr>
            </THead>
            <TBody>
              {p.fields.map((f) => {
                const cols = p.mapping[f.key] ?? [];
                const slots = f.multi ? [...cols, -1] : [cols[0] ?? -1];
                return (
                  <Tr key={f.key}>
                    <Td className="align-top">
                      <p className="font-medium">{f.label}</p>
                      {f.hint ? <p className="text-[11px] text-subtle">{f.hint}</p> : null}
                    </Td>
                    <Td className="align-top">
                      <div className="flex flex-col gap-1">
                        {slots.map((col, i) => (
                          <Select
                            key={i}
                            selectSize="sm"
                            aria-label={`${f.label} の列${f.multi ? ` ${i + 1}` : ''}`}
                            value={String(col)}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const next = slots.filter((x) => x >= 0);
                              if (f.multi) {
                                if (col >= 0) next.splice(i, 1, ...(v >= 0 ? [v] : []));
                                else if (v >= 0) next.push(v);
                                update(f.key, [...new Set(next)]);
                              } else update(f.key, v >= 0 ? [v] : []);
                            }}
                          >
                            <option value="-1">
                              {f.multi && col < 0 && i > 0 ? '＋列を追加' : '使わない'}
                            </option>
                            {p.header.map((h, idx) => (
                              <option key={idx} value={idx}>
                                {h || `（${idx + 1}列目）`}
                              </option>
                            ))}
                          </Select>
                        ))}
                      </div>
                    </Td>
                    <Td className="max-w-64 align-top text-xs text-muted">
                      <span className="break-all">
                        {firstRow?.values[f.key] ?? (cols.length ? sampleOf(cols) : '—')}
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </div>
      ) : null}
    </Card>
  );
}

function rowLabel(r: PreviewRow) {
  const v = r.values;
  const name = v.fullName ?? [v.lastName, v.firstName].filter(Boolean).join(' ');
  const when = v.datetime ?? [v.date, v.time].filter(Boolean).join(' ');
  return (
    [v.customerNumber, name, when, v.menu?.split('\n')[0]].filter(Boolean).join(' / ') || '（空）'
  );
}

function ProblemList({ p, kind }: { p: PreviewResult; kind: ImportKind }) {
  const [onlyErrors, setOnlyErrors] = useState(true);
  const rows = p.problems.filter((r) => (onlyErrors ? r.errors.length : true));
  if (!p.problems.length) {
    return (
      <Alert tone="success" title="問題のある行はありません">
        すべての行を取り込めます。
      </Alert>
    );
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardHeader
          title="確認が必要な行"
          description={
            kind === 'reservations'
              ? '取り込めない予約は、旧システムの内容を見て予約カレンダーに手動で登録してください。'
              : '取り込めない行は、取り込み後に「取り込めなかった行」をCSVで書き出して修正できます。'
          }
        />
        <Segmented
          size="sm"
          label="表示"
          value={onlyErrors ? 'errors' : 'all'}
          onChange={(v) => setOnlyErrors(v === 'errors')}
          options={[
            { value: 'errors', label: `取り込めない（${p.counts.errors}）` },
            { value: 'all', label: `注意も含む（${p.problems.length}）` },
          ]}
        />
      </div>
      <div className="mt-3 max-h-96 overflow-auto rounded-xl border border-border">
        <Table>
          <THead>
            <Tr>
              <Th>行</Th>
              <Th>内容</Th>
              <Th>理由</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.rowNo}>
                <Td className="tabular">{r.rowNo}</Td>
                <Td className="max-w-72 truncate">{rowLabel(r)}</Td>
                <Td>
                  {r.errors.map((e) => (
                    <p key={e} className="text-danger">
                      {e}
                    </p>
                  ))}
                  {r.warnings.map((w) => (
                    <p key={w} className="text-xs text-warning">
                      {w}
                    </p>
                  ))}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      {p.problems.length >= 500 ? (
        <p className="mt-2 text-xs text-muted">先頭500件を表示しています。</p>
      ) : null}
    </Card>
  );
}

const STATUS: Record<ImportJob['status'], { label: string; tone: Tone }> = {
  queued: { label: '待機中', tone: 'neutral' },
  running: { label: '取り込み中', tone: 'info' },
  completed: { label: '完了', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  undone: { label: '取り消し済み', tone: 'neutral' },
};

function JobResult({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const q = useImportJob(id);
  const [undoing, setUndoing] = useState(false);
  const undo = useMutation({
    mutationFn: () => migrationApi.undo(id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['migration'] });
      setUndoing(false);
      toast.success(
        '取り込みを取り消しました',
        `削除 ${r.removed}件・元に戻した顧客 ${r.restored}件${r.kept.length ? `・残したもの ${r.kept.length}件` : ''}`,
      );
    },
    onError: (e) => toast.error(e),
  });
  const j = q.data;
  if (q.isLoading) return <InlineLoading />;
  if (q.error || !j) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const busy = j.status === 'queued' || j.status === 'running';
  const pct = j.total_rows ? Math.round((j.processed_rows / j.total_rows) * 100) : 0;
  const t = j.totals ?? {};
  const amountMismatch =
    t.fileAmount !== undefined &&
    t.importedAmount !== undefined &&
    t.fileAmount !== t.importedAmount;
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold">
            {KIND_LABEL[j.kind]}の取り込み{' '}
            <Badge tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Badge>
          </p>
          <p className="text-xs text-muted">
            {j.file_name ?? 'CSV'} ・{j.source_label} ・{formatDateTime(j.created_at, tz)}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          新しく取り込む
        </Button>
      </div>
      {busy ? (
        <div>
          <div
            className="h-2 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="取り込みの進み具合"
          >
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">
            {formatNumber(j.processed_rows)} / {formatNumber(j.total_rows)}
            行（この画面を閉じても取り込みは続きます）
          </p>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(['created', 'updated', 'matched', 'skipped', 'error'] as const).map((k) => (
          <div key={k} className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted">{OUTCOME_LABEL[k]}</p>
            <p
              className={`mt-0.5 text-lg font-semibold tabular ${k === 'error' && j.summary[k] ? 'text-danger' : ''}`}
            >
              {formatNumber(j.summary[k] ?? 0)}
            </p>
          </div>
        ))}
      </div>
      {j.status === 'completed' && t.fileRows !== undefined ? (
        <Alert
          tone={amountMismatch || (j.summary.error ?? 0) > 0 ? 'warning' : 'success'}
          title="照合結果"
        >
          ファイル {formatNumber(t.fileRows)}行
          {t.fileAmount !== undefined ? ` ・金額合計 ${formatYen(t.fileAmount)}` : ''} → Salon OS{' '}
          {formatNumber(t.importedRows ?? 0)}件
          {t.importedAmount !== undefined ? ` ・金額合計 ${formatYen(t.importedAmount)}` : ''}
          {amountMismatch ? (
            <span className="block text-xs">
              金額の差は「取り込めず」の行の分です。下の一覧を確認してください。
            </span>
          ) : null}
        </Alert>
      ) : null}
      {j.problems?.length ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium">取り込めなかった行・注意</p>
            {j.summary.error ? (
              <Button
                size="sm"
                icon="download"
                onClick={() => void migrationApi.errorsCsv(id).catch((e) => toast.error(e))}
              >
                取り込めなかった行をCSVで書き出す
              </Button>
            ) : null}
          </div>
          <div className="max-h-80 overflow-auto rounded-xl border border-border">
            <Table>
              <THead>
                <Tr>
                  <Th>行</Th>
                  <Th>結果</Th>
                  <Th>内容</Th>
                </Tr>
              </THead>
              <TBody>
                {j.problems.map((r) => (
                  <Tr key={r.row_no}>
                    <Td className="tabular">{r.row_no}</Td>
                    <Td>
                      <Badge tone={r.outcome === 'error' ? 'danger' : 'neutral'}>
                        {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                      </Badge>
                    </Td>
                    <Td className={r.outcome === 'error' ? 'text-danger' : 'text-muted'}>
                      {r.message}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
      ) : null}
      {j.status === 'completed' || j.status === 'failed' ? (
        <div className="flex justify-end border-t border-border pt-3">
          <Button variant="ghost" icon="undo" onClick={() => setUndoing(true)}>
            この取り込みを取り消す
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={undoing}
        onClose={() => setUndoing(false)}
        title="この取り込みを取り消しますか？"
        description="この取り込みで登録した顧客・来店履歴・予約を削除し、補完した項目を元に戻します。取り込み後に予約・会計・カルテ・メモが追加された顧客や、変更・来店処理された予約は残します。"
        tone="danger"
        confirmLabel="取り消す"
        loading={undo.isPending}
        onConfirm={() => undo.mutate()}
      />
    </Card>
  );
}

function JobHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const { timezone: tz } = useAuth();
  const q = useImportJobs();
  if (!q.data?.length) return null;
  return (
    <Card padded={false}>
      <div className="p-5 pb-2">
        <CardHeader title="取り込み履歴" />
      </div>
      <ul className="divide-y divide-border">
        {q.data.map((j) => (
          <li key={j.id}>
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left text-[13px] hover:bg-surface-2"
              onClick={() => onOpen(j.id)}
            >
              <Badge tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Badge>
              <span className="font-medium">{KIND_LABEL[j.kind]}</span>
              <span className="min-w-0 truncate text-muted">{j.file_name ?? 'CSV'}</span>
              <span className="text-xs text-muted">
                新規 {j.summary.created ?? 0} ・補完 {j.summary.updated ?? 0} ・取り込めず{' '}
                {j.summary.error ?? 0}
              </span>
              <span className="ml-auto text-xs text-subtle tabular">
                {formatDateTime(j.created_at, tz)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
