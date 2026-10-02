"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { authApi, type Customer } from "@/lib/api";
import {
  User,
  CalendarDays,
  History,
  FileText,
  MessageCircle,
  Settings,
  LogOut,
  ChevronRight,
  Store,
  ClipboardList,
} from "lucide-react";

const menuItems = [
  {
    href: "/mypage/reservations",
    icon: CalendarDays,
    label: "予約一覧",
    description: "今後のご予約を確認",
  },
  {
    href: "/mypage/history",
    icon: History,
    label: "来店履歴",
    description: "過去のご来店記録",
  },
  {
    href: "/mypage/karutes",
    icon: FileText,
    label: "カルテ",
    description: "施術記録を確認",
  },
  {
    href: "/mypage/counseling",
    icon: ClipboardList,
    label: "カウンセリングシート",
    description: "事前問診・ご要望の入力",
  },
  {
    href: "/messages",
    icon: MessageCircle,
    label: "メッセージ",
    description: "サロンとのやり取り",
  },
  {
    href: "/store",
    icon: Store,
    label: "店舗情報",
    description: "アクセス・営業時間",
  },
  {
    href: "/mypage/profile",
    icon: Settings,
    label: "プロフィール設定",
    description: "お客様情報の変更",
  },
];

export default function MyPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi
      .me()
      .then((data) => setCustomer(data.customer))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = async () => {
    try {
      await authApi.logout();
      router.push("/login");
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-bold">マイページ</h1>

      {/* プロフィールカード */}
      <Card>
        <CardContent className="flex items-center gap-4 p-4">
          <Avatar className="h-16 w-16">
            <AvatarFallback className="bg-primary/10 text-xl text-primary">
              {customer?.name?.charAt(0) || "?"}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{customer?.name}</h2>
            <p className="text-sm text-muted-foreground">{customer?.email}</p>
            <p className="text-sm text-muted-foreground">
              来店回数: {customer?.visit_count || 0}回
            </p>
          </div>
        </CardContent>
      </Card>

      {/* メニュー */}
      <Card>
        <CardContent className="divide-y p-0">
          {menuItems.map((item, index) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/50"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                <item.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-medium">{item.label}</p>
                <p className="text-sm text-muted-foreground">
                  {item.description}
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
            </Link>
          ))}
        </CardContent>
      </Card>

      {/* ログアウト */}
      <Button
        variant="outline"
        className="w-full"
        onClick={handleLogout}
      >
        <LogOut className="mr-2 h-4 w-4" />
        ログアウト
      </Button>
    </div>
  );
}
