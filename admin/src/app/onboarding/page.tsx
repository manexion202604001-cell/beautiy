"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth, tokenStorage } from "@/lib/api";

type OwnerType = "individual" | "company";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Step 1: Company info
  const [ownerType, setOwnerType] = useState<OwnerType>("individual");
  const [companyName, setCompanyName] = useState("");
  const [companyPostalCode, setCompanyPostalCode] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [companyEmail, setCompanyEmail] = useState("");

  // Step 2: Store info
  const [storeName, setStoreName] = useState("");
  const [storePostalCode, setStorePostalCode] = useState("");
  const [storeAddress, setStoreAddress] = useState("");
  const [storePhone, setStorePhone] = useState("");
  const [storeEmail, setStoreEmail] = useState("");

  // Step 3: Account info
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Check auth on mount
  useEffect(() => {
    const token = tokenStorage.get();
    if (!token) {
      router.push("/login");
      return;
    }
    // Verify the user needs onboarding
    auth.me().then(({ staff }) => {
      if (staff.onboarding_completed === 1) {
        router.push("/dashboard");
      } else {
        setCheckingAuth(false);
      }
    }).catch(() => {
      router.push("/login");
    });
  }, [router]);

  const handleNext = () => {
    setError("");
    if (step === 1) {
      if (ownerType === "company" && !companyName) {
        setError("法人の場合は会社名を入力してください");
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!storeName) {
        setError("店舗名は必須です");
        return;
      }
      setStep(3);
    }
  };

  const handleBack = () => {
    setError("");
    setStep(step - 1);
  };

  const handleSubmit = async () => {
    setError("");

    if (!email) {
      setError("メールアドレスは必須です");
      return;
    }
    if (password.length < 8) {
      setError("パスワードは8文字以上にしてください");
      return;
    }
    if (password !== confirmPassword) {
      setError("パスワードが一致しません");
      return;
    }

    setLoading(true);
    try {
      await auth.completeOnboarding({
        owner_type: ownerType,
        company_name: companyName || undefined,
        company_postal_code: companyPostalCode || undefined,
        company_phone: companyPhone || undefined,
        company_address: companyAddress || undefined,
        company_email: companyEmail || undefined,
        store_name: storeName,
        store_postal_code: storePostalCode || undefined,
        store_address: storeAddress || undefined,
        store_phone: storePhone || undefined,
        store_email: storeEmail || undefined,
        email,
        password,
      });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  if (checkingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <span style={{ fontFamily: "var(--font-montserrat)", fontWeight: 700, color: "#1a1a1a" }}>SALO</span>
            <span style={{ fontFamily: "var(--font-montserrat)", fontWeight: 700, color: "#b8936a" }}>GIC</span>
          </CardTitle>
          <CardDescription>初期設定（ステップ {step}/3）</CardDescription>
          {/* Progress bar */}
          <div className="flex gap-1 mt-3">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={`h-1.5 flex-1 rounded-full ${s <= step ? "bg-primary" : "bg-muted"}`}
              />
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive mb-4">
              {error}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-medium">会社・事業者情報</h3>
              <div className="space-y-2">
                <Label>事業形態</Label>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant={ownerType === "individual" ? "default" : "outline"}
                    className="flex-1"
                    onClick={() => setOwnerType("individual")}
                  >
                    個人事業主
                  </Button>
                  <Button
                    type="button"
                    variant={ownerType === "company" ? "default" : "outline"}
                    className="flex-1"
                    onClick={() => setOwnerType("company")}
                  >
                    法人
                  </Button>
                </div>
              </div>
              {ownerType === "company" && (
                <div className="space-y-2">
                  <Label htmlFor="companyName">会社名 *</Label>
                  <Input
                    id="companyName"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="株式会社サンプル"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="companyPostalCode">郵便番号</Label>
                <Input
                  id="companyPostalCode"
                  value={companyPostalCode}
                  onChange={(e) => setCompanyPostalCode(e.target.value)}
                  placeholder="000-0000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companyAddress">住所</Label>
                <Input
                  id="companyAddress"
                  value={companyAddress}
                  onChange={(e) => setCompanyAddress(e.target.value)}
                  placeholder="東京都渋谷区..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companyPhone">電話番号</Label>
                <Input
                  id="companyPhone"
                  type="tel"
                  value={companyPhone}
                  onChange={(e) => setCompanyPhone(e.target.value)}
                  placeholder="03-0000-0000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companyEmail">メールアドレス</Label>
                <Input
                  id="companyEmail"
                  type="email"
                  value={companyEmail}
                  onChange={(e) => setCompanyEmail(e.target.value)}
                  placeholder="info@example.com"
                />
              </div>
              <Button className="w-full" onClick={handleNext}>
                次へ
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h3 className="font-medium">店舗情報</h3>
              <p className="text-sm text-muted-foreground">最初の店舗を登録します。後から変更・追加できます。</p>
              <div className="space-y-2">
                <Label htmlFor="storeName">店舗名 *</Label>
                <Input
                  id="storeName"
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder="ビューティーサロン 渋谷店"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storePostalCode">郵便番号</Label>
                <Input
                  id="storePostalCode"
                  value={storePostalCode}
                  onChange={(e) => setStorePostalCode(e.target.value)}
                  placeholder="000-0000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storeAddress">住所</Label>
                <Input
                  id="storeAddress"
                  value={storeAddress}
                  onChange={(e) => setStoreAddress(e.target.value)}
                  placeholder="東京都渋谷区..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storePhone">電話番号</Label>
                <Input
                  id="storePhone"
                  type="tel"
                  value={storePhone}
                  onChange={(e) => setStorePhone(e.target.value)}
                  placeholder="03-0000-0000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="storeEmail">メールアドレス</Label>
                <Input
                  id="storeEmail"
                  type="email"
                  value={storeEmail}
                  onChange={(e) => setStoreEmail(e.target.value)}
                  placeholder="shop@example.com"
                />
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={handleBack}>
                  戻る
                </Button>
                <Button className="flex-1" onClick={handleNext}>
                  次へ
                </Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h3 className="font-medium">アカウント設定</h3>
              <p className="text-sm text-muted-foreground">
                メールアドレスとパスワードを設定します。この情報でスタッフアプリ（staff.example.com）にもログインできます。
              </p>
              <div className="space-y-2">
                <Label htmlFor="email">メールアドレス *</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@example.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">新しいパスワード *</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8文字以上"
                  minLength={8}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">パスワード（確認） *</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="パスワードを再入力"
                  minLength={8}
                />
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={handleBack}>
                  戻る
                </Button>
                <Button className="flex-1" onClick={handleSubmit} disabled={loading}>
                  {loading ? "設定中..." : "設定完了"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
