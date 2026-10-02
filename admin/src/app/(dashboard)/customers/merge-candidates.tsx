"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { User, Phone, Calendar, GitMerge, X } from "lucide-react";
import { mergeCandidates, type MergeCandidate } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";

export default function MergeCandidates() {
  const { currentStore } = useStore();
  const [candidates, setCandidates] = useState<MergeCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [mergeTarget, setMergeTarget] = useState<MergeCandidate | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  const fetchCandidates = useCallback(async () => {
    if (!currentStore) return;
    setLoading(true);
    try {
      const data = await mergeCandidates.list(currentStore.id);
      setCandidates(data.candidates);
    } catch (error) {
      console.error("Failed to fetch merge candidates:", error);
    } finally {
      setLoading(false);
    }
  }, [currentStore?.id]);

  useEffect(() => {
    fetchCandidates();
  }, [fetchCandidates]);

  const handleMerge = async (candidate: MergeCandidate) => {
    setProcessing(candidate.id);
    try {
      await mergeCandidates.merge(candidate.id);
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
    } catch (error) {
      console.error("Failed to merge:", error);
      alert("統合に失敗しました");
    } finally {
      setProcessing(null);
      setMergeTarget(null);
    }
  };

  const handleSkip = async (candidate: MergeCandidate) => {
    setProcessing(candidate.id);
    try {
      await mergeCandidates.skip(candidate.id);
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
    } catch (error) {
      console.error("Failed to skip:", error);
      alert("スキップに失敗しました");
    } finally {
      setProcessing(null);
    }
  };

  if (loading) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        読み込み中...
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <GitMerge className="mx-auto h-12 w-12 mb-2 opacity-50" />
        <p>統合候補はありません</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {candidates.map((candidate) => (
          <Card key={candidate.id}>
            <CardContent className="p-4">
              {/* Two columns: LINE customer vs Existing customer */}
              <div className="grid grid-cols-2 gap-4">
                {/* LINE customer (left) */}
                <div className="space-y-2">
                  <Badge variant="outline" className="text-[10px] border-green-400 text-green-600">
                    LINE
                  </Badge>
                  <div className="flex items-center gap-2">
                    <Avatar className="h-10 w-10 shrink-0">
                      {candidate.line_customer_avatar && (
                        <AvatarImage src={candidate.line_customer_avatar} />
                      )}
                      <AvatarFallback className="text-xs">
                        {candidate.line_customer_name?.charAt(0) || "L"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {candidate.line_customer_name}
                      </p>
                      {candidate.line_display_name && candidate.line_display_name !== candidate.line_customer_name && (
                        <p className="text-xs text-muted-foreground truncate">
                          LINE: {candidate.line_display_name}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Existing customer (right) */}
                <div className="space-y-2">
                  <Badge variant="outline" className="text-[10px] border-blue-400 text-blue-600">
                    既存
                  </Badge>
                  <div className="flex items-center gap-2">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                      <User className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {candidate.existing_customer_name}
                      </p>
                      {candidate.existing_customer_name_kana && (
                        <p className="text-xs text-muted-foreground truncate">
                          {candidate.existing_customer_name_kana}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {candidate.existing_customer_phone && (
                      <div className="flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        {candidate.existing_customer_phone}
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      来店{candidate.existing_customer_visit_count}回
                      {candidate.existing_customer_last_visit_at && (
                        <span> (最終: {formatDate(candidate.existing_customer_last_visit_at, "short")})</span>
                      )}
                    </div>
                    {candidate.existing_customer_staff_name && (
                      <div>担当: {candidate.existing_customer_staff_name}</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Match info + Actions */}
              <div className="mt-3 flex items-center justify-between border-t pt-3">
                <Badge variant="secondary" className="text-[10px]">
                  {candidate.match_type === "name" ? "名前一致" : candidate.match_type === "phone" ? "電話番号一致" : "読み仮名一致"}
                </Badge>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSkip(candidate)}
                    disabled={processing === candidate.id}
                  >
                    <X className="mr-1 h-3 w-3" />
                    スキップ
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setMergeTarget(candidate)}
                    disabled={processing === candidate.id}
                  >
                    <GitMerge className="mr-1 h-3 w-3" />
                    統合する
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Merge confirmation dialog */}
      <AlertDialog open={!!mergeTarget} onOpenChange={(open) => !open && setMergeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>顧客情報を統合しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              LINE顧客「{mergeTarget?.line_customer_name}」の情報（LINE連携、メッセージ、予約、カルテ）を
              既存顧客「{mergeTarget?.existing_customer_name}」に統合します。
              <br /><br />
              この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => mergeTarget && handleMerge(mergeTarget)}
              disabled={processing === mergeTarget?.id}
            >
              {processing === mergeTarget?.id ? "統合中..." : "統合する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
