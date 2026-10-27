import { FounderLogin } from '@/components/founder-login';

export default function LoginPage() {
  return (
    <main className="adm-login">
      {/* The sign-in moment: the stacked lockup (kit files in public/brand, from packages/ui/brand). */}
      <div className="adm-brand adm-brand--stacked">
        <span className="adm-lockup adm-lockup--stacked" role="img" aria-label="INTAFACED" />
        <small>Founder console</small>
      </div>
      <h1>Sign in to your workspace</h1>
      <p>Use your INTAFACED identity and second factor.</p>
      <FounderLogin />
    </main>
  );
}
