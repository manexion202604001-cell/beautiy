import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ExternalLink, MessageCircle, QrCode, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SOURCE_LABEL, appointmentKeys, appointmentsApi, useAppointment } from '../../../api/appointments';
import { useCustomer } from '../../../api/customers';
import { formsApi, useFormTemplates } from '../../../api/forms';
import { consentSections } from '../../../api/walkin';
import type { AppointmentDetail, AppointmentStatus } from '../../../api/types';
import { AppointmentDrawer } from '../../../components/appointments/AppointmentDrawer';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  type BadgeVariant,
} from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { mediaBadges } from '../../../lib/mediaSync';
import { zonedParts, zonedToIso } from '../../../lib/time';
import { MessageDialog } from './MessageDialog';
import { formatCurrency } from './model';
import { SalonboardButton, SalonboardChip, SalonboardRow, isFromHotPepper } from './salonboard';

const STATUS_BADGE: Record<AppointmentStatus, { label: string; variant: BadgeVariant }> = {
  tentative: { label: '確認待ち', variant: 'warning' },
  confirmed: { label: '確定', variant: 'success' },
  checked_in: { label: '来店', variant: 'default' },
  in_service: { label: '施術中', variant: 'default' },
  completed: { label: '完了', variant: 'secondary' },
  cancelled: { label: 'キャンセル', variant: 'destructive' },
  no_show: { label: '無断キャンセル', variant: 'destructive' },
};

/** Booking route chip: medium colours for HPB / minimo / LINE, the house colour for the rest */
function routeChip(a: AppointmentDetail): { label: string; color: string } {
  // only bookings taken in from the SALON BOARD connector are HPB ('phone_hpb' is a phone booking)
  if (isFromHotPepper(a)) return { label: 'HPB', color: '#CB006D' };
  if (a.source === 'minimo') return { label: 'minimo', color: '#00A7FF' };
  if (a.source === 'line') return { label: 'LINE', color: '#00B900' };
  if (a.source === 'web') return { label: 'Web', color: '#FD7878' };
  if (a.source === 'phone') return { label: '電話', color: '#FD7878' };
  if (a.source === 'walk_in') return { label: '来店', color: '#FD7878' };
  return { label: SOURCE_LABEL[a.source] ?? a.source, color: '#FD7878' };
}

/** Menu text of a booking without menu rows (taken over from a booking medium) */
function menuText(a: AppointmentDetail): string {
  const d = a.source_detail ?? {};
  const v = d.menuName ?? d.menu_name ?? d.menuText;
  return typeof v === 'string' ? v : '';
}

/** QR code as an inline SVG (quiet zone of 4 modules, error correction M) */
function QrSvg({ value, size }: { value: string; size: number }) {
  const { path, count } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const margin = 4;
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (qr.modules.get(y, x)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
      }
    }
    return { path: d, count: n + margin * 2 };
  }, [value]);
  return (
    <svg height={size} width={size} viewBox={`0 0 ${count} ${count}`} role="img" aria-label="QRコード">
      <path fill="#FFFFFF" d={`M0,0 h${count}v${count}H0z`} shapeRendering="crispEdges" />
      <path fill="#000000" d={path} shapeRendering="crispEdges" />
    </svg>
  );
}

