import { FormEvent, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

export default function LoginPage() {
  const { login, changePassword, logout, profile } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mustChangeLocal, setMustChange] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const mustChange = mustChangeLocal || !!profile?.user.mustChangePassword;

  const { data: ws } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get('/api/v1/workspace'),
    staleTime: Infinity,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const p = await login(email.trim(), password);
      if (p.user.mustChangePassword) setMustChange(true);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Wait a minute and try again.');
      else if (err instanceof ApiError && err.body?.error === 'AccountNotActivated') setError(err.body.message);
      else if (err instanceof ApiError && err.status === 400) setError('Enter a valid email address.');
      else setError('Invalid email or password.');
    } finally {
      setBusy(false);
    }
  }

  async function submitChange(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (newPw !== newPw2) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await changePassword(password, newPw);
    } catch (err: any) {
      setError(err.message || 'Could not change password.');
    } finally {
      setBusy(false);
    }
  }

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
        {!mustChange ? (
          <form onSubmit={submit}>
            <div className="auth-title">Sign in</div>
            <div className="auth-sub">Sign in with your work email address.</div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoFocus autoComplete="email" placeholder="you@company.com" />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            {error && <div className="field-hint c-red mb8">{error}</div>}
            <button className="btn btn-primary btn-full" disabled={busy || !email || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <Link to="/forgot-password" className="fs12 c-muted" style={{ textDecoration: 'underline' }}>
                Forgot your password?
              </Link>
            </div>
          </form>
        ) : (
          <form onSubmit={submitChange}>
            <div className="auth-title">Set a new password</div>
            <div className="auth-sub">Your temporary password must be replaced before you continue. Minimum 10 characters.</div>
            <div className="field">
              <label>Current (temporary) password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <label>New password</label>
              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>Repeat new password</label>
              <input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
            </div>
            {error && <div className="field-hint c-red mb8">{error}</div>}
            <button className="btn btn-primary btn-full" disabled={busy || newPw.length < 10}>
              {busy ? 'Saving…' : 'Change password & continue'}
            </button>
            <button type="button" className="btn btn-outline btn-full mt8" onClick={() => { setMustChange(false); logout(); }}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
