/**
 * サロンボードから取込 dialogs of the メニュー screens (SALOGIC's six 「SB取込」 flows): each shows which
 * SALON BOARD screen to open, the script to run in its console (sbImportScripts.ts) and a box for the
 * JSON the script copied.
 */
import { Copy, Download } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  importSbImages,
  sbImportApi,
  type SbMenuKind,
  type SbMissingRow,
  type SbPreviewRow,
} from '../../../api/menuSbImport';
import type { MenuCategory } from '../../../api/types';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogTitle,
  Label,
  Textarea,
} from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { cx } from '../../../lib/cn';
import {
  SB_CATEGORY_SCRIPT,
  SB_COUPON_EDIT_SCRIPT,
  SB_COUPON_LIST_SCRIPT,
  SB_COUPON_PAGE_SCRIPT,
  SB_EQUIPMENT_TABLE_SCRIPT,
  SB_MENU_SCRIPT,
  SB_STAFF_TABLE_SCRIPT,
  parsePastedJson,
  toSbMenuItems,
} from './sbImportScripts';

const BAD_JSON = 'JSONの形式が正しくありません';
const EMPTY = 'データが空です';

/** The 「SB取込」 button of the screens */
export function SbImportButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Download className="mr-1 h-4 w-4" />
      {label}
    </Button>
  );
}

function DialogHead({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <>
      <DialogTitle>{title}</DialogTitle>
      <p className="text-sm text-muted-foreground">{description}</p>
    </>
  );
}

/** 1. the script, with its copy button */
function ScriptStep({ label, script, wide }: { label: ReactNode; script: string; wide?: boolean }) {
  const toast = useToast();
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <pre className="mt-1 max-h-16 overflow-hidden whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[10px] text-muted-foreground">
        {script}
      </pre>
      <Button
        variant="outline"
        size="sm"
        className={wide ? 'mt-1.5 w-full' : 'mt-1'}
        onClick={() => {
          void navigator.clipboard
            .writeText(script)
            .then(() => toast.success('コピーしました'))
            .catch(() => toast.error('コピーできませんでした'));
        }}
      >
        <Copy className={wide ? 'mr-1.5 h-3 w-3' : 'mr-1 h-3 w-3'} />
        スクリプトをコピー
      </Button>
    </div>
  );
}

/** 2. the box for the copied JSON */
function PasteStep({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: ReactNode;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Textarea
        aria-label="コピーされたJSON"
        className="mt-1 font-mono text-xs"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
      />
    </div>
  );
}

const Footer = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:sx-2">{children}</div>
);

const shopSuffix = (name?: string | null) => (name ? `（${name}）` : '');

/** Parses the pasted text; reports a broken paste and returns undefined */
function readJson(text: string, toast: ReturnType<typeof useToast>): unknown {
  try {
    return parsePastedJson(text);
  } catch {
    toast.error(BAD_JSON);
    return undefined;
  }
}

/** a server message of several lines → toast title + description */
function toastMessage(toast: ReturnType<typeof useToast>, message: string) {
  const [first, ...rest] = message.split('\n');
  toast.success(first ?? '', rest.length ? rest.join('\n') : undefined);
}

// ================================================================ 一覧「SB取込」: comparison table

const yen = (n: number | null | undefined) => `¥${(n ?? 0).toLocaleString()}`;
const minutes = (n: number | null | undefined) => `${n ?? 0}分`;
const COUPON_LABEL: Record<string, string> = { all: '全員', new: '新規', repeat: '再来' };
/** changes applied even with 「価格・時間・説明・カテゴリも上書き」 off */
const ALWAYS_APPLIED = ['掲載', '〜表示', 'クーポン種別'];

