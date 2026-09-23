import { FormEvent, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

export default function LoginPage() {
  const { login, completeMfa, changePassword, logout, profile } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mustChangeLocal, setMustChange] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const mustChange = mustChangeLocal || !!profile?.user.mustChangePassword;

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('sso_error');
    if (!code) return;
    const messages: Record<string, string> = {
      not_registered: 'Your DWS Hub account is not registered in EngPro yet. Ask a manager to add you in Settings → Users.',
      account_disabled: 'That account is disabled. Contact your manager.',
      access_denied: 'Sign-in was cancelled at DWS Hub.',
      state_mismatch: 'The sign-in attempt expired or was interrupted. Please try again.',
      no_session: 'Start sign-in from this page (the button below) rather than from a Hub link, and make sure you are on http://test-ind-pm.kpndomain.com — the sign-in could not be matched to a session started here.',
      exchange_failed: 'Could not complete sign-in with DWS Hub. Try again, or use your email and password.',
      token_invalid: 'DWS Hub returned an identity that failed verification. Contact IT.',
      sso_disabled: 'Single sign-on is not enabled on this server.',
    };
    setError(messages[code] || 'Single sign-on failed. Try again, or use your email and password.');
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const { data: sso } = useQuery({
    queryKey: ['sso-config'],
    queryFn: () => api.get('/api/v1/auth/sso/config'),
    staleTime: Infinity,
  });

  const { data: ws } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get('/api/v1/workspace'),
    staleTime: Infinity,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const res = await login(email.trim(), password);
      if (res.kind === 'mfa') { setMfaToken(res.mfaToken); setPassword(''); return; }
      if (res.profile.user.mustChangePassword) setMustChange(true);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Wait a minute and try again.');
      else if (err instanceof ApiError && err.status === 400) setError('Enter a valid email address.');
      // AR-05: the server no longer distinguishes unknown, wrong and not-yet-activated
      // accounts, so neither does this message.
      else setError('Invalid email or password.');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const p = await completeMfa(mfaToken, mfaCode.trim());
      if (p.user.mustChangePassword) { setMfaToken(''); setMustChange(true); }
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Wait a minute and try again.');
      else if (err instanceof ApiError && err.status === 401 && /expired/i.test(err.body?.message || '')) {
        setMfaToken(''); setError('That sign-in attempt expired. Please sign in again.');
      } else setError('That code is not right. Check your authenticator app and try again.');
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
        {mfaToken ? (
          <form onSubmit={submitMfa}>
            <div className="auth-title">Two-factor authentication</div>
            <div className="auth-sub">
              Enter the 6-digit code from your authenticator app. If you have lost your phone,
              use one of the backup codes you saved when you set this up.
            </div>
            <div className="field">
              <label>Authentication code</label>
              <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoFocus
                inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
                className="mono" maxLength={20} />
            </div>
            {error && <div className="field-hint c-red mb8">{error}</div>}
            <button className="btn btn-primary btn-full" disabled={busy || mfaCode.trim().length < 6}>
              {busy ? 'Verifying…' : 'Verify and sign in'}
            </button>
            <button type="button" className="btn btn-outline btn-full mt8"
              onClick={() => { setMfaToken(''); setMfaCode(''); setError(''); }}>
              Back
            </button>
          </form>
        ) : !mustChange ? (
          <form onSubmit={submit}>
            <div className="auth-title">Sign in</div>
            <div className="auth-sub">Sign in with your work email address.</div>
            {sso?.enabled && (
              <>
                <button type="button" className="btn btn-accent btn-full"
                  onClick={() => { window.location.href = '/api/v1/auth/sso/start'; }}>
                  {sso.buttonLabel || 'Continue with DWS Hub'}
                </button>
                <div className="flex gap8 mt12 mb12" style={{ color: 'var(--hint)' }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <span className="fs11">or sign in with email</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
              </>
            )}
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
              <div className="fs11 c-hint mt8">
                Just been invited and cannot sign in yet? Use the same link — it will send your
                activation email again.
              </div>
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
