import React from "react";
import { useSearchParams } from "wouter";
import { Activity, Bell, Database, Monitor, Moon, Settings as SettingsIcon, Sparkles, Sun } from "lucide-react";
import { NotificationPreferences } from "@/components/notifications/NotificationPreferences";
import { ArchiveTab, ExtractionTab, PipelineTab } from "@/components/settings/DiagnosticsTabs";
import { useTheme } from "@/lib/ThemeContext";
import { useScienceMode } from "@/lib/ScienceModeContext";

/**
 * SettingsPage — everything behind the gear.
 *
 * The tab lives in the query string (`/settings?tab=notifications`) so a
 * section is linkable and survives a refresh, matching how the Event Archive
 * carries its group. A modal was the alternative but cannot be linked, and the
 * notification form is far too tall for one.
 *
 * WHAT THIS PAGE IS NOT
 * ─────────────────────
 * It does not edit server secrets. LLM_API_KEY, SMTP_PASS and
 * GCN_CLIENT_SECRET stay in the server's environment: a settings screen that
 * edited them would have to ship them to the browser, and a credential that
 * reaches the browser is a leaked credential. Where a key matters, this page
 * reports whether one is configured — never its value.
 */

type TabKey = "display" | "notifications" | "pipeline" | "extraction" | "archive";

const TABS: readonly { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "display", label: "Display", icon: <Monitor className="w-3.5 h-3.5" /> },
  { key: "notifications", label: "Notifications", icon: <Bell className="w-3.5 h-3.5" /> },
  // Diagnostics. Each answers a question that previously required server logs
  // or psql to answer at all.
  { key: "pipeline", label: "Pipeline", icon: <Activity className="w-3.5 h-3.5" /> },
  { key: "extraction", label: "AI extraction", icon: <Sparkles className="w-3.5 h-3.5" /> },
  { key: "archive", label: "Archive", icon: <Database className="w-3.5 h-3.5" /> },
];

// ─── A labelled on/off row ───────────────────────────────────────────────────

function ToggleRow({
  title,
  description,
  checked,
  onChange,
  onIcon,
  offIcon,
  onLabel,
  offLabel,
}: {
  title: string;
  description: React.ReactNode;
  checked: boolean;
  onChange: () => void;
  onIcon?: React.ReactNode;
  offIcon?: React.ReactNode;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-border last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`shrink-0 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
          checked
            ? "border-primary/40 bg-primary/15 text-primary"
            : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
        }`}
      >
        {checked ? onIcon : offIcon}
        {checked ? onLabel : offLabel}
      </button>
    </div>
  );
}

// ─── Display ─────────────────────────────────────────────────────────────────

function DisplayTab() {
  const { isDark, toggleTheme } = useTheme();
  const { scienceMode, toggleScienceMode } = useScienceMode();

  return (
    <div className="max-w-3xl">
      <h2 className="text-sm font-bold text-foreground mb-1">Display</h2>
      <p className="text-xs text-muted-foreground mb-4">
        These are saved in this browser and now survive a reload — previously both reset every
        time the page was refreshed.
      </p>

      <div className="rounded-lg border border-border bg-card px-4">
        <ToggleRow
          title="Theme"
          description={
            <>
              Dark is the default for a control-room display. With no saved choice the app follows
              your operating system.
            </>
          }
          checked={isDark}
          onChange={toggleTheme}
          onIcon={<Moon className="w-3.5 h-3.5" />}
          offIcon={<Sun className="w-3.5 h-3.5" />}
          onLabel="Dark"
          offLabel="Light"
        />

        <ToggleRow
          title="Science mode"
          description={
            <>
              Reveals derived quantities with their methods and assumptions, validation
              diagnostics, provenance and system metadata. Off by default: this detail is
              meaningful if you asked for it and noise if you did not. It changes what is{" "}
              <em>shown</em>, never what was measured.
            </>
          }
          checked={scienceMode}
          onChange={toggleScienceMode}
          onLabel="On"
          offLabel="Off"
        />
      </div>

      <p className="mt-3 text-[10px] text-muted-foreground">
        Stored in this browser only — they do not follow your account to another machine.
      </p>
    </div>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

function NotificationsTab() {
  // NotificationPreferences is self-contained: it fetches its own state and
  // already hosts the WeCom panel, the delivery history and every selector.
  // It simply had no page to live on until now.
  return (
    <div className="max-w-4xl">
      <NotificationPreferences />
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const active: TabKey = TABS.some((t) => t.key === requested) ? (requested as TabKey) : "display";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card shrink-0">
        <SettingsIcon className="w-4 h-4 text-primary" />
        <div>
          <h1 className="text-sm font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-[10px] text-muted-foreground font-mono">
            Display, alert delivery, and system diagnostics
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Tab rail */}
        <nav className="w-48 shrink-0 border-r border-border p-2 space-y-0.5 overflow-y-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              // replace:true — flipping tabs should not stack history entries
              // that the back button then has to walk through.
              onClick={() => setSearchParams({ tab: t.key }, { replace: true })}
              className={`w-full flex items-center gap-2 rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
                active === t.key
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/30 border border-transparent"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4">
          {active === "display" && <DisplayTab />}
          {active === "notifications" && <NotificationsTab />}
          {active === "pipeline" && <PipelineTab />}
          {active === "extraction" && <ExtractionTab />}
          {active === "archive" && <ArchiveTab />}
        </div>
      </div>
    </div>
  );
}
