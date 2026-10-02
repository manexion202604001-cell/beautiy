// カウンセリングシートのカテゴリー単位上書きマージ。
// incoming（新規提出）に記入のあるカテゴリーは、そのカテゴリーの全項目で既存を丸ごと置換。
// incoming に無い/空のカテゴリーは既存を維持。

type CategoryData = Record<string, unknown>;
type CounselingData = Record<string, CategoryData>;

function isNonEmptyCategory(cat: unknown): cat is CategoryData {
  if (!cat || typeof cat !== 'object' || Array.isArray(cat)) return false;
  return Object.values(cat as CategoryData).some((v) => {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}

/**
 * existingData をベースに、incoming の非空カテゴリーで上書きした結果を返す。
 */
export function applyCounselingOverwrite(
  existingData: CounselingData | null | undefined,
  incoming: CounselingData | null | undefined
): CounselingData {
  const result: CounselingData = { ...(existingData || {}) };
  if (!incoming) return result;
  for (const [category, value] of Object.entries(incoming)) {
    if (isNonEmptyCategory(value)) {
      result[category] = value; // カテゴリー丸ごと置換
    }
  }
  return result;
}
