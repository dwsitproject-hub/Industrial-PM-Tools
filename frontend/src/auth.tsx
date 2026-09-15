import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { api, setAccessToken, setSessionLostHandler, tryRefresh } from './api';

export interface Profile {
  user: {
    id: string; username: string; email: string; fullName: string;
    role: 'MANAGER' | 'ADMIN' | 'SITE_ADMIN' | 'ESTIMATOR';
    siteId: string | null; siteName: string | null;
    avatarColor: number; mustChangePassword: boolean;
  };
  workspace: { id: string; company: string; subtitle: string | null; ticketPrefix: string; timezone: string };
}

export type PagePerms = { view?: boolean; create?: boolean; edit?: boolean; delete?: boolean };
export interface Perms {
  role: string;
  locked: boolean;
  ticketScope: 'ALL' | 'OWN';
  pages: Record<string, PagePerms>;
}

interface AuthCtx {
  profile: Profile | null;
  perms: Perms | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Profile>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshPerms: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

/** Convenience: can('tickets','create') */
export function usePerm() {
  const { perms } = useAuth();
  return (resource: string, action: string = 'view') => perms?.pages?.[resource]?.[action as keyof PagePerms] === true;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [perms, setPerms] = useState<Perms | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPerms = useCallback(async () => {
    setPerms(await api.get<Perms>('/api/v1/roles/me'));
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => { setProfile(null); setPerms(null); });
    (async () => {
      if (await tryRefresh()) {
        try {
          const me = await api.get<Profile>('/api/v1/auth/me');
          setPerms(await api.get<Perms>('/api/v1/roles/me'));
          setProfile(me);
        } catch { /* ignore */ }
      }
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<any>('/api/v1/auth/login', { email, password });
    setAccessToken(res.accessToken);
    const p: Profile = { user: res.user, workspace: res.workspace };
    if (!res.user.mustChangePassword) setPerms(await api.get<Perms>('/api/v1/roles/me'));
    setProfile(p);
    return p;
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/api/v1/auth/logout'); } catch { /* ignore */ }
    setAccessToken(null);
    setProfile(null);
    setPerms(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.post<any>('/api/v1/auth/change-password', { currentPassword, newPassword });
    setAccessToken(res.accessToken);
    const me = await api.get<Profile>('/api/v1/auth/me');
    setPerms(await api.get<Perms>('/api/v1/roles/me'));
    setProfile(me);
  }, []);

  const refreshProfile = useCallback(async () => {
    setProfile(await api.get<Profile>('/api/v1/auth/me'));
  }, []);

  return (
    <Ctx.Provider value={{ profile, perms, loading, login, logout, changePassword, refreshProfile, refreshPerms: loadPerms }}>
      {children}
    </Ctx.Provider>
  );
}
