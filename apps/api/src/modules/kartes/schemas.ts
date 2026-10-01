import { z } from 'zod';
import { isoDate, uuid } from '../../lib/schemas.js';

// ---------------------------------------------------------------- dynamic field definitions

export const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date', 'color_formula'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** customers.attributes keys a form field may write into (顧客事前入力 → 顧客プロフィール) */
export const ATTRIBUTE_KEYS = ['allergies', 'hair_concerns', 'scalp_condition', 'skin_type', 'medical_notes', 'preferred_style', 'pregnancy', 'medications'] as const;

const fieldBase = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, 'キーは英小文字・数字・_ で指定してください'),
  label: z.string().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().min(1).max(100)).max(100).optional(),
  required: z.boolean().optional(),
  helpText: z.string().max(500).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().min(1).max(10000).optional(),
});

/** Karte template field: customerVisible fields are shown on the customer share page */
export const karteFieldSchema = fieldBase.extend({ customerVisible: z.boolean().optional() });
export type KarteField = z.infer<typeof karteFieldSchema>;

/** Form field: mapsTo copies the answer into customers.attributes on submission */
export const formFieldSchema = fieldBase.extend({ mapsTo: z.enum(ATTRIBUTE_KEYS).optional() });
export type FormField = z.infer<typeof formFieldSchema>;

export type FieldDef = KarteField | FormField;

function validateFieldList(fields: FieldDef[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `キー「${f.key}」が重複しています` });
    seen.add(f.key);
    if ((f.type === 'select' || f.type === 'multiselect') && !f.options?.length) {
      ctx.addIssue({ code: 'custom', path: [i, 'options'], message: '選択肢を指定してください' });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: 'custom', path: [i, 'min'], message: 'min は max 以下にしてください' });
  });
}

export const karteFieldsSchema = z.array(karteFieldSchema).max(100).superRefine(validateFieldList);
export const formFieldsSchema = z
  .array(formFieldSchema)
  .max(100)
  .superRefine((fields, ctx) => {
    validateFieldList(fields, ctx);
    fields.forEach((f, i) => {
      if (f.type === 'color_formula') ctx.addIssue({ code: 'custom', path: [i, 'type'], message: 'フォームでは color_formula は使用できません' });
    });
  });

// ---------------------------------------------------------------- karte templates

export const createKarteTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.string().max(50).nullable().optional(),
  shopId: uuid.nullable().optional(),
  fields: karteFieldsSchema,
  isDefault: z.boolean().default(false),
});
export const updateKarteTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  category: z.string().max(50).nullable().optional(),
  fields: karteFieldsSchema.optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export const listKarteTemplatesSchema = z.object({
  shopId: uuid.optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});
export type CreateKarteTemplateInput = z.infer<typeof createKarteTemplateSchema>;
export type UpdateKarteTemplateInput = z.infer<typeof updateKarteTemplateSchema>;

// ---------------------------------------------------------------- kartes

const fieldValue = z.union([z.string().max(10000), z.number(), z.boolean(), z.array(z.string().max(200)).max(100), z.null()]);
export const fieldValuesSchema = z.record(z.string().max(50), fieldValue);

export const chemicalSchema = z.object({
  name: z.string().min(1).max(100),
  brand: z.string().max(100).nullable().optional(),
  ratio: z.string().max(100).nullable().optional(),
  processingMin: z.number().int().min(0).max(600).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});
export type Chemical = z.infer<typeof chemicalSchema>;

export const homecareSchema = z.object({
  advice: z.string().max(5000).nullable().optional(),
  productIds: z.array(uuid).max(20).optional(),
});
export type Homecare = z.infer<typeof homecareSchema>;

export const createKarteSchema = z.object({
  customerId: uuid,
  shopId: uuid,
  appointmentId: uuid.nullable().optional(),
  staffId: uuid.nullable().optional(),
  templateId: uuid.nullable().optional(),
  visitDate: isoDate.optional(),
  fields: fieldValuesSchema.default({}),
  chemicals: z.array(chemicalSchema).max(50).default([]),
  note: z.string().max(10000).nullable().optional(),
  homecare: homecareSchema.default({}),
});
export type CreateKarteInput = z.infer<typeof createKarteSchema>;

export const updateKarteSchema = z.object({
  version: z.number().int().min(1),
  appointmentId: uuid.nullable().optional(),
  staffId: uuid.optional(),
  templateId: uuid.nullable().optional(),
  visitDate: isoDate.optional(),
  fields: fieldValuesSchema.optional(),
  chemicals: z.array(chemicalSchema).max(50).optional(),
  note: z.string().max(10000).nullable().optional(),
  homecare: homecareSchema.optional(),
});
export type UpdateKarteInput = z.infer<typeof updateKarteSchema>;

