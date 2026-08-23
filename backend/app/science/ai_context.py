"""
ai_context.py
-------------
What the language model is allowed to see, and what it is allowed to say
(spec sections 40-43).

The spec's rule is that the model is an analytical assistant, NOT a source of
truth. Two things follow, and this module implements both.

1. THE INPUT MUST NOT LIE
─────────────────────────
The notification path previously built the model's context like this:

    snr:         Number(event["snr"]         ?? 0),
    far:         Number(event["far"]         ?? 0),
    ra:          Number(event["ra"]          ?? 0),
    dec:         Number(event["dec"]         ?? 0),
    errorRadius: Number(event["errorRadius"] ?? 0),

The prompt around it says "NO HALLUCINATION — you MUST NOT invent physics that
are not explicitly present in the provided metadata". But the metadata itself
was inventing: an event with no reported position was presented as sitting at
RA = 0, Dec = 0, and an event with no false-alarm rate was presented as having
FAR = 0 Hz — which does not mean "unknown", it means *no false alarms ever*,
i.e. infinite significance. A model obeying its instructions perfectly would
still write that the event was extraordinarily significant and precisely
located. The anti-hallucination guard was defeated by the input, not by the
model.

So context here carries only what is known, states every unknown explicitly as
UNKNOWN with the reason, and attaches provenance to every value. An absent
quantity is never rendered as a number.

2. THE OUTPUT MUST BE CHECKED
─────────────────────────────
Instructions are not a guarantee. `verify_output` screens generated text for
numeric claims that do not trace back to the context it was given. It is a
screen, not a proof: it can only catch numbers that were never supplied, and it
deliberately ignores the numbers that appear in ordinary prose. A finding here
means "a human should look at this", not "this is definitely false".
"""

from __future__ import annotations

import math
import re
from typing import Any

# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------

#: Quantities offered to the model, with their unit and a short description.
#: The description travels with the value so the model is never guessing what a
#: bare number means.
CONTEXT_FIELDS: dict[str, tuple[str, str]] = {
    "ra":                 ("deg", "Right ascension (J2000)"),
    "dec":                ("deg", "Declination (J2000)"),
    "errorRadius":        ("arcmin", "Localization radius"),
    "area90Deg2":         ("deg2", "90% credible sky area"),
    "snr":                ("", "Signal-to-noise ratio"),
    "far":                ("Hz", "False alarm rate"),
    "signalness":         ("", "P(astrophysical) — a probability, not an SNR"),
    "fluence":            ("erg/cm2", "Fluence in the instrument band"),
    "t90":                ("s", "T90 burst duration"),
    "dm":                 ("pc/cm3", "Dispersion measure"),
    "chirpMass":          ("Msun", "Chirp mass"),
    "luminosityDistance": ("Mpc", "Luminosity distance"),
    "redshift":           ("", "Redshift"),
    "epeak":              ("keV", "Spectral peak energy"),
}

#: Non-numeric descriptors that are safe to pass through verbatim.
IDENTITY_FIELDS = (
    "eventId", "eventType", "observatory", "detectionTime",
    "lifecycle", "alertType", "classificationTier", "fluenceBand",
    "errorRadiusContainment",
)


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(f) or math.isinf(f)) else f


def build_context(ev: dict[str, Any]) -> dict[str, Any]:
    """
    The model's view of an event: measured values with provenance, and an
    explicit inventory of what is not known.

    Absent quantities are never given a numeric placeholder. They appear in
    `unknown` so the model is told, in words, that they were not reported —
    which is information it can legitimately use ("no localization was
    reported, so no pointed follow-up can be recommended") rather than a
    number it will reason from incorrectly.
    """
    measured: dict[str, Any] = {}
    unknown: list[dict[str, str]] = []

    for field, (unit, label) in CONTEXT_FIELDS.items():
        v = _num(ev.get(field))
        if v is None:
            unknown.append({
                "field": field,
                "label": label,
                "reason": "not reported by the source notice",
            })
        else:
            measured[field] = {
                "value": v,
                "unit": unit,
                "label": label,
                "provenance": "OBSERVED",
            }

    identity = {f: ev.get(f) for f in IDENTITY_FIELDS if ev.get(f) is not None}

    # Derived quantities are offered separately and clearly marked, so the
    # model cannot present a modelled distance as a measured one.
    derived = _derived_summary(ev.get("derived"))

    validation = ev.get("validation") or {}
    quality = ev.get("quality") or {}

    return {
        "identity": identity,
        "measured": measured,
        "unknown": unknown,
        "derived": derived,
        "dataQuality": {
            "validationStatus": validation.get("status") if isinstance(validation, dict) else None,
            "qualityScore": quality.get("overall") if isinstance(quality, dict) else None,
            "note": (
                "This score describes how trustworthy the DATA is, not how "
                "scientifically interesting the event is."
            ),
        },
        "instructions": CONTEXT_RULES,
    }


