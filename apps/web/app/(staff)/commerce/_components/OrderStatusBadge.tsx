import { Badge } from '@/components/ui';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TONE } from '@/lib/pos-shared';

export function OrderStatusBadge({ status }: { status: string }) {
  const s = status as keyof typeof ORDER_STATUS_LABEL;
  return <Badge tone={ORDER_STATUS_TONE[s] ?? 'gray'}>{ORDER_STATUS_LABEL[s] ?? status}</Badge>;
}
