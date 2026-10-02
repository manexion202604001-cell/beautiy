"use client";

import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, Settings, Store, ChevronDown, Check } from "lucide-react";
import { auth, type Staff } from "@/lib/api";
import { useStore } from "@/contexts/store-context";

type MobileHeaderProps = {
  staff: Staff;
};

export function MobileHeader({ staff }: MobileHeaderProps) {
  const router = useRouter();
  const { currentStore, stores, setCurrentStore } = useStore();

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      // Ignore logout errors
    }
    router.push("/login");
  };

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b bg-background px-4 md:hidden">
      {stores.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 focus:outline-none">
              <h1 className="text-lg font-bold text-primary truncate max-w-[200px]">{currentStore?.name || "SALOGIC"}</h1>
              <ChevronDown className="h-4 w-4 text-primary shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>店舗切替</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {stores.map((store) => (
              <DropdownMenuItem
                key={store.id}
                onClick={() => setCurrentStore(store)}
                className="cursor-pointer"
              >
                <Store className="mr-2 h-4 w-4" />
                <span className="truncate">{store.name}</span>
                {currentStore?.id === store.id && (
                  <Check className="ml-auto h-4 w-4" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <h1 className="text-lg font-bold text-primary truncate max-w-[200px]">{currentStore?.name || "SALOGIC"}</h1>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="focus:outline-none">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                {staff.name.charAt(0)}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">{staff.name}</p>
              <p className="text-xs text-muted-foreground">{staff.email}</p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/settings")}>
            <Settings className="mr-2 h-4 w-4" />
            設定
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout} className="text-destructive">
            <LogOut className="mr-2 h-4 w-4" />
            ログアウト
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
