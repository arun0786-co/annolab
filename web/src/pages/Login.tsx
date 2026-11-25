import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { ThemeButton } from "../components/AppShell";
import { useSession } from "../state";

const DEMO = [
  ["admin@annolab.dev", "admin"],
  ["annotator1@annolab.dev", "annotator"],
  ["reviewer1@annolab.dev", "reviewer"],
];

export function Login() {
  const { user, login } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = (loc.state as { from?: string } | null)?.from ?? "/";
  if (user) return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      nav(from, { replace: true });
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.status === 401 ? "Email or password is incorrect." : ae.offline ? "Cannot reach the server." : ae.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div style={{ position: "fixed", top: 8, right: 8 }}>
        <ThemeButton />
      </div>
      <main className="panel login-card">
        <div className="brand" style={{ fontSize: 18 }}>
          <span className="brand-mark" aria-hidden="true" />
          annolab
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Label images, audio, video and text in one place.
        </p>
        <form onSubmit={submit} noValidate>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy || !email || !password}>
            {busy ? "Signing in" : "Sign in"}
          </button>
        </form>
        <div className="demo-accounts">
          <div style={{ marginBottom: 4 }}>Demo accounts (password <code>annolab</code>)</div>
          {DEMO.map(([e, r]) => (
            <div key={e} className="row">
              <button
                type="button"
                onClick={() => {
                  setEmail(e);
                  setPassword("annolab");
                }}
              >
                {e}
              </button>
              <span className="faint">{r}</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
