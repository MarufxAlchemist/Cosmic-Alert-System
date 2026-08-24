import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EventBadge } from "@/components/EventBadge";
import { FileText, Radio } from "lucide-react";

/**
 * SearchPalette — one box across events and GCN circulars.
 *
 * Opened by the navbar magnifier or Ctrl/Cmd-K. Backed by GET /api/search,
 * which runs an identifier search and a weighted full-text search together:
 * "260310" finds the burst, "kilonova" finds the circulars discussing one.
 *
 * FILTERING IS SERVER-SIDE
 * ────────────────────────
 * `shouldFilter={false}` is essential. cmdk filters its own children by
 * default, so it would take results the server already matched and hide the
 * ones whose visible label happens not to contain the query — a circular
 * matched on its BODY has a subject that need not mention the word at all, and
 * would silently vanish.
 *
 * SNIPPETS ARE NOT HTML
 * ─────────────────────
 * The server marks hit terms with [[hl]]...[[/hl]] rather than <mark>, because
 * ts_headline does not escape the text around them: emitting HTML would mean
 * rendering markup built from untrusted circular bodies. This component splits on that
 * marker and renders plain text nodes, so a body containing "<script>" is
 * displayed, never executed.
 */

// ─── Wire types ──────────────────────────────────────────────────────────────

interface EventHit {
  id: string;
  eventId: string;
  eventType: string;
  observatory: string;
  detectionTime: string;
  circularCount: number;
}

interface CircularHit {
  id: string;
  circularId: number;
  version: number;
  subject: string;
  submitter: string;
  createdOn: string;
  eventPk: string | null;
  eventId: string | null;
  snippet: string | null;
}

interface SearchResponse {
  query: string;
  events: EventHit[];
  circulars: CircularHit[];
  counts: { events: number; circulars: number; capped?: boolean; ceiling?: number };
  note: string | null;
}

const HL_START = "[[hl]]";
const HL_STOP = "[[/hl]]";

/**
 * Render a server snippet, highlighting the marked terms.
 *
 * Returns React text nodes, never markup — see the component header. A stray
 * sentinel in the source text can at worst misplace a highlight; it cannot
 * inject anything.
 */
function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const start = rest.indexOf(HL_START);
    if (start === -1) {
      parts.push(rest.replace(/\s+/g, " "));
      break;
    }
    if (start > 0) parts.push(rest.slice(0, start).replace(/\s+/g, " "));

    // Advance by the sentinel's LENGTH, not by 1. These were single control
    // characters at first, so `start + 1` happened to work; with a multi-character
    // marker it left the tail of the sentinel in the output and the UI rendered
    // "[hl]]Kilonova [/hl]]".
    const after = rest.slice(start + HL_START.length);
    const stop = after.indexOf(HL_STOP);
    if (stop === -1) {
      parts.push(after.replace(/\s+/g, " "));
      break;
    }
    parts.push(
      <mark key={key++} className="rounded bg-primary/25 px-0.5 text-foreground">
        {after.slice(0, stop)}
      </mark>,
    );
    rest = after.slice(stop + HL_STOP.length);
  }

  return <span className="text-[10px] text-muted-foreground leading-snug">{parts}</span>;
}

function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** "1000+" once the server stopped counting, rather than a wrong exact number. */
function countLabel(n: number, counts: SearchResponse["counts"]): string {
  const ceiling = counts.ceiling ?? Number.POSITIVE_INFINITY;
  return n >= ceiling ? `${ceiling}+` : String(n);
}

// ─── Palette ─────────────────────────────────────────────────────────────────

