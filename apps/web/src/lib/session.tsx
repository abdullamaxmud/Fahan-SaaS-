'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Level, ModuleKey, Permissions, Scope } from '@fahan/policy';
import { levelRank } from '@fahan/policy';
import { ApiError, api } from './api';

export interface Me {
  id: string;
  kind: 'platform' | 'tenant';
  name: string;
  email: string;
  roles: string[];
  perms: Permissions;
  scope: Scope;
  branchId: string | null;
  tenant: { id: string; slug: string; name: string } | null;
  mfa: 'ok' | 'pending' | 'enroll';
  /** Modules the hospital has switched off (feature switchboard). */
  disabledModules?: string[];
  /** Portal accounts: the patient records this person may see. */
  patientIds?: string[];
}

export const PORTAL_ROLES = ['patient', 'caregiver'];
export const isPortalUser = (m: Pick<Me, 'roles'>) => m.roles.length > 0 && m.roles.every((r) => PORTAL_ROLES.includes(r));

const Ctx = createContext<{ me: Me; refresh: () => Promise<void> } | null>(null);

/** Loads the signed-in user; sends them to sign-in or MFA when the API says so. */
export function SessionProvider({ children, portal = false }: { children: React.ReactNode; portal?: boolean }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/auth/me');
      if (m.mfa !== 'ok') return router.replace('/mfa');
      if (isPortalUser(m) && !portal) return router.replace('/portal');
      if (!isPortalUser(m) && portal) return router.replace('/');
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else throw e;
    }
  }, [router, portal]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!me) {
    return <div className="grid min-h-screen place-items-center text-ink-3"><span className="inline-flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />Fahan</span></div>;
  }
  return <Ctx.Provider value={{ me, refresh }}>{children}</Ctx.Provider>;
}

export function useMe() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMe outside SessionProvider');
  return c;
}

/** UI hint only — the API enforces the real decision on every request. */
export const canDo = (me: Me, m: ModuleKey, l: Level) => levelRank(me.perms[m]) >= levelRank(l);
