"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [staffCode, setStaffCode] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("パスワードが一致しません");
      return;
    }

    if (password.length < 8) {
      setError("パスワードは8文字以上にしてください");
      return;
    }

    setLoading(true);
    try {
      const result = await auth.register({ name, email, password });
      setStaffCode(result.staff_code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  if (staffCode) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">認証メールを送信しました</CardTitle>
            <CardDescription>メールをご確認ください</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>ご登録いただいたメールアドレスに認証メールを送信しました。</p>
              <p>メールに記載されたリンクをクリックして、メールアドレスの認証を完了してください。</p>
            </div>
            <Button asChild className="w-full">
              <Link href="/login">ログインページへ</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl"><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#1a1a1a' }}>SALO</span><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#b8936a' }}>GIC</span><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 200, color: '#b8936a' }}> Staff</span></CardTitle>
          <CardDescription>アカウント登録</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">氏名</Label>
              <Input
                id="name"
                type="text"
                placeholder="山田 太郎"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
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
                placeholder="8文字以上"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">パスワード（確認）</Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="パスワードを再入力"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "登録中..." : "アカウント登録"}
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              既にアカウントをお持ちの方は{" "}
              <Link href="/login" className="text-primary underline">
                ログイン
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
