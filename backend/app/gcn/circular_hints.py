"""
circular_hints.py
------------------
Deterministic, offline content triage for GCN Circulars, using the
`astro-colibri-circular-parser` package's regex hints module.

SCOPE — WHY ONLY `build_regexp_hints`
--------------------------------------
The package's full pipeline, `circular_parser.parse_circular()`, is:

    regex hints -> event resolution (network) -> LLM extraction -> payload

Event resolution defaults to calling the public Astro-COLIBRI API, and the
LLM step *requires* a configured provider (OpenAI by default) — calling
`parse_circular()` with no provider raises `ValueError`
(circular_parser/pipeline.py). Neither belongs here:

  * Event association is this repository's Node api-server's job, done
    deterministically against `core.events` (see association.py's TS
    counterpart, `circulars/association.ts`). A second, independent
    association decision made in Python — using astro-colibri.science's own
    event catalogue rather than ours — could disagree with it.
  * The LLM extraction step is a deliberate later phase (Priority #8), once
    a provider is chosen. Pulling it in now would silently spend an OpenAI
    key (or fail loudly with none configured) on every circular.

So this module calls only `build_regexp_hints(subject, body)`: pure regex
over text already in hand, no network call, no API key, no event-table
access. It answers "what kind of report is this, roughly?" — optical
follow-up, redshift report, retraction, which instruments are named — as
hints for a human or a later LLM pass, never as concluded facts. It does
NOT extract RA/Dec/error-radius/etc.; that numeric extraction is a
different, existing regex pipeline (`app/ingest/circulars.py`), used only
for the offline archive backfill.

Never raises: a circular that fails to parse for hints must still reach the
event table and be broadcast. See `build_hints_safe`.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

try:
    from circular_parser import build_regexp_hints as _build_regexp_hints

    _IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - defensive, e.g. package not installed
    _build_regexp_hints = None
    _IMPORT_ERROR = exc


def hints_available() -> bool:
    """Whether the parser package imported successfully."""
    return _build_regexp_hints is not None


def build_hints_safe(subject: str, body: str) -> Optional[Dict[str, Any]]:
    """
    Return `build_regexp_hints(subject, body)`, or None if unavailable or the
    call fails for any reason.

    Deliberately swallows every exception: hints are a supplementary,
    best-effort annotation on top of the circular, never a precondition for
    storing or broadcasting it. A circular the hints step chokes on (an
    unexpected encoding, a pathological body) must still go through.
    """
    if _build_regexp_hints is None:
        logger.warning(
            "[circular_hints] astro-colibri-circular-parser not importable "
            "(%s); circulars will be broadcast without regexp_hints.",
            _IMPORT_ERROR,
        )
        return None

    try:
        return _build_regexp_hints(subject or "", body or "")
    except Exception as exc:
        logger.warning("[circular_hints] build_regexp_hints failed: %s", exc)
        return None
