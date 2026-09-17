import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api';

type Mode = 'activate' | 'reset';

function useBranding() {
  const { data } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get('/api/v1/workspace'),
    staleTime: Infinity,
  });
  return data;
}

function Shell({ children }: { children: React.ReactNode }) {
  const ws = useBranding();
  return (
    <div className="center-wrap">
      <div className="auth-box">
        <div className="auth-logo">
          <div className="auth-logo-icon">E</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 500 }}>{ws?.company || 'EngPro'}</div>
            <div className="fs11 c-hint mono">{ws?.subtitle || 'Estimation Management System'}</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Shared page for /activate?token=… and /reset-password?token=… */
export function TokenPasswordPage({ mode }: { mode: Mode }) {
  const nav = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [state, setState] = useState<'checking' | 'ok' | 'bad'>('checking');
  const [who, setWho] = useState<{ email: string; fullName: string } | null>(null);
  const [problem, setProblem] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const path = mode === 'activate' ? 'activate' : 'reset-password';
  const title = mode === 'activate' ? 'Activate your account' : 'Choose a new password';

  useEffect(() => {
    (async () => {
      if (!token) { setState('bad'); setProblem('This link is missing its token.'); return; }
      try {
        const res = await api.get(`/api/v1/auth/${path}/${encodeURIComponent(token)}`);
        setWho({ email: res.email, fullName: res.fullName });
        setState('ok');
      } catch (e: any) {
        setProblem(e?.body?.message || 'This link is not valid.');
        setState('bad');
      }
    })();
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (pw !== pw2) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.post(`/api/v1/auth/${path}`, { token, newPassword: pw });
      setDone(true);
      setTimeout(() => nav('/login', { replace: true }), 2500);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not save the password.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'checking') return <Shell><div className="auth-sub">Checking the link…</div></Shell>;

  if (state === 'bad') {
    return (
      <Shell>
        <div className="auth-title">Link no longer valid</div>
        <div className="auth-sub">{problem}</div>
        <div className="field-hint mb16">
          {mode === 'activate'
            ? 'Ask your manager to resend the invitation from Settings → Users.'
            : 'Request a new reset link from the sign-in page.'}
        </div>
        <button className="btn btn-primary btn-full" onClick={() => nav('/login', { replace: true })}>
          Back to sign in
        </button>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="auth-title">{mode === 'activate' ? 'Account activated' : 'Password updated'}</div>
        <div className="auth-sub">
          You can now sign in as <strong>{who?.email}</strong>. Taking you to the sign-in page…
        </div>
        <button className="btn btn-primary btn-full" onClick={() => nav('/login', { replace: true })}>
          Sign in now
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submit}>
        <div className="auth-title">{title}</div>
        <div className="auth-sub">
          {mode === 'activate' ? `Welcome ${who?.fullName}. ` : ''}
          For <strong>{who?.email}</strong>. Minimum 10 characters.
        </div>
        <div className="field">
          <label>New password</label>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="new-password" />
        </div>
        <div className="field">
          <label>Repeat new password</label>
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </div>
        {error && <div className="field-hint c-red mb8">{error}</div>}
        <button className="btn btn-primary btn-full" disabled={busy || pw.length < 10}>
          {busy ? 'Saving…' : mode === 'activate' ? 'Activate account' : 'Update password'}
        </button>
      </form>
    </Shell>
  );
}

/** /forgot-password */
export function ForgotPasswordPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.post('/api/v1/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (e: any) {
      setError(e instanceof ApiError && e.status === 429
        ? 'Too many requests. Wait a minute and try again.'
        : 'Enter a valid email address.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Shell>
        <div className="auth-title">Check your email</div>
        <div className="auth-sub">
          If <strong>{email.trim()}</strong> belongs to an account, a reset link is on its way.
          It expires in an hour and can be used once.
        </div>
        <div className="field-hint mb16">
          Nothing arrives? Check spam, or ask your manager to send a link from Settings → Users.
        </div>
        <button className="btn btn-primary btn-full" onClick={() => nav('/login', { replace: true })}>
          Back to sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submit}>
        <div className="auth-title">Forgot your password?</div>
        <div className="auth-sub">Enter your work email and we will send you a link to choose a new one.</div>
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoFocus autoComplete="email" placeholder="you@company.com" />
        </div>
        {error && <div className="field-hint c-red mb8">{error}</div>}
        <button className="btn btn-primary btn-full" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
        <button type="button" className="btn btn-outline btn-full mt8" onClick={() => nav('/login', { replace: true })}>
          Back to sign in
        </button>
      </form>
    </Shell>
  );
}
