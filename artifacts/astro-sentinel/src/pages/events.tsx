import React, { useEffect, useState } from "react";
import { useSearchParams } from "wouter";
import { EventCard } from "@/components/EventCard";
import type { AstroEvent } from "@workspace/api-client-react/src/generated/api.schemas";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ChevronLeft, ChevronRight, FileText, Filter, Info } from "lucide-react";

/**
 * EventsPage — the Event Archive.
 *
 * TWO VIEWS, ONE URL.
 *
 *   /events              a card per messenger category, with ARCHIVE-WIDE counts
 *   /events?group=GRB    every event in that category, server-paginated
 *
 * The group lives in the query string so a drill-in is linkable, bookmarkable
 * and survives the back button — a scientist can send a colleague "all 270
 * gamma-ray bursts" rather than "click the third card".
 *
 * WHY THIS REPLACED THE PREVIOUS GROUPING
 * ───────────────────────────────────────
 * Grouping used to happen in this component, over whichever 24 events the
 * current page had fetched. The headings therefore read "8 on this page",
 * which is not a category count: it changed as you paged, and it could not
 * answer "how many gamma-ray bursts are in this archive?". Worse, two whole
 * categories were unreachable — the generated `eventType` enum is
 * [GRB, GW, FRB], so the 52 EP, 9 NU and 5 OTHER events could not be filtered
 * to at all.
 *
 * Both the counts and the membership now come from `/api/events/groups`, and
 * the drill-in asks the server for the group, so the number on the card and
 * the number of events behind it cannot disagree.
 */

// ─── Wire types ──────────────────────────────────────────────────────────────

interface GroupTypeBreakdown {
  eventType: string;
  count: number;
  withCirculars: number;
}

interface EventGroup {
  key: string;
  label: string;
  description: string;
  /** Stated when the group spans event_type labels the ingest paths disagree on. */
  note: string | null;
  memberTypes: string[];
  count: number;
  /** How many events in this group carry at least one human-written GCN Circular. */
  withCirculars: number;
  byType: GroupTypeBreakdown[];
}

interface GroupsResponse {
  totalEvents: number;
  groups: EventGroup[];
  /** event_type values belonging to no group. Should always be empty. */
  ungrouped: { eventType: string; count: number }[];
}

interface EventListResponse {
  events: AstroEvent[];
  total: number;
}

const ITEMS_PER_PAGE = 24;

/** Matches the badge colours EventCard/EventBadge already use per messenger. */
const TYPE_BADGE: Record<string, string> = {
  GRB: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  EP: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  GW: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  FRB: "bg-yellow-400/15 text-yellow-300 border-yellow-400/30",
  NU: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  OTHER: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

function badgeClass(t: string): string {
  return TYPE_BADGE[t] ?? TYPE_BADGE["OTHER"]!;
}

// ─── Category cards ──────────────────────────────────────────────────────────

function GroupCard({ group, onOpen }: { group: EventGroup; onOpen: () => void }) {
  const empty = group.count === 0;
  return (
    <button
      onClick={onOpen}
      disabled={empty}
      className={`text-left p-4 rounded-lg border bg-card transition-all ${
        empty
          ? "border-border/40 opacity-60 cursor-default"
          : "border-border hover:border-primary/50 hover:bg-accent/20 cursor-pointer"
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <h2 className="text-base font-bold text-foreground">{group.label}</h2>
        <div className="text-right shrink-0">
          <div className="font-mono text-2xl font-bold text-primary leading-none">
            {group.count.toLocaleString()}
          </div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
            {group.count === 1 ? "event" : "events"}
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed mb-3">{group.description}</p>

      {/* Composition. A group spanning several event_type labels shows them
          rather than merging them out of sight. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {group.byType.map((t) => (
          <span
            key={t.eventType}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${badgeClass(t.eventType)}`}
          >
            {t.eventType} {t.count.toLocaleString()}
          </span>
        ))}
      </div>

      {/* Human-written follow-up coverage — the thing that makes an event
          worth opening, so it belongs on the card. */}
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <FileText className="w-3 h-3 shrink-0" />
        {group.withCirculars.toLocaleString()} with GCN Circulars
      </div>

      {group.note && (
        <p className="mt-2 pt-2 border-t border-border/50 text-[10px] text-amber-500/80 leading-relaxed flex gap-1.5">
          <Info className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{group.note}</span>
        </p>
      )}
    </button>
  );
}

function GroupGrid({ onOpen }: { onOpen: (key: string) => void }) {
  const [data, setData] = useState<GroupsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/events/groups")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: GroupsResponse) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <p className="text-sm text-amber-500/80">
        The archive categories could not be loaded, so how many events this archive holds is
        unknown here.
      </p>
    );
  }

  if (!data) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-44 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {data.groups.map((g) => (
          <GroupCard key={g.key} group={g} onOpen={() => onOpen(g.key)} />
        ))}
      </div>

      {/* Should never render. If it does, those events exist in the database
          and are invisible in this archive — say so rather than hide it. */}
      {data.ungrouped.length > 0 && (
        <p className="text-xs text-amber-500">
          {data.ungrouped.reduce((a, u) => a + u.count, 0)} events have an event type belonging to
          no category ({data.ungrouped.map((u) => `${u.eventType}: ${u.count}`).join(", ")}) and are
          not reachable from this page.
        </p>
      )}
    </div>
  );
}