export const listKartesSchema = z.object({
  customerId: uuid.optional(),
  shopId: uuid.optional(),
  staffId: uuid.optional(),
  appointmentId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListKartesInput = z.infer<typeof listKartesSchema>;

export const duplicateKarteSchema = z.object({
  shopId: uuid.optional(),
  appointmentId: uuid.nullable().optional(),
  staffId: uuid.nullable().optional(),
  visitDate: isoDate.optional(),
  includeNote: z.boolean().default(false),
});
export type DuplicateKarteInput = z.infer<typeof duplicateKarteSchema>;

// ---------------------------------------------------------------- assets

export const ASSET_TYPES = ['photo_before', 'photo_after', 'photo', 'sketch', 'document'] as const;
export const createAssetSchema = z.object({
  fileId: uuid,
  assetType: z.enum(ASSET_TYPES),
  caption: z.string().max(500).nullable().optional(),
  shareWithCustomer: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});
export const updateAssetSchema = z.object({
  caption: z.string().max(500).nullable().optional(),
  shareWithCustomer: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  assetType: z.enum(ASSET_TYPES).optional(),
});
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

// ---------------------------------------------------------------- sharing

export const shareKarteSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).default(30),
  notify: z.boolean().default(false),
  channel: z.enum(['line', 'email', 'sms']).optional(),
});
export type ShareKarteInput = z.infer<typeof shareKarteSchema>;

// ---------------------------------------------------------------- forms

export const FORM_KINDS = ['counseling', 'consent', 'pre_visit'] as const;

export const createFormTemplateSchema = z.object({
  kind: z.enum(FORM_KINDS),
  name: z.string().min(1).max(100),
  shopId: uuid.nullable().optional(),
  fields: formFieldsSchema,
  bodyMarkdown: z.string().max(50000).nullable().optional(),
  requiresSignature: z.boolean().default(false),
  status: z.enum(['draft', 'active']).default('active'),
});
export const updateFormTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  fields: formFieldsSchema.optional(),
  bodyMarkdown: z.string().max(50000).nullable().optional(),
  requiresSignature: z.boolean().optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
});
export const listFormTemplatesSchema = z.object({
  kind: z.enum(FORM_KINDS).optional(),
  shopId: uuid.optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});
export type CreateFormTemplateInput = z.infer<typeof createFormTemplateSchema>;
export type UpdateFormTemplateInput = z.infer<typeof updateFormTemplateSchema>;

/** data:image/png;base64,... (max ~1MB encoded) */
const signatureDataUrl = z
  .string()
  .max(1_400_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/, '署名は PNG の data URL で指定してください');

export const signatureInputSchema = z
  .object({
    dataUrl: signatureDataUrl.optional(),
    fileId: uuid.optional(),
    signerName: z.string().min(1).max(100),
  })
  .refine((s) => !!s.dataUrl !== !!s.fileId, { message: 'dataUrl か fileId のどちらか一方を指定してください' });
export type SignatureInput = z.infer<typeof signatureInputSchema>;

export const answersSchema = fieldValuesSchema;

export const createFormResponseSchema = z.object({
  templateId: uuid,
  customerId: uuid,
  appointmentId: uuid.nullable().optional(),
  karteId: uuid.nullable().optional(),
  answers: answersSchema,
  signature: signatureInputSchema.optional(),
});
export type CreateFormResponseInput = z.infer<typeof createFormResponseSchema>;

export const formLinkSchema = z.object({
  templateId: uuid,
  expiresInDays: z.number().int().min(1).max(60).optional(),
  notify: z.boolean().default(false),
  channel: z.enum(['line', 'email', 'sms']).optional(),
});
export type FormLinkInput = z.infer<typeof formLinkSchema>;

export const publicFormSubmitSchema = z.object({
  answers: answersSchema,
  signature: z
    .object({ dataUrl: signatureDataUrl, signerName: z.string().min(1).max(100) })
    .optional(),
});
export type PublicFormSubmitInput = z.infer<typeof publicFormSubmitSchema>;

export const listFormResponsesSchema = z.object({
  customerId: uuid,
  templateId: uuid.optional(),
  appointmentId: uuid.optional(),
  karteId: uuid.optional(),
  kind: z.enum(FORM_KINDS).optional(),
  status: z.enum(['pending', 'submitted', 'voided']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListFormResponsesInput = z.infer<typeof listFormResponsesSchema>;

export const voidFormResponseSchema = z.object({ reason: z.string().min(1).max(500) });
