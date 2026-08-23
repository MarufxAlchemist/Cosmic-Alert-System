import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Telescope, Lock, Mail, User, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { GoogleLogin } from "@react-oauth/google";

type Mode = "login" | "register";

interface ApiAuthResponse {
  token: string;
  user: { id: string; email: string; name: string; role: string };
  error?: string;
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      // Clear the code from URL to prevent replay on refresh
      window.history.replaceState({}, document.title, window.location.pathname);
      
      setLoading(true);
      setError("");
      const redirectUri = window.location.origin + "/login";
      
      fetch("/api/auth/orcid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, redirectUri }),
      })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          setError(data.error ?? "ORCID authentication failed");
          setLoading(false);
          return;
        }
        login(data.token, { userId: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role });
        navigate("/");
      })
      .catch(() => {
        setError("Network error during ORCID callback");
        setLoading(false);
      });
    }
  }, [login, navigate]);

  function handleOrcidLogin() {
    const clientId = import.meta.env.VITE_ORCID_CLIENT_ID;
    if (!clientId) {
      setError("ORCID client ID not configured");
      return;
    }
    const redirectUri = encodeURIComponent(window.location.origin + "/login");
    window.location.href = `https://orcid.org/oauth/authorize?client_id=${clientId}&response_type=code&scope=openid%20email&redirect_uri=${redirectUri}`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body: Record<string, string> = { email, password };
      if (mode === "register" && name) body["name"] = name;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: ApiAuthResponse = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Request failed");
        return;
      }
      login(data.token, { userId: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role });
      navigate("/");
    } catch {
      setError("Network error — check your connection");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6"
      style={{ background: "hsl(var(--background))" }}>
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="bg-primary/15 p-3 rounded-xl border border-primary/30">
            <Telescope className="w-6 h-6 text-primary" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-bold text-foreground tracking-tight">Transient Event Detection</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Researcher Access Portal</p>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex rounded border border-border bg-card mb-6 overflow-hidden">
          {(["login", "register"] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(""); }}
              className={`flex-1 py-2 text-[11px] font-mono font-semibold uppercase tracking-wider transition-all ${mode === m
                ? "bg-primary/15 text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground"
                }`}
            >
              {m === "login" ? "Sign in" : "Register"}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "register" && (
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Display name"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 text-sm bg-card border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"
              />
            </div>
          )}
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="email"
              placeholder="Institutional email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-card border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"
            />
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="password"
              placeholder={mode === "register" ? "Min. 8 characters" : "Password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-card border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-[11px]">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors mt-1"
          >
            {loading ? "Processing…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="relative mt-5 mb-5">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border"></div>
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-[hsl(var(--background))] px-2 text-muted-foreground uppercase tracking-wider font-semibold">Or</span>
          </div>
        </div>

        <div className="flex flex-col gap-3 justify-center">
          <div className="flex justify-center">
            <GoogleLogin
              onSuccess={async (credentialResponse) => {
                setError("");
                setLoading(true);
                try {
                  const res = await fetch("/api/auth/google", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: credentialResponse.credential }),
                  });
                  const data: ApiAuthResponse = await res.json();
                  if (!res.ok) {
                    setError(data.error ?? "Google authentication failed");
                    return;
                  }
                  login(data.token, { userId: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role });
                  navigate("/");
                } catch {
                  setError("Network error — check your connection");
                } finally {
                  setLoading(false);
                }
              }}
              onError={() => setError("Google authentication failed")}
              theme="filled_blue"
              shape="rectangular"
              text={mode === "login" ? "signin_with" : "signup_with"}
            />
          </div>

          <button
             type="button"
             onClick={handleOrcidLogin}
             disabled={loading}
             className="w-full flex items-center justify-center gap-2 py-2 border border-border rounded bg-card hover:bg-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
             <img src="https://orcid.org/assets/vectors/orcid.logo.icon.svg" alt="ORCID" className="w-4 h-4" />
             <span className="text-sm font-semibold text-foreground">Continue with ORCID</span>
          </button>
        </div>

        {mode === "register" && (
          <p className="mt-4 text-center text-[10px] text-muted-foreground leading-relaxed">
            The first registered account is granted admin access.<br />
            Subsequent accounts require team invitation.
          </p>
        )}
      </div>
    </div>
  );
}
