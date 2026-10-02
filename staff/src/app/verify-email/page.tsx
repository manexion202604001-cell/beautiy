"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import { auth } from "@/lib/api";

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"loading" | "success" | "error" | "no-token">("loading");
  const [message, setMessage] = useState("");
  const [resendEmail, setResendEmail] = useState("");
  const [resendLoading, setResendLoading] = useState(false);
  const [resendMessage, setResendMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("no-token");
      return;
    }

    const verify = async () => {
      try {
        const result = await auth.verifyEmail(token);
        setMessage(result.message);
        setStatus("success");
      } catch (err) {
        setMessage(err instanceof Error ? err.message : "認証に失敗しました");
        setStatus("error");
      }
    };

    verify();
  }, [token]);

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resendEmail) return;
    setResendLoading(true);
    setResendMessage("");
    try {
      const result = await auth.resendVerification(resendEmail);
      setResendMessage(result.message);
    } catch (err) {
      setResendMessage(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setResendLoading(false);
    }
  };

  return (
    <>
      {status === "loading" && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground">認証中...</p>
        </div>
      )}

      {status === "success" && (
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle className="h-12 w-12 text-green-500" />
          <p className="font-medium">{message}</p>
          <Button asChild className="mt-4 w-full">
            <Link href="/login">ログインページへ</Link>
          </Button>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-3 py-4">
            <XCircle className="h-12 w-12 text-destructive" />
            <p className="text-destructive">{message}</p>
          </div>
          <div className="border-t pt-4">
            <CardDescription className="mb-3">認証メールを再送する</CardDescription>
            <form onSubmit={handleResend} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="resendEmail">メールアドレス</Label>
                <Input
                  id="resendEmail"
                  type="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  placeholder="email@example.com"
                  required
                />
              </div>
              <Button type="submit" variant="outline" className="w-full" disabled={resendLoading}>
                {resendLoading ? "送信中..." : "認証メールを再送"}
              </Button>
              {resendMessage && (
                <p className="text-sm text-muted-foreground text-center">{resendMessage}</p>
              )}
            </form>
          </div>
        </div>
      )}

      {status === "no-token" && (
        <div className="space-y-4">
          <p className="text-center text-muted-foreground">認証メールのリンクからアクセスしてください。</p>
          <div className="border-t pt-4">
            <CardDescription className="mb-3">認証メールを再送する</CardDescription>
            <form onSubmit={handleResend} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="resendEmail">メールアドレス</Label>
                <Input
                  id="resendEmail"
                  type="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  placeholder="email@example.com"
                  required
                />
              </div>
              <Button type="submit" variant="outline" className="w-full" disabled={resendLoading}>
                {resendLoading ? "送信中..." : "認証メールを再送"}
              </Button>
              {resendMessage && (
                <p className="text-sm text-muted-foreground text-center">{resendMessage}</p>
              )}
            </form>
          </div>
        </div>
      )}

      <div className="text-center">
        <Link href="/login" className="text-sm text-muted-foreground underline">
          ログインページに戻る
        </Link>
      </div>
    </>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">メールアドレス認証</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <Suspense
            fallback={
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="text-muted-foreground">読み込み中...</p>
              </div>
            }
          >
            <VerifyEmailContent />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
