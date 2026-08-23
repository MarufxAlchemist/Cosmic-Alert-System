import { useState } from "react";
import { Check, Loader2, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * WeComConfigPanel
 * ────────────────
 * Configuration for the WeChat channel, delivered via a WeCom (企业微信) group
 * robot webhook.
 *
 * WHY THIS IS A FORM AND NOT A "LOG IN WITH WECHAT" BUTTON
 * ────────────────────────────────────────────────────────
 * There is no OAuth flow that grants permission to push alerts to someone's
 * WeChat. The mechanisms that exist are different things:
 *
 *   • WeCom group robot webhook — outbound only. Someone in the organisation
 *     creates a robot inside a WeCom group and receives a URL. No end user
 *     logs in, ever. This is what Transient Event Detection uses.
 *   • "Login with WeChat" (WeChat OAuth) — authenticates a person. It does NOT
 *     confer the right to send them messages.
 *   • WeChat Official Account template messages — can reach personal WeChat,
 *     but needs a verified business entity, pre-approved templates, and the
 *     recipient must already follow the account.
 *
 * Presenting a login popup here would imply a capability that does not exist,
 * and the failure would only surface later as "why am I not getting alerts?".
 * So the panel asks for the one credential that actually works, and explains
 * where to obtain it.
 *
 * SECRET HANDLING
 * The webhook URL is a bearer credential: anyone holding it can post to the
 * group. It is submitted once, encrypted server-side, and never sent back. A
 * saved configuration renders only as a redacted string, which is why this
 * component distinguishes "editing a new value" from "showing what is stored".
 */

export type ChannelHealth = "connected" | "configuration_required" | "degraded" | "unknown";

export interface WeComConfigState {
  /** Redacted display string from the server. Never the real URL. */
  display?: string | null;
  health: ChannelHealth;
  healthDetail?: string;
}

interface Props {
  state: WeComConfigState;
  /** Submits a NEW webhook URL. Resolves with a user-safe error, or null on success. */
  onSave: (webhookUrl: string) => Promise<string | null>;
  /** Sends a test message. Resolves with a user-safe error, or null on success. */
  onTest: () => Promise<string | null>;
  onRemove: () => Promise<void>;
}

const HEALTH_STYLE: Record<ChannelHealth, { dot: string; label: string }> = {
  connected:              { dot: "bg-emerald-500", label: "Connected" },
  unknown:                { dot: "bg-sky-500",     label: "Configured — not yet verified" },
  degraded:               { dot: "bg-amber-500",   label: "Delivery degraded" },
  configuration_required: { dot: "bg-zinc-500",    label: "Configuration required" },
};

export function WeComConfigPanel({ state, onSave, onTest, onRemove }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const configured = Boolean(state.display);
  const health = HEALTH_STYLE[state.health];

  async function run(kind: "save" | "test" | "remove") {
    setBusy(kind);
    setError(null);
    setOk(null);
    try {
      if (kind === "save") {
        const err = await onSave(url.trim());
        if (err) setError(err);
        else { setOk("Webhook saved."); setUrl(""); }
      } else if (kind === "test") {
        const err = await onTest();
        if (err) setError(err);
        else setOk("Test notification sent.");
      } else {
        await onRemove();
        setOk("Webhook removed.");
      }
    } catch {
      // Never surface a raw exception: it can contain the request URL, and for
      // this transport the URL contains the key.
      setError("The request failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
      {/* Health — never claims "connected" merely because a URL exists */}
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${health.dot}`} aria-hidden />
        <span className="text-xs font-medium">WeChat · {health.label}</span>
      </div>
      {state.healthDetail && (
        <p className="text-xs leading-relaxed text-muted-foreground">{state.healthDetail}</p>
      )}

      {/* Stored credential, redacted */}
      {configured && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Configured webhook</label>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <code className="truncate font-mono text-xs">{state.display}</code>
          </div>
          <p className="text-[11px] text-muted-foreground">
            The key is encrypted on the server and is never sent back to this page.
          </p>
        </div>
      )}

      {/* Entry */}
      <div className="space-y-1">
        <label htmlFor="wecom-url" className="text-xs font-medium">
          {configured ? "Replace webhook URL" : "WeCom robot webhook URL"}
        </label>
        <Input
          id="wecom-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="font-mono text-xs"
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          In WeCom, open the group → <span className="font-medium">Group Robot / 群机器人</span> →
          add a robot → copy its webhook URL. Only{" "}
          <code className="font-mono">qyapi.weixin.qq.com</code> addresses are accepted.
        </p>
      </div>

      {/* Result */}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
      {ok && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{ok}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!url.trim() || busy !== null} onClick={() => run("save")}>
          {busy === "save" && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
          Save webhook
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!configured || busy !== null}
          onClick={() => run("test")}
          title={configured ? undefined : "Save a webhook first"}
        >
          {busy === "test" && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
          Send test notification
        </Button>
        {configured && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => run("remove")}
            className="text-muted-foreground"
          >
            <X className="mr-1 h-3 w-3" />
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * QQ is presented as genuinely unavailable rather than as a card that appears
 * to work. There is no official API for sending to a personal QQ account from
 * a third party; QQ官方机器人 targets QQ groups and channels and requires
 * developer registration and review on the Tencent QQ Open Platform.
 *
 * Marking it "Coming Soon" while it cannot deliver is the same class of
 * dishonesty as the placeholder Telegram card this replaces — so the reason is
 * stated instead.
 */
export function QQUnavailableNote() {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-zinc-500" aria-hidden />
        <span className="text-xs font-medium">QQ · Not yet available</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Tencent provides no official API for delivering messages to a personal QQ
        account from a third-party service. The supported route is a QQ group or
        channel bot registered on the QQ Open Platform, which requires developer
        registration and review before it can send anything. Until that
        registration exists, selecting QQ would not deliver alerts.
      </p>
    </div>
  );
}
