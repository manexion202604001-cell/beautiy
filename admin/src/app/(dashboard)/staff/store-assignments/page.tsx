"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronLeft, Eye, EyeOff } from "lucide-react";
import { staff as staffApi } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { getImageUrl } from "@/lib/utils";

type AssignmentStaff = {
  id: string;
  name: string;
  email: string;
  role: string;
  staff_code: string | null;
  avatar_url: string | null;
  stores: { id: string; name: string; is_primary: number; is_visible_to_customer: number }[];
};

export default function StoreAssignmentsPage() {
  const router = useRouter();
  const { stores } = useStore();
  const [matrixStaff, setMatrixStaff] = useState<AssignmentStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    staffApi
      .getStoreAssignments()
      .then((result) => setMatrixStaff(result.staff))
      .catch((error) => console.error("Failed to fetch store assignments:", error))
      .finally(() => setLoading(false));
  }, []);

  const handleToggleStore = async (staffMember: AssignmentStaff, storeId: string, checked: boolean) => {
    const key = `${staffMember.id}-${storeId}`;
    setUpdating(key);
    try {
      const currentStoreIds = staffMember.stores.map((s) => s.id);
      let newStoreIds: string[];
      if (checked) {
        newStoreIds = [...currentStoreIds, storeId];
      } else {
        newStoreIds = currentStoreIds.filter((id) => id !== storeId);
      }
      const currentPrimary = staffMember.stores.find((s) => s.is_primary)?.id;
      const primaryId = newStoreIds.includes(currentPrimary || "") ? currentPrimary : newStoreIds[0];
      await staffApi.updateStores(staffMember.id, newStoreIds, primaryId);
      setMatrixStaff((prev) =>
        prev.map((s) => {
          if (s.id !== staffMember.id) return s;
          const updatedStores = newStoreIds.map((sid) => {
            const existing = s.stores.find((st) => st.id === sid);
            const storeName = stores.find((st) => st.id === sid)?.name || "";
            return {
              id: sid,
              name: existing?.name || storeName,
              is_primary: sid === primaryId ? 1 : 0,
              is_visible_to_customer: existing?.is_visible_to_customer ?? 1,
            };
          });
          return { ...s, stores: updatedStores };
        })
      );
    } catch (error) {
      console.error("Failed to update store assignment:", error);
      alert(error instanceof Error ? error.message : "店舗割り当ての更新に失敗しました");
    } finally {
      setUpdating(null);
    }
  };

  const handleToggleVisibility = async (staffMember: AssignmentStaff, storeId: string, isVisible: boolean) => {
    const key = `vis-${staffMember.id}-${storeId}`;
    setUpdating(key);
    try {
      await staffApi.updateStoreVisibility(staffMember.id, storeId, isVisible);
      setMatrixStaff((prev) =>
        prev.map((s) => {
          if (s.id !== staffMember.id) return s;
          return {
            ...s,
            stores: s.stores.map((st) =>
              st.id === storeId ? { ...st, is_visible_to_customer: isVisible ? 1 : 0 } : st
            ),
          };
        })
      );
    } catch (error) {
      console.error("Failed to update visibility:", error);
      alert(error instanceof Error ? error.message : "表示設定の更新に失敗しました");
    } finally {
      setUpdating(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.push("/staff")}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl md:text-2xl font-bold">店舗割り当て</h1>
      </div>

      <Card>
        <CardHeader className="py-3 md:py-6">
          <CardTitle className="text-base md:text-lg">
            スタッフ × 店舗マトリックス
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            チェックでスタッフの所属店舗を設定。目のアイコンでお客様への表示/非表示を切り替えられます。
          </p>
        </CardHeader>
        <CardContent>
          {stores.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">店舗がありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4 font-medium sticky left-0 bg-background min-w-[160px]">
                      スタッフ
                    </th>
                    {stores.map((store) => (
                      <th key={store.id} className="text-center py-2 px-4 font-medium whitespace-nowrap">
                        {store.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixStaff.map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="py-3 pr-4 sticky left-0 bg-background">
                        <div className="flex items-center gap-2">
                          <Avatar className="h-8 w-8">
                            {s.avatar_url && (
                              <AvatarImage src={getImageUrl(s.avatar_url) || undefined} />
                            )}
                            <AvatarFallback className="text-xs">{s.name.charAt(0)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="font-medium truncate text-sm">{s.name}</p>
                            {s.staff_code && (
                              <p className="text-xs text-muted-foreground">ID: {s.staff_code}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      {stores.map((store) => {
                        const storeAssignment = s.stores.find((st) => st.id === store.id);
                        const isAssigned = !!storeAssignment;
                        const isVisible = storeAssignment?.is_visible_to_customer === 1;
                        const cellKey = `${s.id}-${store.id}`;
                        const visKey = `vis-${s.id}-${store.id}`;
                        const isCellUpdating = updating === cellKey || updating === visKey;
                        return (
                          <td key={store.id} className="text-center py-3 px-4">
                            <div className="flex items-center justify-center gap-2">
                              <Checkbox
                                checked={isAssigned}
                                onCheckedChange={(checked) => {
                                  if (updating === cellKey) return;
                                  handleToggleStore(s, store.id, !!checked);
                                }}
                                className={isCellUpdating ? "opacity-50 pointer-events-none" : "cursor-pointer"}
                              />
                              {isAssigned && (
                                <button
                                  onClick={() => {
                                    if (updating === visKey) return;
                                    handleToggleVisibility(s, store.id, !isVisible);
                                  }}
                                  className={`p-0.5 rounded hover:bg-accent ${isCellUpdating ? "opacity-50 pointer-events-none" : ""}`}
                                  title={isVisible ? "お客様に表示中" : "お客様に非表示"}
                                >
                                  {isVisible ? (
                                    <Eye className="h-4 w-4 text-primary" />
                                  ) : (
                                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                                  )}
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {matrixStaff.length === 0 && (
                    <tr>
                      <td colSpan={stores.length + 1} className="py-8 text-center text-muted-foreground">
                        スタッフがいません
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