export function SbBulkImportDialog({
  open,
  onOpenChange,
  shopId,
  shopName,
  initialKind,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string;
  shopName?: string | null;
  initialKind: SbMenuKind;
  onImported: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<SbMenuKind>(initialKind);
  const [text, setText] = useState('');
  const [items, setItems] = useState<ReturnType<typeof toSbMenuItems>>([]);
  const [rows, setRows] = useState<(SbPreviewRow & { checked: boolean })[] | null>(null);
  const [missing, setMissing] = useState<(SbMissingRow & { checked: boolean })[]>([]);
  const [overwrite, setOverwrite] = useState(true);
  const [hideSame, setHideSame] = useState(true);
  const [busy, setBusy] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setKind(initialKind);
  }

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setRows(null);
      setMissing([]);
    }
  };

  const showComparison = async () => {
    const data = readJson(text, toast);
    if (data === undefined) return;
    if (!Array.isArray(data) || data.length === 0) {
      toast.error(EMPTY);
      return;
    }
    const list = toSbMenuItems(data);
    setBusy(true);
    try {
      const res = await sbImportApi.preview({ shopId, kind, items: list });
      setItems(list);
      setRows(res.rows.map((r) => ({ ...r, checked: r.selected })));
      setMissing(res.missing.map((m) => ({ ...m, checked: false })));
    } catch (e) {
      toast.error('比較表を作れませんでした', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const result = await sbImportApi.run({
        shopId,
        mode: 'compare',
        kind,
        items,
        selected: rows.filter((r) => r.checked && r.kind !== 'same').map((r) => r.index),
        overwriteDetails: overwrite,
        hideMenuIds: missing.filter((m) => m.checked).map((m) => m.id),
      });
      // pictures only for menus without one (decided by the server)
      await importSbImages(result.images);
      toast.success(
        `${result.created}件追加、${result.updated}件上書き、${result.hidden}件を非掲載、${result.skipped}件スキップ`,
      );
      setText('');
      close(false);
      await onImported();
    } catch (e) {
      toast.error('取り込みに失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const counts = rows
    ? {
        new: rows.filter((r) => r.kind === 'new').length,
        update: rows.filter((r) => r.kind === 'update').length,
        same: rows.filter((r) => r.kind === 'same').length,
      }
    : null;
  const visible = rows ? rows.filter((r) => !(hideSame && r.kind === 'same')) : [];
  const actionable = visible.filter((r) => r.kind !== 'same');
  const toggleRow = (index: number, checked: boolean) =>
    setRows((prev) => prev && prev.map((r) => (r.index === index ? { ...r, checked } : r)));
  const chosenNew = rows?.filter((r) => r.checked && r.kind === 'new').length ?? 0;
  const chosenUpdate = rows?.filter((r) => r.checked && r.kind === 'update').length ?? 0;
  const chosenHide = missing.filter((m) => m.checked).length;

  /** a cell that shows old → new when the field changed */
  const cell = (row: SbPreviewRow, label: string, from: string, to: string, right = false) => (
    <td className={cx('p-2 align-top', right && 'text-right')}>
      {row.existing && row.changes.some((c) => c.label === label) ? (
        <span>
          <span className="text-muted-foreground line-through">{from}</span>
          <span className="mx-1 text-muted-foreground">→</span>
          <span
            className={cx(
              'font-medium',
              overwrite || ALWAYS_APPLIED.includes(label)
                ? 'text-amber-700'
                : 'text-muted-foreground',
            )}
          >
            {to}
          </span>
        </span>
      ) : (
        <span>{to}</span>
      )}
    </td>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      className={cx('flex max-h-[90vh] flex-col overflow-hidden', rows ? 'max-w-5xl' : 'max-w-lg')}
      title={
        <DialogHead
          title={`サロンボードから取込${shopSuffix(shopName)}`}
          description={
            rows
              ? '取り込み前の比較表です。チェックした行だけが反映されます。'
              : 'SBの編集画面でスクリプトを実行し、コピーされたJSONを貼り付けてください。'
          }
        />
      }
    >
      {rows && counts ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge className="bg-green-600 hover:bg-green-600">新規追加 {counts.new}</Badge>
            <Badge className="bg-amber-500 hover:bg-amber-500">上書き {counts.update}</Badge>
            <Badge variant="secondary">変更なし {counts.same}</Badge>
            <Badge variant="outline" className="border-red-300 text-red-600">
              SBに無い {missing.length}
            </Badge>
            <span className="ml-auto flex items-center gap-3">
              <label className="flex items-center gap-1.5">
                <Checkbox checked={overwrite} onCheckedChange={setOverwrite} />
                価格・時間・説明・カテゴリも上書き
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox checked={hideSame} onCheckedChange={setHideSame} />
                変更なしを隠す
              </label>
            </span>
          </div>
          {!overwrite && counts.update > 0 ? (
            <p className="text-xs text-muted-foreground">
              上書きオフの間は、掲載状態・〜表示・並び順・クーポン種別だけが更新されます。
            </p>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm">
                <tr className="text-left">
                  <th className="w-8 p-2">
                    <Checkbox
                      checked={actionable.length > 0 && actionable.every((r) => r.checked)}
                      onCheckedChange={(v) =>
                        setRows(
                          (prev) =>
                            prev && prev.map((r) => (r.kind === 'same' ? r : { ...r, checked: v })),
                        )
                      }
                    />
                  </th>
                  <th className="w-20 p-2">状態</th>
                  <th className="p-2">メニュー名</th>
                  <th className="p-2">カテゴリ</th>
                  <th className="w-28 p-2 text-right">価格</th>
                  <th className="w-24 p-2 text-right">時間</th>
                  <th className="w-16 p-2">掲載</th>
                  <th className="p-2">変更点</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const e = r.existing;
                  const item = r.item;
                  return (
                    <tr
                      key={r.index}
                      data-sb-row={r.kind}
                      className={cx(
                        'border-t',
                        r.kind === 'new' && 'bg-green-50/60',
                        r.kind === 'update' && 'bg-amber-50/60',
                        !r.checked && r.kind !== 'same' && 'opacity-50',
                      )}
                    >
                      <td className="p-2 align-top">
                        {r.kind !== 'same' ? (
                          <Checkbox
                            checked={r.checked}
                            onCheckedChange={(v) => toggleRow(r.index, v)}
                          />
                        ) : null}
                      </td>
                      <td className="p-2 align-top">
                        {r.kind === 'new' ? (
                          <Badge className="bg-green-600 hover:bg-green-600">新規追加</Badge>
                        ) : null}
                        {r.kind === 'update' ? (
                          <Badge className="bg-amber-500 hover:bg-amber-500">上書き</Badge>
                        ) : null}
                        {r.kind === 'same' ? <Badge variant="secondary">変更なし</Badge> : null}
                      </td>
                      <td className="p-2 align-top">
                        <div className="font-medium">{item.name}</div>
                        {e && e.name !== item.name ? (
                          <div className="text-[10px] text-muted-foreground">現在: {e.name}</div>
                        ) : null}
                        {item.couponType ? (
                          <div className="text-[10px] text-muted-foreground">
                            クーポン: {COUPON_LABEL[item.couponType]}
                          </div>
                        ) : null}
                      </td>
                      {cell(
                        r,
                        'カテゴリ',
                        e?.categoryName || '—',
                        item.category || e?.categoryName || '—',
                      )}
                      {cell(r, '価格', yen(e?.price), yen(item.price), true)}
                      {cell(r, '時間', minutes(e?.durationMin), minutes(item.durationMin), true)}
                      {cell(
                        r,
                        '掲載',
                        e?.listed ? '掲載' : '非掲載',
                        item.listed ? '掲載' : '非掲載',
                      )}
                      <td className="p-2 align-top text-muted-foreground">
                        {r.kind === 'new'
                          ? 'Salon OS に無いので追加'
                          : r.changes.length
                            ? r.changes.map((c) => c.label).join('・')
                            : '—'}
                      </td>
                    </tr>
                  );
                })}
                {missing.length > 0 ? (
                  <>
                    <tr className="border-t bg-muted/60">
                      <td colSpan={8} className="p-2 text-xs font-medium text-red-700">
                        Salon OS
                        にのみ存在（今回のSBデータに無い掲載中メニュー）。チェックすると非掲載にします。削除はしません。
                      </td>
                    </tr>
                    {missing.map((m) => (
                      <tr key={m.id} data-sb-row="missing" className="border-t bg-red-50/40">
                        <td className="p-2 align-top">
                          <Checkbox
                            checked={m.checked}
                            onCheckedChange={(v) =>
                              setMissing((prev) =>
                                prev.map((x) => (x.id === m.id ? { ...x, checked: v } : x)),
                              )
                            }
                          />
                        </td>
                        <td className="p-2 align-top">
                          <Badge variant="outline" className="border-red-300 text-red-600">
                            SBに無い
                          </Badge>
                        </td>
                        <td className="p-2 align-top font-medium">{m.name}</td>
                        <td className="p-2 align-top">{m.categoryName || '—'}</td>
                        <td className="p-2 text-right align-top">{yen(m.price)}</td>
                        <td className="p-2 text-right align-top">{minutes(m.durationMin)}</td>
                        <td className="p-2 align-top">掲載</td>
                        <td className="p-2 align-top text-muted-foreground">
                          {m.checked ? '非掲載にする' : 'そのまま'}
                        </td>
                      </tr>
                    ))}
                  </>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="sy-3">
          <div className="flex gap-2">
            {(
              [
                ['regular', 'メニュー'],
                ['coupon', 'クーポン'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={kind === key}
                className={cx(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  kind === key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setKind(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <ScriptStep
            label={`1. SBの${kind === 'coupon' ? 'クーポン一覧' : 'メニュー編集'}画面のコンソールで実行`}
            script={kind === 'coupon' ? SB_COUPON_LIST_SCRIPT : SB_MENU_SCRIPT}
          />
          <PasteStep
            label={`2. コピーされたJSONを貼り付け${kind === 'coupon' ? '（ページが分かれている場合は全ページ分をつなげて貼り付けると「SBに無い」判定が正確になります）' : ''}`}
            placeholder={
              kind === 'coupon'
                ? '[{"name":"カット+カラー","couponType":"new","price":8000,"durationMin":90,...}]'
                : '[{"category":"まつげ・メイクなど：まつげデザイン・ケア","name":"パリジェンヌ","price":8000,"durationMin":60,...}]'
            }
            value={text}
            onChange={setText}
          />
        </div>
      )}
      <Footer>
        {rows ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRows(null);
                setMissing([]);
              }}
            >
              戻る
            </Button>
            <Button
              onClick={() => void execute()}
              disabled={busy || (chosenNew + chosenUpdate === 0 && chosenHide === 0)}
            >
              {busy
                ? '取込中...'
                : `取り込み実行（追加 ${chosenNew} / 上書き ${chosenUpdate}${chosenHide ? ` / 非掲載 ${chosenHide}` : ''}）`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => close(false)}>
              キャンセル
            </Button>
            <Button onClick={() => void showComparison()} disabled={busy || !text.trim()}>
              比較表を見る
            </Button>
          </>
        )}
      </Footer>
    </Dialog>
  );
}

// ================================================================ 「SB取込（個別）」

export function SbSingleImportDialog({
  open,
  onOpenChange,
  shopId,
  shopName,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string;
  shopName?: string | null;
  onImported: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const data = readJson(text, toast);
    if (data === undefined) return;
    if (!Array.isArray(data) || data.length === 0) {
      toast.error(EMPTY);
      return;
    }
    setBusy(true);
    try {
      const result = await sbImportApi.run({ shopId, mode: 'single', items: toSbMenuItems(data) });
      await importSbImages(result.images);
      toast.success(
        `${result.created}件作成、${result.updated}件更新、${result.skipped}件スキップ`,
      );
      setText('');
      onOpenChange(false);
      await onImported();
    } catch (e) {
      toast.error('取り込みに失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <DialogHead
          title={`クーポン編集ページから取込${shopSuffix(shopName)}`}
          description="SBのクーポン掲載情報編集ページでスクリプトを実行し、コピーされたJSONを貼り付けてください。"
        />
      }
    >
      <div className="sy-3">
        <ScriptStep
          label="1. SBのクーポン編集ページのコンソールで実行"
          script={SB_COUPON_PAGE_SCRIPT}
        />
        <PasteStep
          label="2. コピーされたJSONを貼り付け（複数クーポンの場合は各ページで実行して配列を結合）"
          placeholder='[{"name":"クーポン名","couponType":"new","price":8000,"durationMin":90,...}]'
          value={text}
          onChange={setText}
        />
      </div>
      <Footer>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          キャンセル
        </Button>
        <Button onClick={() => void run()} disabled={busy || !text.trim()}>
          {busy ? '取込中...' : '取り込み'}
        </Button>
      </Footer>
    </Dialog>
  );
}

// ================================================================ 対応スタッフ / 対応設備

/** pasted table data: the script's { names, assignments } or a bare array of rows */
function tableData(
  data: unknown,
  namesKey: 'staff' | 'equipment',
): { names?: string[]; assignments: unknown[] } | null {
  if (Array.isArray(data)) return { assignments: data };
  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { assignments?: unknown }).assignments)
  ) {
    const names = (data as Record<string, unknown>)[namesKey];
    return {
      names: Array.isArray(names)
        ? names.filter((n): n is string => typeof n === 'string')
        : undefined,
      assignments: (data as { assignments: unknown[] }).assignments,
    };
  }
  return null;
}

export function SbAssignmentsImportDialog({
  target,
  open,
  onOpenChange,
  shopId,
  shopName,
  onImported,
}: {
  target: 'staff' | 'equipment';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string;
  shopName?: string | null;
  onImported: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const staff = target === 'staff';

  const run = async () => {
    const parsed = readJson(text, toast);
    if (parsed === undefined) return;
    const data = tableData(parsed, target);
    if (!data || data.assignments.length === 0) {
      toast.error(EMPTY);
      return;
    }
    setBusy(true);
    try {
      const res = staff
        ? await sbImportApi.staffAssignments({
            shopId,
            staffNames: data.names,
            assignments: data.assignments,
          })
        : await sbImportApi.equipmentAssignments({
            shopId,
            equipmentNames: data.names,
            assignments: data.assignments,
          });
      toastMessage(toast, res.message);
      onOpenChange(false);
      setText('');
      await onImported();
    } catch (e) {
      toast.error('インポートに失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        staff ? (
          <DialogHead
            title={`サロンボードから対応スタッフ取込${shopSuffix(shopName)}`}
            description="SBの対応メニュー設定 or 対応クーポン設定画面でスクリプトを実行し、コピーされたJSONを貼り付けてください"
          />
        ) : (
          <DialogHead
            title="サロンボードから対応設備取込"
            description="SBのメニュー・設備設定画面でスクリプトを実行し、コピーされたJSONを貼り付けてください"
          />
        )
      }
    >
      <div className="sy-3">
        <ScriptStep
          label={
            staff
              ? '1. SBの対応メニュー/クーポン設定画面のコンソールで実行'
              : '1. SBのメニュー・設備設定画面のコンソールで実行'
          }
          script={staff ? SB_STAFF_TABLE_SCRIPT : SB_EQUIPMENT_TABLE_SCRIPT}
        />
        <PasteStep
          label="2. コピーされたJSONを貼り付け"
          placeholder={
            staff
              ? '[{"menuName": "カット", "noStaffNeeded": false, "assignedStaff": ["スタッフA", "スタッフB"]}]'
              : '[{"menuName": "カット", "assignedEquipment": ["リクライニングソファ"]}]'
          }
          value={text}
          onChange={setText}
        />
      </div>
      <Footer>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          キャンセル
        </Button>
        <Button onClick={() => void run()} disabled={busy || !text.trim()}>
          {busy ? 'インポート中...' : 'インポート'}
        </Button>
      </Footer>
    </Dialog>
  );
}

// ================================================================ 編集画面「SBから取込」

/** What the coupon edit page script copies */
export interface SbCouponForm {
  couponType: 'all' | 'new' | 'repeat' | null;
  name: string;
  description: string;
  presentationCondition: string;
  usageCondition: string;
  expiryDate: string | null;
  price: number | null;
  priceTilde: boolean | null;
  durationMin: number | null;
  imageUrl: string | null;
  /** search categories as 「親：子」 */
  categories: string[];
}

function toCouponForm(x: Record<string, unknown>): SbCouponForm {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const type = x.couponType;
  return {
    couponType: type === 'all' || type === 'new' || type === 'repeat' ? type : null,
    name: s(x.name),
    description: s(x.description),
    presentationCondition: s(x.presentationCondition),
    usageCondition: s(x.usageCondition),
    expiryDate:
      typeof x.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.expiryDate)
        ? x.expiryDate
        : null,
    price: n(x.price),
    priceTilde:
      typeof x.priceTilde === 'boolean'
        ? x.priceTilde
        : typeof x.priceTilde === 'number'
          ? x.priceTilde === 1
          : null,
    durationMin: n(x.durationMin),
    imageUrl: s(x.imageUrl) || null,
    categories: Array.isArray(x.categories)
      ? x.categories.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

/** SALON BOARD search categories → the shop's categories: same name first, then one containing the other */
export function matchSbCategories(names: string[], categories: MenuCategory[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const hit =
      categories.find((c) => c.name === name) ??
      categories.find((c) => name.includes(c.name) || c.name.includes(name));
    if (hit && !out.includes(hit.id)) out.push(hit.id);
  }
  return out;
}

export function SbCouponFormImportDialog({
  open,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (data: SbCouponForm) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const apply = () => {
    const data = readJson(text, toast);
    if (data === undefined) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      toast.error(BAD_JSON);
      return;
    }
    onApply(toCouponForm(data as Record<string, unknown>));
    setText('');
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <DialogHead
          title="サロンボードから取り込み"
          description="サロンボードのクーポン編集ページで以下のスクリプトを実行し、コピーされたJSONを貼り付けてください"
        />
      }
    >
      <div className="sy-3">
        <ScriptStep label="1. SBのコンソールで実行" script={SB_COUPON_EDIT_SCRIPT} wide />
        <PasteStep
          label="2. コピーされたJSONを貼り付け"
          placeholder='{"couponType":"new","name":"...","price":14500,...}'
          value={text}
          onChange={setText}
        />
      </div>
      <Footer>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          キャンセル
        </Button>
        <Button onClick={apply} disabled={!text.trim()}>
          取り込み
        </Button>
      </Footer>
    </Dialog>
  );
}

// ================================================================ カテゴリ管理「SBから取込」

export function SbCategoryImportDialog({
  open,
  onOpenChange,
  shopId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string;
  onImported: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const data = readJson(text, toast);
    if (data === undefined) return;
    if (!Array.isArray(data) || data.length === 0) {
      toast.error(EMPTY);
      return;
    }
    const groups = data
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
      .map((g) => ({
        parent: typeof g.parent === 'string' ? g.parent : '',
        children: Array.isArray(g.children)
          ? g.children.filter((c): c is string => typeof c === 'string')
          : [],
      }));
    setBusy(true);
    try {
      const res = await sbImportApi.categories({ shopId, groups });
      await onImported();
      onOpenChange(false);
      setText('');
      toast.success(res.message);
    } catch (e) {
      toast.error('取り込みに失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <DialogHead
          title="サロンボードからカテゴリ取込"
          description="SBのクーポン編集画面の「検索カテゴリ」を開いた状態でスクリプトを実行し、コピーされたJSONを貼り付けてください。"
        />
      }
    >
      <div className="sy-3">
        <ScriptStep label="1. SBのコンソールで実行" script={SB_CATEGORY_SCRIPT} wide />
        <PasteStep
          label="2. コピーされたJSONを貼り付け"
          placeholder='[{"parent":"ネイル","children":["ジェル","スカルプ",...]},...]'
          value={text}
          onChange={setText}
        />
      </div>
      <Footer>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          キャンセル
        </Button>
        <Button onClick={() => void run()} disabled={busy || !text.trim()}>
          {busy ? '取込中...' : '取り込み'}
        </Button>
      </Footer>
    </Dialog>
  );
}
