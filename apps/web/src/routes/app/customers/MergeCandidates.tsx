import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, GitMerge, Phone, User, X } from 'lucide-react';
import { useState } from 'react';
import { customerKeys, customersApi, type LineMergeCandidate } from '../../../api/customers';
import { Avatar, Badge, Button, Card, CardContent } from '../../../components/shad';
import { AlertDialog } from '../../../components/shad/alert-dialog';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatWhen } from './shared';

export const mergeCandidatesKey = (shopId: string | null, customerId?: string) =>
  ['customers', 'line-merge-candidates', shopId, customerId ?? null] as const;

/**
 * 統合候補 of the current shop: a record that came in through LINE next to a record the salon
 * already had (same phone / name / reading). The tab badge counts them (`total`).
 */
export function useLineMergeCandidates(opts: { customerId?: string | null; shopId?: string | null; enabled?: boolean } = {}) {
  const { currentShopId, can } = useAuth();
  const shopId = opts.shopId ?? currentShopId ?? null;
  const customerId = opts.customerId ?? undefined;
  return useQuery({
    queryKey: mergeCandidatesKey(shopId, customerId),
    queryFn: () => customersApi.lineMergeCandidates({ shopId: shopId ?? undefined, customerId, limit: customerId ? 20 : 100 }),
    enabled: (opts.enabled ?? true) && can('customer.merge') && (opts.customerId === undefined || !!opts.customerId),
    staleTime: 60_000,
  });
}

/** SALOGIC's labels of the match (一覧: name / phone / それ以外 = 読み仮名一致) */
export function matchLabel(type: LineMergeCandidate['match_type']): string {
  return type === 'name' ? '名前一致' : type === 'phone' ? '電話番号一致' : '読み仮名一致';
}

/** 統合候補 (customer list tab): merge the LINE record into the existing one, or skip the pair */
export function MergeCandidates() {
  const { timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const listQ = useLineMergeCandidates();
  const [gone, setGone] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<LineMergeCandidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const candidates = (listQ.data?.candidates ?? []).filter((c) => !gone.includes(c.id));

  const settle = (c: LineMergeCandidate) => {
    setGone((ids) => [...ids, c.id]);
    void qc.invalidateQueries({ queryKey: customerKeys.all });
  };

  const merge = async (c: LineMergeCandidate) => {
    setBusy(c.id);
    try {
      await customersApi.merge(c.existing_customer_id, c.line_customer_id);
      settle(c);
    } catch (e) {
      toast.error('統合に失敗しました', errorMessage(e));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const skip = async (c: LineMergeCandidate) => {
    setBusy(c.id);
    try {
      await customersApi.dismissDuplicate(c.line_customer_id, c.existing_customer_id);
      settle(c);
    } catch (e) {
      toast.error('スキップに失敗しました', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (listQ.isLoading) return <div className="py-12 text-center text-muted-foreground">読み込み中...</div>;
  if (candidates.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <GitMerge className="mx-auto mb-2 h-12 w-12 opacity-50" />
        <p>統合候補はありません</p>
      </div>
    );
  }

  return (
    <>
      <div className="sy-3">
        {candidates.map((c) => (
          <Card key={c.id} data-merge-candidate={c.id}>
            <CardContent className="p-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="sy-2">
                  <Badge variant="outline" className="border-green-400 text-[10px] text-green-600">
                    LINE
                  </Badge>
                  <div className="flex items-center gap-2">
                    <Avatar
                      name={c.line_customer_name || 'L'}
                      src={c.line_customer_avatar}
                      className="h-10 w-10 shrink-0"
                      fallbackClassName="text-xs"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.line_customer_name}</p>
                      {c.line_display_name && c.line_display_name !== c.line_customer_name ? (
                        <p className="truncate text-xs text-muted-foreground">LINE: {c.line_display_name}</p>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="sy-2">
                  <Badge variant="outline" className="border-blue-400 text-[10px] text-blue-600">
                    既存
                  </Badge>
                  <div className="flex items-center gap-2">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                      <User className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.existing_customer_name}</p>
                      {c.existing_customer_name_kana ? (
                        <p className="truncate text-xs text-muted-foreground">{c.existing_customer_name_kana}</p>
                      ) : null}
                    </div>
                  </div>
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
                      {c.existing_customer_last_visit_at ? (
                        <span> (最終: {formatWhen(c.existing_customer_last_visit_at, tz, 'short')})</span>
                      ) : null}
                    </div>
                    {c.existing_customer_staff_name ? <div>担当: {c.existing_customer_staff_name}</div> : null}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t pt-3">
                <Badge variant="secondary" className="text-[10px]">
                  {matchLabel(c.match_type)}
                </Badge>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void skip(c)} disabled={busy === c.id}>
                    <X className="mr-1 h-3 w-3" />
                    スキップ
                  </Button>
                  <Button size="sm" onClick={() => setConfirming(c)} disabled={busy === c.id}>
                    <GitMerge className="mr-1 h-3 w-3" />
                    統合する
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <AlertDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="顧客情報を統合しますか？"
        description={
          confirming ? (
            <>
              LINE顧客「{confirming.line_customer_name}」の情報（LINE連携、メッセージ、予約、カルテ）を 既存顧客「
              {confirming.existing_customer_name}」に統合します。
              <br />
              <br />
              この操作は取り消せません。
            </>
          ) : null
        }
        actionLabel={confirming && busy === confirming.id ? '統合中...' : '統合する'}
        onAction={() => confirming && void merge(confirming)}
        busy={!!confirming && busy === confirming.id}
      />
    </>
  );
}
