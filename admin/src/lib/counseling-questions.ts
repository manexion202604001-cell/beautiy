export type QuestionType = "text" | "radio" | "multi_select" | "radio_with_text" | "slider";

export interface CounselingQuestion {
  id: string;
  label: string;
  type: QuestionType;
  options?: string[];
  /** スライダーの左右ラベル [左, 右] */
  sliderLabels?: [string, string];
  /** サブフィールドを表示するトリガー。string = 単一選択肢, string[] = 複数の選択肢どれか。省略時: options[0] */
  subFieldTrigger?: string | string[];
  subFields?: { id: string; label: string }[];
  /** 同じカテゴリ内の別の質問の値に応じて表示/非表示を切り替える */
  showWhen?: { questionId: string; values: string[] };
}

export interface CounselingCategory {
  id: string;
  label: string;
  questions: CounselingQuestion[];
}

export const COUNSELING_CATEGORIES: CounselingCategory[] = [
  {
    id: "basic_info",
    label: "基本情報",
    questions: [
      { id: "birthday", label: "生年月日", type: "text" },
      { id: "address", label: "住所", type: "text" },
      { id: "phone", label: "電話番号", type: "text" },
      { id: "occupation", label: "ご職業", type: "text" },
      { id: "visit_reason", label: "来店理由", type: "text" },
      {
        id: "referral_source",
        label: "ご来店のきっかけ",
        type: "multi_select",
        options: ["ホットペッパー", "minimo", "Instagram", "TikTok", "ご紹介", "その他"],
      },
    ],
  },
  {
    id: "hair",
    label: "髪",
    questions: [
      {
        id: "hair_volume",
        label: "毛量",
        type: "slider",
        sliderLabels: ["少ない", "多い"],
      },
      {
        id: "hair_curl",
        label: "癖",
        type: "radio",
        options: ["あり", "不明", "なし"],
      },
      {
        id: "hair_curl_type",
        label: "癖の種類",
        type: "multi_select",
        options: ["生え癖", "髪癖"],
        showWhen: { questionId: "hair_curl", values: ["あり"] },
      },
      {
        id: "hair_curl_intensity",
        label: "癖の強さ",
        type: "slider",
        sliderLabels: ["ゆるゆる", "くるくる"],
        showWhen: { questionId: "hair_curl", values: ["あり"] },
      },
      {
        id: "hair_hardness",
        label: "硬さ",
        type: "slider",
        sliderLabels: ["柔らかい", "固い"],
      },
      {
        id: "hair_thickness",
        label: "太さ",
        type: "slider",
        sliderLabels: ["細毛", "太毛"],
      },
      {
        id: "hair_moisture",
        label: "親水 / 撥水",
        type: "slider",
        sliderLabels: ["親水毛", "撥水毛"],
      },
    ],
  },
  {
    id: "eye_counseling",
    label: "目",
    questions: [
      {
        id: "allergies",
        label: "アレルギーについて",
        type: "multi_select",
        options: ["花粉", "ゴム", "アルコール", "金属", "その他"],
      },
      {
        id: "experience",
        label: "ご経験について",
        type: "multi_select",
        options: ["ない", "パリジェンヌ", "ラッシュリフト", "パーマ"],
      },
      {
        id: "previous_timing",
        label: "ご経験がある方、以前されたのはいつ頃ですか？",
        type: "text",
      },
      {
        id: "visit_count",
        label: "ご経験がある方、今回で何回目の施術になりますか？",
        type: "text",
      },
      {
        id: "satisfaction",
        label: "ご経験がある方、仕上がりはいかがでしたか？",
        type: "radio_with_text",
        options: ["満足", "不満"],
        subFieldTrigger: "不満",
        subFields: [{ id: "satisfaction_reason", label: "不満理由" }],
      },
      {
        id: "desired_design",
        label: "ご希望のデザインについて",
        type: "multi_select",
        options: ["根本から立ち上げたい", "根本から毛先までカール", "自然なカール"],
      },
      {
        id: "plan_extension",
        label: "これからまつ毛エクステを付けるご予定はございますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "adhesive_reaction",
        label: "つけまつ毛や二重用の接着剤でかぶれた事はございますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "eye_condition",
        label: "お目元周りで状態が悪い箇所はございますか？",
        type: "radio_with_text",
        options: ["はい", "いいえ"],
        subFields: [
          { id: "eye_condition_area", label: "箇所" },
          { id: "eye_condition_symptoms", label: "症状" },
        ],
      },
      {
        id: "contact_lens",
        label: "コンタクトレンズは装着されていますか？",
        type: "radio",
        options: ["していない", "ソフト", "ハード"],
      },
      {
        id: "current_condition",
        label: "今現在、当てはまるものはございますか？",
        type: "multi_select",
        options: ["妊娠中", "授乳中", "生理中"],
      },
      {
        id: "questions",
        label: "ご不明な点、ご質問はございますか？",
        type: "text",
      },
    ],
  },
  {
    id: "extension",
    label: "エクステ",
    questions: [
      {
        id: "allergies",
        label: "アレルギーについて",
        type: "multi_select",
        options: ["花粉", "ゴム", "アルコール", "金属", "その他"],
      },
      {
        id: "experience",
        label: "ご経験について",
        type: "multi_select",
        options: ["ない", "まつ毛エクステ", "まつ毛パーマ"],
      },
      {
        id: "skin_trouble",
        label: "ご経験のある方、その際にかゆみや腫れなど皮膚にトラブルはございましたか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "eye_disease",
        label: "現在、ものもらいや結膜炎などの症状はございますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "tape_reaction",
        label: "テープでかぶれた事はございますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "recent_treatment",
        label: "ここ1ヶ月前後でエクステなどのピーリングやフォトフェイシャルのご利用はございますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "cosmetic_surgery",
        label: "目元の美容整形、レーシック、アートメイクをされた事はございますか？",
        type: "radio_with_text",
        options: ["はい", "いいえ"],
        subFields: [{ id: "cosmetic_surgery_detail", label: "施術内容" }],
      },
      {
        id: "dry_eye",
        label: "ドライアイと診断されたことはございますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "contact_lens",
        label: "コンタクトレンズは装着されていますか？",
        type: "radio",
        options: ["していない", "ソフト", "ハード"],
      },
      {
        id: "current_condition",
        label: "今現在、当てはまるものはございますか？",
        type: "multi_select",
        options: ["妊娠中", "授乳中", "生理中"],
      },
      {
        id: "questions",
        label: "ご不明な点、ご質問はございますか？",
        type: "text",
      },
    ],
  },
  {
    id: "eyebrow",
    label: "眉",
    questions: [
      {
        id: "self_care_method",
        label: "眉の自己処理方法について",
        type: "multi_select",
        options: ["毛抜き", "シェービング", "カット", "脱色", "その他"],
      },
      {
        id: "last_self_care_date",
        label: "直前の自己処理日はいつですか？",
        type: "text",
      },
      {
        id: "dermatology",
        label: "現在皮膚科に通っていますか？",
        type: "radio_with_text",
        options: ["はい", "いいえ"],
        subFields: [{ id: "dermatology_disease", label: "病名" }],
      },
      {
        id: "skin_allergy",
        label: "これまで皮膚の病気やアレルギー症状が出たことはございますか？",
        type: "multi_select",
        options: ["アトピー", "皮膚病", "ケロイド体質", "アレルギー", "なし"],
      },
      {
        id: "pregnancy",
        label: "現在妊娠中、妊娠している可能性、生理中いずれかに該当しますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "skin_type",
        label: "肌タイプについて",
        type: "radio",
        options: ["ノーマル", "オイリー", "ドライ", "混合", "敏感"],
      },
      {
        id: "skin_trouble",
        label: "肌トラブルはございますか？",
        type: "radio_with_text",
        options: ["はい", "いいえ"],
        subFields: [{ id: "skin_trouble_area", label: "トラブル箇所" }],
      },
      {
        id: "wax_hair_removal",
        label: "ワックス脱毛した事はありますか？",
        type: "radio_with_text",
        options: ["はい", "いいえ"],
        subFields: [{ id: "wax_hair_removal_area", label: "脱毛部位" }],
      },
      {
        id: "wax_trouble",
        label: "上記で「はい」の方、ワックス脱毛でトラブル経験はございますか？",
        type: "text",
      },
      {
        id: "regular_medicine",
        label: "常備薬について（薬名）",
        type: "text",
      },
      {
        id: "patch_test",
        label: "パッチテストについて",
        type: "radio",
        options: ["希望", "希望なし"],
      },
      {
        id: "medical_history",
        label: "病歴・手術について（病歴・手術　時期）",
        type: "text",
      },
    ],
  },
  {
    id: "nail",
    label: "ネイル",
    questions: [
      {
        id: "nail_experience",
        label: "これまでにネイルのご経験はございますか？（ジェル・マニキュア）",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "nail_trouble",
        label: "上記で「はい」の方、その際に何かトラブルが発生した事はございますか？",
        type: "radio",
        options: ["はい", "いいえ"],
      },
      {
        id: "allergy",
        label: "アレルギーをお持ちですか？",
        type: "radio_with_text",
        options: ["はい", "いいえ"],
        subFields: [{ id: "allergy_detail", label: "アレルギー詳細" }],
      },
      {
        id: "requests",
        label: "ネイルのデザインや施術するにあたりご要望やご質問がございましたらご入力ください",
        type: "text",
      },
    ],
  },
  {
    id: "facial",
    label: "顔",
    questions: [
      {
        id: "health_condition",
        label: "体調について",
        type: "radio",
        options: ["良好", "普通", "不調"],
      },
      {
        id: "major_illness",
        label: "過去に大きな病気をした事はありますか？",
        type: "radio_with_text",
        options: ["なし", "あり"],
        subFieldTrigger: "あり",
        subFields: [{ id: "major_illness_name", label: "病名" }],
      },
      {
        id: "surgery_experience",
        label: "手術のご経験について",
        type: "radio",
        options: ["なし", "あり"],
      },
      {
        id: "constitution_allergy",
        label: "体質・アレルギーについて",
        type: "multi_select",
        options: [
          "冷え性", "便秘症", "下痢症", "貧血症", "肩こり", "腰痛",
          "神経過敏", "のぼせ", "めまい", "不眠症", "高血圧", "低血圧",
          "浮腫み", "花粉症", "アトピー", "金属", "植物", "食物", "薬疹",
        ],
      },
      {
        id: "medication",
        label: "使用薬について",
        type: "multi_select",
        options: ["頭痛薬", "睡眠薬", "精神安定剤", "ホルモン剤", "抵抗剤", "ステロイド剤", "その他"],
      },
      {
        id: "menstruation",
        label: "生理について",
        type: "radio",
        options: ["毎月", "不順", "なし"],
      },
      {
        id: "menstrual_pain",
        label: "生理痛について",
        type: "radio",
        options: ["あり", "なし"],
      },
      {
        id: "physical_fatigue",
        label: "肉体面の疲労感について",
        type: "radio",
        options: ["疲労が激しい", "疲れやすい", "あまりない"],
      },
      {
        id: "mental_fatigue",
        label: "精神面の疲労感について",
        type: "radio",
        options: ["うつ", "やや不安", "安定"],
      },
      {
        id: "sleep",
        label: "睡眠について",
        type: "radio_with_text",
        options: ["熟睡できる", "熟睡できない"],
        subFieldTrigger: ["熟睡できる", "熟睡できない"],
        subFields: [{ id: "sleep_hours", label: "平均睡眠時間" }],
      },
      {
        id: "work_hours",
        label: "平均労働時間について",
        type: "text",
      },
      {
        id: "exercise",
        label: "運動について",
        type: "radio",
        options: ["運動する", "運動しない"],
      },
      {
        id: "smoking",
        label: "タバコ（1日何本）",
        type: "text",
      },
      {
        id: "alcohol",
        label: "アルコール（1週何日）",
        type: "text",
      },
      {
        id: "coffee_intake",
        label: "コーヒー（1日何杯）",
        type: "text",
      },
      {
        id: "tea_intake",
        label: "お茶（1日何杯）",
        type: "text",
      },
      {
        id: "juice_intake",
        label: "ジュース（1日何杯）",
        type: "text",
      },
      {
        id: "water_intake",
        label: "水（1日何リットル）",
        type: "text",
      },
      {
        id: "skin_treatment",
        label: "肌治療経験について",
        type: "radio_with_text",
        options: ["なし", "あり"],
        subFieldTrigger: "あり",
        subFields: [
          { id: "skin_treatment_hydroquinone", label: "ハイドロキノン（いつ頃）" },
          { id: "skin_treatment_photo", label: "フォト（いつ頃）" },
          { id: "skin_treatment_laser", label: "レーザー（いつ頃）" },
          { id: "skin_treatment_peeling", label: "ピーリング（いつ頃）" },
          { id: "skin_treatment_other", label: "その他" },
        ],
      },
      {
        id: "skin_quality",
        label: "肌質について",
        type: "radio",
        options: ["普通肌", "油性肌", "乾燥肌", "敏感肌", "混合肌", "ニキビ肌", "わからない"],
      },
      {
        id: "skin_concern",
        label: "肌のお悩みについて",
        type: "multi_select",
        options: [
          "シミ", "そばかす", "シワ", "たるみ", "くすみ", "毛穴",
          "肌荒れ", "赤み", "化粧崩れ", "ニキビ", "ニキビ跡", "その他",
        ],
      },
      {
        id: "skincare_products",
        label: "使用スキンケアについて",
        type: "text",
      },
      {
        id: "requests",
        label: "その他ご要望などございましたらご入力ください。",
        type: "text",
      },
    ],
  },
  {
    id: "body",
    label: "体",
    questions: [
      {
        id: "health_condition",
        label: "体調について",
        type: "radio_with_text",
        options: ["好調", "不調"],
        subFieldTrigger: "不調",
        subFields: [{ id: "health_condition_reason", label: "不調の理由" }],
      },
      {
        id: "allergy",
        label: "アレルギーについて",
        type: "multi_select",
        options: ["光(紫外線)", "植物", "金属", "食物", "薬", "その他"],
      },
      {
        id: "menstruation",
        label: "生理について",
        type: "radio_with_text",
        options: ["順調", "不順", "閉経"],
        subFieldTrigger: ["不順", "閉経"],
        subFields: [{ id: "menstruation_detail", label: "詳細" }],
      },
      {
        id: "physical_fatigue",
        label: "肉体面について",
        type: "radio",
        options: ["疲労が激しい", "疲れやすい", "ほとんどない"],
      },
      {
        id: "mental_fatigue",
        label: "精神面について",
        type: "radio_with_text",
        options: ["安定", "不安定"],
        subFieldTrigger: "不安定",
        subFields: [{ id: "mental_fatigue_detail", label: "詳細" }],
      },
      {
        id: "current_treatment",
        label: "治療中の病名について",
        type: "radio_with_text",
        options: ["ない", "ある"],
        subFieldTrigger: "ある",
        subFields: [{ id: "current_treatment_name", label: "病名" }],
      },
      {
        id: "surgery_experience",
        label: "手術経験について",
        type: "radio_with_text",
        options: ["ない", "ある(外科)", "ある(美容整形)"],
        subFieldTrigger: ["ある(外科)", "ある(美容整形)"],
        subFields: [{ id: "surgery_detail", label: "部位や時期" }],
      },
      {
        id: "constitution",
        label: "体質について",
        type: "multi_select",
        options: ["冷え性", "便秘", "貧血", "肩こり", "むくみ", "糖尿病", "不眠症", "高血圧"],
      },
      {
        id: "regular_medicine",
        label: "常備薬について",
        type: "radio_with_text",
        options: ["ない", "ある"],
        subFieldTrigger: "ある",
        subFields: [{ id: "regular_medicine_name", label: "薬名" }],
      },
      {
        id: "sleep",
        label: "睡眠について",
        type: "radio_with_text",
        options: ["熟睡できる", "熟睡できない"],
        subFieldTrigger: ["熟睡できる", "熟睡できない"],
        subFields: [{ id: "sleep_hours", label: "平均睡眠時間" }],
      },
      {
        id: "exercise",
        label: "運動について",
        type: "radio_with_text",
        options: ["毎日", "時々", "しない"],
        subFieldTrigger: ["毎日", "時々"],
        subFields: [{ id: "exercise_frequency", label: "週何回" }],
      },
      {
        id: "diet",
        label: "食事について",
        type: "radio",
        options: ["規則正しい", "不規則"],
      },
      {
        id: "preferences",
        label: "嗜好品について（お酒、タバコ）",
        type: "text",
      },
      {
        id: "body_concern",
        label: "気になるお悩みについて",
        type: "multi_select",
        options: ["セルライト", "むくみ", "たるみ"],
      },
      {
        id: "concern_area",
        label: "気になる部分について",
        type: "text",
      },
      {
        id: "concern_body_part",
        label: "気になる部位",
        type: "text",
      },
    ],
  },
];

export type CounselingData = {
  [categoryId: string]: {
    [questionId: string]: string | string[];
  };
};
