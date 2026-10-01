/**
 * Printable consent / counseling document. Everything user-provided is HTML-escaped;
 * the markdown subset (headings, lists, bold, paragraphs) is rendered after escaping.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let list: string[] | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^\s*[-*・]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1]!.length + 1, 5);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (item) {
      flushPara();
      (list ??= []).push(item[1]!);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

export interface ConsentDocument {
  title: string;
  version: number;
  shopName: string | null;
  customerName: string;
  bodyMarkdown: string | null;
  answers: { label: string; value: string }[];
  signatureUrl: string | null;
  signerName: string | null;
  signedAt: string | null;
  submittedAt: string | null;
  submittedVia: string | null;
  documentHash: string | null;
  voided: { reason: string | null; at: string | null } | null;
}

const VIA: Record<string, string> = { staff: '店頭(スタッフ端末)', customer_link: 'お客様専用リンク', line: 'LINE' };

export function renderConsentHtml(d: ConsentDocument): string {
  const rows = d.answers.map((a) => `<tr><th>${escapeHtml(a.label)}</th><td>${escapeHtml(a.value) || '<span class="muted">未回答</span>'}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.title)}</title>
<style>
  body { font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; color: #222; max-width: 760px; margin: 24px auto; padding: 0 16px; line-height: 1.7; }
  h1 { font-size: 22px; border-bottom: 2px solid #222; padding-bottom: 6px; }
  h2, h3, h4, h5 { font-size: 16px; margin-top: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { border: 1px solid #bbb; padding: 6px 10px; text-align: left; vertical-align: top; font-size: 14px; }
  th { background: #f4f4f4; width: 40%; }
  .meta { font-size: 13px; color: #555; }
  .muted { color: #999; }
  .signature img { max-width: 320px; max-height: 140px; border-bottom: 1px solid #222; }
  .hash { font-family: monospace; font-size: 11px; word-break: break-all; color: #555; }
  .void { border: 3px solid #c00; color: #c00; padding: 8px 12px; font-weight: bold; margin: 12px 0; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
${d.voided ? `<div class="void">この書類は無効化されています${d.voided.at ? `(${escapeHtml(d.voided.at)})` : ''}${d.voided.reason ? `<br>理由: ${escapeHtml(d.voided.reason)}` : ''}</div>` : ''}
<h1>${escapeHtml(d.title)}</h1>
<p class="meta">${d.shopName ? `${escapeHtml(d.shopName)} / ` : ''}版: ${d.version} / お客様: ${escapeHtml(d.customerName)} 様</p>
${d.bodyMarkdown ? `<section class="body">${renderMarkdown(d.bodyMarkdown)}</section>` : ''}
<table>
${rows}
</table>
<section class="signature">
  ${d.signatureUrl ? `<p>署名:</p><img src="${escapeHtml(d.signatureUrl)}" alt="署名">` : ''}
  ${d.signerName ? `<p>署名者: ${escapeHtml(d.signerName)}</p>` : ''}
  ${d.signedAt ? `<p>署名日時: ${escapeHtml(d.signedAt)}</p>` : ''}
  ${d.submittedAt ? `<p>提出日時: ${escapeHtml(d.submittedAt)}${d.submittedVia ? ` (${escapeHtml(VIA[d.submittedVia] ?? d.submittedVia)})` : ''}</p>` : ''}
</section>
${d.documentHash ? `<p class="hash">文書ハッシュ (SHA-256): ${escapeHtml(d.documentHash)}</p>` : ''}
</body>
</html>`;
}
