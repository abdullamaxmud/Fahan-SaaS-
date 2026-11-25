import { ObjectId } from 'mongodb';
import { z, type ZodTypeAny } from 'zod';
import { Errors } from './errors';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const objectId = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'Must be a valid id')
  .transform((s) => new ObjectId(s));

export function idParam(value: unknown, what = 'Resource'): ObjectId {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) throw Errors.notFound(what);
  return new ObjectId(value);
}

export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(12, 'Use at least 12 characters').max(200);
export const mfaCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3–40 lowercase letters, digits or hyphens');
