"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Edit, Trash2, Eye, EyeOff, ImagePlus, Palette, Upload, Grid3X3, List, Check, ChevronUp, ChevronDown, Wrench, Copy } from "lucide-react";
import { Label } from "@/components/ui/label";
import { menus, staff as staffApi, equipment as equipmentApi, type Menu, type Staff, type Equipment } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { formatPrice, formatDuration, getImageUrl, cn } from "@/lib/utils";

type ViewTab = "regular" | "coupon";

const getParentName = (category: string) => {
  const idx = category.indexOf('：');
  return idx > 0 ? category.substring(0, idx) : category;
};

function MenuItem({
  menu,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onToggleActive,
  onDelete,
  onNavigate,
}: {
  menu: Menu;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleActive: (menu: Menu) => void;
  onDelete: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  return (
    <div
      className={`rounded-lg border p-3 md:p-4 cursor-pointer hover:bg-muted/50 transition-colors bg-background ${!menu.is_active ? "opacity-50" : ""}`}
      onClick={() => onNavigate(menu.id)}
    >
      {/* モバイル */}
      <div className="md:hidden">
        <div className="flex items-start gap-2">
          <div className="flex flex-col shrink-0">
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isFirst}
              onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
            >
              <ChevronUp className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isLast}
              onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
            >
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>
          {menu.image_url ? (
            <img src={getImageUrl(menu.image_url) || ""} alt={menu.name} className="h-14 w-14 rounded-lg object-cover shrink-0" />
          ) : (
            <div className="h-14 w-14 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <ImagePlus className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{menu.name}</span>
              {menu.coupon_type && (
                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold shrink-0 ${
                  menu.coupon_type === 'new' ? 'bg-blue-100 text-blue-700' : menu.coupon_type === 'repeat' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                }`}>
                  {menu.coupon_type === 'new' ? '新規' : menu.coupon_type === 'repeat' ? '再来' : '全員'}
                </span>
              )}
              {!menu.is_active && <Badge variant="secondary" className="text-xs shrink-0">非掲載</Badge>}
            </div>
            {menu.description && <p className="text-xs text-muted-foreground mt-0.5">{menu.description}</p>}
          </div>
        </div>
        <div className="flex items-center justify-between mt-2 pt-2 border-t">
          <div className="text-sm text-muted-foreground">
            <span className="font-bold text-foreground">{formatPrice(menu.price)}</span>
            <span className="mx-1.5">·</span>
            <span>{formatDuration(menu.duration)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onToggleActive(menu); }}>
              {menu.is_active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onNavigate(menu.id); }}>
              <Edit className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(menu.id); }}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      {/* デスクトップ */}
      <div className="hidden md:flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex flex-col shrink-0">
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isFirst}
              onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
            >
              <ChevronUp className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isLast}
              onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
            >
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>
          {menu.image_url ? (
            <img src={getImageUrl(menu.image_url) || ""} alt={menu.name} className="h-16 w-16 rounded-lg object-cover shrink-0" />
          ) : (
            <div className="h-16 w-16 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <ImagePlus className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{menu.name}</span>
              {menu.coupon_type && (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  menu.coupon_type === 'new' ? 'bg-blue-100 text-blue-700' : menu.coupon_type === 'repeat' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                }`}>
                  {menu.coupon_type === 'new' ? '新規' : menu.coupon_type === 'repeat' ? '再来' : '全員'}
                </span>
              )}
              {!menu.is_active && <Badge variant="secondary">非掲載</Badge>}
              {menu.assigned_staff_ids && menu.assigned_staff_ids.length > 0 && (
                <Badge variant="outline" className="text-xs">{menu.assigned_staff_ids.length}名対応</Badge>
              )}
            </div>
            {menu.description && <p className="text-sm text-muted-foreground ">{menu.description}</p>}
            <div className="mt-1 text-sm text-muted-foreground">{formatDuration(menu.duration)}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-lg font-bold">{formatPrice(menu.price)}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onToggleActive(menu); }}>
              {menu.is_active ? "非掲載" : "掲載"}
            </Button>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onNavigate(menu.id); }}>
              <Edit className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(menu.id); }}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MenusPage() {
  const { currentStore } = useStore();
  const [menuList, setMenuList] = useState<Menu[]>([]);
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [viewMode, setViewMode] = useState<"list" | "staff-matrix" | "equipment-matrix">("list");
  const [matrixChanges, setMatrixChanges] = useState<Map<string, Set<string>>>(new Map());
  const [matrixSaving, setMatrixSaving] = useState(false);
  const [equipmentMatrixChanges, setEquipmentMatrixChanges] = useState<Map<string, Set<string>>>(new Map());
  const [equipmentMatrixSaving, setEquipmentMatrixSaving] = useState(false);
  const [importJsonText, setImportJsonText] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<ViewTab>(() =>
    searchParams.get("tab") === "coupon" ? "coupon" : "regular"
  );
  const [couponFilter, setCouponFilter] = useState<"all" | "new" | "repeat" | "everyone">("all");
  const [sbMenuImportOpen, setSbMenuImportOpen] = useState(false);
  const [sbMenuImportText, setSbMenuImportText] = useState("");
  const [sbMenuImporting, setSbMenuImporting] = useState(false);
  const [sbImportType, setSbImportType] = useState<"menu" | "coupon">("menu");
  const [sbSingleImportOpen, setSbSingleImportOpen] = useState(false);
  const [sbSingleImportText, setSbSingleImportText] = useState("");
  const [reorderSaved, setReorderSaved] = useState(false);
  const [equipImportDialogOpen, setEquipImportDialogOpen] = useState(false);
  const [equipImportJsonText, setEquipImportJsonText] = useState("");
  const [equipImporting, setEquipImporting] = useState(false);

  useEffect(() => {
    if (!currentStore) return;
    fetchMenus();
    fetchStaff();
    fetchEquipment();
  }, [currentStore?.id]);

  const fetchStaff = async () => {
    try {
      const { staff: data } = await staffApi.list(currentStore?.id);
      setStaffList(data.filter(s => s.is_active && s.role !== 'system_admin'));
    } catch (error) {
      console.error("Failed to fetch staff:", error);
    }
  };

  const fetchEquipment = async () => {
    try {
      const { equipment } = await equipmentApi.list(currentStore?.id);
      setEquipmentList(equipment);
    } catch (error) {
      console.error("Failed to fetch equipment:", error);
    }
  };

  const fetchMenus = async () => {
    try {
      const { menus: data, categoryColors: colors } = await menus.list(currentStore?.id, false);
      setMenuList(data);
      setCategoryColors(colors);
      return data;
    } catch (error) {
      console.error("Failed to fetch menus:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このメニューを削除しますか？")) return;
    try {
      await menus.delete(id);
      await fetchMenus();
    } catch (error: unknown) {
      if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 409) {
        const msg = "message" in error ? String((error as Record<string, unknown>).message) : "このメニューは予約で使用されています。";
        if (confirm(`${msg}\n\n非表示にしますか？（予約履歴は保持されます）`)) {
          try {
            await menus.delete(id, true);
            await fetchMenus();
          } catch (e) {
            console.error("Failed to soft delete menu:", e);
          }
        }
        return;
      }
      console.error("Failed to delete menu:", error);
    }
  };

  const handleToggleActive = async (menu: Menu) => {
    try {
      await menus.update(menu.id, { is_active: menu.is_active ? 0 : 1 });
      await fetchMenus();
    } catch (error) {
      console.error("Failed to toggle menu:", error);
    }
  };

  const handleMove = useCallback(async (categoryMenus: Menu[], index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= categoryMenus.length) return;

    const reordered = [...categoryMenus];
    [reordered[index], reordered[newIndex]] = [reordered[newIndex], reordered[index]];

    const items = reordered.map((m, i) => ({ id: m.id, sort_order: i }));
    try {
      await menus.reorder(items);
      await fetchMenus();
      setReorderSaved(true);
      setTimeout(() => setReorderSaved(false), 2000);
    } catch (error) {
      console.error("Failed to reorder:", error);
      await fetchMenus();
    }
  }, []);

  // Matrix view
  const initMatrixFromMenus = (list?: Menu[]) => {
    const source = list ?? menuList;
    const map = new Map<string, Set<string>>();
    for (const menu of source) {
      map.set(menu.id, new Set(menu.assigned_staff_ids || []));
    }
    setMatrixChanges(map);
  };

  const toggleMatrixCell = (menuId: string, staffId: string) => {
    setMatrixChanges((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(menuId) || []);
      if (current.has(staffId)) current.delete(staffId);
      else current.add(staffId);
      next.set(menuId, current);
      return next;
    });
  };

  const handleMatrixSave = async () => {
    if (!currentStore) return;
    setMatrixSaving(true);
    try {
      const assignments = [...matrixChanges.entries()].map(([menu_id, staffSet]) => ({
        menu_id, staff_ids: [...staffSet],
      }));
      await menus.bulkUpdateStaffAssignments(currentStore.id, assignments);
      await fetchMenus();
      alert("保存しました");
    } catch (error) {
      console.error("Failed to save:", error);
      alert("保存に失敗しました");
    } finally {
      setMatrixSaving(false);
    }
  };

  // Equipment matrix view
  const initEquipmentMatrixFromMenus = (list?: Menu[]) => {
    const source = list ?? menuList;
    const map = new Map<string, Set<string>>();
    for (const menu of source) {
      map.set(menu.id, new Set(menu.assigned_equipment_ids || []));
    }
    setEquipmentMatrixChanges(map);
  };

  const toggleEquipmentMatrixCell = (menuId: string, equipmentId: string) => {
    setEquipmentMatrixChanges((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(menuId) || []);
      if (current.has(equipmentId)) current.delete(equipmentId);
      else current.add(equipmentId);
      next.set(menuId, current);
      return next;
    });
  };

  const handleEquipmentMatrixSave = async () => {
    if (!currentStore) return;
    setEquipmentMatrixSaving(true);
    try {
      const assignments = [...equipmentMatrixChanges.entries()].map(([menu_id, eqSet]) => ({
        menu_id, equipment_ids: [...eqSet],
      }));
      await menus.bulkUpdateEquipmentAssignments(currentStore.id, assignments);
      await fetchMenus();
      alert("保存しました");
    } catch (error) {
      console.error("Failed to save:", error);
      alert("保存に失敗しました");
    } finally {
      setEquipmentMatrixSaving(false);
    }
  };

  const handleImportJson = async () => {
    if (!currentStore || !importJsonText.trim()) return;
    setImporting(true);
    try {
      const parsed = JSON.parse(importJsonText);
      const assignments = Array.isArray(parsed) ? parsed : parsed.assignments;
      const result = await menus.importStaffAssignments(currentStore.id, assignments);
      alert(result.message);
      setImportDialogOpen(false);
      setImportJsonText("");
      const freshMenus = await fetchMenus();
      if (freshMenus) initMatrixFromMenus(freshMenus);
    } catch (error: unknown) {
      const msg = error instanceof SyntaxError ? "JSONの形式が正しくありません" : String(error);
      alert(msg);
    } finally {
      setImporting(false);
    }
  };

  // SB 対応メニュー/クーポン設定 → スタッフ割当抽出スクリプト (unified)
  // Menu page: tbl1_1/tbl1_2, .menuTextDataHeight, staffNoLinkMenuId
  // Coupon page: tbl2_1/tbl2_2, .couponTextDataHeight, staffNoLinkStoreCouponId
  const SB_STAFF_ASSIGN_SCRIPT = `(()=>{let lt=document.getElementById('tbl1_1')||document.getElementById('tbl2_1');let rt=document.getElementById('tbl1_2')||document.getElementById('tbl2_2');if(!lt||!rt){alert('テーブルが見つかりません');return}const sns=[];rt.querySelectorAll('thead th').forEach(th=>{sns.push(th.textContent.trim())});let lr=lt.querySelectorAll('tbody.jscMenu tr');if(!lr.length)lr=lt.querySelectorAll('tbody tr');let rr=rt.querySelectorAll('tbody.jscBody tr');if(!rr.length)rr=rt.querySelectorAll('tbody tr');const res=[];for(let j=0;j<lr.length;j++){const ne=lr[j].querySelector('.menuTextDataHeight')||lr[j].querySelector('.couponTextDataHeight');if(!ne)continue;const mn=ne.textContent.trim();const nc=lr[j].querySelector('input[name="staffNoLinkMenuId"]')||lr[j].querySelector('input[name="staffNoLinkStoreCouponId"]');const nn=nc?nc.checked:false;const as=[];if(rr[j]){rr[j].querySelectorAll('td').forEach((td,k)=>{const cb=td.querySelector('input[type="checkbox"]');if(cb&&cb.checked&&k<sns.length&&sns[k]&&sns[k]!=='すべて')as.push(sns[k])})}res.push({menuName:mn,noStaffNeeded:nn,assignedStaff:as})}if(!res.length){alert('データが見つかりません');return}const sn=sns.filter(s=>s&&s!=='すべて');const j=JSON.stringify(res);const ta=document.createElement('textarea');ta.value=j;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('コピーしました（'+res.length+'件）\\nスタッフ('+sn.length+'名): '+sn.join(', '))})()`;

  const SB_COUPON_SCRIPT = `(()=>{const tbls=document.querySelectorAll('table.couponTbl');if(!tbls.length){alert('クーポンテーブルが見つかりません');return}const cs=[];tbls.forEach(tbl=>{const tr=tbl.querySelector('tbody tr');if(!tr)return;const tds=tr.querySelectorAll('td');if(tds.length<2)return;const ft=tds[0].textContent.trim();let ct='all';if(ft.includes('新規'))ct='new';else if(ft.includes('再来'))ct='repeat';const ne=tr.querySelector('.couponMenuName');if(!ne)return;const nm=ne.textContent.trim();if(!nm)return;let pr=0,du=60,pt=0,desc='';if(tds.length>=3){const dt=tds[2].textContent;const pm=dt.match(/[¥￥]\\s*(\\d[\\d,]*)/)||dt.match(/(\\d[\\d,]*)\\s*円/);if(pm)pr=parseInt(pm[1].replace(/,/g,''),10);if(dt.includes('～'))pt=1;const dm=dt.match(/(\\d+)\\s*分/);if(dm)du=parseInt(dm[1],10)}const dc=tds[1].cloneNode(true);const nr=dc.querySelector('.couponMenuName');if(nr)nr.remove();desc=dc.textContent.trim().replace(/[\\n\\r]+/g,' ').replace(/\\s{2,}/g,' ').replace(/[¥￥]\\s*[\\d,]+.*/,'').trim();const im=tbl.querySelector('img[name="couponPhoto"],img.couponImgSize,img[src*="imgbp"]');let iu='';if(im&&im.src&&!im.src.includes('noneimage'))iu=im.src;cs.push({name:nm,coupon_type:ct,price:pr,duration:du,category:'',description:desc,price_tilde:pt,...(iu?{image_url:iu}:{})})});if(!cs.length){alert('データが見つかりません');return}const ic=cs.filter(c=>c.image_url).length;const j=JSON.stringify(cs);const ta=document.createElement('textarea');ta.value=j;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('コピーしました（'+cs.length+'件、画像'+ic+'件）')})()`;

  const SB_COUPON_EDIT_SCRIPT = `(()=>{function f(l){const cs=document.querySelectorAll('td,th');for(const c of cs){const t=c.textContent.trim();if(!t.includes(l))continue;if(t.length>l.length+20)continue;const r=c.closest('tr');if(!r)continue;const tds=r.querySelectorAll('td');for(const td of tds){if(td===c)continue;const el=td.querySelector('select,input:not([type=hidden]):not([type=radio]):not([type=checkbox]),textarea');if(el)return el}}return null}const ne=f('クーポン名');const pe=document.getElementById('TagIN_NM_PRICE_01')||document.querySelector('[name$=".price"]')||f('価格');const de=document.querySelector('[name$=".sejyutsuAimTime"]')||document.getElementById('TagSL_NM_SEJYUTSU_AIM_TIME_01')||f('所要目安時間');const ce=f('検索用カテゴリ');const ue=document.getElementById('TagIN_NM_USE_CONDITION_01')||document.querySelector('[name$=".useCondition"]')||f('利用条件');const te=document.getElementById('TagSL_NM_COUPON_CONDITION_CD_01')||document.querySelector('[name$=".selectedTeijiJoukenCd"]')||f('提示条件');const xe=f('クーポン内容');const nm=ne?ne.value.trim():'';const pr=pe?parseInt(pe.value.replace(/,/g,''),10)||0:0;const du=de?parseInt(de.value,10)||60:60;const cat=ce&&ce.tagName==='SELECT'?(ce.selectedOptions[0]||{}).text||'':'';const cond=ue?ue.value.trim():'';const teiji=te&&te.tagName==='SELECT'?(te.selectedOptions[0]||{}).text||'':'';let ct='all';if(cond.includes('新規'))ct='new';else if(cond.includes('再来'))ct='repeat';const desc=xe?xe.value.trim().replace(/[\\n\\r]+/g,' ').replace(/\\s{2,}/g,' '):'';const im=document.getElementById('TagImgCouponPoto')||document.querySelector('img[name$="couponPhoto_IMG"]')||document.querySelector('img[src*="imgbp.salonboard"]');let iu='';if(im&&im.src&&!im.src.includes('noneimage')&&!im.src.includes('noimage')){iu=im.src.replace(/w=\\d+/,'w=600').replace(/h=\\d+/,'h=600')}if(!nm){alert('クーポン名が見つかりません');return}const r=[{name:nm,coupon_type:ct,price:pr,duration:du,category:cat,description:desc,condition:cond,display_condition:teiji,...(iu?{image_url:iu}:{})}];const j=JSON.stringify(r);const ta=document.createElement('textarea');ta.value=j;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('コピーしました: '+nm+'\\n'+pr+'円 / '+du+'分 / '+ct+(iu?' / 画像あり':'')+'\\n提示:'+teiji+' / 利用:'+cond)})()`;

  const SB_MENU_SCRIPT = `(()=>{const ms=[];for(let i=1;i<=999;i++){const x=String(i).padStart(3,'0');const g=document.querySelector('#MENU_SET_GENRE_NAME_'+x);if(!g)break;const c=document.querySelector('#MENU_SET_MENU_CATEGORY_NAME_'+x);const n=document.querySelector('#MENU_SET_NAME_NAME_'+x);const d=document.querySelector('#MENU_SET_EXPLANATION_NAME_'+x);const p=document.querySelector('#MENU_SET_PRICE_NAME_'+x);const t=document.querySelector('#MENU_SET_TIME_NAME_'+x);const tf=document.querySelector('#MENU_SET_TILDE_FLG_NAME_'+x);const pr=document.querySelector('#MENU_SET_PRESENT_FLG_NAME_'+x+'_PRESENT');ms.push({category:g.value+'：'+(c?c.value:''),name:(n?n.value:'').trim(),description:(d?d.value:'').trim(),price:parseInt(p?p.value:'0',10),duration:parseInt(t?t.value:'60',10),price_tilde:tf&&tf.checked?1:0,is_active:pr?(pr.checked?1:0):1})}const j=JSON.stringify(ms);const ta=document.createElement('textarea');ta.value=j;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('コピーしました（'+ms.length+'件）')})()`;

  const handleSbMenuImport = async () => {
    if (!currentStore || !sbMenuImportText.trim()) return;
    setSbMenuImporting(true);
    try {
      const data = JSON.parse(sbMenuImportText) as { category: string; name: string; description: string; price: number; duration: number; price_tilde?: number; is_active?: number; coupon_type?: string; image_url?: string }[];
      if (!Array.isArray(data) || data.length === 0) {
        alert("データが空です");
        setSbMenuImporting(false);
        return;
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      const existingMenuMap = new Map(menuList.map(m => [m.name, m]));
      // Start sort_order after existing menus so 2nd page appends
      const maxSortOrder = menuList.reduce((max, m) => Math.max(max, m.sort_order ?? 0), -1);
      const sortOffset = maxSortOrder + 1;

      for (let idx = 0; idx < data.length; idx++) {
        const item = data[idx];
        if (!item.name) {
          skipped++;
          continue;
        }
        const existing = existingMenuMap.get(item.name);
        if (existing) {
          // Update is_active, price_tilde, coupon_type, and sort_order for existing menus
          try {
            await menus.update(existing.id, {
              is_active: item.is_active ?? 1,
              price_tilde: item.price_tilde ?? 0,
              sort_order: sortOffset + idx,
              ...(item.coupon_type ? { coupon_type: item.coupon_type, menu_type: "coupon" } : {}),
            } as Partial<Menu>);
            // Import image if URL provided and menu has no image yet
            if (item.image_url && !existing.image_url) {
              try { await menus.importImageFromUrl(existing.id, item.image_url); } catch {}
            }
            updated++;
          } catch {
            skipped++;
          }
          continue;
        }
        try {
          const result = await menus.create({
            store_id: currentStore.id,
            category: item.category || "",
            name: item.name,
            description: item.description || null,
            price: item.price || 0,
            duration: item.duration || 60,
            menu_type: item.coupon_type ? "coupon" : "regular",
            ...(item.coupon_type ? { coupon_type: item.coupon_type } : {}),
            is_active: item.is_active ?? 1,
            price_tilde: item.price_tilde ?? 0,
            sort_order: sortOffset + idx,
          } as Partial<Menu> & { store_id: string });
          // Import image if URL provided
          if (item.image_url && result.menu?.id) {
            try { await menus.importImageFromUrl(result.menu.id, item.image_url); } catch {}
          }
          created++;
        } catch {
          skipped++;
        }
      }

      alert(`${created}件作成、${updated}件更新、${skipped}件スキップ`);
      setSbMenuImportOpen(false);
      setSbMenuImportText("");
      await fetchMenus();
    } catch {
      alert("JSONの形式が正しくありません");
    } finally {
      setSbMenuImporting(false);
    }
  };

  // SB メニュー・設備設定 / クーポン・設備設定 → 設備割当抽出スクリプト (unified)
  // Menu: tbl3_1/tbl3_2, Coupon: tbl4_1/tbl4_2
  const SB_EQUIP_ASSIGN_SCRIPT = `(()=>{const lt=document.getElementById('tbl3_1')||document.getElementById('tbl4_1');const rt=document.getElementById('tbl3_2')||document.getElementById('tbl4_2');if(!lt||!rt){alert('テーブルが見つかりません');return}const ens=[];rt.querySelectorAll('thead th,thead td').forEach(el=>{const t=(el.textContent||'').replace(/すべて/g,'').replace(/\\s+/g,' ').trim();ens.push(t)});let lr=lt.querySelectorAll('tbody.jscMenu tr');if(!lr.length)lr=lt.querySelectorAll('tbody tr');let rr=rt.querySelectorAll('tbody.jscBody tr');if(!rr.length)rr=rt.querySelectorAll('tbody tr');const res=[];for(let j=0;j<lr.length;j++){const ne=lr[j].querySelector('.menuTextDataHeight')||lr[j].querySelector('.couponTextDataHeight')||lr[j].querySelector('td.jscMenuText')||lr[j].querySelector('td');if(!ne)continue;const mn=ne.textContent.trim();if(!mn)continue;const ae=[];if(rr[j]){rr[j].querySelectorAll('td').forEach((td,k)=>{const cb=td.querySelector('input[type="checkbox"]');if(cb&&cb.checked&&k<ens.length&&ens[k]&&ens[k]!=='すべて'&&!ens[k].includes('設備不要'))ae.push(ens[k])})}res.push({menuName:mn,assignedEquipment:ae})}if(!res.length){alert('データが見つかりません');return}const en=ens.filter(s=>s&&s!=='すべて'&&!s.includes('設備不要'));const j=JSON.stringify(res);const ta=document.createElement('textarea');ta.value=j;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('コピーしました（'+res.length+'件）\\n設備('+en.length+'): '+en.join(', '))})()`;

  const handleEquipImportJson = async () => {
    if (!currentStore || !equipImportJsonText.trim()) return;
    setEquipImporting(true);
    try {
      const parsed = JSON.parse(equipImportJsonText);
      const assignments = Array.isArray(parsed) ? parsed : parsed.assignments;
      const result = await menus.importEquipmentAssignments(currentStore.id, assignments);
      alert(result.message);
      setEquipImportDialogOpen(false);
      setEquipImportJsonText("");
      const freshMenus = await fetchMenus();
      if (freshMenus) initEquipmentMatrixFromMenus(freshMenus);
    } catch (error: unknown) {
      const msg = error instanceof SyntaxError ? "JSONの形式が正しくありません" : String(error);
      alert(msg);
    } finally {
      setEquipImporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  // Split menus by type
  const regularMenus = menuList.filter(m => m.menu_type !== "coupon");
  const couponMenus = menuList.filter(m => m.menu_type === "coupon");

  const groupByParentCategory = (items: Menu[]) => {
    const grouped: Record<string, Menu[]> = {};
    for (const m of items) {
      const parent = getParentName(m.category);
      if (!grouped[parent]) grouped[parent] = [];
      grouped[parent].push(m);
    }
    return grouped;
  };

  const regularByCategory = groupByParentCategory(regularMenus);
  const regularCategoryKeys = Object.keys(regularByCategory);
  const allByParentCategory = groupByParentCategory(menuList);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold">メニュー管理</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === "staff-matrix" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (viewMode !== "staff-matrix") {
                initMatrixFromMenus();
                setViewMode("staff-matrix");
              } else {
                setViewMode("list");
              }
            }}
          >
            {viewMode === "staff-matrix" ? <List className="mr-1 h-4 w-4" /> : <Grid3X3 className="mr-1 h-4 w-4" />}
            <span className="hidden sm:inline">{viewMode === "staff-matrix" ? "リスト表示" : "対応スタッフ"}</span>
          </Button>
          <Button
            variant={viewMode === "equipment-matrix" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (viewMode !== "equipment-matrix") {
                initEquipmentMatrixFromMenus();
                setViewMode("equipment-matrix");
              } else {
                setViewMode("list");
              }
            }}
          >
            {viewMode === "equipment-matrix" ? <List className="mr-1 h-4 w-4" /> : <Wrench className="mr-1 h-4 w-4" />}
            <span className="hidden sm:inline">{viewMode === "equipment-matrix" ? "リスト表示" : "対応設備"}</span>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/menus/categories">
              <Palette className="mr-1 md:mr-2 h-4 w-4" />
              <span className="hidden sm:inline">カテゴリ管理</span>
              <span className="sm:hidden">カテゴリ</span>
            </Link>
          </Button>
        </div>
      </div>

      {viewMode === "staff-matrix" ? (
        <Card>
          <CardHeader className="py-3 md:py-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">対応スタッフ設定</CardTitle>
              <div className="flex items-center gap-2">
                <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Upload className="mr-1 h-4 w-4" />
                      SB取込
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>サロンボードから対応スタッフ取込</DialogTitle>
                      <DialogDescription>SBの対応メニュー設定 or 対応クーポン設定画面でスクリプトを実行し、コピーされたJSONを貼り付けてください</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          1. SBの対応メニュー/クーポン設定画面のコンソールで実行
                        </Label>
                        <pre className="bg-muted rounded-md p-2 mt-1 text-[10px] font-mono max-h-16 overflow-hidden whitespace-pre-wrap break-all text-muted-foreground">
                          {SB_STAFF_ASSIGN_SCRIPT}
                        </pre>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1"
                          onClick={() => {
                            navigator.clipboard.writeText(SB_STAFF_ASSIGN_SCRIPT);
                            alert("コピーしました");
                          }}
                        >
                          <Copy className="mr-1 h-3 w-3" />
                          スクリプトをコピー
                        </Button>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          2. コピーされたJSONを貼り付け
                        </Label>
                        <Textarea
                          className="mt-1 font-mono text-xs"
                          placeholder='[{"menuName": "カット", "noStaffNeeded": false, "assignedStaff": ["e miri", "ra mu"]}]'
                          value={importJsonText}
                          onChange={(e) => setImportJsonText(e.target.value)}
                          rows={6}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setImportDialogOpen(false)}>キャンセル</Button>
                      <Button onClick={handleImportJson} disabled={importing || !importJsonText.trim()}>
                        {importing ? "インポート中..." : "インポート"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Button size="sm" onClick={handleMatrixSave} disabled={matrixSaving}>
                  {matrixSaving ? "保存中..." : "保存"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="sticky left-0 bg-muted/50 px-3 py-2 text-left font-medium min-w-[200px]">メニュー</th>
                    {staffList.map((s) => (
                      <th key={s.id} className="px-2 py-2 text-center font-medium whitespace-nowrap min-w-[60px]">
                        <div className="text-xs">{s.name}</div>
                        {s.salonboard_name && (
                          <div className="text-[10px] font-normal text-muted-foreground">{s.salonboard_name}</div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(allByParentCategory).map(([category, catMenus]) => (
                    <>
                      <tr key={`cat-${category}`} className="bg-muted/30">
                        <td
                          colSpan={staffList.length + 1}
                          className="sticky left-0 bg-muted/30 px-3 py-1.5 font-medium text-xs text-muted-foreground"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: categoryColors[category] || categoryColors[catMenus[0]?.category] || "#6B7280" }} />
                            {category}
                          </div>
                        </td>
                      </tr>
                      {catMenus.map((menu) => {
                        const assigned = matrixChanges.get(menu.id) || new Set<string>();
                        return (
                          <tr key={menu.id} className={cn("border-b hover:bg-muted/20", !menu.is_active && "opacity-50")}>
                            <td className="sticky left-0 bg-background px-3 py-2 text-xs max-w-[200px]">
                              <span className="truncate">{menu.name}</span>
                              {!menu.is_active && <span className="ml-1 text-[10px] text-muted-foreground">(非掲載)</span>}
                            </td>
                            {staffList.map((s) => (
                              <td key={s.id} className="px-2 py-2 text-center">
                                <button
                                  type="button"
                                  className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${
                                    assigned.has(s.id) ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-primary/50"
                                  }`}
                                  onClick={() => toggleMatrixCell(menu.id, s.id)}
                                >
                                  {assigned.has(s.id) && <Check className="h-3 w-3" />}
                                </button>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : viewMode === "equipment-matrix" ? (
        <Card>
          <CardHeader className="py-3 md:py-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">対応設備設定</CardTitle>
              <div className="flex items-center gap-2">
                <Dialog open={equipImportDialogOpen} onOpenChange={setEquipImportDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Upload className="mr-1 h-4 w-4" />
                      SB取込
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>サロンボードから対応設備取込</DialogTitle>
                      <DialogDescription>SBのメニュー・設備設定画面でスクリプトを実行し、コピーされたJSONを貼り付けてください</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          1. SBのメニュー・設備設定画面のコンソールで実行
                        </Label>
                        <pre className="bg-muted rounded-md p-2 mt-1 text-[10px] font-mono max-h-16 overflow-hidden whitespace-pre-wrap break-all text-muted-foreground">
                          {SB_EQUIP_ASSIGN_SCRIPT}
                        </pre>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1"
                          onClick={() => {
                            navigator.clipboard.writeText(SB_EQUIP_ASSIGN_SCRIPT);
                            alert("コピーしました");
                          }}
                        >
                          <Copy className="mr-1 h-3 w-3" />
                          スクリプトをコピー
                        </Button>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          2. コピーされたJSONを貼り付け
                        </Label>
                        <Textarea
                          className="mt-1 font-mono text-xs"
                          placeholder='[{"menuName": "カット", "assignedEquipment": ["リクライニングソファ"]}]'
                          value={equipImportJsonText}
                          onChange={(e) => setEquipImportJsonText(e.target.value)}
                          rows={6}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setEquipImportDialogOpen(false)}>キャンセル</Button>
                      <Button onClick={handleEquipImportJson} disabled={equipImporting || !equipImportJsonText.trim()}>
                        {equipImporting ? "インポート中..." : "インポート"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Button size="sm" onClick={handleEquipmentMatrixSave} disabled={equipmentMatrixSaving}>
                  {equipmentMatrixSaving ? "保存中..." : "保存"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="sticky left-0 bg-muted/50 px-3 py-2 text-left font-medium min-w-[200px]">メニュー</th>
                    {equipmentList.map((eq) => (
                      <th key={eq.id} className="px-2 py-2 text-center font-medium whitespace-nowrap min-w-[60px]">
                        <div className="text-xs">{eq.name}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(allByParentCategory).map(([category, catMenus]) => (
                    <>
                      <tr key={`cat-${category}`} className="bg-muted/30">
                        <td
                          colSpan={equipmentList.length + 1}
                          className="sticky left-0 bg-muted/30 px-3 py-1.5 font-medium text-xs text-muted-foreground"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: categoryColors[category] || categoryColors[catMenus[0]?.category] || "#6B7280" }} />
                            {category}
                          </div>
                        </td>
                      </tr>
                      {catMenus.map((menu) => {
                        const assigned = equipmentMatrixChanges.get(menu.id) || new Set<string>();
                        return (
                          <tr key={menu.id} className={cn("border-b hover:bg-muted/20", !menu.is_active && "opacity-50")}>
                            <td className="sticky left-0 bg-background px-3 py-2 text-xs max-w-[200px]">
                              <span className="truncate">{menu.name}</span>
                              {!menu.is_active && <span className="ml-1 text-[10px] text-muted-foreground">(非掲載)</span>}
                            </td>
                            {equipmentList.map((eq) => (
                              <td key={eq.id} className="px-2 py-2 text-center">
                                <button
                                  type="button"
                                  className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${
                                    assigned.has(eq.id) ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-primary/50"
                                  }`}
                                  onClick={() => toggleEquipmentMatrixCell(menu.id, eq.id)}
                                >
                                  {assigned.has(eq.id) && <Check className="h-3 w-3" />}
                                </button>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Tabs: 通常メニュー / クーポン */}
          <div className="border-b">
            <div className="flex items-center gap-2">
              <button
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "regular" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab("regular")}
              >
                通常メニュー
                <Badge variant="secondary" className="ml-2 text-xs">{regularMenus.length}</Badge>
              </button>
              <button
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "coupon" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab("coupon")}
              >
                クーポン
                <Badge variant="secondary" className="ml-2 text-xs">{couponMenus.length}</Badge>
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setSbImportType(activeTab === "coupon" ? "coupon" : "menu"); setSbMenuImportOpen(true); }}
            >
              <Upload className="mr-1 h-4 w-4" />
              SB取込
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setSbSingleImportOpen(true); setSbSingleImportText(""); }}
            >
              <Upload className="mr-1 h-4 w-4" />
              SB取込（個別）
            </Button>
            <Button
              size="sm"
              onClick={() => window.location.href = `/menus/new?type=${activeTab === "coupon" ? "coupon" : "regular"}`}
            >
              <Plus className="mr-1 h-4 w-4" />
              {activeTab === "coupon" ? "新規クーポン" : "新規メニュー"}
            </Button>
          </div>

          {activeTab === "coupon" ? (
            <>
              {/* 種別フィルター */}
              <div className="flex items-center gap-2 flex-wrap">
                {([
                  { key: "all", label: "すべて" },
                  { key: "everyone", label: "全員" },
                  { key: "new", label: "新規" },
                  { key: "repeat", label: "再来" },
                ] as const).map(({ key, label }) => {
                  const count = key === "all"
                    ? couponMenus.length
                    : couponMenus.filter(m => key === "everyone" ? m.coupon_type === "all" : m.coupon_type === key).length;
                  return (
                    <button
                      key={key}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                        couponFilter === key
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setCouponFilter(key)}
                    >
                      {label}
                      <span className="ml-1.5 text-xs opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>

              {(() => {
                const filtered = couponFilter === "all"
                  ? couponMenus
                  : couponMenus.filter(m => couponFilter === "everyone" ? m.coupon_type === "all" : m.coupon_type === couponFilter);
                return filtered.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      クーポンがありません
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-2 md:space-y-3">
                    {filtered.map((menu, index) => (
                      <MenuItem
                        key={menu.id}
                        menu={menu}
                        isFirst={index === 0}
                        isLast={index === filtered.length - 1}
                        onMoveUp={() => handleMove(filtered, index, "up")}
                        onMoveDown={() => handleMove(filtered, index, "down")}
                        onToggleActive={handleToggleActive}
                        onDelete={handleDelete}
                        onNavigate={(id) => window.location.href = `/menus/${id}?type=coupon`}
                      />
                    ))}
                  </div>
                );
              })()}
            </>
          ) : (
            regularCategoryKeys.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  メニューがありません
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4 md:space-y-6">
                {regularCategoryKeys.map((category) => {
                  const catMenus = regularByCategory[category];
                  return (
                    <Card key={category}>
                      <CardHeader className="py-3 md:py-6">
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: categoryColors[category] || categoryColors[catMenus[0]?.category] || "#6B7280" }} />
                          <CardTitle className="text-base md:text-lg">{category}</CardTitle>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2 md:space-y-3">
                          {catMenus.map((menu, index) => (
                            <MenuItem
                              key={menu.id}
                              menu={menu}
                              isFirst={index === 0}
                              isLast={index === catMenus.length - 1}
                              onMoveUp={() => handleMove(catMenus, index, "up")}
                              onMoveDown={() => handleMove(catMenus, index, "down")}
                              onToggleActive={handleToggleActive}
                              onDelete={handleDelete}
                              onNavigate={(id) => window.location.href = `/menus/${id}`}
                            />
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )
          )}
        </>
      )}

      {/* SB Menu Import Dialog */}
      <Dialog open={sbMenuImportOpen} onOpenChange={setSbMenuImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>サロンボードから取込</DialogTitle>
            <DialogDescription>
              SBの編集画面でスクリプトを実行し、コピーされたJSONを貼り付けてください。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <button
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  sbImportType === "menu" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSbImportType("menu")}
              >
                メニュー
              </button>
              <button
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  sbImportType === "coupon" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSbImportType("coupon")}
              >
                クーポン
              </button>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                1. SBの{sbImportType === "coupon" ? "クーポン一覧" : "メニュー編集"}画面のコンソールで実行
              </Label>
              <pre className="bg-muted rounded-md p-2 mt-1 text-[10px] font-mono max-h-16 overflow-hidden whitespace-pre-wrap break-all text-muted-foreground">
                {sbImportType === "coupon" ? SB_COUPON_SCRIPT : SB_MENU_SCRIPT}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => {
                  navigator.clipboard.writeText(sbImportType === "coupon" ? SB_COUPON_SCRIPT : SB_MENU_SCRIPT);
                  alert("コピーしました");
                }}
              >
                <Copy className="mr-1 h-3 w-3" />
                スクリプトをコピー
              </Button>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                2. コピーされたJSONを貼り付け{sbImportType === "coupon" ? "（ページが分かれている場合は各ページで実行）" : ""}
              </Label>
              <Textarea
                className="mt-1 font-mono text-xs"
                placeholder={sbImportType === "coupon"
                  ? '[{"name":"カット+カラー","coupon_type":"new","price":8000,"duration":90,...}]'
                  : '[{"category":"まつげ・メイクなど：まつげデザイン・ケア","name":"パリジェンヌ","price":8000,"duration":60,...}]'
                }
                value={sbMenuImportText}
                onChange={(e) => setSbMenuImportText(e.target.value)}
                rows={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSbMenuImportOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleSbMenuImport}
              disabled={sbMenuImporting || !sbMenuImportText.trim()}
            >
              {sbMenuImporting ? "取込中..." : "取り込み"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SB Single Coupon Import Dialog */}
      <Dialog open={sbSingleImportOpen} onOpenChange={setSbSingleImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>クーポン編集ページから取込</DialogTitle>
            <DialogDescription>
              SBのクーポン掲載情報編集ページでスクリプトを実行し、コピーされたJSONを貼り付けてください。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">
                1. SBのクーポン編集ページのコンソールで実行
              </Label>
              <pre className="bg-muted rounded-md p-2 mt-1 text-[10px] font-mono max-h-16 overflow-hidden whitespace-pre-wrap break-all text-muted-foreground">
                {SB_COUPON_EDIT_SCRIPT}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => {
                  navigator.clipboard.writeText(SB_COUPON_EDIT_SCRIPT);
                  alert("コピーしました");
                }}
              >
                <Copy className="mr-1 h-3 w-3" />
                スクリプトをコピー
              </Button>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                2. コピーされたJSONを貼り付け（複数クーポンの場合は各ページで実行して配列を結合）
              </Label>
              <Textarea
                className="mt-1 font-mono text-xs"
                placeholder='[{"name":"クーポン名","coupon_type":"new","price":8000,"duration":90,...}]'
                value={sbSingleImportText}
                onChange={(e) => setSbSingleImportText(e.target.value)}
                rows={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSbSingleImportOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={async () => {
                setSbMenuImportText(sbSingleImportText);
                setSbSingleImportOpen(false);
                // Use existing import handler by setting the text and triggering
                setSbMenuImportOpen(false);
                // Direct import
                if (!currentStore || !sbSingleImportText.trim()) return;
                setSbMenuImporting(true);
                try {
                  const data = JSON.parse(sbSingleImportText) as { category: string; name: string; description: string; price: number; duration: number; price_tilde?: number; is_active?: number; coupon_type?: string; image_url?: string; condition?: string; display_condition?: string }[];
                  if (!Array.isArray(data) || data.length === 0) {
                    alert("データが空です");
                    return;
                  }
                  let created = 0;
                  let updated = 0;
                  let skipped = 0;
                  const existingMenuMap = new Map(menuList.map(m => [m.name, m]));
                  const maxSortOrder = menuList.reduce((max, m) => Math.max(max, m.sort_order ?? 0), -1);
                  const sortOffset = maxSortOrder + 1;
                  for (let idx = 0; idx < data.length; idx++) {
                    const item = data[idx];
                    if (!item.name) { skipped++; continue; }
                    const existing = existingMenuMap.get(item.name);
                    if (existing) {
                      try {
                        await menus.update(existing.id, {
                          is_active: item.is_active ?? 1,
                          price_tilde: item.price_tilde ?? 0,
                          sort_order: sortOffset + idx,
                          ...(item.coupon_type ? { coupon_type: item.coupon_type, menu_type: "coupon" } : {}),
                          ...(item.condition ? { usage_condition: item.condition } : {}),
                          ...(item.display_condition ? { presentation_condition: item.display_condition } : {}),
                        } as Partial<Menu>);
                        if (item.image_url && !existing.image_url) {
                          try { await menus.importImageFromUrl(existing.id, item.image_url); } catch {}
                        }
                        updated++;
                      } catch { skipped++; }
                      continue;
                    }
                    try {
                      const result = await menus.create({
                        store_id: currentStore.id,
                        category: item.category || "",
                        name: item.name,
                        description: item.description || null,
                        price: item.price || 0,
                        duration: item.duration || 60,
                        menu_type: item.coupon_type ? "coupon" : "regular",
                        ...(item.coupon_type ? { coupon_type: item.coupon_type } : {}),
                        ...(item.condition ? { usage_condition: item.condition } : {}),
                        ...(item.display_condition ? { presentation_condition: item.display_condition } : {}),
                        is_active: item.is_active ?? 1,
                        price_tilde: item.price_tilde ?? 0,
                        sort_order: sortOffset + idx,
                      } as Partial<Menu> & { store_id: string });
                      if (item.image_url && result.menu?.id) {
                        try { await menus.importImageFromUrl(result.menu.id, item.image_url); } catch {}
                      }
                      created++;
                    } catch { skipped++; }
                  }
                  alert(`${created}件作成、${updated}件更新、${skipped}件スキップ`);
                  setSbSingleImportText("");
                  await fetchMenus();
                } catch {
                  alert("JSONの形式が正しくありません");
                } finally {
                  setSbMenuImporting(false);
                }
              }}
              disabled={sbMenuImporting || !sbSingleImportText.trim()}
            >
              {sbMenuImporting ? "取込中..." : "取り込み"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reorder saved toast */}
      {reorderSaved && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-foreground text-background px-4 py-2 rounded-lg shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2">
          並び順を保存しました
        </div>
      )}
    </div>
  );
}
