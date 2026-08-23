import { useState, useEffect } from "react";
import { Users, UserPlus, Trash2, Shield, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { useLocation } from "wouter";

interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

interface LabInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

interface InviteOutcome {
  email: string;
  /** The register link. Always present — it is the recovery path when mail fails. */
  inviteUrl: string;
  delivery: { sent: boolean; provider: string; skipped: boolean; error: string | null };
}

export default function TeamPage() {
  const { token, isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<LabInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<"researcher" | "admin">("researcher");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  /**
   * Outcome of the LAST invite, kept so the admin learns whether the email
   * actually left the building. An invitation row is created either way; only
   * this tells them whether the person will hear about it.
   */
  const [lastInvite, setLastInvite] = useState<InviteOutcome | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) { navigate("/login"); return; }
    fetchMembers();
    fetchInvitations();
  }, [token]);

  async function fetchMembers() {
    setLoading(true);
    try {
      const res = await fetch("/api/team", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json() as { members: TeamMember[] };
      setMembers(data.members ?? []);
    } catch {
      setError("Failed to load team members");
    } finally {
      setLoading(false);
    }
  }

  async function fetchInvitations() {
    try {
      const res = await fetch("/api/team/invitations", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json() as { invitations: LabInvitation[] };
      setInvitations(data.invitations ?? []);
    } catch {
      // Ignore failure to load invitations
    }
  }

  async function inviteMember(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      const res = await fetch("/api/team/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: addEmail, role: addRole }),
      });
      const data = await res.json() as {
        invitation?: LabInvitation;
        error?: string;
        inviteUrl?: string;
        delivery?: InviteOutcome["delivery"];
      };
      if (!res.ok) { setAddError(data.error ?? "Failed to send invitation"); return; }
      setInvitations(prev => [...prev, data.invitation!]);
      // Record the outcome BEFORE clearing the field, so the panel can name
      // the address the link belongs to.
      if (data.inviteUrl && data.delivery) {
        setLastInvite({ email: addEmail, inviteUrl: data.inviteUrl, delivery: data.delivery });
        setCopied(false);
      }
      setAddEmail("");
    } catch {
      setAddError("Network error");
    } finally {
      setAdding(false);
    }
  }

  async function removeMember(id: number) {
    try {
      await fetch(`/api/team/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      setMembers(prev => prev.filter(m => m.id !== id));
    } catch {
      setError("Failed to remove member");
    }
  }

  async function revokeInvitation(id: string) {
    try {
      await fetch(`/api/team/invitations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      setInvitations(prev => prev.filter(i => i.id !== id));
    } catch {
      setError("Failed to revoke invitation");
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6" style={{ background: "hsl(var(--background))" }}>
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="bg-primary/15 p-2 rounded border border-primary/30">
            <Users className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground">Research Team</h1>
            <p className="text-xs text-muted-foreground">Manage authorized researchers with access to this system</p>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}

        {/* Add member form (admin only) */}
        {isAdmin && (
          <div className="rounded border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground mb-2">
              <UserPlus className="w-3.5 h-3.5 text-primary" /> Invite Researcher
            </div>
            <form onSubmit={inviteMember} className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  type="email"
                  placeholder="Institutional email"
                  value={addEmail}
                  onChange={e => setAddEmail(e.target.value)}
                  required
                  className="flex-1 px-3 py-1.5 text-xs bg-background border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 transition-colors"
                />
                <select
                  value={addRole}
                  onChange={e => setAddRole(e.target.value as "researcher" | "admin")}
                  className="px-2 py-1.5 text-xs bg-background border border-border rounded text-foreground focus:outline-none focus:border-primary/60 transition-colors"
                >
                  <option value="researcher">Researcher</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {addError && <p className="text-[10px] text-red-500">{addError}</p>}

              {/* Delivery outcome.
                  The invitation row exists either way — this says whether the
                  invitee will actually hear about it. Previously the UI showed
                  nothing here, so a silently undelivered invitation looked
                  exactly like a delivered one. */}
              {lastInvite && (
                <div
                  className={`mt-1 rounded border p-2.5 ${
                    lastInvite.delivery.sent
                      ? "border-emerald-500/40 bg-emerald-500/[0.06]"
                      : "border-amber-500/40 bg-amber-500/[0.06]"
                  }`}
                >
                  {lastInvite.delivery.sent ? (
                    <p className="text-[10px] text-emerald-400">
                      Invitation emailed to <span className="font-mono">{lastInvite.email}</span>{" "}
                      via {lastInvite.delivery.provider}. If it does not arrive, check their spam
                      folder or share the link below.
                    </p>
                  ) : (
                    <p className="text-[10px] text-amber-400">
                      <strong>Invitation created, but no email was sent.</strong>{" "}
                      {lastInvite.delivery.skipped
                        ? "No email provider is configured on the server (EMAIL_PROVIDER)."
                        : lastInvite.delivery.error}{" "}
                      Send this link to <span className="font-mono">{lastInvite.email}</span>{" "}
                      yourself — it works regardless.
                    </p>
                  )}

                  {/* Always shown, delivered or not: the link is the recovery
                      path, and it is also what someone pastes into chat when
                      the email lands in spam. */}
                  <div className="mt-1.5 flex items-center gap-2">
                    <code className="flex-1 min-w-0 truncate rounded bg-background px-2 py-1 text-[10px] text-muted-foreground">
                      {lastInvite.inviteUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(lastInvite.inviteUrl).then(
                          () => setCopied(true),
                          () => setCopied(false),
                        );
                      }}
                      className="shrink-0 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    They must register with exactly this address — the invitation is matched by
                    email.
                  </p>
                </div>
              )}
              <button
                type="submit"
                disabled={adding}
                className="self-start px-4 py-1.5 bg-primary text-primary-foreground text-xs font-semibold rounded hover:bg-primary/90 disabled:opacity-60 transition-colors"
              >
                {adding ? "Sending…" : "Send Invite"}
              </button>
            </form>
          </div>
        )}

        {/* Pending Invitations list */}
        {invitations.length > 0 && (
          <div className="rounded border border-border overflow-hidden mb-6">
            <div className="px-4 py-2.5 border-b border-border bg-card flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">Pending Invitations</span>
              <span className="text-[10px] text-muted-foreground font-mono">{invitations.length} invitations</span>
            </div>
            <div className="divide-y divide-border">
              {invitations.map(i => (
                <div key={i.id} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/10 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground">{i.email}</div>
                    <div className="text-[10px] text-muted-foreground">Expires: {new Date(i.expiresAt).toLocaleDateString()}</div>
                  </div>
                  <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase ${
                    i.role === "admin" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                  }`}>
                    {i.role === "admin" && <Shield className="w-2 h-2" />}
                    {i.role}
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => revokeInvitation(i.id)}
                      className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="Revoke invitation"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Members list */}
        <div className="rounded border border-border overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-card flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">Team Members</span>
            <span className="text-[10px] text-muted-foreground font-mono">{members.length} members</span>
          </div>
          {loading ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</div>
          ) : members.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">No team members yet</div>
          ) : (
            <div className="divide-y divide-border">
              {members.map(m => (
                <div key={m.id} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/10 transition-colors">
                  <div className="w-7 h-7 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
                    <span className="text-[11px] font-bold text-primary">{m.name?.[0]?.toUpperCase() ?? m.email[0]?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground">{m.name || "—"}</div>
                    <div className="text-[10px] text-muted-foreground">{m.email}</div>
                  </div>
                  <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase ${
                    m.role === "admin" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                  }`}>
                    {m.role === "admin" && <Shield className="w-2 h-2" />}
                    {m.role}
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => removeMember(m.id)}
                      className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="Remove member"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
