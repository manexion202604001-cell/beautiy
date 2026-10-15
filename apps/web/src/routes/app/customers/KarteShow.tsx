import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Calendar,
  Camera,
  ClipboardList,
  FileText,
  ImagePlus,
  Pencil,
  Scissors,
  Share2,
  SquarePen,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useCustomer } from '../../../api/customers';
import { sameOriginBlobUrl, uploadFile } from '../../../api/files';
import {
  displayFieldValue,
  karteKeys,
  kartesApi,
  useKarte,
  type AssetType,
  type FieldValues,
  type KarteAsset,
  type KarteDetail,
} from '../../../api/kartes';
import { copyText } from '../../../components/QrCode';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogTitle,
  Input,
  Label,
  Select,
  Tabs,
  Textarea,
} from '../../../components/shad';
import { AlertDialog } from '../../../components/shad/alert-dialog';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { CounselingSheet } from './CounselingSheet';
import { FaceDrawing } from './FaceDrawing';
import { formatWhen } from './shared';

/** The fixed treatment record of a karte (stored in the karte's fields under these keys) */
const RECORD_KEYS = [
  'menu_content',
  'hair_condition',
  'color_formula',
  'perm_info',
  'styling_notes',
  'customer_feedback',
  'next_suggestion',
] as const;
type RecordKey = (typeof RECORD_KEYS)[number];

type PhotoKind = 'before' | 'after' | 'other';
const PHOTO_ASSET: Record<PhotoKind, AssetType> = { before: 'photo_before', after: 'photo_after', other: 'photo' };
const photoLabel = (t: AssetType) => (t === 'photo_before' ? '施術前' : t === 'photo_after' ? '施術後' : 'その他');

const EMPTY_FORM = {
  visit_date: '',
  menu_content: '',
  hair_condition: '',
  color_formula: '',
  perm_info: '',
  styling_notes: '',
  customer_feedback: '',
  next_suggestion: '',
  internal_memo: '',
};

const text = (fields: FieldValues, key: string) => {
  const v = fields?.[key];
  return typeof v === 'string' ? v : '';
};

