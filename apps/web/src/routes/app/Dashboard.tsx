import { useQueryClient } from '@tanstack/react-query';
import { Calendar, Check, ChevronRight, Clock, MessageCircle, MessageSquare, Users, X, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { SOURCE_LABEL, appointmentKeys, appointmentsApi, useAppointments } from '../../api/appointments';
import { useUnreadCount } from '../../api/messaging';
import type { AppointmentListItem } from '../../api/types';
import { ReservationStatusBadge } from '../../components/appointments/ReservationStatusBadge';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogTitle,
} from '../../components/shad';
import { ErrorState, useToast } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateJa, formatTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { todayIn } from '../../lib/time';
import { ManualBlocksCard } from './integrations/MailTools';
import { MessageDialog } from './reservations/MessageDialog';
import { formatCurrency, isHotPepper } from './reservations/model';

const menuNameOf = (a: AppointmentListItem) => a.services.map((s) => s.name).join('、');

/** Booking route badge of the dashboard dialog */
function RouteBadge({ a }: { a: AppointmentListItem }) {
  if (isHotPepper(a))
    return (
      <Badge variant="outline" className="border-orange-500 bg-orange-50 text-xs text-orange-600">
        HPB
      </Badge>
    );
  if (a.source === 'line')
    return (
      <Badge variant="outline" className="border-green-500 text-xs text-green-600">
        LINE
      </Badge>
    );
  const label =
    a.source === 'web' ? 'Web' : a.source === 'phone' ? '電話' : a.source === 'walk_in' ? '来店' : (SOURCE_LABEL[a.source] ?? a.source);
  return (
    <Badge variant="outline" className="text-xs">
      {label}
    </Badge>
  );
}

