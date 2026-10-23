import { useQueryClient } from '@tanstack/react-query';
import { Calendar, GitMerge, Phone, User, X } from 'lucide-react';
import { useState } from 'react';
import { appointmentKeys } from '../../../api/appointments';
import { customerKeys, customersApi, type LineMergeCandidate } from '../../../api/customers';
import { Badge, Button } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useLineMergeCandidates } from '../customers/MergeCandidates';

/** SALOGIC's labels on the reservation (phone / name_kana / それ以外 = 名前一致) */
const label = (t: LineMergeCandidate['match_type']) =>
  t === 'phone' ? '電話番号一致' : t === 'name_kana' ? '読み仮名一致' : '名前一致';

/**
 * 予約詳細「既存顧客との統合候補があります」: the reservation's customer came in through LINE and
 * looks like a customer the salon already had. 統合する moves the LINE record (with this
 * reservation) into the existing one; スキップ dismisses the pair.
 */
export function LineMergeCandidatesPanel({
  customerId,
  shopId,
}: {
  customerId: string | null;
  shopId?: string | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useLineMergeCandidates({ customerId, shopId });
  const [gone, setGone] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const candidates = (q.data?.candidates ?? []).filter((c) => !gone.includes(c.id));
  if (!customerId || candidates.length === 0) return null;

  const skip = async (c: LineMergeCandidate) => {
    setBusy(c.id);
    try {
      await customersApi.dismissDuplicate(c.line_customer_id, c.existing_customer_id);
      setGone((ids) => [...ids, c.id]);
      void qc.invalidateQueries({ queryKey: customerKeys.all });
    } catch (e) {
      toast.error('スキップに失敗しました', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const merge = async (c: LineMergeCandidate) => {
    if (
      !window.confirm(
        `「${c.line_customer_name}」を「${c.existing_customer_name}」に統合しますか？\nこの操作は取り消せません。`,
      )
    )
      return;
    setBusy(c.id);
    try {
      await customersApi.merge(c.existing_customer_id, c.line_customer_id);
      setGone((ids) => [...ids, c.id]);
      // the reservation now belongs to the existing customer
      void qc.invalidateQueries({ queryKey: appointmentKeys.all });
      void qc.invalidateQueries({ queryKey: customerKeys.all });
    } catch (e) {
      toast.error('統合に失敗しました', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="sy-3 rounded-md border border-amber-200 bg-amber-50 p-3"
      data-testid="line-merge-candidates"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800">
        <GitMerge className="h-4 w-4" />
        既存顧客との統合候補があります
      </p>
      {candidates.map((c) => (
        <div key={c.id} className="sy-2 rounded-md border bg-white p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="sy-1">
              <Badge variant="outline" className="border-green-400 text-[10px] text-green-600">
                LINE（この予約）
              </Badge>
              <p className="truncate text-sm font-medium">{c.line_customer_name}</p>
              {c.line_display_name && c.line_display_name !== c.line_customer_name ? (
                <p className="truncate text-xs text-muted-foreground">
                  LINE: {c.line_display_name}
                </p>
              ) : null}
            </div>
            <div className="sy-1">
              <Badge variant="outline" className="border-blue-400 text-[10px] text-blue-600">
                既存
              </Badge>
              <p className="truncate text-sm font-medium">{c.existing_customer_name}</p>
              <div className="sy-0.5 text-xs text-muted-foreground">
                {c.existing_customer_phone ? (
                  <div className="flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {c.existing_customer_phone}
                  </div>
                ) : null}
                <div className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  来店{c.existing_customer_visit_count}回
                </div>
                {c.existing_customer_staff_name ? (
                  <div className="flex items-center gap-1">
                    <User className="h-3 w-3" />
                    {c.existing_customer_staff_name}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t pt-1">
            <Badge variant="secondary" className="text-[10px]">
              {label(c.match_type)}
            </Badge>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy === c.id}
                onClick={() => void skip(c)}
              >
                <X className="mr-1 h-3 w-3" />
                スキップ
              </Button>
              <Button size="sm" disabled={busy === c.id} onClick={() => void merge(c)}>
                <GitMerge className="mr-1 h-3 w-3" />
                統合する
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