// ─── Drill-in ────────────────────────────────────────────────────────────────

function GroupEvents({ groupKey, onBack }: { groupKey: string; onBack: () => void }) {
  const [group, setGroup] = useState<EventGroup | null>(null);
  const [page, setPage] = useState(0);
  const [eventType, setEventType] = useState<string>("ALL");
  const [observatory, setObservatory] = useState<string>("ALL");
  const [data, setData] = useState<EventListResponse | null>(null);
  const [failed, setFailed] = useState(false);

  // The group's definition, for the header and the sub-filters.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/events/groups")
      .then((r) => r.json())
      .then((d: GroupsResponse) => {
        if (!cancelled) setGroup(d.groups.find((g) => g.key === groupKey) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [groupKey]);

  // Reset paging whenever the query changes, so page 5 of a 6-page result
  // cannot survive into a 1-page one and render as empty.
  useEffect(() => {
    setPage(0);
  }, [groupKey, eventType, observatory]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);

    const params = new URLSearchParams({
      group: groupKey,
      limit: String(ITEMS_PER_PAGE),
      offset: String(page * ITEMS_PER_PAGE),
    });
    if (eventType !== "ALL") params.set("eventType", eventType);
    if (observatory !== "ALL") params.set("observatory", observatory);

    fetch(`/api/events?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: EventListResponse) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [groupKey, page, eventType, observatory]);

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
  const filtered = eventType !== "ALL" || observatory !== "ALL";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-card shrink-0">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All categories
        </button>

        <div className="min-w-0">
          <h1 className="text-sm font-bold tracking-tight text-foreground truncate">
            {group?.label ?? groupKey}
          </h1>
          <p className="text-[10px] text-muted-foreground font-mono">
            {/* When a sub-filter is on, both numbers are shown so the filtered
                count is never mistaken for the size of the category. */}
            {filtered
              ? `${total.toLocaleString()} of ${(group?.count ?? 0).toLocaleString()} matching`
              : `${total.toLocaleString()} events in this archive`}
          </p>
        </div>

        <div className="flex items-center gap-2 ml-4">
          <Filter className="w-3.5 h-3.5 text-muted-foreground shrink-0" />

          {/* Only shown when the group actually spans more than one label —
              a single-type group would render a filter that does nothing. */}
          {group && group.memberTypes.length > 1 && (
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger className="h-7 text-xs w-[190px] bg-card border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All types in this group</SelectItem>
                {group.byType.map((t) => (
                  <SelectItem key={t.eventType} value={t.eventType}>
                    {t.eventType} ({t.count.toLocaleString()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={observatory} onValueChange={setObservatory}>
            <SelectTrigger className="h-7 text-xs w-[170px] bg-card border-border">
              <SelectValue placeholder="Observatory" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All observatories</SelectItem>
              <SelectItem value="Swift">Swift</SelectItem>
              <SelectItem value="Fermi">Fermi</SelectItem>
              <SelectItem value="Einstein Probe">Einstein Probe</SelectItem>
              <SelectItem value="SVOM">SVOM</SelectItem>
              <SelectItem value="INTEGRAL">INTEGRAL</SelectItem>
              <SelectItem value="Konus">Konus-Wind</SelectItem>
              <SelectItem value="CALET">CALET</SelectItem>
              <SelectItem value="MAXI">MAXI</SelectItem>
              <SelectItem value="LIGO">LIGO</SelectItem>
              <SelectItem value="Virgo">Virgo</SelectItem>
              <SelectItem value="KAGRA">KAGRA</SelectItem>
              <SelectItem value="CHIME">CHIME</SelectItem>
              <SelectItem value="IceCube">IceCube</SelectItem>
            </SelectContent>
          </Select>

          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setEventType("ALL");
                setObservatory("ALL");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Composition note, carried into the drill-in so the merge stays visible. */}
      {group?.note && (
        <p className="px-4 py-1.5 text-[10px] text-amber-500/80 border-b border-border/50 bg-amber-500/[0.03] flex gap-1.5 shrink-0">
          <Info className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{group.note}</span>
        </p>
      )}

      {/* Events */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4">
        {failed ? (
          <p className="text-sm text-amber-500/80">
            These events could not be loaded. This is a display failure — it is not a statement
            that the category is empty.
          </p>
        ) : !data ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : data.events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3">
            <p className="text-muted-foreground text-sm">
              {filtered
                ? "No events in this category match those filters."
                : "This category has no events in the archive."}
            </p>
            {filtered && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEventType("ALL");
                  setObservatory("ALL");
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {data.events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 py-2 border-t border-border shrink-0 bg-card">
          <Button
            variant="outline"
            size="icon"
            className="w-7 h-7"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </Button>
          <span className="text-xs font-mono text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="w-7 h-7"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function EventsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const groupKey = searchParams.get("group");

  if (groupKey) {
    return (
      <GroupEvents
        groupKey={groupKey}
        // Replaces rather than pushes, so "back" leaves the archive instead of
        // stepping through every category the user opened.
        onBack={() => setSearchParams({}, { replace: true })}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-card shrink-0">
        <div>
          <h1 className="text-sm font-bold tracking-tight text-foreground">Event Archive</h1>
          <p className="text-[10px] text-muted-foreground font-mono">
            Browse by messenger — counts are for the whole archive
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4">
        <GroupGrid onOpen={(key) => setSearchParams({ group: key })} />
      </div>
    </div>
  );
}