function toForm(k: KarteDetail): typeof EMPTY_FORM {
  return {
    visit_date: k.visit_date ?? '',
    ...(Object.fromEntries(RECORD_KEYS.map((key) => [key, text(k.fields, key)])) as Record<RecordKey, string>),
    internal_memo: k.note ?? '',
  };
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

/** カルテ詳細: the treatment record, face drawing and photos of one visit + the counselling sheet */
export default function KarteShow() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, timezone: tz } = useAuth();

  const karteQ = useKarte(id);
  const karte = karteQ.data;
  const customerQ = useCustomer(karte?.customer_id);

  const [tab, setTab] = useState<'karute' | 'counseling'>('karute');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  /** picture drawn in the open dialog (null = not touched) */
  const [drawing, setDrawing] = useState<string | null>(null);
  const [drawingBase, setDrawingBase] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [addingPhoto, setAddingPhoto] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoKind, setPhotoKind] = useState<PhotoKind>('other');
  const [caption, setCaption] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [photoToDelete, setPhotoToDelete] = useState<KarteAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof EMPTY_FORM>) => setForm((f) => ({ ...f, ...patch }));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: karteKeys.all });
  };

  const faceAsset = karte?.assets.find((a) => a.asset_type === 'face_drawing') ?? null;
  const faceUrl = faceAsset ? sameOriginBlobUrl(faceAsset.url) : null;

  const openEdit = async (k: KarteDetail) => {
    setForm(toForm(k));
    setDrawing(null);
    setDrawingBase(undefined);
    const asset = k.assets.find((a) => a.asset_type === 'face_drawing');
    if (asset) {
      // the earlier drawing is loaded as a blob so the canvas can be saved again
      try {
        const blob = await (await fetch(sameOriginBlobUrl(asset.url))).blob();
        setDrawingBase(URL.createObjectURL(blob));
      } catch {
        toast.error('フェイス描画を読み込めませんでした', '描き直して保存すると置き換わります');
      }
    }
    setEditing(true);
  };

  // a karte just created on the customer screen opens ready to be filled in (?edit=1)
  const wantsEdit = params.get('edit') === '1';
  useEffect(() => {
    if (!karte || !wantsEdit) return;
    const next = new URLSearchParams(params);
    next.delete('edit');
    setParams(next, { replace: true });
    void openEdit(karte);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when the karte arrives
  }, [karte?.id, wantsEdit]);

  useEffect(
    () => () => {
      if (drawingBase) URL.revokeObjectURL(drawingBase);
    },
    [drawingBase],
  );

  if (karteQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }
  if (!karte) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">カルテが見つかりません</div>
      </div>
    );
  }

  const canWrite = can('karte.write');
  const customerName = customerQ.data?.display_name ?? '';
  const record = Object.fromEntries(RECORD_KEYS.map((key) => [key, text(karte.fields, key)])) as Record<RecordKey, string>;
  // items recorded with a karte template, chemicals and home care (written on the detailed karte screen)
  const templateRows = (karte.template?.fields ?? [])
    .filter((f) => !(RECORD_KEYS as readonly string[]).includes(f.key))
    .map((f) => ({ key: f.key, label: f.label, value: karte.fields?.[f.key] }))
    .filter((r) => r.value !== undefined && r.value !== null && r.value !== '' && !(Array.isArray(r.value) && r.value.length === 0));
  const chemicals = karte.chemicals ?? [];
  const advice = karte.homecare?.advice ?? '';
  const hasRecord =
    RECORD_KEYS.some((key) => record[key]) || !!karte.note || templateRows.length > 0 || chemicals.length > 0 || !!advice;
  const photos = karte.assets.filter((a) => a.asset_type !== 'face_drawing');

  const save = async () => {
    setSaving(true);
    try {
      const fields: FieldValues = { ...(karte.fields ?? {}) };
      for (const key of RECORD_KEYS) fields[key] = form[key].trim() || null;
      await kartesApi.update(karte.id, {
        version: karte.version,
        visitDate: form.visit_date || undefined,
        fields,
        note: form.internal_memo.trim() || null,
      });
      if (drawing) {
        const file = await uploadFile(await dataUrlToBlob(drawing), 'sketch', { fileName: 'face-drawing.png' });
        await kartesApi.addAsset(karte.id, { fileId: file.id, assetType: 'face_drawing', shareWithCustomer: true });
      }
      refresh();
      await qc.invalidateQueries({ queryKey: karteKeys.detail(karte.id) });
      setEditing(false);
    } catch (e) {
      toast.error('カルテの更新に失敗しました', errorMessage(e));
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const share = async () => {
    setBusy(true);
    try {
      const res = await kartesApi.share(karte.id, { expiresInDays: 30, notify: false });
      const copied = await copyText(res.url);
      toast.success('カルテを共有しました', copied ? '共有リンクをコピーしました' : res.url);
      refresh();
    } catch (e) {
      toast.error('カルテの共有に失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const uploaded = await uploadFile(file, 'karte_photo');
      await kartesApi.addAsset(karte.id, {
        fileId: uploaded.id,
        assetType: PHOTO_ASSET[photoKind],
        caption: caption.trim() || null,
        shareWithCustomer: true,
      });
      refresh();
      setAddingPhoto(false);
      setCaption('');
      setPhotoKind('other');
    } catch (err) {
      toast.error('画像のアップロードに失敗しました', errorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const deletePhoto = async () => {
    if (!photoToDelete) return;
    setBusy(true);
    try {
      await kartesApi.removeAsset(karte.id, photoToDelete.id);
      refresh();
      setPhotoToDelete(null);
    } catch (e) {
      toast.error('画像の削除に失敗しました', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteKarte = async () => {
    setBusy(true);
    try {
      await kartesApi.remove(karte.id);
      qc.removeQueries({ queryKey: karteKeys.detail(karte.id) });
      refresh();
      navigate(-1);
    } catch (e) {
      toast.error('カルテの削除に失敗しました', errorMessage(e));
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sy-4 md:sy-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-label="戻る" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-bold md:text-2xl">カルテ詳細</h1>
        </div>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" aria-label="編集" onClick={() => void openEdit(karte)}>
              <SquarePen className="mr-1 h-4 w-4" />
              <span className="hidden sm:inline">編集</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="カルテを削除"
              className="text-destructive"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>

      <Tabs
        label="カルテ"
        value={tab}
        onValueChange={setTab}
        triggerClassName="gap-1.5"
        items={[
          {
            value: 'karute',
            label: (
              <>
                <Scissors className="h-4 w-4" />
                カルテ
              </>
            ),
          },
          {
            value: 'counseling',
            label: (
              <>
                <ClipboardList className="h-4 w-4" />
                カウンセリングシート
              </>
            ),
          },
        ]}
      />

      {tab === 'karute' ? (
        <div role="tabpanel" className="mt-4 sy-4 md:sy-6">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <Avatar name={customerName || '?'} className="h-12 w-12" fallbackClassName="text-lg" />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/app/customers/${karte.customer_id}`} className="text-lg font-semibold">
                      {customerName}
                    </Link>
                    {karte.shared_with_customer ? (
                      <Badge variant="success">共有済み</Badge>
                    ) : canWrite ? (
                      <Button variant="outline" size="sm" onClick={() => void share()} disabled={busy}>
                        <Share2 className="mr-1 h-3 w-3" />
                        共有
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      {formatWhen(karte.visit_date, tz, 'date')}
                    </span>
                    <span className="flex items-center gap-1">
                      <User className="h-4 w-4" />
                      担当: {karte.staff_name}
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Scissors className="h-4 w-4" />
                施術内容
              </CardTitle>
            </CardHeader>
            <CardContent className="sy-4">
              {record.menu_content ? (
                <div>
                  <Label className="text-xs text-muted-foreground">メニュー</Label>
                  <p className="mt-1">{record.menu_content}</p>
                </div>
              ) : null}
              {record.hair_condition ? (
                <div>
                  <Label className="text-xs text-muted-foreground">髪の状態</Label>
                  <p className="mt-1 whitespace-pre-wrap">{record.hair_condition}</p>
                </div>
              ) : null}
              {record.color_formula ? (
                <div>
                  <Label className="text-xs text-muted-foreground">カラー配合</Label>
                  <p className="mt-1 rounded-sm bg-muted px-2 py-1 font-mono text-sm">{record.color_formula}</p>
                </div>
              ) : null}
              {record.perm_info ? (
                <div>
                  <Label className="text-xs text-muted-foreground">パーマ情報</Label>
                  <p className="mt-1 whitespace-pre-wrap">{record.perm_info}</p>
                </div>
              ) : null}
              {record.styling_notes ? (
                <div>
                  <Label className="text-xs text-muted-foreground">スタイリングメモ</Label>
                  <p className="mt-1 whitespace-pre-wrap">{record.styling_notes}</p>
                </div>
              ) : null}
              {record.customer_feedback ? (
                <div>
                  <Label className="text-xs text-muted-foreground">お客様フィードバック</Label>
                  <p className="mt-1 whitespace-pre-wrap">{record.customer_feedback}</p>
                </div>
              ) : null}
              {record.next_suggestion ? (
                <div>
                  <Label className="text-xs text-muted-foreground">次回提案</Label>
                  <p className="mt-1 whitespace-pre-wrap">{record.next_suggestion}</p>
                </div>
              ) : null}
              {templateRows.map((r) => (
                <div key={r.key} data-template-field={r.key}>
                  <Label className="text-xs text-muted-foreground">{r.label}</Label>
                  <p className="mt-1 whitespace-pre-wrap">{displayFieldValue(r.value)}</p>
                </div>
              ))}
              {chemicals.length > 0 ? (
                <div>
                  <Label className="text-xs text-muted-foreground">薬剤</Label>
                  {chemicals.map((ch, i) => (
                    <p key={i} className="mt-1 rounded-sm bg-muted px-2 py-1 font-mono text-sm">
                      {[ch.brand, ch.name, ch.ratio, ch.processing_min != null ? `${ch.processing_min}分` : null, ch.note]
                        .filter(Boolean)
                        .join(' ')}
                    </p>
                  ))}
                </div>
              ) : null}
              {advice ? (
                <div>
                  <Label className="text-xs text-muted-foreground">ホームケア</Label>
                  <p className="mt-1 whitespace-pre-wrap">{advice}</p>
                </div>
              ) : null}
              {karte.note ? (
                <div className="rounded-lg bg-yellow-50 p-3">
                  <Label className="text-xs text-muted-foreground">内部メモ（非公開）</Label>
                  <p className="mt-1 whitespace-pre-wrap">{karte.note}</p>
                </div>
              ) : null}
              {!hasRecord ? (
                <div className="py-4 text-center text-muted-foreground">施術内容が記録されていません</div>
              ) : null}
              <Link
                to={`/app/kartes/${karte.id}`}
                data-testid="karte-classic-link"
                className="block text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                テンプレート項目・薬剤・ホームケア・共有設定を開く
              </Link>
            </CardContent>
          </Card>

          {faceUrl ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Pencil className="h-4 w-4" />
                  フェイス描画
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex justify-center">
                  <div className="max-w-[280px] overflow-hidden rounded-lg border bg-white">
                    <img src={faceUrl} alt="フェイス描画" className="h-auto w-full" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Camera className="h-4 w-4" />
                  施術写真
                </CardTitle>
                {canWrite ? (
                  <Button variant="outline" size="sm" onClick={() => setAddingPhoto(true)}>
                    <ImagePlus className="mr-1 h-4 w-4" />
                    追加
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {photos.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">写真がありません</div>
              ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                  {photos.map((a) => (
                    <div key={a.id} className="group relative" data-karte-photo={a.id}>
                      <div className="aspect-square overflow-hidden rounded-lg bg-muted">
                        {a.content_type.startsWith('image/') ? (
                          <img
                            src={sameOriginBlobUrl(a.url)}
                            alt={a.caption || '施術写真'}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <a
                            href={sameOriginBlobUrl(a.url)}
                            target="_blank"
                            rel="noreferrer"
                            className="flex h-full w-full flex-col items-center justify-center gap-2 p-2 text-center text-xs text-muted-foreground"
                          >
                            <FileText className="h-8 w-8" />
                            <span className="break-all">{a.file_name ?? '書類'}</span>
                          </a>
                        )}
                      </div>
                      <Badge variant="secondary" className="absolute left-2 top-2 text-xs">
                        {photoLabel(a.asset_type)}
                      </Badge>
                      {canWrite ? (
                        <Button
                          variant="destructive"
                          size="icon"
                          aria-label="写真を削除"
                          className="absolute right-2 top-2 h-6 w-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => setPhotoToDelete(a)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      ) : null}
                      {a.caption ? <p className="mt-1 truncate text-xs text-muted-foreground">{a.caption}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div role="tabpanel" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="h-4 w-4" />
                カウンセリングシート
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CounselingSheet customerId={karte.customer_id} shopId={karte.shop_id} />
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={<DialogTitle>カルテ編集</DialogTitle>}
        className="max-h-[90vh] max-w-lg overflow-y-auto"
      >
        <div className="sy-4 py-4">
          <div className="sy-2">
            <Label htmlFor="karte-visit-date">来店日</Label>
            <Input
              id="karte-visit-date"
              type="date"
              value={form.visit_date}
              onChange={(e) => set({ visit_date: e.target.value })}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-menu">施術内容</Label>
            <Input
              id="karte-menu"
              value={form.menu_content}
              onChange={(e) => set({ menu_content: e.target.value })}
              placeholder="カット、カラー..."
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-hair">髪の状態</Label>
            <Textarea
              id="karte-hair"
              value={form.hair_condition}
              onChange={(e) => set({ hair_condition: e.target.value })}
              placeholder="髪質、ダメージ状態..."
              rows={2}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-color">カラー配合</Label>
            <Input
              id="karte-color"
              value={form.color_formula}
              onChange={(e) => set({ color_formula: e.target.value })}
              placeholder="8AB:6N = 1:1 + 6%OX"
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-perm">パーマ情報</Label>
            <Textarea
              id="karte-perm"
              value={form.perm_info}
              onChange={(e) => set({ perm_info: e.target.value })}
              placeholder="ロッド、放置時間..."
              rows={2}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-styling">スタイリングメモ</Label>
            <Textarea
              id="karte-styling"
              value={form.styling_notes}
              onChange={(e) => set({ styling_notes: e.target.value })}
              placeholder="スタイリングのポイント..."
              rows={2}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-feedback">お客様フィードバック</Label>
            <Textarea
              id="karte-feedback"
              value={form.customer_feedback}
              onChange={(e) => set({ customer_feedback: e.target.value })}
              placeholder="お客様からの感想..."
              rows={2}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-next">次回提案</Label>
            <Textarea
              id="karte-next"
              value={form.next_suggestion}
              onChange={(e) => set({ next_suggestion: e.target.value })}
              placeholder="次回の施術提案..."
              rows={2}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-memo">内部メモ（非公開）</Label>
            <Textarea
              id="karte-memo"
              value={form.internal_memo}
              onChange={(e) => set({ internal_memo: e.target.value })}
              placeholder="スタッフ間共有メモ..."
              rows={2}
            />
          </div>
          <div className="sy-2">
            <Label className="flex items-center gap-2">
              <Pencil className="h-4 w-4" />
              フェイス描画
            </Label>
            <FaceDrawing onChange={setDrawing} initialImage={drawingBase} />
          </div>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:sx-2">
          <Button variant="outline" onClick={() => setEditing(false)}>
            キャンセル
          </Button>
          <Button onClick={() => void save()} disabled={saving} data-testid="save-karte-record">
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </Dialog>

      <Dialog open={addingPhoto} onOpenChange={setAddingPhoto} title={<DialogTitle>写真を追加</DialogTitle>}>
        <div className="sy-4 py-4">
          <div className="sy-2">
            <Label>写真の種類</Label>
            <Select
              label="写真の種類"
              value={photoKind}
              onValueChange={(v) => setPhotoKind(v as PhotoKind)}
              options={[
                { value: 'before', label: '施術前' },
                { value: 'after', label: '施術後' },
                { value: 'other', label: 'その他' },
              ]}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="karte-photo-caption">キャプション（任意）</Label>
            <Input
              id="karte-photo-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="写真の説明..."
            />
          </div>
          <input
            type="file"
            ref={fileRef}
            accept="image/*"
            data-testid="karte-record-photo-input"
            onChange={(e) => void onFile(e)}
            className="hidden"
          />
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:sx-2">
          <Button variant="outline" onClick={() => setAddingPhoto(false)}>
            キャンセル
          </Button>
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? 'アップロード中...' : '写真を選択'}
          </Button>
        </div>
      </Dialog>

      <AlertDialog
        open={!!photoToDelete}
        onOpenChange={(open) => !open && setPhotoToDelete(null)}
        title="写真を削除しますか？"
        description="この操作は取り消せません。"
        actionLabel="削除"
        actionClassName="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        onAction={() => void deletePhoto()}
        busy={busy}
      />
      <AlertDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="カルテを削除しますか？"
        description="このカルテと関連する写真がすべて削除されます。この操作は取り消せません。"
        actionLabel="削除"
        actionClassName="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        onAction={() => void deleteKarte()}
        busy={busy}
      />
    </div>
  );
}
