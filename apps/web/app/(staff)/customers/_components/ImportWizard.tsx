'use client';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { FileUp, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import { parseCsv } from '@salonos/core';
import { importCustomersAction } from '../actions';

// Mirrors IMPORT_FIELDS in lib/server/crm.ts (server module; not importable here).
const FIELDS = {
  lastName: '姓', firstName: '名', fullName: '氏名（姓名まとめて）', lastNameKana: 'セイ', firstNameKana: 'メイ', fullKana: 'フリガナ（まとめて）',
  phone: '電話', email: 'メール', birthday: '誕生日', gender: '性別', address: '住所', notes: 'メモ', tags: 'タグ',
} as const;
type Field = keyof typeof FIELDS;
const ALIASES: Record<Field, string[]> = {
  lastName: ['姓', '苗字', '名字', 'lastname', 'last_name', 'last name', 'family name'],
  firstName: ['名', '名前', 'firstname', 'first_name', 'first name', 'given name'],
  fullName: ['氏名', 'お名前', '顧客名', 'name', 'フルネーム'],
  lastNameKana: ['セイ', 'せい', '姓カナ', '姓（カナ）', 'フリガナ姓', 'ふりがな姓'],
  firstNameKana: ['メイ', 'めい', '名カナ', '名（カナ）', 'フリガナ名', 'ふりがな名'],
  fullKana: ['フリガナ', 'ふりがな', 'カナ', 'kana', '氏名カナ', '氏名（カナ）'],
  phone: ['電話', '電話番号', '携帯', '携帯番号', 'tel', 'phone', 'mobile'],
  email: ['メール', 'メールアドレス', 'email', 'e-mail', 'mail'],
  birthday: ['誕生日', '生年月日', 'birthday', 'birthdate'],
  gender: ['性別', 'gender', 'sex'],
  address: ['住所', 'address'],
  notes: ['メモ', '備考', 'note', 'notes', 'memo'],
  tags: ['タグ', 'tag', 'tags', 'ラベル'],
};
const TEMPLATE_HEADER = ['姓', '名', 'セイ', 'メイ', '電話', 'メール', '誕生日', 'メモ', 'タグ'];
const MAX_ROWS = 5000;

interface RowResult { row: number; action: 'create' | 'update' | 'skip' | 'error'; name: string; message?: string; customerId?: string; matchedBy?: string }
interface Report { created: number; updated: number; skipped: number; errors: number; rows: RowResult[]; dryRun: boolean }

function guess(header: string): Field | '' {
  const h = header.normalize('NFKC').trim().toLowerCase();
  for (const [k, list] of Object.entries(ALIASES) as [Field, string[]][]) if (list.some((a) => a.normalize('NFKC').toLowerCase() === h)) return k;
  return '';
}

async function decode(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('shift_jis').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

const ACTION_LABEL: Record<RowResult['action'], string> = { create: '新規登録', update: '更新', skip: 'スキップ', error: 'エラー' };
const ACTION_TONE: Record<RowResult['action'], string> = { create: 'green', update: 'blue', skip: '', error: 'red' };

export function ImportWizard() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<(Field | '')[]>([]);
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<'all' | RowResult['action']>('all');

  const header = table?.[0] ?? [];
  const body = useMemo(() => table?.slice(1) ?? [], [table]);
  const mapped = useMemo(() => body.map((r) => {
    const o: Partial<Record<Field, string>> = {};
    mapping.forEach((f, i) => { if (f && r[i] !== undefined && r[i].trim() !== '') o[f] = o[f] ? `${o[f]};${r[i]}` : r[i]; });
    return o;
  }), [body, mapping]);
  const hasName = mapping.some((f) => f === 'lastName' || f === 'fullName');
  const dupTargets = mapping.filter((f, i) => f && f !== 'tags' && mapping.indexOf(f) !== i);

  const onFile = async (f: File | null) => {
    setErr(null); setReport(null);
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setErr('ファイルサイズは8MBまでです'); return; }
    const text = await decode(f);
    const rows = parseCsv(text);
    if (rows.length < 2) { setErr('データ行がありません。1行目に見出し、2行目以降に顧客データを入れてください。'); return; }
    if (rows.length - 1 > MAX_ROWS) { setErr(`一度に取り込めるのは${MAX_ROWS}行までです（${rows.length - 1}行）。ファイルを分割してください。`); return; }
    setFileName(f.name);
    setTable(rows);
    setMapping(rows[0].map(guess));
  };

  const run = (dryRun: boolean) => start(async () => {
    setErr(null);
    const r = await importCustomersAction({ rows: mapped as Record<string, string>[], mode, dryRun });
    if (!r.ok) { setErr(r.error); return; }
    setReport(r.data ?? null);
    setFilter('all');
  });

  const downloadTemplate = () => {
    const csv = '﻿' + TEMPLATE_HEADER.join(',') + '\r\n' + '山田,花子,ヤマダ,ハナコ,090-1234-5678,hanako@example.com,1990/04/01,カラーはアッシュ系希望,VIP;紹介\r\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = '顧客インポート_テンプレート.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const shown = report?.rows.filter((r) => filter === 'all' || r.action === filter) ?? [];

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>1. CSVファイルを選択</h2><button type="button" className="btn ghost sm" onClick={downloadTemplate}><Download size={14} />テンプレート</button></div>
        <label className="crm-drop">
          <FileUp size={22} />
          <span>{fileName ? <><strong>{fileName}</strong>（{body.length.toLocaleString()}行）— 別のファイルを選ぶ</> : 'クリックしてCSVファイルを選択（UTF-8 / Shift_JIS）'}</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        </label>
        <p className="sub" style={{ margin: '8px 0 0' }}>見出しの例: {TEMPLATE_HEADER.join(' / ')}。電話番号またはメールアドレスが既存の顧客と一致した行は重複として扱います。タグは「;」区切りで複数指定できます。</p>
      </div>

      {err && <div className="alert error" role="alert">{err}</div>}

      {table && (
        <div className="card">
          <div className="card-head"><h2>2. 項目の対応付け</h2><span className="sub">プレビュー（先頭5行）</span></div>
          <div className="table-wrap">
            <table className="table crm-import-map">
              <thead>
                <tr>{header.map((h, i) => (
                  <th key={i}>
                    <div className="sub">{h || `列${i + 1}`}</div>
                    <select className="select sm" value={mapping[i] ?? ''} onChange={(e) => { setReport(null); setMapping((m) => m.map((x, j) => (j === i ? (e.target.value as Field | '') : x))); }} aria-label={`${h}の取り込み先`}>
                      <option value="">取り込まない</option>
                      {(Object.keys(FIELDS) as Field[]).map((f) => <option key={f} value={f}>{FIELDS[f]}</option>)}
                    </select>
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {body.slice(0, 5).map((r, i) => <tr key={i}>{header.map((_, j) => <td key={j} className={mapping[j] ? '' : 'sub'}>{r[j]}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
          {!hasName && <div className="alert warn" style={{ marginTop: 10 }}>「姓」または「氏名」の列を指定してください。</div>}
          {dupTargets.length > 0 && <div className="alert warn" style={{ marginTop: 10 }}>同じ項目に複数の列が割り当てられています（値は「;」で連結されます）。</div>}

          <div className="section">
            <div className="label" style={{ marginBottom: 6 }}>3. 既存顧客と一致した場合</div>
            <div className="seg" role="radiogroup">
              <button type="button" className={mode === 'skip' ? 'active' : ''} onClick={() => { setMode('skip'); setReport(null); }} role="radio" aria-checked={mode === 'skip'}>スキップする</button>
              <button type="button" className={mode === 'update' ? 'active' : ''} onClick={() => { setMode('update'); setReport(null); }} role="radio" aria-checked={mode === 'update'}>CSVの内容で更新する</button>
            </div>
            <p className="sub" style={{ margin: '6px 0 0' }}>{mode === 'skip' ? '一致した行は取り込みません。' : '一致した顧客の、CSVに値がある項目だけを上書きします（タグは追加、メモは追記）。'}</p>
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" disabled={!hasName || pending} onClick={() => run(true)}>{pending ? <span className="spinner" /> : null}取り込み内容を確認</button>
            <button type="button" className="btn" disabled={!hasName || pending || !report?.dryRun} onClick={() => run(false)} title={report?.dryRun ? undefined : '先に内容を確認してください'}>取り込みを実行</button>
          </div>
        </div>
      )}

      {report && (
        <div className="card">
          <div className="card-head">
            <h2>{report.dryRun ? '確認結果（まだ保存されていません）' : '取り込み結果'}</h2>
            {!report.dryRun && <Link href="/customers?sort=created" className="btn secondary sm">顧客一覧を見る</Link>}
          </div>
          {!report.dryRun && <div className="alert success" style={{ marginBottom: 12 }}><CheckCircle2 size={14} /> 取り込みが完了しました。</div>}
          <div className="grid-4">
            {(['create', 'update', 'skip', 'error'] as const).map((k) => (
              <button key={k} type="button" className={`card stat crm-stat-btn ${filter === k ? 'active' : ''}`} onClick={() => setFilter(filter === k ? 'all' : k)}>
                <div className="label">{ACTION_LABEL[k]}</div>
                <div className="value">{{ create: report.created, update: report.updated, skip: report.skipped, error: report.errors }[k].toLocaleString()}</div>
              </button>
            ))}
          </div>
          {report.errors > 0 && <div className="alert warn section"><AlertTriangle size={14} /> エラーの行は取り込まれません。CSVを修正して再度取り込んでください。</div>}
          <div className="table-wrap section" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>行</th><th>氏名</th><th>処理</th><th>詳細</th></tr></thead>
              <tbody>
                {shown.slice(0, 500).map((r) => (
                  <tr key={r.row}>
                    <td className="num">{r.row}</td>
                    <td>{r.customerId && !report.dryRun ? <Link className="link" href={`/customers/${r.customerId}`}>{r.name}</Link> : r.name}</td>
                    <td><span className={`badge ${ACTION_TONE[r.action]}`}>{ACTION_LABEL[r.action]}</span></td>
                    <td className="sub">{r.message ?? (r.matchedBy ? `${r.matchedBy === 'phone' ? '電話番号' : 'メール'}で一致` : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > 500 && <p className="sub" style={{ padding: 10 }}>先頭500件を表示しています。</p>}
          </div>
        </div>
      )}
    </div>
  );
}
