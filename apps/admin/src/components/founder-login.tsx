'use client';
import { useState } from 'react';

function decode(value: string): ArrayBuffer {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (letter) => letter.charCodeAt(0)).buffer;
}
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function FounderLogin() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function post(path: string, input: unknown) {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const data: unknown = await response.json();
    if (!response.ok) {
      const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : '';
      throw new Error(
        code.includes('unconfigured')
          ? 'The founder workspace is awaiting deployment configuration.'
          : 'Sign-in was refused. Check your credentials and second factor.',
      );
    }
    return data;
  }
  return (
    <form
      className="adm-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
          await post('/api/session', { identifier, password, totpCode });
          window.location.assign('/crm');
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
        } finally {
          setPassword('');
          setTotpCode('');
          setBusy(false);
        }
      }}
    >
      <label>
        Email or handle
        <input
          autoComplete="username"
          required
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          maxLength={254}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          maxLength={1024}
        />
      </label>
      <label>
        Authenticator or recovery code
        <input
          autoComplete="one-time-code"
          required
          value={totpCode}
          onChange={(event) => setTotpCode(event.target.value)}
          maxLength={11}
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <button
        type="button"
        disabled={busy || !identifier.trim()}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            if (!navigator.credentials) throw new Error('Passkeys are unavailable in this browser.');
            const raw = (await post('/api/session/passkey', { action: 'options', identifier })) as {
              challenge: string;
              allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>;
              rpId?: string;
              timeout?: number;
              userVerification?: UserVerificationRequirement;
            };
            if (typeof raw.challenge !== 'string') throw new Error('Passkey challenge unavailable.');
            const credential = (await navigator.credentials.get({
              publicKey: {
                ...raw,
                challenge: decode(raw.challenge),
                allowCredentials: raw.allowCredentials?.map((item) => ({ ...item, id: decode(item.id) })),
              },
            })) as PublicKeyCredential | null;
            if (!credential) throw new Error('Passkey sign-in was cancelled.');
            const response = credential.response as AuthenticatorAssertionResponse;
            await post('/api/session/passkey', {
              action: 'authenticate',
              identifier,
              credential: {
                id: credential.id,
                rawId: encode(credential.rawId),
                type: credential.type,
                response: {
                  clientDataJSON: encode(response.clientDataJSON),
                  authenticatorData: encode(response.authenticatorData),
                  signature: encode(response.signature),
                  userHandle: response.userHandle ? encode(response.userHandle) : null,
                },
                clientExtensionResults: credential.getClientExtensionResults(),
              },
            });
            window.location.assign('/crm');
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Passkey sign-in failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign in with a passkey
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
