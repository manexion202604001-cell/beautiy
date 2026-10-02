"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/contexts/store-context";
import { reservations, staffApi, type Reservation, type Staff } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useRouter } from "next/navigation";
import { UserX, Phone, UserCog, X, MessageSquare } from "lucide-react";

export default function RetiredReservationsPage() {
  const router = useRouter();
  const { currentStore } = useStore();
  const [list, setList] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  // Reassign dialog state
  const [reassignTarget, setReassignTarget] = useState<Reservation | null>(null);
  const [activeStaff, setActiveStaff] = useState<Staff[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await reservations.retiredStaff();
      setList(res.reservations);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload on mount and when the current store changes
  useEffect(() => {
    load();
  }, [load, currentStore]);

  const openReassign = async (r: Reservation) => {
    setReassignTarget(r);
    setSelectedStaffId("");
    setActiveStaff([]);
    try {
      const res = await staffApi.list(r.store_id);
      setActiveStaff(res.staff.filter((s) => s.is_active === 1 && s.role !== "system_admin"));
    } catch (e) {
      console.error(e);
    }
  };

  const handleReassign = async () => {
    if (!reassignTarget || !selectedStaffId) return;
    setProcessing(true);
    try {
      await reservations.update(reassignTarget.id, { staff_id: selectedStaffId });
      setList((l) => l.filter((r) => r.id !== reassignTarget.id));
      setReassignTarget(null);
      alert("担当を変更しました");
    } catch (e) {
      console.error(e);
      alert("担当変更に失敗しました");
    } finally {
      setProcessing(false);
    }
  };

  const handleCancel = async (r: Reservation) => {
    if (!confirm(`${r.customer_name || "お客様"}の予約をキャンセルしますか？`)) return;
    setProcessing(true);
    try {
      await reservations.cancel(r.id);
      setList((l) => l.filter((x) => x.id !== r.id));
      alert("予約をキャンセルしました");
    } catch (e) {
      console.error(e);
      alert("キャンセルに失敗しました");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <UserX className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold">退職スタッフ担当の予約</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        退職したスタッフが担当のままの確定予約です。お客様に確認の上、担当を変更するかキャンセルしてください。
      </p>

      {loading ? (
        <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
      ) : list.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">退職スタッフ担当の予約はありません</div>
      ) : (
        <div className="space-y-2">
          {list.map((r) => (
            <Card key={r.id}>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-medium">{formatDate(r.start_at, "datetime")}</span>
                  {r.store_name && (
                    <Badge variant="outline" className="text-[10px]">{r.store_name}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-medium">{r.customer_name || "(名前なし)"}</span>
                  {r.customer_phone && (
                    <a href={`tel:${r.customer_phone}`} className="flex items-center gap-1 text-primary">
                      <Phone className="h-3 w-3" />
                      {r.customer_phone}
                    </a>
                  )}
                </div>
                {r.menu_name && (
                  <div className="text-xs text-muted-foreground">{r.menu_name}</div>
                )}
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">担当:</span>
                  <span>{r.staff_nickname || r.staff_name}</span>
                  <Badge variant="destructive" className="text-[10px]">退職</Badge>
                </div>
                {r.has_line === 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full mt-1"
                    style={{ borderColor: "#06C755", color: "#06C755" }}
                    onClick={() => router.push(`/messages?customer_id=${r.customer_id}`)}
                  >
                    <MessageSquare className="mr-1 h-4 w-4" />LINEでメッセージ
                  </Button>
                )}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" className="flex-1" disabled={processing} onClick={() => openReassign(r)}>
                    <UserCog className="mr-1 h-4 w-4" />担当変更
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1 text-destructive" disabled={processing} onClick={() => handleCancel(r)}>
                    <X className="mr-1 h-4 w-4" />キャンセル
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 担当変更ダイアログ */}
      <Dialog open={!!reassignTarget} onOpenChange={(o) => !o && setReassignTarget(null)}>
        <DialogContent className="max-w-md w-[calc(100vw-2rem)] flex flex-col">
          <DialogHeader>
            <DialogTitle>担当スタッフを変更</DialogTitle>
          </DialogHeader>
          {reassignTarget && (
            <div className="space-y-3 text-sm">
              <div className="text-xs text-muted-foreground">
                {formatDate(reassignTarget.start_at, "datetime")} / {reassignTarget.customer_name}
              </div>
              <Select value={selectedStaffId} onValueChange={setSelectedStaffId}>
                <SelectTrigger>
                  <SelectValue placeholder="変更先のスタッフを選択" />
                </SelectTrigger>
                <SelectContent>
                  {activeStaff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nickname || s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeStaff.length === 0 && (
                <p className="text-xs text-muted-foreground">変更可能なスタッフがいません</p>
              )}
            </div>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button className="w-full" disabled={processing || !selectedStaffId} onClick={handleReassign}>
              変更する
            </Button>
            <Button variant="ghost" className="w-full" disabled={processing} onClick={() => setReassignTarget(null)}>
              キャンセル
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
