// Log in and sign up: username + password, or "Continue with Google".
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Provider } from "../../../shared/types";
import { api } from "../api";

export default function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const signup = mode === "signup";
  const [params] = useSearchParams();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [needsCode, setNeedsCode] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState(params.get("error") || ""); // handed back after a Google sign-in problem
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ providers: Provider[]; needsCode: boolean }>("/api/auth/config", { allow401: true })
      .then(c => { setProviders(c.providers); setNeedsCode(c.needsCode); })
      .catch(() => {});
  }, []);

  useEffect(() => setError(params.get("error") || ""), [mode, params]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (signup && password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      await api(signup ? "/api/signup" : "/api/login", { method: "POST", json: { username, password, code }, allow401: true });
      window.location.href = "/"; // reload so the app picks up the new session
      return;
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  const codeMissing = signup && needsCode && !code.trim();

  return (
    <main className="login">
      <form onSubmit={submit} noValidate>
        <div>
          <h1>Lena Dena Ledger</h1>
          <p className="sub">{signup ? "Create an account to keep track of who owes you, and who you owe." : "Log in to your ledger."}</p>
        </div>
        {signup && needsCode && (
          <div className="field">
            <label htmlFor="code">Invite code</label>
            <input id="code" type="text" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} required />
          </div>
        )}
        {providers.length > 0 && (
          <div className="social">
            {providers.map(p => (
              // A normal link, not fetch(): the browser has to leave the app and visit Google.
              <a key={p.key} className={`btn social-btn${codeMissing ? " off" : ""}`} aria-disabled={codeMissing}
                href={`/api/oauth/${p.key}/start?mode=${signup ? "signup" : "login"}${signup && code.trim() ? `&code=${encodeURIComponent(code.trim())}` : ""}`}
                onClick={e => { if (codeMissing) { e.preventDefault(); setError("Enter the invite code first."); } }}>
                Continue with {p.name}
              </a>
            ))}
            <div className="or" role="separator"><span>or use a username</span></div>
          </div>
        )}
        <div className="field">
          <label htmlFor="username">Username</label>
          <input id="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
            value={username} onChange={e => setUsername(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete={signup ? "new-password" : "current-password"}
            value={password} onChange={e => setPassword(e.target.value)} required minLength={signup ? 8 : undefined} />
          {signup && <span className="hint">At least 8 characters.</span>}
        </div>
        {signup && (
          <div className="field">
            <label htmlFor="confirm">Confirm password</label>
            <input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
          </div>
        )}
        <button className="primary" type="submit" disabled={busy || !username || !password}>
          {busy ? (signup ? "Creating account…" : "Logging in…") : signup ? "Create account" : "Log in"}
        </button>
        <p className="msg err" aria-live="polite">{error}</p>
        <p className="switch">
          {signup ? <>Already have an account? <Link to="/login">Log in</Link></> : <>New here? <Link to="/signup">Create an account</Link></>}
        </p>
        <p className="switch"><Link to="/privacy">Privacy</Link></p>
      </form>
    </main>
  );
}
