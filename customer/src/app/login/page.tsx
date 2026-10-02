"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { authApi } from "@/lib/api";
import { Sparkles } from "lucide-react";

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    }>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await authApi.login({ email, password });
      router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="mb-8 flex flex-col items-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl"><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#1a1a1a' }}>SALO</span><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#b8936a' }}>GIC</span></h1>
        <p className="text-sm text-muted-foreground">
          ログインしてご予約ください
        </p>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-lg">ログイン</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">メールアドレス</Label>
              <Input
                id="email"
                type="email"
                placeholder="example@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">パスワード</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full" size="lg" disabled={loading}>
              {loading ? "ログイン中..." : "ログイン"}
            </Button>
          </form>

          <div className="relative my-6">
            <Separator />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
              または
            </span>
          </div>

          <Button
            variant="outline"
            className="w-full"
            size="lg"
            onClick={() => {
              // LINE ログイン処理
              window.location.href = "/api/auth/line";
            }}
          >
            <svg
              className="mr-2 h-5 w-5"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .348-.281.63-.63.63h-2.223v1.396h2.223c.349 0 .63.284.63.63 0 .349-.281.63-.63.63h-2.854c-.348 0-.63-.281-.63-.63V8.108c0-.349.282-.63.63-.63h2.854c.349 0 .63.281.63.63 0 .347-.281.63-.63.63h-2.223v1.125h2.223zm-4.592 3.287c0 .277-.18.525-.436.614-.064.02-.133.033-.2.033-.218 0-.425-.11-.544-.3l-2.445-3.348v3.001c0 .349-.282.63-.63.63-.349 0-.63-.281-.63-.63V8.108c0-.276.18-.525.435-.614.063-.02.131-.033.199-.033.22 0 .426.11.545.3l2.445 3.345V8.108c0-.349.281-.63.63-.63.347 0 .63.281.63.63v5.042zm-5.684 0c0 .349-.282.63-.63.63-.348 0-.63-.281-.63-.63V8.108c0-.349.282-.63.63-.63.348 0 .63.281.63.63v5.042zm-1.924 0c0 .348-.281.63-.63.63h-2.853c-.349 0-.63-.282-.63-.63V8.108c0-.349.281-.63.63-.63.348 0 .63.281.63.63v4.411h2.223c.348 0 .63.282.63.631zM12 0C5.373 0 0 4.925 0 11c0 5.47 4.822 10.019 11.048 10.844v-3.727h-2.49v-3.083h2.49v-2.348c0-2.456 1.496-3.808 3.696-3.808 1.05 0 2.148.188 2.148.188v2.41h-1.21c-1.193 0-1.565.739-1.565 1.498v1.84h2.714l-.434 3.083h-2.28v3.727C19.178 21.019 24 16.47 24 11c0-6.075-5.373-11-12-11z" />
            </svg>
            LINEでログイン
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
