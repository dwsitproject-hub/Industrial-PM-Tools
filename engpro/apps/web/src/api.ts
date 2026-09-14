/** Fetch wrapper: in-memory access token, silent refresh-and-retry on 401. */
let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;
let onTokenChange: ((t: string | null) => void) | null = null;

export function setAccessToken(t: string | null) {
  accessToken = t;
  onTokenChange?.(t);
}
export function getAccessToken() { return accessToken; }
export function setSessionLostHandler(fn: () => void) { onSessionLost = fn; }
export function setTokenChangeHandler(fn: (t: string | null) => void) { onTokenChange = fn; }

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(Array.isArray(body?.message) ? body.message.join('; ') : body?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  return fetch(path, {
    method, headers, credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    setAccessToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await rawRequest(method, path, body);
  if (res.status === 401 && !path.startsWith('/api/v1/auth/')) {
    const refreshed = await tryRefresh();
    if (refreshed) res = await rawRequest(method, path, body);
    else { setAccessToken(null); onSessionLost?.(); }
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? '?' + parts.join('&') : '';
}
