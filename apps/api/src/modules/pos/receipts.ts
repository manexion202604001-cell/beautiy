import { assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { formatJst } from '../../lib/time.js';
import { formatNumber, loadPosShop, localYear, METHOD_LABELS, nextCounter, SOLD_STATUSES } from './common.js';
import type { ReceiptInput } from './schemas.js';
import { getTransactionUnchecked } from './transactions.js';

/**
 * レシート / 領収書 (適格簡易請求書). The rendered content is snapshotted at issue time so later
 * master changes (shop address, registration number) never alter an issued document.
 * Required invoice items: 発行事業者名・登録番号(T+13桁), 取引年月日, 内容(軽減税率対象の明示),
 * 税率ごとの対象額と消費税額.
 */
export interface ReceiptContent {
  type: 'receipt' | 'invoice';
  title: string;
  receiptNumber: string;
  issuedAt: string;
  reissue: boolean;
  reissueOfNumber: string | null;
  issuer: { name: string; shopName: string; address: string; phone: string | null; invoiceRegistrationNumber: string | null };
  transaction: { id: string; number: string | null; completedAt: string | null; status: string };
  customerName: string | null;
  addressee: string | null;
  proviso: string | null;
  items: { name: string; quantity: number; unitPrice: number; amount: number; taxRateBp: number; reducedRate: boolean; kind: string }[];
  subtotal: number;
  discountTotal: number;
  total: number;
  taxTotal: number;
  taxBreakdown: { rateBp: number; label: string; taxable: number; tax: number }[];
  payments: { method: string; label: string; amount: number; tendered: number | null; change: number }[];
  refundedTotal: number;
  points: { used: number; earned: number; balance: number | null };
  footer: string;
}

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

function rateLabel(bp: number) {
  const pct = bp / 100;
  return bp === 800 ? `${pct}%(軽減税率)` : `${pct}%`;
}

export async function issueReceipt(ctx: Ctx, txId: string, input: ReceiptInput) {
  requirePermission(ctx.actor, 'pos.operate');
  const tx = await getTransactionUnchecked(ctx, txId);
  assertShopAccess(ctx.actor, tx.shop_id);
  if (!(SOLD_STATUSES as readonly string[]).includes(tx.status)) throw Errors.business('RECEIPT_NOT_AVAILABLE', '確定済みの会計のみ発行できます', { status: tx.status });
  // serialize issuance per transaction so reissue chains stay linear
  await ctx.trx.selectFrom('transactions').select('id').where('id', '=', txId).forUpdate().execute();
  const shop = await loadPosShop(ctx, tx.shop_id);
  const org = await ctx.trx.selectFrom('organizations').select(['name', 'invoice_registration_number']).where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();
  const previous = await ctx.trx
    .selectFrom('receipts')
    .select(['id', 'receipt_number'])
    .where('transaction_id', '=', txId)
    .where('receipt_type', '=', input.type)
    .orderBy('issued_at', 'desc')
    .orderBy('receipt_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  const now = new Date();
  const year = localYear(now, shop.timezone);
  const number = formatNumber('R', year, await nextCounter(ctx, `rcpt:${tx.shop_id}:${year}`));
  const breakdown = tx.tax_breakdown as Record<string, { taxable: number; tax: number }>;
  const content: ReceiptContent = {
    type: input.type,
    title: input.type === 'invoice' ? '領収書' : 'レシート',
    receiptNumber: number,
    issuedAt: now.toISOString(),
    reissue: !!previous,
    reissueOfNumber: previous?.receipt_number ?? null,
    issuer: {
      name: org.name,
      shopName: shop.name,
      address: [shop.postal_code ? `〒${shop.postal_code}` : '', shop.prefecture ?? '', shop.city ?? '', shop.address_line ?? ''].filter(Boolean).join(' ').trim(),
      phone: shop.phone,
      invoiceRegistrationNumber: org.invoice_registration_number && /^T\d{13}$/.test(org.invoice_registration_number) ? org.invoice_registration_number : null,
    },
    transaction: { id: tx.id, number: tx.transaction_number, completedAt: tx.completed_at ? new Date(tx.completed_at).toISOString() : null, status: tx.status },
    customerName: tx.customer_name,
    addressee: input.addressee ?? (input.type === 'invoice' ? (tx.customer_name ? `${tx.customer_name} 様` : null) : null),
    proviso: input.type === 'invoice' ? (input.proviso ?? '施術代・商品代として') : (input.proviso ?? null),
    items: tx.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unit_price, amount: i.amount, taxRateBp: i.tax_rate_bp, reducedRate: i.tax_rate_bp === 800 && i.amount > 0, kind: i.item_type })),
    subtotal: tx.subtotal,
    discountTotal: tx.discount_total,
    total: tx.total,
    taxTotal: tx.tax_total,
    taxBreakdown: Object.entries(breakdown ?? {})
      .map(([rate, b]) => ({ rateBp: Number(rate), label: rateLabel(Number(rate)), taxable: b.taxable, tax: b.tax }))
      .filter((b) => b.taxable !== 0)
      .sort((a, b) => b.rateBp - a.rateBp),
    payments: tx.payments
      .filter((p) => ['succeeded', 'partially_refunded', 'refunded'].includes(p.status))
      .map((p) => ({ method: p.method, label: p.method === 'custom' ? (p.custom_method_name ?? METHOD_LABELS.custom!) : (METHOD_LABELS[p.method] ?? p.method), amount: p.amount, tendered: p.tendered_amount, change: p.change_amount })),
    refundedTotal: tx.refunded_total,
    points: { used: tx.point_used, earned: tx.point_earned, balance: tx.customer_point_balance ?? null },
    footer: shop.settings.pos.receiptFooter,
  };
  const row = await ctx.trx
    .insertInto('receipts')
    .values({
      organization_id: ctx.actor.organizationId,
      transaction_id: txId,
      receipt_number: number,
      receipt_type: input.type,
      addressee: content.addressee,
      proviso: content.proviso,
      content: JSON.stringify(content),
      reissue_of: previous?.id ?? null,
      issued_by: auditUserId(ctx.actor),
      issued_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: previous ? 'receipt.reissue' : 'receipt.issue', resourceType: 'receipt', resourceId: row.id, shopId: tx.shop_id, after: { receiptNumber: number, type: input.type, transactionId: txId } });
  return row;
}

