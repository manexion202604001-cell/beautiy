'use client';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ImagePlus, Trash2, Eye, EyeOff, Link2, Send, RefreshCw } from 'lucide-react';
import { CopyButton } from '@/components/client';
import { deletePhotoAction, sendShareAction, setShareAction, updatePhotoAction, uploadPhotoAction } from '../actions';

export interface PhotoItem { id: string; kind: string; caption: string | null; shareable: boolean; url: string }
const KIND_LABEL: Record<string, string> = { BEFORE: 'ビフォー', AFTER: 'アフター', OTHER: 'その他' };
const KIND_TONE: Record<string, string> = { BEFORE: 'amber', AFTER: 'blue', OTHER: '' };
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_EDGE = 2048;

/** Downscale large photos in the browser before upload (keeps requests well under limits). */
async function shrink(file: File): Promise<File> {
  if (!RESIZABLE.has(file.type) || file.size < 1_200_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale);
    cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', 0.86));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export function PhotoPanel({ karteId, photos, canEdit }: { karteId: string; photos: PhotoItem[]; canEdit: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState('AFTER');
  const [caption, setCaption] = useState('');
  const [shareable, setShareable] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<PhotoItem | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null); setOk(null);
    const list = Array.from(files).slice(0, 10);
    let done = 0;
    for (const f of list) {
      setProgress(`${done + 1} / ${list.length} 枚目をアップロード中…`);
      const fd = new FormData();
      fd.set('karteId', karteId); fd.set('kind', kind); fd.set('caption', caption);
      if (shareable) fd.set('shareable', 'on');
      fd.append('photos', await shrink(f));
      const r = await uploadPhotoAction(fd).catch(() => ({ ok: false as const, error: '通信エラーが発生しました。再試行してください。' }));
      if (!r.ok) { setErr(`${f.name}: ${r.error}`); break; }
      done++;
    }
    setProgress(null);
    if (done) { setOk(`${done}枚の写真を追加しました`); setCaption(''); }
    if (fileRef.current) fileRef.current.value = '';
    router.refresh();
  };

  const act = async (id: string, fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fields: Record<string, string>) => {
    setBusy(id); setErr(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const r = await fn(fd);
    if (!r.ok) setErr(r.error ?? 'エラーが発生しました');
    setBusy(null);
    router.refresh();
  };

  const groups = ['BEFORE', 'AFTER', 'OTHER'].map((k) => ({ k, items: photos.filter((p) => p.kind === k) })).filter((g) => g.items.length);

  return (
    <div className="card">
      <div className="card-head"><h2>写真</h2><span className="sub">{photos.length}枚</span></div>
      {canEdit && (
        <div className="kt-upload">
          <div className="seg" role="radiogroup" aria-label="写真の種類">
            {['BEFORE', 'AFTER', 'OTHER'].map((k) => <button key={k} type="button" className={kind === k ? 'active' : ''} onClick={() => setKind(k)} role="radio" aria-checked={kind === k}>{KIND_LABEL[k]}</button>)}
          </div>
          <input className="input sm" placeholder="キャプション（任意）" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={200} aria-label="キャプション" />
          <label className="checkbox"><input type="checkbox" checked={shareable} onChange={(e) => setShareable(e.target.checked)} />お客様に共有可</label>
          <label className={`btn sm ${progress ? 'disabled' : ''}`} aria-disabled={!!progress}>
            {progress ? <span className="spinner" /> : <ImagePlus size={14} />}写真を追加
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/gif" multiple hidden disabled={!!progress} onChange={(e) => upload(e.target.files)} />
          </label>
        </div>
      )}
      {progress && <div className="alert info" style={{ marginTop: 10 }}>{progress}</div>}
      {err && <div className="alert error" style={{ marginTop: 10 }} role="alert">{err}</div>}
      {ok && <div className="alert success" style={{ marginTop: 10 }} role="status">{ok}</div>}
      {photos.length === 0 ? (
        <p className="sub" style={{ margin: '12px 0 0' }}>写真はまだありません。{canEdit ? 'ビフォー・アフターを撮影して追加しましょう。' : ''}</p>
      ) : groups.map((g) => (
        <div key={g.k} className="section">
          <div className="label" style={{ marginBottom: 6 }}>{KIND_LABEL[g.k]}</div>
          <div className="photo-grid">
            {g.items.map((p) => (
              <figure key={p.id} className="kt-photo">
                <button type="button" className="photo" onClick={() => setView(p)} aria-label="拡大表示">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={p.caption ?? KIND_LABEL[p.kind]} loading="lazy" />
                  <span className={`badge tag ${KIND_TONE[p.kind] ?? ''}`}>{KIND_LABEL[p.kind] ?? p.kind}</span>
                  {!p.shareable && <span className="badge kt-private">非共有</span>}
                </button>
                {p.caption && <figcaption className="sub crm-clamp">{p.caption}</figcaption>}
                {canEdit && (
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    <button type="button" className="btn ghost sm" disabled={busy === p.id} onClick={() => act(p.id, updatePhotoAction, { photoId: p.id, shareable: p.shareable ? '0' : '1' })} title={p.shareable ? 'お客様に共有しない' : 'お客様に共有する'}>
                      {p.shareable ? <><Eye size={13} />共有</> : <><EyeOff size={13} />非共有</>}
                    </button>
                    <button type="button" className="btn ghost sm" disabled={busy === p.id} onClick={() => window.confirm('この写真を削除しますか？') && act(p.id, deletePhotoAction, { photoId: p.id })} aria-label="削除"><Trash2 size={13} /></button>
                  </div>
                )}
              </figure>
            ))}
          </div>
        </div>
      ))}
      {view && (
        <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && setView(null)} role="dialog" aria-modal="true">
          <div className="kt-lightbox">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={view.url} alt={view.caption ?? ''} />
            <div className="between" style={{ padding: '8px 4px 0', color: '#fff' }}>
              <span>{KIND_LABEL[view.kind]}{view.caption ? ` ・ ${view.caption}` : ''}</span>
              <button type="button" className="btn secondary sm" onClick={() => setView(null)}>閉じる</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SharePanel({ karteId, enabled, url, sharedAt, careMemo, shareablePhotos, canEdit, canSend, reach }: {
  karteId: string; enabled: boolean; url: string | null; sharedAt: string | null; careMemo: boolean; shareablePhotos: number; canEdit: boolean; canSend: boolean;
  /** whether the customer can receive on each channel (linked + opted in) */
  reach: { line: boolean; email: boolean };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, fields: Record<string, string>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    start(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const r: { ok: boolean; error?: string; message?: string } = await fn(fd).catch(() => ({ ok: false, error: '通信エラーが発生しました' }));
      setMsg(r.ok ? (r.message ? { ok: true, text: r.message } : null) : { ok: false, text: r.error ?? 'エラー' });
      router.refresh();
    });
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>お客様への共有</h2>
        <span className={`badge ${enabled ? 'green' : ''}`}>{enabled ? '共有中' : '非公開'}</span>
      </div>
      <p className="sub" style={{ marginTop: 0 }}>共有ページには<strong>ケアメモ</strong>と<strong>「共有可」の写真</strong>（{shareablePhotos}枚）、担当者名のみが表示されます。施術内容・薬剤・社内メモ・連絡先は表示されません。</p>
      {!careMemo && shareablePhotos === 0 && <div className="alert warn" style={{ marginBottom: 10 }}>ケアメモと共有可の写真がありません。共有ページがほぼ空になります。</div>}
      {enabled && url && (
        <div className="row" style={{ alignItems: 'stretch', marginBottom: 10 }}>
          <input className="input sm mono" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="共有URL" />
          <CopyButton text={url} />
          <a className="btn secondary sm" href={url} target="_blank" rel="noreferrer"><Link2 size={13} />開く</a>
        </div>
      )}
      {msg && <div className={`alert ${msg.ok ? 'success' : 'error'}`} style={{ marginBottom: 10 }}>{msg.text}</div>}
      {canEdit && (
        <div className="row-wrap">
          {enabled ? (
            <>
              {canSend && <button type="button" className="btn sm" disabled={pending || !reach.line} title={reach.line ? undefined : 'LINE未連携、または配信停止中です'} onClick={() => run(sendShareAction, { karteId, channel: 'LINE' })}><Send size={13} />LINEで共有</button>}
              {canSend && <button type="button" className="btn secondary sm" disabled={pending || !reach.email} title={reach.email ? undefined : 'メール未登録、または配信停止中です'} onClick={() => run(sendShareAction, { karteId, channel: 'EMAIL' })}>メールで共有</button>}
              <button type="button" className="btn ghost sm" disabled={pending} onClick={() => run(setShareAction, { karteId, mode: 'regenerate' }, '共有URLを作り直しますか？\n以前のURLは使えなくなります。')}><RefreshCw size={13} />URL再発行</button>
              <button type="button" className="btn danger-outline sm" disabled={pending} onClick={() => run(setShareAction, { karteId, mode: 'disable' })}>共有を停止</button>
            </>
          ) : (
            <button type="button" className="btn sm" disabled={pending} onClick={() => run(setShareAction, { karteId, mode: 'enable' })}>{pending ? <span className="spinner" /> : <Link2 size={13} />}共有リンクを発行</button>
          )}
        </div>
      )}
      {enabled && canSend && !reach.line && !reach.email && <p className="sub" style={{ margin: '8px 0 0' }}>LINE・メールで送れる連絡先がありません。URLをコピーしてお渡しください。</p>}
      {sharedAt && <p className="sub" style={{ margin: '8px 0 0' }}>最終共有: {sharedAt}</p>}
    </div>
  );
}
