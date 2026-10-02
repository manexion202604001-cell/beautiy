"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setErrorCode("");
    setLoading(true);

    try {
      await auth.login(email, password);
      router.push("/dashboard");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "ログインに失敗しました";
      setError(message);
      // Check for email not verified error
      if (message.includes("未認証")) {
        setErrorCode("EMAIL_NOT_VERIFIED");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl"><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#1a1a1a' }}>SALO</span><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#b8936a' }}>GIC</span><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 200, color: '#b8936a' }}> Staff</span></CardTitle>
          <CardDescription>スタッフ用アプリにログイン</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
                <p>{error}</p>
                {errorCode === "EMAIL_NOT_VERIFIED" && (
                  <Link href="/verify-email" className="mt-1 block underline">
                    認証メールを再送する
                  </Link>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">メールアドレス</Label>
              <Input
                id="email"
                type="email"
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">パスワード</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "ログイン中..." : "ログイン"}
            </Button>
            <div className="text-center">
              <Link href="/forgot-password" className="text-sm text-muted-foreground hover:underline">
                パスワードを忘れた方
              </Link>
            </div>
            <div className="text-center text-sm text-muted-foreground">
              アカウントをお持ちでない方は{" "}
              <Link href="/register" className="text-primary underline">
                アカウント登録
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