export async function getReceipt(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'pos.read');
  const r = await ctx.trx
    .selectFrom('receipts')
    .innerJoin('transactions as t', 't.id', 'receipts.transaction_id')
    .selectAll('receipts')
    .select('t.shop_id')
    .where('receipts.id', '=', id)
    .executeTakeFirst();
  if (!r) throw Errors.notFound('領収書', id);
  assertShopAccess(ctx.actor, r.shop_id);
  return r;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Printable HTML (80mm receipt printers and A4 both work) */
export function renderReceiptHtml(c: ReceiptContent): string {
  const issued = formatJst(new Date(c.issuedAt), 'yyyy年MM月dd日 HH:mm');
  const txDate = c.transaction.completedAt ? formatJst(new Date(c.transaction.completedAt), 'yyyy年MM月dd日 HH:mm') : '';
  const items = c.items
    .map(
      (i) =>
        `<tr><td>${esc(i.name)}${i.reducedRate ? ' ※' : ''}${i.quantity > 1 ? `<br><small>${yen(i.unitPrice)} × ${i.quantity}</small>` : ''}</td><td class="r">${i.amount < 0 ? '-' + yen(-i.amount) : yen(i.amount)}</td></tr>`,
    )
    .join('');
  const taxes = c.taxBreakdown.map((t) => `<tr><td>${esc(t.label)}対象</td><td class="r">${yen(t.taxable)}</td></tr><tr><td class="indent">内消費税</td><td class="r">${yen(t.tax)}</td></tr>`).join('');
  const pays = c.payments
    .map((p) => `<tr><td>${esc(p.label)}</td><td class="r">${yen(p.amount)}</td></tr>${p.method === 'cash' && p.tendered != null ? `<tr><td class="indent">お預り</td><td class="r">${yen(p.tendered)}</td></tr><tr><td class="indent">お釣り</td><td class="r">${yen(p.change)}</td></tr>` : ''}`)
    .join('');
  const invoiceHead =
    c.type === 'invoice'
      ? `<div class="addressee">${esc(c.addressee ?? '')}&nbsp;</div><div class="amount">${yen(c.total - c.refundedTotal)}<small>(税込)</small></div><div>但し ${esc(c.proviso ?? '')}<br>上記正に領収いたしました</div>`
      : '';
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)} ${esc(c.receiptNumber)}</title>
<style>
  body { font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif; margin: 0; padding: 16px; color: #111; background: #fff; }
  .sheet { max-width: 360px; margin: 0 auto; }
  h1 { font-size: 20px; text-align: center; margin: 0 0 8px; letter-spacing: .2em; }
  .reissue { text-align: center; font-weight: bold; border: 1px solid #111; padding: 2px; margin-bottom: 8px; }
  .addressee { border-bottom: 1px solid #111; font-size: 16px; margin: 8px 0; }
  .amount { font-size: 22px; font-weight: bold; text-align: center; border: 1px solid #111; padding: 6px; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 2px 0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .indent { padding-left: 1em; }
  .total td { font-size: 16px; font-weight: bold; border-top: 1px dashed #111; padding-top: 4px; }
  hr { border: none; border-top: 1px dashed #111; margin: 8px 0; }
  .meta, .issuer, .footer { font-size: 12px; }
  .footer { text-align: center; margin-top: 12px; white-space: pre-wrap; }
  @media print { body { padding: 0; } @page { margin: 6mm; } }
</style></head>
<body><div class="sheet">
<h1>${esc(c.title)}</h1>
${c.reissue ? `<div class="reissue">再発行${c.reissueOfNumber ? `（原本 ${esc(c.reissueOfNumber)}）` : ''}</div>` : ''}
${invoiceHead}
<div class="issuer"><strong>${esc(c.issuer.name)}</strong> ${esc(c.issuer.shopName)}<br>${esc(c.issuer.address)}${c.issuer.phone ? `<br>TEL ${esc(c.issuer.phone)}` : ''}${c.issuer.invoiceRegistrationNumber ? `<br>登録番号 ${esc(c.issuer.invoiceRegistrationNumber)}` : ''}</div>
<hr>
<div class="meta">取引日時 ${esc(txDate)}<br>会計番号 ${esc(c.transaction.number ?? '')}<br>${esc(c.title)}番号 ${esc(c.receiptNumber)}<br>発行日時 ${esc(issued)}${c.customerName ? `<br>お客様 ${esc(c.customerName)} 様` : ''}</div>
<hr>
<table>${items}</table>
<hr>
<table>
<tr><td>小計</td><td class="r">${yen(c.subtotal)}</td></tr>
${c.discountTotal ? `<tr><td>値引・割引</td><td class="r">-${yen(c.discountTotal)}</td></tr>` : ''}
<tr class="total"><td>合計</td><td class="r">${yen(c.total)}</td></tr>
${taxes}
${c.refundedTotal ? `<tr><td>返金額</td><td class="r">-${yen(c.refundedTotal)}</td></tr>` : ''}
</table>
<hr>
<table>${pays}</table>
${c.points.used || c.points.earned ? `<hr><table><tr><td>ご利用ポイント</td><td class="r">${c.points.used.toLocaleString('ja-JP')}pt</td></tr><tr><td>今回付与ポイント</td><td class="r">${c.points.earned.toLocaleString('ja-JP')}pt</td></tr></table>` : ''}
${c.items.some((i) => i.reducedRate) ? '<div class="meta">※は軽減税率(8%)対象商品です</div>' : ''}
<div class="footer">${esc(c.footer)}</div>
</div></body></html>`;
}

export async function receiptHtml(ctx: Ctx, id: string): Promise<string> {
  const r = await getReceipt(ctx, id);
  return renderReceiptHtml(r.content as unknown as ReceiptContent);
}
