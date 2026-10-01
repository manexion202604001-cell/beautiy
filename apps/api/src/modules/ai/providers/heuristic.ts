import type { AiProvider, AiResult, AiTask, KarteSummaryInput, MessageDraftInput, ReviewReplyInput, Tone } from './types.js';

/**
 * Deterministic Japanese templates — used when ANTHROPIC_API_KEY is unset, and as the fallback when
 * the LLM provider fails. Output depends only on the (already minimized) task input.
 */
const CLOSING: Record<Tone, string> = {
  polite: 'またのご来店を心よりお待ちしております。',
  friendly: 'またお会いできるのを楽しみにしています！',
  casual: 'また気軽に遊びに来てくださいね！',
};

const GREETING: Record<Tone, (name: string) => string> = {
  polite: (n) => `${n}様\nいつも誠にありがとうございます。`,
  friendly: (n) => `${n}様\nこんにちは！いつもありがとうございます。`,
  casual: (n) => `${n}様\nこんにちは！`,
};

function signature(i: MessageDraftInput) {
  return [i.shopName, i.staffName].join(String.fromCharCode(0x3000)); // full-width space
}

export function messageDraftText(i: MessageDraftInput): string {
  const name = i.customer.firstName;
  const menu = i.customer.recentMenus[0];
  const lines: string[] = [GREETING[i.tone](name)];
  switch (i.purpose) {
    case 'followup':
      lines.push(
        `先日は${i.shopName}にご来店いただき、ありがとうございました。` + (menu ? `${menu}の仕上がりやその後の扱いやすさはいかがでしょうか。` : 'その後の仕上がりはいかがでしょうか。'),
        '気になる点がございましたら、お気軽にご連絡ください。',
      );
      break;
    case 'dormant':
      lines.push(
        i.customer.daysSinceLastVisit !== null
          ? `前回のご来店から${i.customer.daysSinceLastVisit}日ほど経ちましたが、その後お変わりなくお過ごしでしょうか。`
          : 'その後お変わりなくお過ごしでしょうか。',
        (menu ? `前回の${menu}から時間が経ち、そろそろメンテナンスの時期かと思います。` : 'そろそろメンテナンスの時期かと思います。') + 'ご都合のよい日時がございましたら、ぜひご予約ください。',
      );
      break;
    case 'birthday':
      lines.push('お誕生日おめでとうございます。素敵な一年になりますよう、スタッフ一同心よりお祈りしております。', '特別な日の前のお手入れにも、ぜひご利用ください。');
      break;
    case 'review_thanks':
      lines.push('このたびは口コミをご投稿いただき、誠にありがとうございました。', 'いただいたお声はスタッフ一同の励みになります。今後のサービス向上にも活かしてまいります。');
      break;
  }
  lines.push(CLOSING[i.tone], '', signature(i));
  return lines.join('\n');
}

export function reviewReplyText(i: ReviewReplyInput): string {
  const staff = i.staffName ? `担当の${i.staffName}にも共有いたします。` : 'スタッフ一同で共有いたします。';
  if (i.rating >= 4) {
    return [
      'このたびはご来店ならびに口コミのご投稿、誠にありがとうございます。',
      `高い評価をいただき大変嬉しく思います。${staff}`,
      '今後もご満足いただけるよう努めてまいりますので、またのご来店を心よりお待ちしております。',
      '',
      i.shopName,
    ].join('\n');
  }
  if (i.rating === 3) {
    return [
      'このたびはご来店ならびに口コミのご投稿、誠にありがとうございます。',
      `いただいたご意見を真摯に受け止め、より満足いただけるサロンを目指して改善してまいります。${staff}`,
      'またのご来店の際には、お気軽にご要望をお聞かせください。',
      '',
      i.shopName,
    ].join('\n');
  }
  return [
    'このたびはご来店いただきありがとうございました。また、ご期待に沿えず大変申し訳ございません。',
    `ご指摘いただいた点は${i.staffName ? `担当の${i.staffName}を含め` : ''}スタッフ全員で共有し、改善に努めてまいります。`,
    'もしよろしければ、改めて詳しいお話をお聞かせいただけますと幸いです。',
    '',
    i.shopName,
  ].join('\n');
}

function clip(s: string, n = 80) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function karteSummaryText(i: KarteSummaryInput): string {
  const c = i.customer;
  const lines: string[] = [`【${c.firstName}様 カルテ要約】`];
  lines.push('■来店傾向');
  lines.push(
    `・来店${c.visitCount}回` + (c.lastVisitDate ? ` / 最終来店 ${c.lastVisitDate}` : '') + (c.avgCycleDays ? ` / 平均来店周期 約${Math.round(c.avgCycleDays)}日` : ''),
  );
  const menus = [...new Set(i.recentVisits.flatMap((v) => v.menus))].slice(0, 5);
  if (menus.length) lines.push(`・直近のメニュー: ${menus.join('、')}`);
  lines.push('■直近の施術・薬剤');
  if (!i.kartes.length) lines.push('・カルテの記録はありません');
  for (const k of i.kartes.slice(0, 3)) {
    const parts = [`・${k.visitDate}${k.staffName ? `(${k.staffName})` : ''}`];
    if (k.note) parts.push(clip(k.note));
    if (k.chemicals.length) parts.push(`薬剤: ${k.chemicals.join('、')}`);
    lines.push(parts.join(' '));
  }
  const homecare = i.kartes.map((k) => k.homecare).find((h) => !!h);
  lines.push('■注意点・ホームケア');
  lines.push(homecare ? `・${clip(homecare)}` : '・特記事項なし(カルテをご確認ください)');
  lines.push('■次回の提案');
  lines.push(menus[0] ? `・前回同様の${menus[0]}をベースに、状態を確認して提案` : '・カウンセリングでご要望を確認');
  return lines.join('\n');
}

export const heuristicProvider: AiProvider = {
  name: 'heuristic',
  async generate(task: AiTask): Promise<AiResult> {
    const text = task.kind === 'message_draft' ? messageDraftText(task.input) : task.kind === 'review_reply' ? reviewReplyText(task.input) : karteSummaryText(task.input);
    return { text, provider: 'heuristic', model: null };
  },
};
