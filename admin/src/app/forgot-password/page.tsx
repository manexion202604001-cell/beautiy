"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [notRegistered, setNotRegistered] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotRegistered(false);
    setLoading(true);

    try {
      const result = await auth.forgotPassword(email);
      if (result.registered === false) {
        setNotRegistered(true);
      } else {
        setSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#1a1a1a' }}>SALO</span>
            <span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#b8936a' }}>GIC</span>
          </CardTitle>
          <CardDescription>パスワードリセット</CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-muted-foreground">
                パスワードリセットのリンクをメールで送信しました。メールをご確認ください。
              </p>
              <Link href="/login">
                <Button variant="outline" className="w-full">ログインに戻る</Button>
              </Link>
            </div>
          ) : notRegistered ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-destructive">
                このメールアドレスは登録されていません。
              </p>
              <Link href="/login">
                <Button variant="outline" className="w-full">ログインに戻る</Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                登録したメールアドレスを入力してください。パスワードリセットのリンクを送信します。
              </p>
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
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "送信中..." : "リセットリンクを送信"}
              </Button>
              <div className="text-center">
                <Link href="/login" className="text-sm text-muted-foreground hover:underline">
                  ログインに戻る
                </Link>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
