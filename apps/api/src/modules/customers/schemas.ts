import { z } from 'zod';
import { booleanQuery, isoDate, optionalString, uuid } from '../../lib/schemas.js';

const customerFields = {
  customerNumber: z.string().max(50).nullable().optional(),
  lastName: z.string().max(50),
  firstName: z.string().max(50),
  lastNameKana: z.string().max(50),
  firstNameKana: z.string().max(50),
  gender: z.enum(['female', 'male', 'other', 'unknown']).nullable().optional(),
  birthday: isoDate.nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().email().nullable().optional(),
  postalCode: z.string().max(10).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  occupation: z.string().max(100).nullable().optional(),
  acquisitionSource: z.string().max(100).nullable().optional(),
  primaryShopId: uuid.nullable().optional(),
  primaryStaffId: uuid.nullable().optional(),
  marketingOptIn: z.boolean().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  tagIds: z.array(uuid).optional(),
};

export const createCustomerSchema = z
  .object({
    ...customerFields,
    // PATCH must not have defaults (they would overwrite stored values), so defaults live only here
    lastName: customerFields.lastName.default(''),
    firstName: customerFields.firstName.default(''),
    lastNameKana: customerFields.lastNameKana.default(''),
    firstNameKana: customerFields.firstNameKana.default(''),
  })
  .refine((v) => (v.lastName + v.firstName + v.lastNameKana + v.firstNameKana).trim().length > 0, {
    message: '氏名またはフリガナを入力してください',
  });
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z.object(customerFields).partial().extend({ status: z.enum(['active', 'blocked']).optional() });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const searchCustomersSchema = z.object({
  q: optionalString,
  tagId: uuid.optional(),
  shopId: uuid.optional(),
  staffId: uuid.optional(),
  lastVisitBefore: isoDate.optional(),
  lastVisitAfter: isoDate.optional(),
  hasFutureAppointment: booleanQuery,
  birthdayMonth: z.coerce.number().int().min(1).max(12).optional(),
  sort: z.enum(['last_visit', 'created', 'name', 'total_sales']).default('last_visit'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SearchCustomersInput = z.infer<typeof searchCustomersSchema>;

export const memoSchema = z.object({
  body: z.string().min(1).max(5000),
  visibility: z.enum(['shared', 'private']).default('shared'),
  pinned: z.boolean().optional(),
});

export const mergeSchema = z.object({
  sourceCustomerId: uuid,
  reason: z.string().max(500).optional(),
});
