import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Link2, QrCode as QrCodeIcon, Search, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { customersApi } from '../../../api/customers';
import { displayFieldValue, type CounselingSheetData, type FieldDef, type FieldValues } from '../../../api/kartes';
import { useStaffList } from '../../../api/org';
import {
  consentSections,
  useWalkinIntakes,
  walkinApi,
  walkinKeys,
  type WalkinIntakeDetail,
  type WalkinIntakeListItem,
} from '../../../api/walkin';
import { Badge, Button, Card, CardContent, Dialog, DialogTitle, Input, Select } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useDebounced } from '../../../lib/hooks';
import { COUNSELING_CATEGORIES, type CounselingCategory } from '../customers/counselingQuestions';
import { ReceptionQrDialog } from './ReceptionQrDialog';

const isBlank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Answered questions of one sheet as 「質問: 回答」 rows */
function AnswerRows({ fields, answers }: { fields: FieldDef[]; answers: FieldValues }) {
  return (
    <div className="sy-0.5">
      {fields.map((f) => {
        const v = answers[f.key];
        if (isBlank(v)) return null;
        return (
          <div key={f.key} className="flex gap-1 text-xs">
            <span className="shrink-0 text-muted-foreground">{f.label}:</span>
            <span>{displayFieldValue(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** One category of the counselling sheet: the answered questions (and their follow-up inputs) */
function CounselingCategoryRows({ category, answers }: { category: CounselingCategory; answers: CounselingSheetData[string] }) {
  const row = (id: string, label: string, hint?: string) => {
    const v = answers[id];
    if (isBlank(v)) return null;
    return (
      <div key={id} className="flex gap-1 text-xs">
        <span className="shrink-0 text-muted-foreground">{label}:</span>
        <span>
          {Array.isArray(v) ? v.join('、') : String(v ?? '')}
          {hint ? <span className="ml-1 text-muted-foreground">{hint}</span> : null}
        </span>
      </div>
    );
  };
  return (
    <div className="rounded-sm border p-2">
      <p className="mb-1 text-xs font-medium">{category.label}</p>
      <div className="sy-0.5">
        {category.questions.flatMap((q) => [
          // sliders are stored as 0–100: say what the two ends mean
          row(q.id, q.label, q.type === 'slider' && q.sliderLabels ? `（0: ${q.sliderLabels[0]} 〜 100: ${q.sliderLabels[1]}）` : undefined),
          ...(q.subFields ?? []).map((f) => row(f.id, f.label)),
        ])}
      </div>
    </div>
  );
}

/** 同意書一覧（受付保留）: consents submitted at reception by customers without a reservation */
export default function Consents() {
  const { currentShopId, timezone: tz, can, me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 300);
  const [detail, setDetail] = useState<WalkinIntakeDetail | null>(null);
  const [linking, setLinking] = useState<WalkinIntakeDetail | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const customerTerm = useDebounced(customerSearch.trim(), 300);
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrStaffId, setQrStaffId] = useState('');
  const canRead = can('karte.read');
  const canWrite = can('karte.write');
  const canCreate = canWrite && can('customer.write');

  const listQ = useWalkinIntakes({ shopId: currentShopId, q: term || undefined }, canRead);
  const intakes = listQ.data?.pages.flatMap((p) => p.items) ?? [];
  // every pending intake is listed (no 「さらに表示」): further pages are fetched right away
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = listQ;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const refresh = () => qc.invalidateQueries({ queryKey: walkinKeys.all });

  // a shop switch leaves the dialogs of the previous shop behind
  useEffect(() => {
    setDetail(null);
    setLinking(null);
  }, [currentShopId]);

  const candidatesQ = useQuery({
    // customers of the shop the intake was submitted at
    queryKey: ['customers', 'walkin-link', currentShopId, customerTerm],
    queryFn: () => customersApi.search({ shopId: currentShopId ?? undefined, q: customerTerm, limit: 20 }),
    enabled: !!linking && !!customerTerm && !!currentShopId,
  });
  const candidates = linking && customerTerm ? (candidatesQ.data?.items ?? []) : [];

  const staffQ = useStaffList({ shopId: currentShopId ?? undefined }, qrOpen && can('staff.read'));
  const staffOptions = (staffQ.data ?? []).filter((s) => s.status === 'active');
  const qrStaff = staffOptions.find((s) => s.id === qrStaffId) ?? null;

  const dateTime = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const openDetail = async (row: WalkinIntakeListItem) => {
    try {
      const res = await walkinApi.get(row.id);
      setDetail(res.intake);
    } catch (e) {
      toast.error('受付の読み込みに失敗しました', errorMessage(e));
    }
  };

  const createCustomer = async (intake: WalkinIntakeDetail) => {
    if (!window.confirm(`「${intake.customer_name}」を新規顧客として登録しますか？`)) return;
    setBusy(true);
    try {
      await walkinApi.create(intake.id);
      setDetail(null);
      await refresh();
      void qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success('新規顧客として登録しました');
    } catch (e) {
      toast.error('登録に失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async (intake: WalkinIntakeDetail) => {
    if (!window.confirm(`「${intake.customer_name}」の受付を破棄しますか？`)) return;
    setBusy(true);
    try {
      await walkinApi.discard(intake.id);
      setDetail(null);
      await refresh();
    } catch (e) {
      toast.error('受付の破棄に失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const link = async (customerId: string) => {
    if (!linking) return;
    if (!window.confirm('この顧客に紐付けますか？カウンセリングは記入カテゴリーごとに上書きされます。')) return;
    setBusy(true);
    try {
      await walkinApi.link(linking.id, customerId);
      setLinking(null);
      setDetail(null);
      await refresh();
      void qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success('既存顧客に紐付けました');
    } catch (e) {
      toast.error('紐付けに失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sections = detail ? consentSections(detail.consent_snapshot.body_markdown) : [];

  return (
    <div className="p-4 pb-20 sy-4">
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold">同意書一覧（受付保留）</h1>
        <Button variant="outline" size="sm" className="-my-0.5 ml-auto" onClick={() => setQrOpen(true)} disabled={!canRead}>
          <QrCodeIcon className="mr-1 h-4 w-4" />
          受付QRコード
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="お客様の名前・電話で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {!canRead ? (
        <div className="py-8 text-center text-muted-foreground">同意書を閲覧する権限がありません</div>
      ) : listQ.isLoading ? (
        <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
      ) : listQ.isError ? (
        <div className="py-8 text-center text-muted-foreground">
          受付の読み込みに失敗しました
          <div className="mt-2">
            <Button variant="outline" size="sm" onClick={() => void listQ.refetch()}>
              再読み込み
            </Button>
          </div>
        </div>
      ) : intakes.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">保留中の受付はありません</div>
      ) : (
        <div className="sy-2">
          {intakes.map((e) => (
            <Card
              key={e.id}
              data-intake={e.id}
              role="button"
              tabIndex={0}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => void openDetail(e)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  void openDetail(e);
                }
              }}
            >
              <CardContent className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{e.customer_name || '(名前なし)'}</span>
                      {e.customer_name_kana ? (
                        <span className="text-xs text-muted-foreground">({e.customer_name_kana})</span>
                      ) : null}
                      {e.has_counseling ? (
                        <Badge variant="secondary" className="text-[10px]">
                          カウンセリング済
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-yellow-600">
                          同意書のみ
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {e.customer_phone ? <span>{e.customer_phone}</span> : null}
                      {e.staff_name ? <span>担当: {e.staff_name}</span> : null}
                      {e.consent_submitted_at ? <span>{dateTime(e.consent_submitted_at)}</span> : null}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={!!detail}
        onOpenChange={(o) => {
          if (!o) setDetail(null);
        }}
        className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg flex-col overflow-y-auto"
        title={<DialogTitle>{detail?.customer_name || '受付詳細'}</DialogTitle>}
      >
        {detail ? (
          <div className="text-sm sy-3">
            <div className="grid grid-cols-2 gap-1 text-xs">
              {detail.customer_name_kana ? <div>ふりがな: {detail.customer_name_kana}</div> : null}
              {detail.customer_phone ? <div>電話: {detail.customer_phone}</div> : null}
              {detail.customer_birthday ? <div>生年月日: {detail.customer_birthday}</div> : null}
              {detail.staff_name ? <div>担当: {detail.staff_name}</div> : null}
              {detail.customer_occupation ? <div>ご職業: {detail.customer_occupation}</div> : null}
              {detail.customer_visit_reason ? <div>ご来店のきっかけ: {detail.customer_visit_reason}</div> : null}
            </div>

            <div className="sy-2">
              <p className="text-xs font-medium text-muted-foreground">同意書</p>
              <div className="rounded-sm border p-2 sy-2">
                {detail.consent_snapshot.title ? (
                  <p className="text-sm font-medium">{detail.consent_snapshot.title}</p>
                ) : null}
                {sections.map((s, i) => (
                  <div key={i}>
                    {s.title ? <p className="text-xs font-medium">{s.title}</p> : null}
                    {s.items.length > 0 ? (
                      <ul className="mt-0.5 list-inside list-disc sy-0.5">
                        {s.items.map((it, j) => (
                          <li key={j} className="text-xs leading-relaxed text-muted-foreground">
                            {it}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {s.content ? (
                      <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{s.content}</p>
                    ) : null}
                  </div>
                ))}
                {detail.consent_snapshot.fields.some((f) => !isBlank(detail.consent_snapshot.answers[f.key])) ? (
                  <AnswerRows fields={detail.consent_snapshot.fields} answers={detail.consent_snapshot.answers} />
                ) : null}
                {detail.consent_snapshot.signature ? (
                  <div className="text-xs text-muted-foreground">
                    <p>署名: {detail.consent_snapshot.signer_name}</p>
                    <img
                      src={detail.consent_snapshot.signature.url}
                      alt="署名"
                      className="mt-1 max-h-24 rounded-sm border bg-white"
                    />
                  </div>
                ) : null}
                {detail.consent_snapshot.agreed_at ? (
                  <p className="border-t pt-1 text-[10px] text-muted-foreground">
                    同意日時: {dateTime(detail.consent_snapshot.agreed_at)}
                  </p>
                ) : null}
              </div>
            </div>

            {detail.counseling_data ? (
              <div className="sy-2">
                <p className="text-xs font-medium text-muted-foreground">カウンセリング内容</p>
                {COUNSELING_CATEGORIES.filter((c) => detail.counseling_data?.[c.id]).map((c) => (
                  <CounselingCategoryRows key={c.id} category={c} answers={detail.counseling_data![c.id]!} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-col sm:justify-end sm:sx-2">
          <Button
            className="w-full"
            disabled={busy || !canWrite}
            onClick={() => {
              if (!detail) return;
              setLinking(detail);
              setCustomerSearch(detail.customer_name);
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            既存の顧客に紐付け
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !canCreate}
            onClick={() => detail && void createCustomer(detail)}
          >
            <UserPlus className="mr-2 h-4 w-4" />
            新規顧客として登録
          </Button>
          <Button
            variant="ghost"
            className="w-full text-destructive"
            disabled={busy || !canWrite}
            onClick={() => detail && void discard(detail)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            破棄
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!linking}
        onOpenChange={(o) => {
          if (!o) setLinking(null);
        }}
        className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-md flex-col overflow-y-auto"
        title={<DialogTitle>既存の顧客に紐付け</DialogTitle>}
      >
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="顧客名で検索"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="sy-1">
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              data-candidate={c.id}
              disabled={busy}
              onClick={() => void link(c.id)}
              className="w-full rounded-md border p-2 text-left hover:bg-muted/50 disabled:opacity-50"
            >
              <div className="text-sm font-medium">
                {c.display_name}
                {(c.member_no ?? c.customer_number) ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{c.member_no ?? c.customer_number}</span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {`${c.last_name_kana ?? ''} ${c.first_name_kana ?? ''}`.trim()} {c.phone}
              </div>
            </button>
          ))}
          {customerSearch.trim() && customerTerm === customerSearch.trim() && candidatesQ.isSuccess && candidates.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">該当する顧客がいません</p>
          ) : null}
        </div>
      </Dialog>

      <ReceptionQrDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        shopId={currentShopId}
        staffId={qrStaff?.id ?? null}
        staffName={qrStaff?.display_name ?? null}
        options={
          staffOptions.length > 0 ? (
            <Select
              label="担当スタッフ"
              value={qrStaff?.id ?? ''}
              onValueChange={setQrStaffId}
              options={[
                { value: '', label: '担当を指定しない' },
                ...staffOptions.map((s) => ({
                  value: s.id,
                  label: s.id === me?.staff.id ? `${s.display_name}（自分）` : s.display_name,
                })),
              ]}
            />
          ) : null
        }
      />
    </div>
  );
}