export default function Dashboard() {
  const { currentShopId: shopId, timezone: tz, can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const now = useNow(60_000);
  const today = todayIn(tz, now);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const canRead = can('appointment.read');
  const appts = useAppointments({ shopId: shopId ?? undefined, date: today }, !!shopId && canRead);
  const unread = useUnreadCount({ shopId: shopId ?? undefined }, !!shopId && can('message.read'));

  if (appts.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  const list = appts.data ?? [];
  const selected = list.find((a) => a.id === selectedId) ?? null;
  const pending = list.filter((a) => a.status === 'tentative').length;
  const confirmed = list.filter((a) => a.status === 'confirmed').length;
  // 確定+完了分 (来店・施術中 are between the two in Salon OS and count as well)
  const sales = list
    .filter((a) => ['confirmed', 'checked_in', 'in_service', 'completed'].includes(a.status))
    .reduce((sum, a) => sum + (a.estimated_total || 0), 0);

  const refresh = () => qc.invalidateQueries({ queryKey: appointmentKeys.all });
  const confirmReservation = async (a: AppointmentListItem) => {
    try {
      await appointmentsApi.transition(a.id, 'confirm', { version: a.version });
    } catch (e) {
      toast.error('予約の確定に失敗しました', errorMessage(e));
    } finally {
      void refresh();
    }
  };
  const cancelReservation = async (a: AppointmentListItem) => {
    if (!window.confirm('この予約をキャンセルしますか？')) return;
    try {
      await appointmentsApi.transition(a.id, 'cancel', { version: a.version });
      setDetailOpen(false);
    } catch (e) {
      toast.error('予約のキャンセルに失敗しました', errorMessage(e));
    } finally {
      void refresh();
    }
  };

  return (
    <div className="sy-6">
      <div>
        <h1 className="text-2xl font-bold">ダッシュボード</h1>
        <p className="text-muted-foreground">{formatDateJa(today, { year: true })}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard title="本日の予約" icon={Calendar} value={list.length} sub={`確認待ち: ${pending}件`} />
        <StatCard title="確定済み" icon={Clock} value={confirmed} sub="本日の確定予約" />
        <StatCard title="未読メッセージ" icon={MessageSquare} value={unread.data?.count ?? 0} sub="対応が必要" />
        <StatCard title="本日の売上見込み" icon={Users} value={formatCurrency(sales)} sub="確定+完了分" />
      </div>

      {shopId ? <ManualBlocksCard shopId={shopId} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>本日の予約一覧</CardTitle>
          <CardDescription>
            {list.length > 0 ? `${list.length}件の予約があります` : '本日の予約はありません'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {appts.error ? (
            <ErrorState error={appts.error} onRetry={() => void appts.refetch()} />
          ) : list.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">予約がありません</div>
          ) : (
            <div className="sy-4">
              {list.map((a) => (
                <TodayRow
                  key={a.id}
                  a={a}
                  tz={tz}
                  onOpen={() => {
                    setSelectedId(a.id);
                    setDetailOpen(true);
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={detailOpen && !!selected}
        onOpenChange={setDetailOpen}
        className="max-w-md"
        title={
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            予約詳細
          </DialogTitle>
        }
      >
        {selected ? (
          <div className="py-2 sy-4">
            <div className="sy-3">
              <DetailRow label="日時">
                {formatTime(selected.start_at, tz)}〜{formatTime(selected.end_at, tz)}
              </DetailRow>
              <DetailRow label="お客様">
                {selected.customer_name || '顧客未登録'}
                {selected.customer_visit_count === 0 ? (
                  <span className="ml-1 text-xs font-normal text-emerald-600">新規</span>
                ) : null}
              </DetailRow>
              <DetailRow label="メニュー">{menuNameOf(selected)}</DetailRow>
              <DetailRow label="担当">{selected.staff_name ?? '未定'}</DetailRow>
              <DetailRow label="料金">{formatCurrency(selected.estimated_total || 0)}</DetailRow>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">ステータス</span>
                <ReservationStatusBadge status={selected.status} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">予約経路</span>
                <RouteBadge a={selected} />
              </div>
            </div>
            {selected.status === 'tentative' ? (
              <div className="flex gap-2 border-t pt-4">
                <Button className="flex-1" variant="outline" onClick={() => void confirmReservation(selected)}>
                  <Check className="mr-2 h-4 w-4" />
                  予約を確定
                </Button>
                <Button variant="destructive" onClick={() => void cancelReservation(selected)}>
                  <X className="mr-2 h-4 w-4" />
                  キャンセル
                </Button>
              </div>
            ) : null}
            <div className="border-t pt-4">
              <Button
                variant="outline"
                className="w-full"
                disabled={!selected.customer_id}
                onClick={() => setMessagesOpen(true)}
              >
                <MessageCircle className="mr-2 h-4 w-4" />
                メッセージを送る
              </Button>
            </div>
            <div className="border-t pt-4">
              <Button variant="outline" className="w-full" onClick={() => navigate(`/app/calendar/${selected.id}`)}>
                予約詳細を開く
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <MessageDialog
        open={messagesOpen}
        onOpenChange={setMessagesOpen}
        customerId={selected?.customer_id ?? null}
        customerName={selected?.customer_name || ''}
        shopId={shopId}
        checkboxId="dashboardSendToLine"
        threadClassName="min-h-[300px]"
      />
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}

function StatCard({
  title,
  icon: Icon,
  value,
  sub,
}: {
  title: string;
  icon: LucideIcon;
  value: ReactNode;
  sub: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between sy-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

function TodayRow({ a, tz, onOpen }: { a: AppointmentListItem; tz: string; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer items-center justify-between rounded-lg border p-4 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center gap-4">
        <div className="text-center">
          <div className="text-lg font-bold">{formatTime(a.start_at, tz)}</div>
          <div className="text-xs text-muted-foreground">〜{formatTime(a.end_at, tz)}</div>
        </div>
        <div>
          <div className="font-medium">{a.customer_name || '顧客未登録'}</div>
          <div className="text-sm text-muted-foreground">
            {menuNameOf(a)} / 担当: {a.staff_name ?? '未定'}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden text-right sm:block">
          <div className="font-medium">{formatCurrency(a.estimated_total || 0)}</div>
        </div>
        <ReservationStatusBadge status={a.status} />
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );
}
