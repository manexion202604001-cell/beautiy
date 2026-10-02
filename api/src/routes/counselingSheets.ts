import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { staffAuth } from '../middleware/auth';

export const counselingSheetsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply auth middleware
counselingSheetsRoutes.use('*', staffAuth);

// Get counseling sheet by customer ID
counselingSheetsRoutes.get('/:customerId', async (c) => {
  const customerId = c.req.param('customerId');
  const storeId = c.req.query('store_id');

  let sheet;
  if (storeId) {
    sheet = await c.env.DB.prepare(
      'SELECT * FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
    ).bind(customerId, storeId).first();
  } else {
    // Return most recent counseling sheet across all stores
    sheet = await c.env.DB.prepare(
      'SELECT * FROM counseling_sheets WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).bind(customerId).first();
  }

  return c.json({
    counseling_sheet: sheet
      ? { ...sheet, data: JSON.parse(sheet.data as string) }
      : null,
  });
});

// OCR: Extract counseling data from image using Claude Vision
counselingSheetsRoutes.post('/ocr', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  const { image, mediaType, questions } = await c.req.json<{
    image: string; // base64
    mediaType: string; // e.g. "image/jpeg"
    questions: Array<{
      id: string;
      label: string;
      type: string;
      options?: string[];
      sliderLabels?: [string, string];
      subFields?: Array<{ id: string; label: string }>;
    }>;
  }>();

  if (!image || !questions?.length) {
    return c.json({ error: 'image and questions are required' }, 400);
  }

  // Build prompt from questions
  const fieldDescriptions = questions.map((q) => {
    let desc = `- "${q.id}" (${q.label}): `;
    switch (q.type) {
      case 'text':
        desc += 'テキスト入力。画像から読み取れるテキストをそのまま返す。';
        break;
      case 'radio':
      case 'radio_with_text':
        desc += `選択肢: [${q.options?.map(o => `"${o}"`).join(', ')}] のいずれか1つを返す。`;
        break;
      case 'multi_select':
        desc += `選択肢: [${q.options?.map(o => `"${o}"`).join(', ')}] から該当するものを配列で返す。`;
        break;
      case 'slider':
        desc += `0〜100の数値文字列を返す。0="${q.sliderLabels?.[0]}", 100="${q.sliderLabels?.[1]}"。`;
        break;
    }
    if (q.subFields?.length) {
      desc += ` サブフィールド: ${q.subFields.map(sf => `"${sf.id}" (${sf.label})`).join(', ')}`;
    }
    return desc;
  });

  const prompt = `あなたは美容サロンのカウンセリングシートのデータ入力アシスタントです。
添付された画像は紙のカウンセリングシートのスクリーンショットまたは写真です。

以下のフィールドについて、画像から読み取れる情報を抽出してJSON形式で返してください。

フィールド一覧:
${fieldDescriptions.join('\n')}

ルール:
- 画像から読み取れる情報のみ抽出する
- 読み取れないフィールドは空文字 "" を返す（textの場合）、空配列 [] を返す（multi_selectの場合）
- radio/radio_with_text の場合、選択肢に完全一致するもののみ返す。一致しない場合は空文字 ""
- sliderの場合、画像の情報から推測して0〜100の数値文字列を返す。不明な場合は ""
- サブフィールドがある場合は、同じ階層にサブフィールドIDをキーとして含める
- JSONのみ返す。説明文は不要。

出力形式（例）:
{
  "field_id1": "値",
  "field_id2": ["値1", "値2"],
  "field_id3": "75"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: image,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);
      return c.json({ error: 'AI processing failed' }, 502);
    }

    const result = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const textContent = result.content.find((b) => b.type === 'text');
    if (!textContent?.text) {
      return c.json({ error: 'No text response from AI' }, 502);
    }

    // Extract JSON from response (may be wrapped in markdown code block)
    let jsonStr = textContent.text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const extracted = JSON.parse(jsonStr) as Record<string, string | string[]>;
    return c.json({ data: extracted });
  } catch (error) {
    console.error('OCR processing error:', error);
    return c.json({ error: 'Failed to process image' }, 500);
  }
});

// Create or update counseling sheet
counselingSheetsRoutes.put('/:customerId', async (c) => {
  const staff = c.get('staff')!;
  const customerId = c.req.param('customerId');
  const storeId = c.req.query('store_id') || staff.store_id;
  const { data } = await c.req.json<{ data: Record<string, unknown> }>();

  if (!storeId) {
    return c.json({ error: 'store_id is required' }, 400);
  }

  if (!data) {
    return c.json({ error: 'data is required' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  await c.env.DB.prepare(
    `INSERT INTO counseling_sheets (id, store_id, customer_id, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id, customer_id)
     DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  )
    .bind(id, storeId, customerId, JSON.stringify(data), now, now)
    .run();

  const sheet = await c.env.DB.prepare(
    'SELECT * FROM counseling_sheets WHERE customer_id = ? AND store_id = ?'
  )
    .bind(customerId, storeId)
    .first();

  return c.json({
    counseling_sheet: sheet
      ? { ...sheet, data: JSON.parse(sheet.data as string) }
      : null,
  });
});
