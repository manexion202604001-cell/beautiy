import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { IMAGE_ACCEPT, sameOriginBlobUrl, uploadFile } from '../../../api/files';
import {
  ASSET_TYPE_LABEL,
  karteKeys,
  kartesApi,
  type AssetType,
  type KarteAsset,
  type KarteDetail,
} from '../../../api/kartes';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';

const UPLOAD_TYPES: AssetType[] = ['photo_before', 'photo_after', 'photo', 'sketch'];

/** Photos (before/after/sketch): presign → PUT → complete → attach; previews via signed URLs */
export function KarteAssets({ karte, writable }: { karte: KarteDetail; writable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [assetType, setAssetType] = useState<AssetType>('photo_before');
  const [share, setShare] = useState(true);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<KarteAsset | null>(null);
  const [deleting, setDeleting] = useState<KarteAsset | null>(null);
  const [viewing, setViewing] = useState<KarteAsset | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: karteKeys.detail(karte.id) });

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const list = [...files];
    setUploading(list.length);
    let ok = 0;
    for (const file of list) {
      try {
        const purpose = assetType === 'sketch' ? 'sketch' : 'karte_photo';
        const uploaded = await uploadFile(file, purpose);
        await kartesApi.addAsset(karte.id, {
          fileId: uploaded.id,
          assetType,
          shareWithCustomer: share,
        });
        ok++;
      } catch (e) {
        setError(`${file.name}: ${errorMessage(e)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (inputRef.current) inputRef.current.value = '';
    if (ok) {
      toast.success(`${ok}枚の画像を追加しました`);
      await refresh();
    }
  };

  const remove = async (a: KarteAsset) => {
    try {
      await kartesApi.removeAsset(karte.id, a.id);
      toast.success('画像を削除しました');
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setDeleting(null);
    }
  };

  const groups = (['photo_before', 'photo_after', 'photo', 'sketch', 'document'] as AssetType[])
    .map((t) => ({ t, items: karte.assets.filter((a) => a.asset_type === t) }))
    .filter((g) => g.items.length);

  return (
    <Card>
      <CardHeader title="写真・スケッチ" description={`${karte.assets.length}枚`} />
      {error ? (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      ) : null}
      {writable ? (
        <div className="mb-4 space-y-3 rounded-xl bg-surface-2 p-3">
          <Field label="種類">
            <Select
              value={assetType}
              onChange={(e) => setAssetType(e.target.value as AssetType)}
              selectSize="sm"
            >
              {UPLOAD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ASSET_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Switch
            checked={share}
            onChange={setShare}
            label="お客様に共有する"
            description="共有ページに表示されます"
          />
          <input
            ref={inputRef}
            type="file"
            accept={assetType === 'sketch' ? 'image/png,image/jpeg,image/webp' : IMAGE_ACCEPT}
            multiple
            className="sr-only"
            id={`karte-upload-${karte.id}`}
            data-testid="karte-photo-input"
            onChange={(e) => void onFiles(e.target.files)}
          />
          <Button
            variant="primary"
            icon="plus"
            className="w-full"
            loading={uploading > 0}
            onClick={() => inputRef.current?.click()}
          >
            {uploading > 0
              ? `アップロード中（残り${uploading}）`
              : '写真を追加（カメラ / ファイル）'}
          </Button>
        </div>
      ) : null}
      {!karte.assets.length ? (
        <p className="text-[13px] text-muted">画像はまだありません。</p>
      ) : null}
      <div className="space-y-4">
        {groups.map((g) => (
          <section key={g.t}>
            <h3 className="mb-1.5 text-xs font-semibold text-muted">{ASSET_TYPE_LABEL[g.t]}</h3>
            <ul className="grid grid-cols-2 gap-2">
              {g.items.map((a) => (
                <li key={a.id} className="overflow-hidden rounded-xl border border-border">
                  <button
                    type="button"
                    className="block w-full"
                    onClick={() => setViewing(a)}
                    aria-label={`${ASSET_TYPE_LABEL[a.asset_type]}を拡大`}
                  >
                    {a.content_type.startsWith('image/') ? (
                      <img
                        src={sameOriginBlobUrl(a.url)}
                        alt={a.caption ?? ASSET_TYPE_LABEL[a.asset_type]}
                        className="aspect-square w-full bg-surface-2 object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span className="flex aspect-square items-center justify-center bg-surface-2 text-xs text-muted">
                        {a.file_name ?? '書類'}
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    {a.share_with_customer ? (
                      <Badge size="sm" tone="primary">
                        共有
                      </Badge>
                    ) : (
                      <Badge size="sm">非共有</Badge>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                      {a.caption ?? ''}
                    </span>
                    {writable ? (
                      <>
                        <button
                          type="button"
                          className="text-[11px] text-primary"
                          onClick={() => setEditing(a)}
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          className="text-[11px] text-danger"
                          onClick={() => setDeleting(a)}
                        >
                          削除
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {editing ? (
        <AssetEditDialog
          karteId={karte.id}
          asset={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="画像を削除しますか？"
        tone="danger"
        confirmLabel="削除する"
        onConfirm={() => deleting && void remove(deleting)}
      />
      {viewing ? (
        <Dialog
          open
          onClose={() => setViewing(null)}
          title={ASSET_TYPE_LABEL[viewing.asset_type]}
          description={viewing.caption ?? undefined}
          size="xl"
        >
          <img
            src={sameOriginBlobUrl(viewing.url)}
            alt={viewing.caption ?? ASSET_TYPE_LABEL[viewing.asset_type]}
            className="mx-auto max-h-[70vh] rounded-xl object-contain"
          />
        </Dialog>
      ) : null}
    </Card>
  );
}

function AssetEditDialog({
  karteId,
  asset,
  onClose,
  onSaved,
}: {
  karteId: string;
  asset: KarteAsset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [caption, setCaption] = useState(asset.caption ?? '');
  const [type, setType] = useState<AssetType>(asset.asset_type);
  const [share, setShare] = useState(asset.share_with_customer);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await kartesApi.updateAsset(karteId, asset.id, {
        caption: caption.trim() || null,
        shareWithCustomer: share,
        ...(type !== asset.asset_type ? { assetType: type } : {}),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="画像の情報"
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="種類">
          <Select value={type} onChange={(e) => setType(e.target.value as AssetType)}>
            {(Object.keys(ASSET_TYPE_LABEL) as AssetType[]).map((t) => (
              <option key={t} value={t}>
                {ASSET_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="キャプション" optional>
          <Input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={500} />
        </Field>
        <Switch checked={share} onChange={setShare} label="お客様に共有する" />
      </div>
    </Dialog>
  );
}
