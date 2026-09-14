import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { getAccessToken, setTokenChangeHandler } from './api';
import { useAuth } from './auth';

type SyncState = 'online' | 'syncing' | 'offline';
const Ctx = createContext<SyncState>('syncing');
export const useSyncState = () => useContext(Ctx);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { profile, refreshPerms } = useAuth();
  const qc = useQueryClient();
  const [state, setState] = useState<SyncState>('syncing');
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!profile) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }
    const socket = io({ path: '/ws', auth: { token: getAccessToken() }, reconnectionDelayMax: 5000 });
    socketRef.current = socket;

    const invalidateTickets = () => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['ticket'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    };
    socket.on('connect', () => setState('online'));
    socket.on('disconnect', () => setState('offline'));
    socket.io.on('reconnect_attempt', () => setState('syncing'));
    socket.io.on('reconnect', () => {
      (socket.auth as any).token = getAccessToken();
      qc.invalidateQueries();
      setState('online');
    });
    socket.on('ticket.created', invalidateTickets);
    socket.on('ticket.updated', invalidateTickets);
    socket.on('ticket.deleted', invalidateTickets);
    socket.on('ticket.restored', invalidateTickets);
    socket.on('note.created', (p: any) => {
      qc.invalidateQueries({ queryKey: ['ticket', p?.id] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    });
    socket.on('kpi.updated', () => qc.invalidateQueries({ queryKey: ['kpi'] }));
    socket.on('roles.updated', () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      refreshPerms().catch(() => { /* ignore */ });
    });
    socket.on('user.updated', (p: any) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      if (p?.deactivated) window.location.reload();
    });

    setTokenChangeHandler((t) => {
      if (socketRef.current && t) (socketRef.current.auth as any).token = t;
    });
    return () => { socket.disconnect(); };
  }, [profile?.user.id]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
