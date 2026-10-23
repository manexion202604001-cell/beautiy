import { useQueryClient } from '@tanstack/react-query';
import { Clock, ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { appointmentKeys, appointmentsApi } from '../../../api/appointments';
import type { AppointmentDetail, SalonboardSync } from '../../../api/types';
import { Badge, Button } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { cx } from '../../../lib/cn';
import { zonedParts } from '../../../lib/time';

/**
 * 予約詳細 › SALON BOARD (SALOGIC salonboard_synced): the SB chip next to the title, the SB連携 row
 * and the 「サロンボードに連携」 button. Only the shop's SALON BOARD (hotpepper_mail) connector counts;
 * minimo / LiME have their own notes.
 */

/** HPB reservation numbers open SALON BOARD's own reservation page (the salon is logged in there) */
export function salonboardReserveUrl(id: string | null | undefined): string | null {
  return id && id.startsWith('BE')
    ? `https://salonboard.com/KLP/reserve/net/reserveDetail/?reserveId=${encodeURIComponent(id)}`
    : null;
}

/** booked on Hot Pepper (taken in from the SALON BOARD connector's mails) */
export const isFromHotPepper = (a: AppointmentDetail) =>
  a.media_sync?.salonboard?.origin === 'hotpepper' ||
  (a.media_sync?.origin?.provider ?? '').startsWith('hotpepper');

function title(sb: SalonboardSync): string {
  if (sb.state === 'error') return `SBエラー: ${sb.message || '不明'}`;
  if (sb.state === 'waiting')
    return sb.auto
      ? 'SB連携待ち（自動枠止めが10分ごとに反映します）'
      : `SB連携待ち: ${sb.message || 'サロンボードで枠を止めてください'}`;
  if (sb.reserve_id) return `SB連携済 ${sb.reserve_id}`;
  if (sb.origin === 'migrated') return 'SB連携済（以前のシステムから移した予約）';
  return sb.message ? `SB連携済（${sb.message}）` : 'SB連携済（予定あり）';
}

const Mark = ({ sb }: { sb: SalonboardSync }) =>
  sb.state === 'synced' ? (
    <span className="text-green-600">✓</span>
  ) : sb.state === 'error' ? (
    <span className="text-red-500">✗</span>
  ) : (
    <Clock className="h-3.5 w-3.5 text-yellow-600" aria-hidden />
  );

/** chip next to 「予約詳細」 */
export function SalonboardChip({ a }: { a: AppointmentDetail }) {
  const sb = a.media_sync?.salonboard;
  if (!sb || !sb.state || a.status === 'tentative') return null;
  const url = sb.state === 'synced' ? salonboardReserveUrl(sb.reserve_id) : null;
  if (url)
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted"
        title={title(sb)}
      >
        <Mark sb={sb} />
        SB予約詳細
        <ExternalLink className="h-3 w-3 text-muted-foreground" />
      </a>
    );
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm"
      title={title(sb)}
    >
      <Mark sb={sb} />
      <span className="text-muted-foreground">SB</span>
    </span>
  );
}

const datetime = (iso: string, tz: string) => {
  const p = zonedParts(iso, tz);
  return `${p.date.replaceAll('-', '/')} ${p.time}`;
};

/** 「SB連携」 row of a booking taken outside Hot Pepper, with when it was last settled */
export function SalonboardRow({ a, tz }: { a: AppointmentDetail; tz: string }) {
  const sb = a.media_sync?.salonboard;
  if (!sb || !sb.state || isFromHotPepper(a)) return null;
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">SB連携</span>
        <div className="flex items-center gap-2">
          {sb.state === 'synced' ? (
            <Badge
              variant="outline"
              className="border-blue-500 bg-blue-50 text-xs text-blue-600"
              title={title(sb)}
            >
              SB連携済
            </Badge>
          ) : sb.state === 'error' ? (
            <Badge
              variant="outline"
              className="border-red-500 bg-red-50 text-xs text-red-600"
              title={sb.message || 'エラー'}
            >
              SBエラー
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-yellow-500 bg-yellow-50 text-xs text-yellow-700"
              title={title(sb)}
            >
              SB連携待ち
            </Badge>
          )}
          {sb.synced_at ? (
            <span className="text-xs text-muted-foreground">{datetime(sb.synced_at, tz)}</span>
          ) : null}
        </div>
      </div>
      {sb.state === 'error' && sb.message ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-2">
          <p className="text-xs text-red-700">{sb.message}</p>
        </div>
      ) : null}
    </>
  );
}

/** full-width 「サロンボードに連携」 button (confirmed bookings taken outside Hot Pepper) */
export function SalonboardButton({ a }: { a: AppointmentDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const sb = a.media_sync?.salonboard;
  if (!sb?.enabled || isFromHotPepper(a) || sb.origin === 'migrated' || a.status !== 'confirmed')
    return null;
  const run = async () => {
    setRunning(true);
    try {
      await appointmentsApi.syncSalonboard(a.id);
      toast.success('サロンボード連携を受け付けました（10分以内に反映）');
    } catch (e) {
      toast.error('サロンボード連携に失敗しました', errorMessage(e));
    } finally {
      setRunning(false);
      void qc.invalidateQueries({ queryKey: appointmentKeys.all });
    }
  };
  return (
    <div className="border-t pt-4">
      <Button variant="outline" className="w-full" onClick={() => void run()} disabled={running}>
        <RefreshCw className={cx('mr-2 h-4 w-4', running && 'animate-spin')} />
        {running
          ? 'サロンボード連携中...'
          : sb.state === 'synced'
            ? 'サロンボードに再同期'
            : sb.state === 'error'
              ? 'サロンボード連携を再試行'
              : 'サロンボードに連携'}
      </Button>
    </div>
  );
}
