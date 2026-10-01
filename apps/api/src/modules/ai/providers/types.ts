/**
 * Provider-neutral AI task definitions. Inputs are already minimized: they carry a first name and a
 * visit summary only — never phone numbers, e-mail addresses, postal addresses, birthdays or full names
 * (要件 10 / 14: AIへ渡す個人情報は最小限). Free text (karte notes, reviews) is PII-scrubbed beforehand.
 */
export type MessagePurpose = 'followup' | 'dormant' | 'birthday' | 'review_thanks';
export type Tone = 'polite' | 'friendly' | 'casual';

export interface MessageDraftInput {
  purpose: MessagePurpose;
  tone: Tone;
  customer: {
    firstName: string;
    visitCount: number;
    daysSinceLastVisit: number | null;
    lastVisitDate: string | null;
    recentMenus: string[];
  };
  shopName: string;
  staffName: string;
}

export interface ReviewReplyInput {
  rating: number;
  title: string | null;
  body: string | null;
  shopName: string;
  staffName: string | null;
}

export interface KarteSummaryInput {
  customer: {
    firstName: string;
    visitCount: number;
    lastVisitDate: string | null;
    avgCycleDays: number | null;
  };
  kartes: {
    visitDate: string;
    staffName: string | null;
    note: string | null;
    chemicals: string[];
    homecare: string | null;
  }[];
  recentVisits: { date: string; menus: string[] }[];
}

export type AiTask =
  | { kind: 'message_draft'; input: MessageDraftInput }
  | { kind: 'review_reply'; input: ReviewReplyInput }
  | { kind: 'karte_summary'; input: KarteSummaryInput };

export interface AiResult {
  text: string;
  provider: 'heuristic' | 'anthropic';
  model: string | null;
  /** set when the configured provider failed and the heuristic fallback produced the text */
  fallbackReason?: string;
  usage?: Record<string, unknown>;
}

export interface AiProvider {
  readonly name: 'heuristic' | 'anthropic';
  generate(task: AiTask): Promise<AiResult>;
}

export const PURPOSE_LABELS: Record<MessagePurpose, string> = {
  followup: '来店後のお礼・フォロー',
  dormant: 'しばらくご来店のないお客様への再来店のご案内',
  birthday: 'お誕生日のお祝い',
  review_thanks: '口コミ投稿へのお礼',
};

export const TONE_LABELS: Record<Tone, string> = {
  polite: '丁寧',
  friendly: '親しみやすい',
  casual: 'カジュアル',
};

/** System prompt shared by LLM providers (Japanese, human-in-the-loop framing) */
export const SYSTEM_PROMPT = [
  'あなたは日本の美容サロンのスタッフを支援するアシスタントです。',
  'あなたの出力はスタッフが確認・編集してから使う「下書き」であり、お客様へ自動送信されることはありません。',
  '- 入力JSONに含まれる情報だけを使い、来店日・メニュー・価格・キャンペーン・特典などの事実を創作しないでください。',
  '- 電話番号・メールアドレス・住所などの個人情報を出力に含めないでください。',
  '- 医療的な効果・効能を断定する表現は避けてください。',
  '- 出力は本文のみとし、前置き・説明・見出し・マークダウン記法は付けないでください。',
].join('\n');

/** Task instruction + minimized JSON input for LLM providers */
export function buildUserPrompt(task: AiTask): string {
  let instruction: string;
  switch (task.kind) {
    case 'message_draft':
      instruction =
        `お客様へLINEで送る「${PURPOSE_LABELS[task.input.purpose]}」メッセージの下書きを作成してください。` +
        `文体は${TONE_LABELS[task.input.tone]}に、200字程度、宛名は「${task.input.customer.firstName}様」としてください。` +
        '署名として店舗名とスタッフ名を末尾に入れてください。';
      break;
    case 'review_reply':
      instruction =
        '店舗に投稿された口コミへの返信文の下書きを作成してください。評価が低い場合は真摯にお詫びし、改善の姿勢を示してください。' +
        'お客様の個人名には触れず、200字程度で、末尾に店舗名を入れてください。';
      break;
    case 'karte_summary':
      instruction =
        '施術担当スタッフ向けに、このお客様の直近のカルテと来店履歴を要約してください。' +
        '「来店傾向」「直近の施術・薬剤」「注意点・ホームケア」「次回の提案」の4項目を、各1〜3行の箇条書き(「・」始まり)でまとめてください。';
      break;
  }
  return `${instruction}\n\n<input>\n${JSON.stringify(task.input, null, 2)}\n</input>`;
}
