"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { reservationsApi, type Reservation } from "@/lib/api";
import { formatDate, formatTime, formatPrice } from "@/lib/utils";
import { ChevronLeft, CalendarDays, Clock, User } from "lucide-react";

export default function HistoryPage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    reservationsApi
      .list()
      .then((data) => {
        // 完了済みの予約のみ表示
        const completed = data.reservations
          .filter((r) => r.status === "completed")
          .sort(
            (a, b) =>
              new Date(b.start_at).getTime() -
              new Date(a.start_at).getTime()
          );
        setReservations(completed);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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
        <h1 className="text-xl font-bold">来店履歴</h1>
      </div>

      {reservations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <CalendarDays className="mb-3 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">来店履歴はありません</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reservations.map((reservation) => (
            <Card key={reservation.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold">{reservation.menu?.name}</h3>
                    <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                      <User className="h-3.5 w-3.5" />
                      <span>{reservation.staff?.name || "担当者情報なし"}</span>
                    </div>
                  </div>
                  {reservation.menu && (
                    <span className="font-semibold text-primary">
                      {formatPrice(reservation.menu.price)}
                    </span>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <CalendarDays className="h-4 w-4" />
                    <span>{formatDate(reservation.start_at)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    <span>{formatTime(reservation.start_at)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
