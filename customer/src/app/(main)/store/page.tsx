"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { storeApi, type Store } from "@/lib/api";
import { ChevronLeft, MapPin, Phone, Mail, Clock } from "lucide-react";

const dayNames = ["日", "月", "火", "水", "木", "金", "土"];

export default function StorePage() {
  const [store, setStore] = useState<Store | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    storeApi
      .get()
      .then((data) => setStore(data.store))
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

  if (!store) {
    return (
      <div className="p-4">
        <p>店舗情報が見つかりません</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Link href="/">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="text-xl font-bold">店舗情報</h1>
      </div>

      {/* 店舗ヘッダー */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            {store.logo_url ? (
              <img
                src={store.logo_url}
                alt={store.name}
                className="h-16 w-16 rounded-lg object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-primary/10 text-2xl font-bold text-primary">
                {store.name.charAt(0)}
              </div>
            )}
            <div>
              <h2 className="text-xl font-bold">{store.name}</h2>
              {store.description && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {store.description}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 連絡先 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">連絡先</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {store.address && (
            <div className="flex items-start gap-3">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">住所</p>
                <p className="text-sm text-muted-foreground">{store.address}</p>
                <a
                  href={`https://maps.google.com/?q=${encodeURIComponent(store.address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm text-primary"
                >
                  Google マップで開く
                </a>
              </div>
            </div>
          )}

          {store.phone && (
            <div className="flex items-start gap-3">
              <Phone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">電話番号</p>
                <a
                  href={`tel:${store.phone}`}
                  className="text-sm text-primary"
                >
                  {store.phone}
                </a>
              </div>
            </div>
          )}

          {store.email && (
            <div className="flex items-start gap-3">
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">メールアドレス</p>
                <a
                  href={`mailto:${store.email}`}
                  className="text-sm text-primary"
                >
                  {store.email}
                </a>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 営業時間 */}
      {store.business_hours && store.business_hours.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-5 w-5" />
              営業時間
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {store.business_hours
                .sort((a, b) => a.day_of_week - b.day_of_week)
                .map((hour) => (
                  <div
                    key={hour.day_of_week}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="font-medium">
                      {dayNames[hour.day_of_week]}曜日
                    </span>
                    <span className={hour.is_closed ? "text-muted-foreground" : ""}>
                      {hour.is_closed
                        ? "定休日"
                        : `${hour.open_time} - ${hour.close_time}`}
                    </span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 予約ボタン */}
      <Link href="/reserve">
        <Button className="w-full" size="lg">
          予約する
        </Button>
      </Link>
    </div>
  );
}
