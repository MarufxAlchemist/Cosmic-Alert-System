import { useEffect, useState } from "react";
import { Check, Clock, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * DeliveryHistory
 * ───────────────
 * What actually happened to this user's notifications.
 *
 * WHY THIS PANEL EARNS ITS SPACE
 * From outside the system, "I never got an alert" and "no alert was sent" look
 * identical. Without this, a researcher whose webhook was deleted in WeCom
 * three weeks ago has no way to discover that — they simply conclude the sky
 * was quiet. The panel exists so a delivery failure is visible to the person
 * affected by it, not only in a server log they cannot read.
 *
 * It deliberately shows failures and retries as prominently as successes. A
 * history that only listed deliveries that worked would be worse than none,
 * because it would look like proof that everything is fine.
 */

interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  priority: string;
  revisionCount: number;
  channel: string;
  provider: string | null;
  status: "pending" | "processing" | "sent" | "retrying" | "failed" | "cancelled";
  attempts: number;
  failureKind: string | null;
  errorCode: string | null;
  error: string | null;
  sentAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

const STATUS: Record<Delivery["status"], { icon: typeof Check; cls: string; label: string }> = {
  sent:       { icon: Check,          cls: "text-emerald-500",  label: "Delivered" },
  pending:    { icon: Clock,          cls: "text-sky-500",      label: "Queued" },
  processing: { icon: Loader2,        cls: "text-sky-500",      label: "Sending" },
  retrying:   { icon: RefreshCw,      cls: "text-amber-500",    label: "Retrying" },
  failed:     { icon: TriangleAlert,  cls: "text-destructive",  label: "Failed" },
  cancelled:  { icon: X,              cls: "text-muted-foreground", label: "Cancelled" },
};

function timeOf(d: Delivery): string {
  const iso = d.sentAt ?? d.createdAt;
  try {
    return new Date(iso).toISOString().slice(11, 19) + " UTC";
  } catch {
    return "";
  }
}

/** "in 2 min" / "in 45s" — why a retrying row is not moving yet. */
function untilRetry(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "shortly";
  return ms < 60_000 ? `in ${Math.ceil(ms / 1000)}s` : `in ${Math.ceil(ms / 60_000)} min`;
}

export function DeliveryHistory({ token }: { token: string | null }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/notifications/deliveries?limit=25", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { setRows([]); return; }
      const j = await res.json();
      setRows(j.deliveries ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [token]);

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold">Recent Deliveries</h3>
          <p className="text-xs text-muted-foreground">
            Whether your alerts actually left Transient Event Detection.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          {loading
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {rows === null && (
        <div className="flex h-20 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {rows !== null && rows.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <p className="text-xs text-muted-foreground">
            No notifications have been dispatched yet. This is what an empty history
            looks like — it does not indicate a delivery problem.
          </p>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((d) => {
            const s = STATUS[d.status] ?? STATUS.pending;
            const Icon = s.icon;
            const retryIn = d.status === "retrying" ? untilRetry(d.nextRetryAt) : null;
            return (
              <li key={d.id} className="flex items-start gap-3 p-3">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.cls} ${d.status === "processing" ? "animate-spin" : ""}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-xs font-medium">{d.eventId || "—"}</span>
                    {d.eventType && (
                      <span className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                        {d.eventType}
                      </span>
                    )}
                    {d.revisionCount > 0 && (
                      <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-600 dark:text-amber-400">
                        rev {d.revisionCount}
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {d.channel}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span className={s.cls}>{s.label}</span>
                    {retryIn && <span>· next attempt {retryIn}</span>}
                    {/* Attempts are shown only when >1: "attempt 1" on every
                        successful row is noise that hides the interesting ones. */}
                    {d.attempts > 1 && <span>· {d.attempts} attempts</span>}
                    <span>· {timeOf(d)}</span>
                  </div>
                  {d.error && (
                    <p className="mt-1 text-[11px] leading-relaxed text-destructive">
                      {d.error}
                      {d.errorCode && <span className="opacity-70"> (code {d.errorCode})</span>}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
