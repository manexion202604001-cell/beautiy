"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Calendar,
  Users,
  MessageSquare,
  Menu,
  UserCog,
  Settings,
  Home,
  LogOut,
  Store,
  ChevronDown,
  CalendarCog,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { auth, type Staff } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useStore } from "@/contexts/store-context";

const navigation = [
  { name: "ダッシュボード", href: "/dashboard", icon: Home },
  { name: "予約管理", href: "/reservations", icon: Calendar },
  { name: "顧客管理", href: "/karutes", icon: Users },
  { name: "同意書一覧", href: "/walkin-intakes", icon: FileText },
  { name: "メッセージ", href: "/messages", icon: MessageSquare },
  { name: "メニュー", href: "/menus", icon: Menu, roles: ["system_admin", "owner", "manager"] },
  { name: "スタッフ", href: "/staff", icon: UserCog, roles: ["system_admin", "owner", "manager"] },
  { name: "予約受付設定", href: "/reservation-settings", icon: CalendarCog, roles: ["system_admin", "owner", "manager"] },
  { name: "店舗設定", href: "/store-settings", icon: Store, roles: ["system_admin", "owner", "manager"] },
  { name: "設定", href: "/settings", icon: Settings, roles: ["system_admin", "owner"] },
];

type SidebarProps = {
  staff: Staff;
};

export function Sidebar({ staff }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { currentStore, stores, setCurrentStore } = useStore();

  const filteredNav = navigation.filter(
    (item) => !item.roles || item.roles.includes(staff.role)
  );

  const handleLogout = async () => {
    await auth.logout();
    router.push("/login");
  };

  return (
    <div className="hidden md:flex h-full w-64 flex-col border-r bg-card">
      <div className="flex h-16 items-center px-6">
        <h1 className="text-xl"><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#1a1a1a' }}>SALO</span><span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#b8936a' }}>GIC</span></h1>
      </div>
      <Separator />

      {/* Store Selector */}
      {stores.length > 0 && (
        <>
          <div className="px-3 py-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between text-left font-normal"
                  disabled={stores.length <= 1}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Store className="h-4 w-4 shrink-0" />
                    <span className="truncate">{currentStore?.name || "店舗を選択"}</span>
                  </div>
                  {stores.length > 1 && <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />}
                </Button>
              </DropdownMenuTrigger>
              {stores.length > 1 && (
                <DropdownMenuContent align="start" className="w-[232px]">
                  {stores.map((store) => (
                    <DropdownMenuItem
                      key={store.id}
                      onClick={() => setCurrentStore(store)}
                      className={cn(
                        "cursor-pointer",
                        currentStore?.id === store.id && "bg-accent"
                      )}
                    >
                      <Store className="mr-2 h-4 w-4" />
                      <span className="truncate">{store.name}</span>
                      {store.is_primary === 1 && (
                        <span className="ml-auto text-xs text-muted-foreground">主</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              )}
            </DropdownMenu>
          </div>
          <Separator />
        </>
      )}

      <nav className="flex-1 space-y-1 px-3 py-4">
        {filteredNav.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>
      <Separator />
      <div className="p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
            {staff.name.charAt(0)}
          </div>
          <div className="flex-1 overflow-hidden">
            <p className="truncate text-sm font-medium">{staff.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {staff.role === "system_admin"
                ? "システム管理者"
                : staff.role === "owner"
                ? "オーナー"
                : staff.role === "manager"
                ? "ディレクター"
                : "スタッフ"}
            </p>
          </div>
        </div>
        <Button variant="outline" className="w-full" onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          ログアウト
        </Button>
      </div>
    </div>
  );
}
