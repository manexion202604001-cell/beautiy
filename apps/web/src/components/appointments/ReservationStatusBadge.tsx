import type { AppointmentStatus } from '../../api/types';
import { Badge, type BadgeVariant } from '../shad';

/** Status wording and colours of the reservation lists (確認待ち = yellow, 確定 = green, 完了 = grey, キャンセル = red) */
export const RESERVATION_STATUS: Record<AppointmentStatus, { label: string; variant: BadgeVariant }> = {
  tentative: { label: '確認待ち', variant: 'warning' },
  confirmed: { label: '確定', variant: 'success' },
  checked_in: { label: '来店', variant: 'default' },
  in_service: { label: '施術中', variant: 'default' },
  completed: { label: '完了', variant: 'secondary' },
  cancelled: { label: 'キャンセル', variant: 'destructive' },
  no_show: { label: '無断キャンセル', variant: 'destructive' },
};

export function ReservationStatusBadge({ status }: { status: AppointmentStatus }) {
  const s = RESERVATION_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
