import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, GitMerge, Phone, User, X } from 'lucide-react';
import { useState } from 'react';
import { customerKeys, customersApi } from '../../../api/customers';
import type { DuplicatePair, DuplicatePairCustomer } from '../../../api/types';
import { Avatar, Badge, Button, Card, CardContent } from '../../../components/shad';
import { AlertDialog } from '../../../components/shad/alert-dialog';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatWhen } from './shared';

const nameOf = (c: DuplicatePairCustomer) =>
  `${c.last_name} ${c.first_name}`.trim() || `${c.last_name_kana} ${c.first_name_kana}`.trim();
const kanaOf = (c: DuplicatePairCustomer) => `${c.last_name_kana} ${c.first_name_kana}`.trim();

export const mergeCandidatesKey = ['customers', 'duplicate-pairs'] as const;

interface Candidate {
  id: string;
  /** the record that is merged away */
  from: DuplicatePairCustomer;
  /** the record that stays */
  keep: DuplicatePairCustomer;
  reasons: string[];
}

/**
 * Which record stays: a record that came in through LINE is merged into the one staff already
 * keep; otherwise the record with more visits stays (the older one when they are equal).
 */
function toCandidate(p: DuplicatePair): Candidate {
  const { a, b } = p;
  let keep = a;
  if (!!a.line !== !!b.line) keep = a.line ? b : a;
  else if (a.visit_count !== b.visit_count) keep = a.visit_count > b.visit_count ? a : b;
  else if (a.created_at && b.created_at && a.created_at !== b.created_at) keep = a.created_at < b.created_at ? a : b;
  const from = keep === a ? b : a;
  return { id: `${a.id}:${b.id}`, from, keep, reasons: p.reasons };
}

function matchLabel(reasons: string[]): string {
  if (reasons.includes('phone_exact')) return '電話番号一致';
  if (reasons.includes('email_exact')) return 'メールアドレス一致';
  if (reasons.includes('kana_similar')) return '読み仮名一致';
  return '名前一致';
}

/** 統合候補: pairs of records that look like the same person — merge them or skip the pair */
export function MergeCandidates() {
  const { timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const listQ = useQuery({ queryKey: mergeCandidatesKey, queryFn: () => customersApi.duplicatePairs(100) });
  const [gone, setGone] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const candidates = (listQ.data ?? []).map(toCandidate).filter((c) => !gone.includes(c.id));

  const settle = (c: Candidate) => {
    setGone((ids) => [...ids, c.id]);
    void qc.invalidateQueries({ queryKey: customerKeys.all });
  };

  const merge = async (c: Candidate) => {
    setBusy(c.id);
    try {
      await customersApi.merge(c.keep.id, c.from.id);
      settle(c);
    } catch (e) {
      toast.error('統合に失敗しました', errorMessage(e));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const skip = async (c: Candidate) => {
    setBusy(c.id);
    try {
      await customersApi.dismissDuplicate(c.from.id, c.keep.id);
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

  const fromIsLine = (c: Candidate) => !!c.from.line;

  return (
    <>
      <div className="sy-3">
        {candidates.map((c) => {
          const fromName = nameOf(c.from);
          const lineName = c.from.line?.display_name;
          return (
            <Card key={c.id} data-merge-candidate={c.id}>
              <CardContent className="p-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="sy-2">
                    {fromIsLine(c) ? (
                      <Badge variant="outline" className="border-green-400 text-[10px] text-green-600">
                        LINE
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-amber-500 text-[10px] text-amber-600">
                        重複
                      </Badge>
                    )}
                    <div className="flex items-center gap-2">
                      <Avatar
                        name={fromName || 'L'}
                        src={c.from.line?.picture_url}
                        className="h-10 w-10 shrink-0"
                        fallbackClassName="text-xs"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{fromName}</p>
                        {lineName && lineName !== fromName ? (
                          <p className="truncate text-xs text-muted-foreground">LINE: {lineName}</p>
                        ) : null}
                        {!fromIsLine(c) && c.from.phone ? (
                          <p className="truncate text-xs text-muted-foreground">{c.from.phone}</p>
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
                        <p className="truncate text-sm font-medium">{nameOf(c.keep)}</p>
                        {kanaOf(c.keep) ? (
                          <p className="truncate text-xs text-muted-foreground">{kanaOf(c.keep)}</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="sy-0.5 text-xs text-muted-foreground">
                      {c.keep.phone ? (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {c.keep.phone}
                        </div>
                      ) : null}
                      <div className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        来店{c.keep.visit_count}回
                        {c.keep.last_visit_at ? (
                          <span> (最終: {formatWhen(c.keep.last_visit_at, tz, 'short')})</span>
                        ) : null}
                      </div>
                      {c.keep.primary_staff_name ? <div>担当: {c.keep.primary_staff_name}</div> : null}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t pt-3">
                  <Badge variant="secondary" className="text-[10px]">
                    {matchLabel(c.reasons)}
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
          );
        })}
      </div>

      <AlertDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="顧客情報を統合しますか？"
        description={
          confirming ? (
            <>
              {fromIsLine(confirming)
                ? `LINE顧客「${nameOf(confirming.from)}」の情報（LINE連携、メッセージ、予約、カルテ）を `
                : `顧客「${nameOf(confirming.from)}」の情報（メッセージ、予約、カルテ）を `}
              既存顧客「{nameOf(confirming.keep)}」に統合します。
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
