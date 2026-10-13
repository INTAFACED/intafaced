import { FounderLogin } from '@/components/founder-login';

export default function LoginPage() {
  return (
    <main className="adm-login">
      <div className="adm-brand">
        <img src="/intafaced-logo.svg" alt="INTAFACED" width="164" height="30" />
        <small>Founder console</small>
      </div>
      <h1>Sign in to your workspace</h1>
      <p>Use your INTAFACED identity and second factor.</p>
      <FounderLogin />
    </main>
  );
}
