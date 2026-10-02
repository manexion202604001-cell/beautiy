"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { karutesApi, type Karute } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { ChevronLeft, ChevronRight, FileText, User, Calendar } from "lucide-react";

export default function KarutesPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedKaruteId = searchParams.get("id");

  const [karutes, setKarutes] = useState<Karute[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailKarute, setDetailKarute] = useState<Karute | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    karutesApi
      .list()
      .then((data) => {
        // 共有されているカルテのみ表示
        const shared = data.karutes.filter((k) => k.is_shared_with_customer);
        setKarutes(shared);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Fetch karute detail when selectedKaruteId changes
  useEffect(() => {
    if (selectedKaruteId) {
      setDetailLoading(true);
      karutesApi
        .get(selectedKaruteId)
        .then((data) => setDetailKarute(data.karute))
        .catch(console.error)
        .finally(() => setDetailLoading(false));
    } else {
      setDetailKarute(null);
    }
  }, [selectedKaruteId]);

  const closeDetail = () => {
    router.push("/mypage/karutes");
  };

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
        <h1 className="text-xl font-bold">カルテ</h1>
      </div>

      {karutes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <FileText className="mb-3 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              共有されているカルテはありません
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {karutes.map((karute) => (
            <div
              key={karute.id}
              onClick={() => router.push(`/mypage/karutes?id=${karute.id}`)}
              className="cursor-pointer"
            >
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="space-y-1">
                    <p className="font-medium">{formatDate(karute.date)}</p>
                    <div className="flex items-center gap-1 text-sm text-muted-foreground">
                      <User className="h-3.5 w-3.5" />
                      <span>{karute.staff?.name || "担当者情報なし"}</span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      施術写真
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}

      {/* Karute Detail Dialog */}
      <Dialog open={!!selectedKaruteId} onOpenChange={(open) => !open && closeDetail()}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>カルテ詳細</DialogTitle>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          ) : detailKarute ? (
            <div className="space-y-4">
              {/* 基本情報 */}
              <Card>
                <CardContent className="space-y-4 pt-6">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-12 w-12">
                      <AvatarImage src={detailKarute.staff?.avatar_url || undefined} />
                      <AvatarFallback>
                        {detailKarute.staff?.name?.charAt(0) || "?"}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{detailKarute.staff?.name || "担当者"}</p>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Calendar className="h-3.5 w-3.5" />
                        <span>{formatDate(detailKarute.date)}</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* 施術写真 */}
              {detailKarute.images && detailKarute.images.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">施術写真</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-2">
                      {detailKarute.images.map((image) => (
                        <div key={image.id} className="space-y-1">
                          <img
                            src={image.image_url}
                            alt={image.caption || "施術写真"}
                            className="aspect-square w-full rounded-lg object-cover"
                          />
                          {image.caption && (
                            <p className="text-xs text-muted-foreground">
                              {image.caption}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    写真はまだありません
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">
              カルテが見つかりません
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