/** 予約詳細 */
export default function ReservationDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { timezone: tz, can } = useAuth();
  const apptQ = useAppointment(id);
  const a = apptQ.data;

  const [messagesOpen, setMessagesOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  // --- consent / counselling form link shown as a QR code
  const templatesQ = useFormTemplates({ shopId: a?.shop_id });
  const template = useMemo(() => {
    const active = (templatesQ.data ?? []).filter((t) => t.status === 'active');
    return (
      active.find((t) => t.kind === 'pre_visit') ??
      active.find((t) => t.kind === 'consent') ??
      active.find((t) => t.kind === 'counseling') ??
      null
    );
  }, [templatesQ.data]);
  const canIssue = can('appointment.write') || can('karte.write');
  const linkQ = useQuery({
    queryKey: ['forms', 'reservation-link', id, template?.id],
    queryFn: () => formsApi.preVisitLink(id, { templateId: template!.id, notify: false, reusePending: true }),
    enabled: !!a?.customer_id && !!template && canIssue,
    staleTime: Infinity,
    retry: false,
  });
  const formUrl = linkQ.data?.url ?? null;

  const consentQ = useQuery({
    queryKey: ['forms', 'reservation-consent', id],
    queryFn: () => formsApi.responses({ customerId: a!.customer_id!, appointmentId: id, status: 'submitted' }),
    enabled: consentOpen && !!a?.customer_id,
  });
  // 同意書 dialog: the signed document (its text) and the customer's details
  const consentResponseId =
    (consentQ.data?.items ?? []).find((r) => r.appointment_id === id && r.status === 'submitted')?.id ?? null;
  const consentDocQ = useQuery({
    queryKey: ['forms', 'response', consentResponseId],
    queryFn: () => formsApi.response(consentResponseId!),
    enabled: consentOpen && !!consentResponseId,
  });
  const consentCustomerQ = useCustomer(consentOpen && can('customer.read') ? a?.customer_id : null);

  const formatDate = (iso: string) =>
    new Date(zonedToIso(zonedParts(iso, tz).date, '12:00', tz)).toLocaleDateString('ja-JP', {
      timeZone: tz,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    });
  const timeOf = (iso: string) => zonedParts(iso, tz).time;
  /** 2026年10月13日 14:30 (同意日時) */
  const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  if (apptQ.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }
  if (!a) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">予約が見つかりません</p>
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          戻る
        </Button>
      </div>
    );
  }

  const refresh = () => qc.invalidateQueries({ queryKey: appointmentKeys.all });
  const confirmReservation = async () => {
    try {
      await appointmentsApi.transition(a.id, 'confirm', { version: a.version });
    } catch (e) {
      toast.error('予約の確定に失敗しました', errorMessage(e));
    } finally {
      void refresh();
    }
  };
  const cancelReservation = async () => {
    if (!window.confirm('この予約をキャンセルしますか？')) return;
    try {
      await appointmentsApi.transition(a.id, 'cancel', { version: a.version });
    } catch (e) {
      toast.error('予約のキャンセルに失敗しました', errorMessage(e));
    } finally {
      void refresh();
    }
  };
  const status = STATUS_BADGE[a.status];
  const route = routeChip(a);
  // the SB chip / row are SALON BOARD only; other media (minimo, LiME) keep their own notes
  const otherMedia = a.media_sync && {
    origin: a.media_sync.origin?.provider === 'hotpepper_mail' ? null : a.media_sync.origin,
    blocks: a.media_sync.blocks.filter((b) => b.provider !== 'hotpepper_mail'),
  };
  const syncNotes = mediaBadges(otherMedia).filter((b) => b.tone === 'danger' || b.tone === 'warning');
  const isNew = a.is_new_customer != null ? a.is_new_customer : a.customer_visit_count === 0;
  const customerName = a.customer_name || '顧客未登録';
  const consentResponses = (consentQ.data?.items ?? []).filter((r) => r.appointment_id === a.id && r.status === 'submitted');

  return (
    <div className="mx-auto max-w-lg p-4 sy-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
        <ChevronLeft className="mr-1 h-4 w-4" />
        戻る
      </Button>

      <Card>
        <CardContent className="p-4 sy-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">予約詳細</h2>
              <SalonboardChip a={a} />
            </div>
            {a.has_consent ? (
              <Badge
                className="cursor-pointer text-xs text-white"
                style={{ backgroundColor: '#F36C21' }}
                onClick={() => setConsentOpen(true)}
              >
                同意済み
              </Badge>
            ) : (
              <span className="inline-flex items-center rounded-sm border px-2 py-0.5 text-xs text-muted-foreground">
                未提出
              </span>
            )}
          </div>

          <div className="sy-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">日時</span>
              <span className="font-medium">
                {formatDate(a.start_at)} {timeOf(a.start_at)}〜{timeOf(a.end_at)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">お客様</span>
              <span className="font-medium">
                {customerName}
                {isNew ? <span className="ml-1 text-xs font-normal text-emerald-600">新規</span> : null}
              </span>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">メニュー</span>
              {a.services.length > 0 ? (
                <div className="mt-1 sy-1">
                  {a.services.map((s) => (
                    <div key={s.id} className="flex justify-between text-sm">
                      <span className="font-medium">{s.name}</span>
                      <span className="text-muted-foreground">
                        {s.duration_min}分 / {formatCurrency(s.price)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                // bookings taken over without menu rows keep the menu text of the medium
                <div className="flex justify-between">
                  <span className="font-medium">{menuText(a)}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">担当</span>
              <span className="flex items-center gap-1.5 font-medium">
                {a.staff_name}
                <span
                  className="inline-flex items-center rounded-sm px-1 py-0.5 text-[9px] font-medium text-white"
                  style={{ backgroundColor: a.is_nominated ? '#FD7878' : '#3A76FD' }}
                >
                  {a.is_nominated ? '指名' : 'フリー'}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">料金</span>
              <span className="font-medium">{formatCurrency(a.estimated_total || 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">ステータス</span>
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">予約経路</span>
              <span
                className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-white"
                style={{ backgroundColor: route.color }}
              >
                {route.label}
              </span>
            </div>
            <SalonboardRow a={a} tz={tz} />
            {syncNotes.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
                {syncNotes.map((n) => (
                  <p key={n.key} className="text-xs text-amber-800">
                    {n.label}: {n.title}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="border-t pt-4">
            <div className="text-center sy-3">
              <div className="flex items-center justify-center gap-2 text-sm font-medium">
                <QrCode className="h-4 w-4" />
                同意書・カウンセリングシート
              </div>
              <p className="text-xs text-muted-foreground">
                QRコードをスキャンすると、同意書の記入後
                <br />
                続けてカウンセリングシートに進めます。
              </p>
              <div className="flex justify-center rounded-lg bg-white p-4">
                {formUrl ? (
                  <QrSvg value={formUrl} size={180} />
                ) : (
                  <div className="flex h-[180px] w-[180px] items-center justify-center text-xs text-muted-foreground">
                    {!a.customer_id
                      ? '顧客が登録されていない予約です'
                      : templatesQ.isLoading || linkQ.isLoading
                        ? '読み込み中...'
                        : !template
                          ? 'フォームが登録されていません'
                          : 'QRコードを作成できません'}
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={!formUrl}
                onClick={() => formUrl && window.open(formUrl, '_blank')}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                リンクを開く
              </Button>
            </div>
          </div>

          <div className="border-t pt-4">
            <Button
              variant="outline"
              className="w-full"
              disabled={!a.customer_id}
              onClick={() => setMessagesOpen(true)}
            >
              <MessageCircle className="mr-2 h-4 w-4" />
              メッセージを送る
            </Button>
          </div>

          {can('appointment.write') ? <SalonboardButton a={a} /> : null}

          {a.status === 'tentative' ? (
            <div className="flex gap-2 border-t pt-4">
              <Button className="flex-1" variant="outline" onClick={() => void confirmReservation()}>
                <Check className="mr-2 h-4 w-4" />
                予約を確定
              </Button>
              <Button variant="destructive" onClick={() => void cancelReservation()}>
                <X className="mr-2 h-4 w-4" />
                キャンセル
              </Button>
            </div>
          ) : null}

          <div className="border-t pt-4">
            <Button variant="outline" className="w-full" onClick={() => setManageOpen(true)}>
              予約を変更・操作
            </Button>
          </div>
        </CardContent>
      </Card>

      <MessageDialog
        open={messagesOpen}
        onOpenChange={setMessagesOpen}
        customerId={a.customer_id}
        customerName={customerName}
        shopId={a.shop_id}
        checkboxId="sendToLine"
        composerClassName="shrink-0"
      />

      <Dialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        className="max-h-[80vh] max-w-md overflow-y-auto"
        title={<DialogTitle>同意書</DialogTitle>}
      >
        {consentQ.isLoading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : consentResponses.length > 0 ? (
          (() => {
            const doc = consentDocQ.data;
            const c = consentCustomerQ.data;
            // what the customer typed at reception (受付の同意書) wins over the customer record
            const typed = (key: string) => {
              const v = doc?.answers[key];
              return typeof v === 'string' && v.trim() ? v : null;
            };
            const kana =
              typed('walkin_name_kana') ??
              (`${c?.last_name_kana ?? a.customer_last_name_kana ?? ''} ${c?.first_name_kana ?? a.customer_first_name_kana ?? ''}`.trim() ||
                null);
            const rows: [string, string | null][] = [
              ['フリガナ', kana],
              ['生年月日', typed('walkin_birthday') ?? c?.birthday ?? null],
              ['電話番号', typed('walkin_phone') ?? c?.phone ?? a.customer_phone],
              ['職業', typed('walkin_occupation') ?? c?.occupation ?? null],
              ['来店理由', typed('walkin_visit_reason') ?? c?.acquisition_source ?? null],
            ];
            const sections = consentSections(doc?.template_snapshot.bodyMarkdown);
            const agreedAt = doc?.submitted_at ?? doc?.signed_at ?? consentResponses[0]?.submitted_at ?? null;
            return (
              <div className="text-sm sy-4">
                <div className="sy-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">お名前</span>
                    <span className="font-medium">{typed('walkin_name') ?? customerName}</span>
                  </div>
                  {rows.map(([label, value]) =>
                    value ? (
                      <div key={label} className="flex justify-between">
                        <span className="text-muted-foreground">{label}</span>
                        <span>{value}</span>
                      </div>
                    ) : null,
                  )}
                </div>
                {sections.length > 0 ? (
                  <div className="border-t pt-3 sy-3">
                    {sections.map((sec, i) => (
                      <div key={i}>
                        <h4 className="text-sm font-medium">{sec.title}</h4>
                        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                          {[...sec.items.map((it) => `・${it}`), sec.content].filter(Boolean).join('\n')}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="border-t pt-3 text-xs text-muted-foreground">
                  同意日時: {agreedAt ? formatDateTime(agreedAt) : '-'}
                </div>
                {/* Salon OS: every answer of the form stays readable on the customer's documents */}
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-4 hover:underline"
                  onClick={() => navigate(`/app/customers/${a.customer_id}`)}
                >
                  回答を見る
                </button>
              </div>
            );
          })()
        ) : (
          <p className="py-4 text-sm text-muted-foreground">同意書データが見つかりません</p>
        )}
      </Dialog>

      <AppointmentDrawer id={manageOpen ? a.id : null} onClose={() => setManageOpen(false)} tz={tz} />
    </div>
  );
}
