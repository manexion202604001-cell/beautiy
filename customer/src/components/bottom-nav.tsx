"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Home, CalendarPlus, User, MessageCircle } from "lucide-react";

const navItems = [
  { href: "/", icon: Home, label: "ホーム" },
  { href: "/reserve", icon: CalendarPlus, label: "予約" },
  { href: "/messages", icon: MessageCircle, label: "メッセージ" },
  { href: "/mypage", icon: User, label: "マイページ" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background safe-area-bottom">
      <div className="mx-auto flex max-w-md items-center justify-around">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 py-3 text-xs transition-colors",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <item.icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
