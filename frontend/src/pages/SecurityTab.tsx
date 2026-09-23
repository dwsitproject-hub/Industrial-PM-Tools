import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setAccessToken } from '../api';
import { fmtDateTime } from '../labels';
import { Badge, Spinner, useToast } from '../ui';

/**
 * AR-04: self-service two-factor enrolment. Not role-gated — every user manages their own
 * second factor, and roles listed in MFA_REQUIRED_ROLES cannot use the application until
 * they have one.
 */
export default function SecurityTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'enrolling' | 'codes'>('idle');
  const [setupData, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const { data: status, isLoading } = useQuery({
    queryKey: ['mfa-status'],
    queryFn: () => api.get<any>('/api/v1/auth/mfa/status'),
  });

  const begin = useMutation({
    mutationFn: () => api.post<any>('/api/v1/auth/mfa/setup', {}),
    onSuccess: (d) => { setSetup(d); setStep('enrolling'); setError(''); },
    onError: (e: any) => setError(e?.body?.message || e?.message || 'Could not start setup.'),
  });

  const enable = useMutation({
    mutationFn: () => api.post<any>('/api/v1/auth/mfa/enable', { code: code.trim() }),
    onSuccess: (d) => {
      // The re-issued token carries the mfa claim, which is what stops the enrolment guard
      // challenging every subsequent request.
      setAccessToken(d.accessToken);
      setCodes(d.backupCodes);
      setStep('codes');
      setCode('');
      setError('');
      qc.invalidateQueries({ queryKey: ['mfa-status'] });
      toast('Two-factor authentication is on');
    },
    onError: (e: any) => setError(e?.body?.message || e?.message || 'That code is not right.'),
  });

  const disable = useMutation({
    mutationFn: () => api.post('/api/v1/auth/mfa/disable', { password }),
    onSuccess: () => {
      setPassword('');
      setError('');
      setStep('idle');
      qc.invalidateQueries({ queryKey: ['mfa-status'] });
      toast('Two-factor authentication is off');
    },
    onError: (e: any) => setError(e?.body?.message || e?.message || 'Could not turn it off.'),
  });

  function copyCodes() {
    const text = codes.join(String.fromCharCode(10));
    navigator.clipboard?.writeText(text).then(
      () => toast('Backup codes copied'),
      () => toast('Could not copy — select and copy them manually'),
    );
  }

  if (isLoading) return <Spinner />;

  return (
    <div className="card" style={{ padding: 18, maxWidth: 620 }}>
      <div className="flex items-center gap8 mb4">
        <div style={{ fontSize: 15, fontWeight: 500 }}>Two-factor authentication</div>
        <Badge kind={status?.enabled ? 'DONE' : status?.required ? 'URGENT' : 'NEW'}
          label={status?.enabled ? 'On' : status?.required ? 'Required' : 'Off'} />
      </div>
      <div className="fs12 c-muted mb12">
        An authenticator app generates a 6-digit code that changes every 30 seconds. With it on,
        someone who learns your password still cannot sign in as you.
        {status?.required && !status?.enabled && (
          <> <strong>Your role requires this — you cannot use the application until it is set up.</strong></>
        )}
      </div>

      {status?.enabled && step !== 'codes' && (
        <>
          <div className="fs12 c-muted mb12">
            Enabled {status.enabledAt ? fmtDateTime(status.enabledAt) : ''} ·{' '}
            {status.backupCodesRemaining} backup code{status.backupCodesRemaining === 1 ? '' : 's'} left
          </div>
          {!status.required ? (
            <>
              <div className="field" style={{ maxWidth: 320 }}>
                <label>Confirm your password to turn it off</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password" />
              </div>
              {error && <div className="field-hint c-red mb8">{error}</div>}
              <button className="btn btn-outline" disabled={!password || disable.isPending}
                onClick={() => disable.mutate()}>
                Turn off two-factor authentication
              </button>
            </>
          ) : (
            <div className="fs12 c-hint">
              Your role is required to keep this on, so it cannot be turned off here.
            </div>
          )}
        </>
      )}

      {!status?.enabled && step === 'idle' && (
        <>
          {error && <div className="field-hint c-red mb8">{error}</div>}
          <button className="btn btn-primary" disabled={begin.isPending} onClick={() => begin.mutate()}>
            {begin.isPending ? 'Preparing…' : 'Set up two-factor authentication'}
          </button>
        </>
      )}

      {step === 'enrolling' && setupData && (
        <>
          <ol className="fs12 c-muted" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Open your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
            <li>Scan this code, or enter the key by hand.</li>
            <li>Type the 6-digit code it shows.</li>
          </ol>
          <div className="flex gap16 items-center mb12" style={{ flexWrap: 'wrap' }}>
            <img src={setupData.qr} alt="Two-factor setup QR code" width={180} height={180}
              style={{ border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
            <div>
              <div className="fs11 c-hint mb4">Or enter this key manually:</div>
              <div className="mono fs12" style={{ wordBreak: 'break-all', maxWidth: 240 }}>{setupData.secret}</div>
            </div>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>6-digit code</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} className="mono"
              inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={8} />
          </div>
          {error && <div className="field-hint c-red mb8">{error}</div>}
          <div className="flex gap8">
            <button className="btn btn-primary" disabled={code.trim().length < 6 || enable.isPending}
              onClick={() => enable.mutate()}>
              {enable.isPending ? 'Verifying…' : 'Verify and turn on'}
            </button>
            <button className="btn btn-outline"
              onClick={() => { setStep('idle'); setSetup(null); setError(''); }}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === 'codes' && (
        <>
          <div className="fs13 mb4" style={{ fontWeight: 500 }}>Save your backup codes</div>
          <div className="fs12 c-muted mb12">
            Each code works once, and they are the only way back in if you lose your phone.
            They are not shown again — store them somewhere safe now.
          </div>
          <div className="mono fs12 mb12" style={{
            display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6,
            background: 'var(--surface-2, #f5f5f4)', padding: 12, borderRadius: 8,
          }}>
            {codes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <div className="flex gap8">
            <button className="btn btn-outline" onClick={copyCodes}>Copy codes</button>
            <button className="btn btn-primary" onClick={() => { setStep('idle'); setCodes([]); }}>
              I have saved them
            </button>
          </div>
        </>
      )}
    </div>
  );
}