export function SearchPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const [input, setInput] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Debounced so a query does not fire per keystroke. The corpus's most common
  // words match tens of thousands of circulars and take the better part of a
  // second to rank; without this, typing "observation" would queue eleven of
  // those and render them out of order.
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(0);

  useEffect(() => {
    clearTimeout(debounce.current);
    const q = input.trim();

    if (q.length < 2) {
      setData(null);
      setLoading(false);
      setFailed(false);
      return;
    }

    setLoading(true);
    debounce.current = setTimeout(() => {
      // Sequence guard: a slow common-word query must not overwrite the results
      // of a faster one typed after it.
      const seq = ++latest.current;
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d: SearchResponse) => {
          if (seq !== latest.current) return;
          setData(d);
          setFailed(false);
        })
        .catch(() => {
          if (seq !== latest.current) return;
          setFailed(true);
        })
        .finally(() => {
          if (seq === latest.current) setLoading(false);
        });
    }, 300);

    return () => clearTimeout(debounce.current);
  }, [input]);

  const go = useCallback(
    (href: string) => {
      onOpenChange(false);
      setInput("");
      setData(null);
      navigate(href);
    },
    [navigate, onOpenChange],
  );

  const events = data?.events ?? [];
  const circulars = data?.circulars ?? [];
  const hasQuery = input.trim().length >= 2;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl">
        {/* Radix requires a title on every dialog, and a screen reader
            announces nothing useful without one. Visually hidden because the
            input's placeholder already labels the box for sighted users. */}
        <DialogTitle className="sr-only">Search events and GCN circulars</DialogTitle>

        {/* shouldFilter={false}: the server already decided what matched. */}
        <Command shouldFilter={false} className="[&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2">
          <CommandInput
            placeholder="Search events and circulars — try GRB260310A, 44112, or kilonova"
            value={input}
            onValueChange={setInput}
          />

          <CommandList className="max-h-[60vh]">
            {!hasQuery && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                Type at least 2 characters.
                <div className="mt-2 text-[10px]">
                  Event identifiers and observatories match as substrings; circulars are also
                  searched by their full text, so <span className="font-mono">kilonova</span> finds{" "}
                  <span className="font-mono">kilonovae</span>.
                </div>
              </div>
            )}

            {hasQuery && failed && (
              <div className="px-4 py-6 text-center text-xs text-amber-500/90">
                The search request failed. That is a lookup failure — it does not mean the archive
                holds nothing for this query.
              </div>
            )}

            {hasQuery && !failed && loading && !data && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground animate-pulse">
                Searching…
              </div>
            )}

            {hasQuery && !failed && data && events.length === 0 && circulars.length === 0 && (
              <CommandEmpty>Nothing matched “{data.query}”.</CommandEmpty>
            )}

            {events.length > 0 && data && (
              <CommandGroup
                heading={`Events — showing ${events.length} of ${countLabel(data.counts.events, data.counts)}`}
              >
                {events.map((e) => (
                  <CommandItem
                    key={e.id}
                    value={`event-${e.id}`}
                    onSelect={() => go(`/events/${e.id}`)}
                    className="gap-2"
                  >
                    <Radio className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <EventBadge type={e.eventType as never} />
                        <span className="font-mono text-xs font-bold truncate">{e.eventId}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {e.observatory} · {utcDay(e.detectionTime)}
                        {e.circularCount > 0 &&
                          ` · ${e.circularCount} circular${e.circularCount === 1 ? "" : "s"}`}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {circulars.length > 0 && data && (
              <CommandGroup
                heading={`GCN Circulars — showing ${circulars.length} of ${countLabel(data.counts.circulars, data.counts)}`}
              >
                {circulars.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`circular-${c.id}`}
                    // A circular is read on its event's page, where the whole
                    // history sits in order. An unattached one has no event to
                    // open, so it routes to the circular itself.
                    onSelect={() =>
                      go(c.eventPk ? `/events/${c.eventPk}` : `/circulars/${c.circularId}`)
                    }
                    className="gap-2 items-start"
                  >
                    <FileText className="w-3.5 h-3.5 shrink-0 mt-0.5 text-violet-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[10px] font-bold text-primary">
                          #{c.circularId}
                        </span>
                        {c.version > 1 && (
                          <span className="text-[9px] font-mono px-1 rounded border border-amber-500/40 text-amber-400">
                            v{c.version}
                          </span>
                        )}
                        {c.eventId ? (
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {c.eventId}
                          </span>
                        ) : (
                          <span className="text-[10px] text-amber-500/80">not attached</span>
                        )}
                      </div>
                      <div className="text-xs text-foreground/90 truncate">{c.subject}</div>
                      {c.snippet && <Snippet text={c.snippet} />}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ctrl/Cmd-K anywhere.
 *
 * Returned as a hook so the navbar owns the open state, and the shortcut and
 * the icon cannot disagree about whether the palette is showing.
 */
export function useSearchPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { open, setOpen };
}
