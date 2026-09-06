import { useState } from "react";
import type { AstroEvent } from "@workspace/api-client-react";
import { Info, Map, Activity, BarChart2, FileSearch } from "lucide-react";
import { BasicInfo } from "./BasicInfo";
import { SkyMap } from "./SkyMap";
import { Lightcurves } from "./Lightcurves";
import { FollowupReports } from "./FollowupReports";
import { SpectralFit } from "./SpectralFit";
import { DerivedParameters } from "./DerivedParameters";
import { SpectralComparison } from "./SpectralComparison";
import { EventTimeline } from "./EventTimeline";
import { PriorityBadge } from "./PriorityBadge";
import { ScientificSummary } from "./ScientificSummary";

interface Props {
  event: AstroEvent | null;
}

type Tab = "basic" | "skymap" | "lightcurves" | "spectral" | "followup";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "basic", label: "Basic Info", icon: <Info className="w-3 h-3" /> },
  { id: "skymap", label: "Skymap", icon: <Map className="w-3 h-3" /> },
  { id: "lightcurves", label: "Lightcurves", icon: <Activity className="w-3 h-3" /> },
  { id: "spectral", label: "Spectral Fit", icon: <BarChart2 className="w-3 h-3" /> },
  { id: "followup", label: "Follow-up", icon: <FileSearch className="w-3 h-3" /> },
];

export function SciencePanel({ event }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("basic");

  if (!event) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Info className="w-8 h-8 text-muted-foreground/30 mb-2" />
        <div className="text-muted-foreground text-sm">Select an event to view details</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="tabs relative z-10 flex shrink-0 border-b border-border bg-[hsl(var(--navbar-bg))] pointer-events-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              console.log("Tab clicked:", tab.id);
              setActiveTab(tab.id);
            }}
            className={`flex flex-col items-center gap-0.5 px-2 py-1.5 text-[9px] font-mono font-medium transition-all border-b-2 flex-1 ${activeTab === tab.id ? "border-primary text-primary bg-primary/5" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30"}`}
          >
            {tab.icon}
            <span className="whitespace-nowrap">{tab.label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => alert("click working")}
          className="px-2 py-1 text-[9px] font-mono border-l border-border text-muted-foreground hover:text-foreground hover:bg-accent/30"
        >
          Test
        </button>
      </div>

      <div className="relative z-0 flex-1 overflow-hidden flex flex-col p-3 gap-3">
        {/* Priority header is always visible */}
        <div className="flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Priority</span>
            <PriorityBadge event={event} />
          </div>
          <div className="text-[9px] font-mono text-muted-foreground">Latency {event.latencyUs} μs</div>
        </div>

        {activeTab === "basic" && (
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin pr-1 space-y-3">
            <ScientificSummary event={event} />
            <EventTimeline event={event} />
            <DerivedParameters event={event} />

            <div className="flex items-center gap-2 rounded border border-border bg-card px-3 py-2 text-[9px] font-mono text-muted-foreground">
              <span>Pipeline</span>
              <span className="text-foreground">PENDING</span>
            </div>

            <div className="rounded border border-border bg-card">
              <BasicInfo event={event} />
            </div>
          </div>
        )}

        {activeTab === "skymap" && (
          <div className="flex-1 min-h-0 rounded border border-border bg-card overflow-hidden">
            <SkyMap events={[event]} selectedEvent={event} />
          </div>
        )}

        {activeTab === "lightcurves" && (
          <div className="flex-1 min-h-0 rounded border border-border bg-card overflow-hidden">
            <Lightcurves event={event} />
          </div>
        )}

        {activeTab === "spectral" && (
          <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
            <div className="flex-1 min-h-0 rounded border border-border bg-card overflow-hidden">
              <SpectralFit event={event} />
            </div>
            <div className="flex-1 min-h-0 rounded border border-border bg-card overflow-hidden">
              <SpectralComparison event={event} />
            </div>
          </div>
        )}

        {activeTab === "followup" && (
          <div className="flex-1 min-h-0 rounded border border-border bg-card overflow-hidden">
            <FollowupReports event={event} />
          </div>
        )}
      </div>
    </div>
  );
}
