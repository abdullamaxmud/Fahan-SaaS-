import type { Db } from 'mongodb';
import { isModuleKey, type ModuleKey } from '@fahan/policy';

/** Modules the hospital has switched off. Read on every request so a change applies at once. */
export async function disabledModules(db: Db): Promise<ModuleKey[]> {
  const s = await db.collection<{ _id: string; disabled?: string[] }>('settings').findOne({ _id: 'features' });
  return (s?.disabled ?? []).filter(isModuleKey);
}
