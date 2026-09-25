import { Badge } from '@/components/ui';
import { TX_STATUS_LABEL, TX_STATUS_TONE, type TxStatusName } from '@/lib/pos-shared';

export function TxStatusBadge({ status }: { status: string }) {
  const s = status as TxStatusName;
  return <Badge tone={TX_STATUS_TONE[s] ?? 'gray'}>{TX_STATUS_LABEL[s] ?? status}</Badge>;
}
