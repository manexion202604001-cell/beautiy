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
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await auth.login(email, password);
      // Redirect to onboarding if not completed
      if (result.onboarding_completed === false) {
        router.push("/onboarding");
      } else {
        router.push("/dashboard");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl"><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#1a1a1a' }}>SALO</span><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#b8936a' }}>GIC</span></CardTitle>
          <CardDescription>スタッフ用管理画面にログイン</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">メールアドレス または ログインID</Label>
              <Input
                id="email"
                type="text"
                placeholder="email@example.com または owner_xxxxx"
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
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
