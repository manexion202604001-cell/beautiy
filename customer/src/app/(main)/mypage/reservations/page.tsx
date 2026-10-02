"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { reservationsApi, type Reservation } from "@/lib/api";
import {
  formatDate,
  formatTime,
  getReservationStatusLabel,
  getReservationStatusColor,
} from "@/lib/utils";
import { CalendarDays, Clock, User, ChevronLeft, Check, MessageSquare } from "lucide-react";

export default function ReservationsPage() {
  const searchParams = useSearchParams();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (searchParams.get("success") === "1") {
      setShowSuccess(true);
    }
    loadReservations();
  }, [searchParams]);

  const loadReservations = () => {
    reservationsApi
      .list()
      .then((data) => setReservations(data.reservations))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  const upcomingReservations = reservations.filter(
    (r) =>
      (r.status === "pending" || r.status === "confirmed") &&
      new Date(r.start_at) > new Date()
  );

  const pastReservations = reservations.filter(
    (r) =>
      r.status === "completed" ||
      r.status === "cancelled" ||
      new Date(r.start_at) <= new Date()
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Link href="/mypage">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="text-xl font-bold">予約一覧</h1>
      </div>

      <Tabs defaultValue="upcoming">
        <TabsList className="w-full">
          <TabsTrigger value="upcoming" className="flex-1">
            今後の予約
          </TabsTrigger>
          <TabsTrigger value="past" className="flex-1">
            過去の予約
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="mt-4 space-y-3">
          {upcomingReservations.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                <CalendarDays className="mb-3 h-12 w-12 text-muted-foreground/50" />
                <p className="text-muted-foreground">予約はありません</p>
                <Link href="/reserve" className="mt-4">
                  <Button>予約する</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            upcomingReservations.map((reservation) => (
              <ReservationCard
                key={reservation.id}
                reservation={reservation}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="past" className="mt-4 space-y-3">
          {pastReservations.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                過去の予約はありません
              </CardContent>
            </Card>
          ) : (
            pastReservations.map((reservation) => (
              <ReservationCard key={reservation.id} reservation={reservation} />
            ))
          )}
        </TabsContent>
      </Tabs>

      {/* 予約完了ダイアログ */}
      <Dialog open={showSuccess} onOpenChange={setShowSuccess}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
                <Check className="h-5 w-5 text-green-600" />
              </div>
              お申し込みが完了しました
            </DialogTitle>
            <p className="text-xs text-red-500 font-medium text-center mt-1">※まだ予約は確定しておりません</p>
            <DialogDescription className="text-left whitespace-pre-line">
              {`ご予約のお申し込みありがとうございます！

ただいまスタッフがスケジュールを確認しております。
このメッセージの時点では、予約はまだ「仮受付」の状態です。

確認ができ次第、すぐにこちらのトーク（メール）からお返事いたします。
確定の連絡まで、いましばらくお待ちくださいませ。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setShowSuccess(false)}>閉じる</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReservationCard({
  reservation,
}: {
  reservation: Reservation;
}) {
  const canCancel =
    (reservation.status === "pending" || reservation.status === "confirmed") &&
    new Date(reservation.start_at) > new Date();

  const router = useRouter();
  const isRetiredStaff = !!reservation.staff_id && reservation.staff_is_active === 0;
  const handleMessageClick = () => {
    if (isRetiredStaff) {
      const ok = window.confirm(
        `${reservation.staff_name || "担当スタッフ"}が退職したため、担当スタッフ宛てのメッセージは送れません。ご不便をおかけして申し訳ありません。\n店舗へメッセージを送ることは可能ですが、送りますか？`
      );
      if (!ok) return;
      router.push("/messages"); // 店舗宛て（staff_idなし）
    } else {
      router.push(`/messages${reservation.staff_id ? `?staff_id=${reservation.staff_id}` : ""}`);
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0 flex-1">
            <h3 className="font-semibold">{reservation.menu_name || reservation.menu?.name || "メニュー未設定"}</h3>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <User className="h-3.5 w-3.5 shrink-0" />
              <span>担当: {reservation.staff_name || reservation.staff?.name || "指名なし"}</span>
            </div>
          </div>
          <Badge className={`shrink-0 ${getReservationStatusColor(reservation.status)}`}>
            {getReservationStatusLabel(reservation.status)}
          </Badge>
        </div>

        <div className="mt-3 flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span>{formatDate(reservation.start_at)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span>{formatTime(reservation.start_at)}</span>
          </div>
        </div>

        {canCancel && (
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={handleMessageClick}>
              <MessageSquare className="h-3.5 w-3.5 mr-1" />
              相談する
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
