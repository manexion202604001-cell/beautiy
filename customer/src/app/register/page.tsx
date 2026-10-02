"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  API_BASE_URL,
  getStoreId,
  setStoreId,
  storeApi,
  registerWithLiff,
} from "@/lib/api";
import {
  initLiff,
  isInLiffBrowser,
  getLiffAccessToken,
  closeLiffWindow,
} from "@/lib/liff";
import { CheckCircle2, Loader2 } from "lucide-react";

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      }
    >
      <RegisterPageInner />
    </Suspense>
  );
}

function RegisterPageInner() {
  const searchParams = useSearchParams();
  const type = (searchParams.get("type") as "returning" | "new") || "new";
  const storeIdParam = searchParams.get("store_id");

  const [liffAccessToken, setLiffAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  // Initialize LIFF and get access token
  useEffect(() => {
    if (storeIdParam) {
      setStoreId(storeIdParam);
    }

    (async () => {
      try {
        // 1. Check sessionStorage first
        const savedToken = sessionStorage.getItem("liff_access_token");
        if (savedToken) {
          setLiffAccessToken(savedToken);
          setLoading(false);
          return;
        }

        // 2. Initialize LIFF
        const storeData = await storeApi.get();
        const liffId = storeData.store?.line_liff_id;
        if (!liffId) {
          setError("LIFF設定が見つかりません");
          setLoading(false);
          return;
        }

        const initialized = await initLiff(liffId);
        if (!initialized) {
          setError("LIFFの初期化に失敗しました");
          setLoading(false);
          return;
        }

        if (!isInLiffBrowser()) {
          setError("LINEアプリからアクセスしてください");
          setLoading(false);
          return;
        }

        const token = getLiffAccessToken();
        if (token) {
          sessionStorage.setItem("liff_access_token", token);
          setLiffAccessToken(token);
        } else {
          setError("LINEの認証に失敗しました");
        }
      } catch (err) {
        console.error("[Register] Init failed:", err);
        setError("初期化に失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [storeIdParam]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !liffAccessToken) return;

    setSubmitting(true);
    setError(null);
    try {
      await registerWithLiff({
        store_id: getStoreId(),
        liff_access_token: liffAccessToken,
        name: name.trim(),
        phone: phone.trim() || undefined,
        type,
      });
      setSuccess(true);
    } catch (err) {
      console.error("[Register] Submit failed:", err);
      setError(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    closeLiffWindow();
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="flex flex-col items-center py-8 text-center">
            <CheckCircle2 className="h-16 w-16 text-primary mb-4" />
            <h2 className="text-lg font-bold mb-2">登録完了</h2>
            <p className="text-sm text-muted-foreground mb-6">
              ありがとうございます！
              <br />
              LINEチャットに戻ってご利用ください。
            </p>
            <Button onClick={handleClose} className="w-full">
              閉じる
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="pb-3">
          <h1 className="text-lg font-bold">
            {type === "returning" ? "お客様情報の連携" : "新規登録"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {type === "returning"
              ? "お名前とお電話番号をご入力いただくと、以前のカルテ情報を連携いたします。"
              : "お名前をご登録いただくと、スムーズにご予約が行えます。"}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">
                お名前 <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：山田 花子"
                required
                autoComplete="name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">
                電話番号{" "}
                <span className="text-muted-foreground text-xs">（任意）</span>
              </Label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="例：09012345678"
                autoComplete="tel"
              />
            </div>

            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={!name.trim() || submitting || !liffAccessToken}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  登録中...
                </>
              ) : (
                "登録する"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