def _derived_summary(derived: Any) -> dict[str, Any]:
    """Flatten the derived block to the values that actually exist."""
    out: dict[str, Any] = {}
    if not isinstance(derived, dict):
        return out
    for group, block in derived.items():
        if not isinstance(block, dict):
            continue
        for name, q in block.items():
            if not isinstance(q, dict) or "provenance" not in q:
                continue
            if q.get("value") is None:
                continue
            out[f"{group}.{name}"] = {
                "value": q["value"],
                "unit": q.get("unit"),
                "provenance": q.get("provenance", "DERIVED"),
                "method": q.get("method"),
                "assumptions": q.get("assumptions", []),
            }
    return out


#: Rules embedded in the context itself, so they survive prompt edits elsewhere.
CONTEXT_RULES = [
    "Every quantity you may cite appears under 'measured' or 'derived'. "
    "Anything listed under 'unknown' was NOT reported — do not estimate it, "
    "do not substitute a typical value, and do not describe it as zero.",
    "A value under 'derived' was computed by Transient Event Detection under the stated "
    "assumptions. Never present it as an observation.",
    "If a quantity you would need is unknown, say that it is unknown and what "
    "would be required to obtain it.",
    "Do not introduce numeric values that do not appear in this context.",
]


# ---------------------------------------------------------------------------
# Output verification
# ---------------------------------------------------------------------------

#: Numbers below this are ignored by the screen: they are overwhelmingly
#: sentence furniture ("1-2 candidates", "within 3 days") rather than quoted
#: measurements, and flagging them would bury the real findings.
SMALL_INTEGER_MAX = 10

#: Four-digit values in this range are almost always years.
YEAR_MIN, YEAR_MAX = 1800, 2200

#: Relative tolerance when matching a quoted number to a supplied one, to
#: allow for legitimate rounding ("12.34" quoted as "12.3").
MATCH_TOLERANCE = 0.02

_NUMBER_RE = re.compile(
    r"[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?"    # 1,234.5
    r"|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?"     # 12.34, 1e-7, .5
)


def _collect_numbers(obj: Any, out: set[float]) -> None:
    """Every number anywhere in the context, including inside strings."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        f = float(obj)
        if not (math.isnan(f) or math.isinf(f)):
            out.add(f)
        return
    if isinstance(obj, str):
        for m in _NUMBER_RE.findall(obj):
            try:
                out.add(float(m.replace(",", "")))
            except ValueError:
                continue
        return
    if isinstance(obj, dict):
        for v in obj.values():
            _collect_numbers(v, out)
        return
    if isinstance(obj, (list, tuple)):
        for v in obj:
            _collect_numbers(v, out)


def _supported(value: float, supplied: set[float]) -> bool:
    for s in supplied:
        if s == value:
            return True
        if s != 0 and abs(value - s) / abs(s) <= MATCH_TOLERANCE:
            return True
        # A rounded quotation of a supplied value, e.g. 1.0e-7 shown as 1e-7.
        if value != 0 and abs(s) > 0:
            try:
                if abs(math.log10(abs(value)) - math.log10(abs(s))) < 1e-9:
                    return True
            except ValueError:
                pass
    return False


def _ignorable(value: float) -> bool:
    if value != value or math.isinf(value):
        return True
    a = abs(value)
    if a == 0:
        return True
    if float(value).is_integer() and a <= SMALL_INTEGER_MAX:
        return True
    if float(value).is_integer() and YEAR_MIN <= a <= YEAR_MAX:
        return True
    return False


def verify_output(text: Any, context: dict[str, Any]) -> dict[str, Any]:
    """
    Screen generated text for numeric claims not traceable to the context.

    This is a SCREEN, not a proof. It catches the failure that matters most —
    a model stating a measurement nobody gave it — and cannot catch a wrong
    claim built from correct numbers. `unsupported` therefore means "a human
    should check this", not "this is false".

    Returns the findings plus a `trusted` flag that downstream code can use to
    decide whether to show the text, label it, or withhold it.
    """
    if not isinstance(text, str):
        try:
            import json
            text = json.dumps(text)
        except Exception:
            text = str(text)

    supplied: set[float] = set()
    _collect_numbers(context, supplied)

    unsupported: list[dict[str, Any]] = []
    seen: set[float] = set()
    for token in _NUMBER_RE.findall(text):
        try:
            value = float(token.replace(",", ""))
        except ValueError:
            continue
        if _ignorable(value) or value in seen:
            continue
        seen.add(value)
        if not _supported(value, supplied):
            unsupported.append({
                "value": value,
                "text": token,
                "message": (
                    f"The value {token} does not appear in the data supplied to "
                    "the model. It may be a fabricated measurement, an arithmetic "
                    "result, or general astrophysical background — it must be "
                    "checked before being read as a property of this event."
                ),
            })

    return {
        "checked": True,
        "unsupportedCount": len(unsupported),
        "unsupported": unsupported,
        "trusted": not unsupported,
        "note": (
            "Numeric screen only. It verifies that quoted numbers were supplied "
            "to the model; it cannot verify that the interpretation built from "
            "them is correct. AI output is an analytical aid, never a source of "
            "truth (spec sections 40-43)."
        ),
    }


__all__ = [
    "CONTEXT_FIELDS", "CONTEXT_RULES", "IDENTITY_FIELDS",
    "SMALL_INTEGER_MAX", "MATCH_TOLERANCE",
    "build_context", "verify_output",
]
