"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  storeApi,
  reservationsApi,
  authApi,
  type Store,
  type Reservation,
  type Customer,
} from "@/lib/api";
import {
  formatDate,
  formatTime,
  formatDuration,
  getReservationStatusLabel,
  getReservationStatusColor,
} from "@/lib/utils";
import {
  CalendarDays,
  Clock,
  MapPin,
  Phone,
  ChevronRight,
  Sparkles,
} from "lucide-react";

export default function HomePage() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [nextReservation, setNextReservation] = useState<Reservation | null>(
    null
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      authApi.me(),
      storeApi.get(),
      reservationsApi.list(),
    ])
      .then(([authData, storeData, reservationsData]) => {
        setCustomer(authData.customer);
        setStore(storeData.store);
        // 次回の予約を取得（confirmed/pendingで未来の日付）
        const upcoming = reservationsData.reservations
          .filter(
            (r) =>
              (r.status === "confirmed" || r.status === "pending") &&
              new Date(r.start_at) > new Date()
          )
          .sort(
            (a, b) =>
              new Date(a.start_at).getTime() -
              new Date(b.start_at).getTime()
          )[0];
        setNextReservation(upcoming || null);
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
    <div className="space-y-6 p-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">こんにちは</p>
          <h1 className="text-xl font-bold">{customer?.name} さん</h1>
        </div>
        {store?.logo_url && (
          <img
            src={store.logo_url}
            alt={store.name}
            className="h-10 w-10 rounded-full object-cover"
          />
        )}
      </div>

      {/* 次回予約 */}
      {nextReservation ? (
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-primary/10">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="h-5 w-5 text-primary" />
              次回のご予約
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold">{nextReservation.menu?.name}</p>
                <p className="text-sm text-muted-foreground">
                  担当: {nextReservation.staff_name || nextReservation.staff?.name || "指名なし"}
                </p>
              </div>
              <Badge className={getReservationStatusColor(nextReservation.status)}>
                {getReservationStatusLabel(nextReservation.status)}
              </Badge>
            </div>
            <Separator />
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-1">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                <span>{formatDate(nextReservation.start_at)}</span>
              </div>
              <div className="flex items-center gap-1">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span>{formatTime(nextReservation.start_at)}</span>
              </div>
            </div>
            <Link href={`/mypage/reservations/${nextReservation.id}`}>
              <Button variant="outline" className="w-full">
                予約詳細を見る
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8">
            <Sparkles className="mb-3 h-12 w-12 text-muted-foreground/50" />
            <p className="mb-4 text-center text-muted-foreground">
              現在予約はありません
            </p>
            <Link href="/reserve">
              <Button>
                予約する
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* クイックアクション */}
      <div className="grid grid-cols-2 gap-3">
        <Link href="/reserve">
          <Card className="transition-shadow hover:shadow-md">
            <CardContent className="flex flex-col items-center justify-center py-6">
              <CalendarDays className="mb-2 h-8 w-8 text-primary" />
              <span className="font-medium">予約する</span>
            </CardContent>
          </Card>
        </Link>
        <Link href="/mypage/reservations">
          <Card className="transition-shadow hover:shadow-md">
            <CardContent className="flex flex-col items-center justify-center py-6">
              <Clock className="mb-2 h-8 w-8 text-primary" />
              <span className="font-medium">予約一覧</span>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* 店舗情報 */}
      {store && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">店舗情報</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <h3 className="font-semibold">{store.name}</h3>
            {store.address && (
              <div className="flex items-start gap-2 text-sm">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{store.address}</span>
              </div>
            )}
            {store.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <a href={`tel:${store.phone}`} className="text-primary">
                  {store.phone}
                </a>
              </div>
            )}
            <Link href="/store">
              <Button variant="outline" className="mt-2 w-full">
                詳細を見る
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
