import { STATUS_LABEL } from '../../api/appointments';
import type { AppointmentStatus } from '../../api/types';
import { Badge, type Tone } from '../ui';

export const STATUS_TONE: Record<AppointmentStatus, Tone> = {
  tentative: 'warning',
  confirmed: 'primary',
  checked_in: 'info',
  in_service: 'info',
  completed: 'success',
  cancelled: 'neutral',
  no_show: 'danger',
};

export function StatusBadge({ status, size }: { status: AppointmentStatus; size?: 'sm' | 'md' }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot size={size}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
