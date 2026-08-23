"""
normalizer.py
-------------
Translates raw GCN Kafka JSON payloads into the normalized AstroEvent
dict that the frontend expects.  Each instrument emits a different schema;
this module contains one parser per topic family.

All parsers return a dict that matches the camelCase AstroEvent TypeScript
type.  Fields that cannot be derived from a given payload are set to
sensible defaults so the frontend never crashes on a missing key.
"""

import math
import uuid
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Optional Astropy import — used for real Sun/Moon angular separation.
# Falls back gracefully if astropy is not installed.
# ---------------------------------------------------------------------------
try:
    from astropy.coordinates import GCRS, SkyCoord, get_body
    from astropy.time import Time
    import astropy.units as u
    # NOTE: NonRotationTransformationWarning is deliberately NOT suppressed.
    # It previously masked a real defect — see _sun_moon_distance(), where
    # separations were being taken between mismatched ICRS/GCRS origins and
    # were wrong by up to ~150°. If that warning starts firing again, a frame
    # mismatch has been reintroduced; fix the frames rather than silencing it.
    _ASTROPY_AVAILABLE = True
except ImportError:  # pragma: no cover
    _ASTROPY_AVAILABLE = False

from app.gcn import voevent
from app.gcn.topics import get_topic_meta

# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def normalize(topic: str, raw: dict[str, Any]) -> dict[str, Any]:
    """
    Return a camelCase AstroEvent-compatible dict from a raw GCN payload.
    Falls back to _generic() if no dedicated parser exists for the topic.
    """
    parsers = {
        "gcn.notices.chime.frb":                  _chime_frb,
        "gcn.notices.einstein_probe.wxt.alert":   _einstein_probe,
        "gcn.notices.icecube.lvk_nu_track_search":       _icecube,
        "gcn.notices.icecube.gold_bronze_track_alerts":  _icecube,
        "igwn.gwalert":                           _igwn,
        "gcn.notices.swift.bat.guano":            _swift_bat,
    }

    # VOEvent XML streams (Fermi GBM, SVOM) share one parser but need the
    # topic to resolve identity prefix and lifecycle stage.
    if raw.get("_voevent_doc"):
        parser = lambda r, et: _voevent_grb(r, et, topic)  # noqa: E731
    else:
        parser = parsers.get(topic, _generic)
    meta   = get_topic_meta(topic)

    base = {
        "id":           str(uuid.uuid4()),
        "eventType":    meta.event_type,
        "observatory":  meta.observatory,
        "topic":        topic,
        # Fields every parser must fill. These defaults apply when a parser
        # raises before setting them — i.e. exactly when nothing is known.
        # They are None (UNKNOWN), never 0.0: a parse failure must not emit a
        # normalized event that claims to sit at (0, 0) with SNR 0.
        "eventId":      _make_event_id(meta.event_type),
        "detectionTime": _now_iso(),
        "ra":            None,
        "dec":           None,
        "errorRadius":   None,
        # What the localization radius actually means (spec section 23). None
        # = the source did not state it, which is the honest default: a
        # 1-sigma radius and a 90% containment radius differ by 2.15x, so
        # assuming one would silently resize every error circle.
        "errorRadiusContainment": None,
        # Credible-region areas in deg2, kept as their own quantity. They are
        # NOT a localization radius: an area is not an angle.
        "area50Deg2":    None,
        "area90Deg2":    None,
        "snr":           None,
        "far":           None,
        "latencyUs":     None,
        "galLon":        None,
        "galLat":        None,
        "sunDistance":   None,
        "moonDistance":  None,
        "fluence":       None,
        "dm":            None,
        # IceCube signalness — a 0-1 probability that the event is
        # astrophysical. NOT an SNR; kept in its own field so the two are
        # never conflated again.
        "signalness":    None,
        # FITS sky-localization URL — populated only for GW events (IGWN).
        # None means "no skymap URL present in this payload".
        "fitsUrl":       None,
        "raw":           raw,
    }

    try:
        parsed = parser(raw, meta.event_type)
        base.update(parsed)
    except Exception as exc:
        # Keep defaults; log but never crash the listener
        print(f"[normalizer] Failed to parse {topic}: {exc}")

    # ── Scientific validation (synchronous critical path, spec section 41) ──
    # Deterministic and cheap: pure range/consistency checks, no I/O and no
    # ephemeris work. Attaches diagnostics + a transparent quality score.
    #
    # Wrapped defensively: validation is an observability feature and must
    # never be able to drop an alert (spec section 48).
    try:
        from app.science import validate_event, score_quality

        report = validate_event(base)
        base["validation"] = report.to_dict()
        base["quality"] = score_quality(base, report)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[normalizer] Validation failed for {topic}: {exc}")
        base["validation"] = {
            "status": "UNKNOWN",
            "worstLevel": None,
            "counts": {},
            "diagnostics": [],
            "error": f"{type(exc).__name__}: {exc}",
        }
        base["quality"] = None

    # ── Derived scientific quantities (spec sections 19-24, 33-34) ──────────
    # Rest-frame values, cosmological distances, band-limited E_iso, credible-
    # region geometry and observability. Every entry carries its method,
    # assumptions and provenance, and an underivable quantity is recorded as
    # UNKNOWN-with-a-reason rather than omitted or guessed.
    #
    # Wrapped separately from validation so a failure in either cannot take the
    # other down, and neither can drop an alert.
    try:
        from app.science.derivations import derive_all

        base["derived"] = derive_all(base)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[normalizer] Derivation failed for {topic}: {exc}")
        base["derived"] = {"error": f"{type(exc).__name__}: {exc}"}

    # ── Research interest (spec section 44) ─────────────────────────────────
    # Deterministic, cheap and rule-based, so it belongs on the synchronous
    # path alongside validation (spec section 41). It answers a different
    # question from the quality score — is this worth STUDYING, rather than is
    # the data trustworthy — and the two are never merged.
    try:
        from app.science.interest import score_interest

        base["researchInterest"] = score_interest(base)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[normalizer] Interest scoring failed for {topic}: {exc}")
        base["researchInterest"] = None

    return base


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _make_event_id(event_type: str) -> str:
    """Synthetic ID used when the payload has no canonical name."""
    now = datetime.now(timezone.utc)
    return f"{event_type}{now.strftime('%Y%m%dT%H%M%S')}Z"


def _safe_float(val: Any, default: float = 0.0) -> float:
    """Coerce to float with a numeric default.

    Only for values where a numeric default is genuinely correct. For SOURCE
    measurements use _measured() instead — a missing measurement must not
    become 0.0.
    """
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _measured(val: Any) -> float | None:
    """
    Coerce a SOURCE-reported measurement to float, or None if absent/invalid.

    None means UNKNOWN: the upstream notice did not report this quantity.

    This exists because coercing a missing measurement to 0.0 produces values
    that are indistinguishable from real ones — a missing position became the
    valid coordinate (0, 0), a missing SNR became a real-looking 0. Never
    substitute a numeric placeholder for an absent measurement.
    """
    if val is None:
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _first_scalar(*candidates: Any) -> str | None:
    """
    First usable scalar, unwrapping one level of list.

    The GCN v4 core schemas declare `id` and `event_name` as ARRAYS. Formatting
    one straight into a string produced identifiers like "EP['11916655551']".
    """
    for c in candidates:
        if c is None:
            continue
        if isinstance(c, (list, tuple)):
            c = next((x for x in c if x is not None and x != ""), None)
            if c is None:
                continue
        s = str(c).strip()
        if s:
            return s
    return None


def _ellipse_major(val: Any) -> float | None:
    """
    Localization radius in the source's units, from a scalar or an ellipse.

    GCN v4 allows `ra_dec_error` to be either a circle radius or an array of
    up to three values, ORDERED: [semi-major, semi-minor, position-angle].

    The semi-major axis is element 0 — it is emphatically NOT max(). The third
    element is an ANGLE ON THE SKY measured North through East, not a length:
    for [0.08, 0.04, 30] the maximum is the 30 deg position angle, which would
    be stored as a 1800 arcmin localization instead of 4.8 arcmin, inflating
    the search region by 375x. Position is by order, never by magnitude.
    """
    if isinstance(val, (list, tuple)):
        for v in val[:1]:
            return _positive_measured(v)
        return None
    return _positive_measured(val)


def _containment_key(prob: Any) -> str | None:
    """
    Map a containment probability onto a CONTAINMENT_CONVENTIONS key.

    Only exact, recognised fractions are mapped. An unrecognised probability
    returns None — reported as unstated rather than snapped to the nearest
    convention, because a radius compared under the wrong containment is
    rescaled by up to 2.15x.
    """
    p = _measured(prob)
    if p is None:
        # Schema default for the GCN v4 notice family.
        p = 0.9
    return {0.5: "50_2D", 0.68: "68_2D", 0.6827: "68_2D",
            0.9: "90_2D", 0.95: "95_2D"}.get(round(p, 4))


def _alias(raw: dict, *keys: str) -> Any:
    """
    First present, non-empty value among several candidate key spellings.

    GCN payloads name the same quantity differently across schemas and schema
    versions (ra_obj/ra, err_rad/loc_error, width_ms/width). The existing
    parsers already handle this with nested raw.get() defaults; this makes the
    pattern readable when there are more than two candidates.

    NOTE ON THE ALIAS LISTS BELOW
    ─────────────────────────────
    They are best-effort and deliberately generous. A key that never appears in
    a real payload simply never matches and the field stays UNKNOWN — the cost
    of a wrong guess is zero, whereas a field that IS present and unlisted is
    silently discarded, which is what this change exists to stop. The lists
    should still be confirmed against live traffic per topic.
    """
    for k in keys:
        if k in raw:
            v = raw[k]
            if v is not None and v != "":
                return v
    return None


def _measured_alias(raw: dict, *keys: str) -> float | None:
    """_measured() over a list of candidate keys."""
    return _measured(_alias(raw, *keys))


def _positive_alias(raw: dict, *keys: str) -> float | None:
    """_positive_measured() over a list of candidate keys."""
    return _positive_measured(_alias(raw, *keys))


def _text_alias(raw: dict, *keys: str) -> str | None:
    """
    Non-empty string over a list of candidate keys.

    Used for qualifiers that are NOT numbers and must never be coerced into
    one — the fluence energy band, the neutrino energy unit, the event
    topology. A missing qualifier stays None so the science layer can refuse
    to derive rather than assume a default.
    """
    v = _alias(raw, *keys)
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _positive_measured(val: Any) -> float | None:
    """
    _measured(), additionally rejecting non-positive values for quantities
    where zero or negative is physically meaningless.

    Applies to SNR (a detection significance), FAR (a rate — exactly 0 Hz
    would mean "never a false alarm") and localization radius (0 would be a
    perfectly known position).
    """
    f = _measured(val)
    if f is None or f <= 0.0:
        return None
    return f


def _valid_radec(ra: Any, dec: Any) -> bool:
    """True only for finite coordinates inside physical ranges."""
    try:
        ra_f, dec_f = float(ra), float(dec)
    except (TypeError, ValueError):
        return False
    if math.isnan(ra_f) or math.isnan(dec_f):
        return False
    if math.isinf(ra_f) or math.isinf(dec_f):
        return False
    return 0.0 <= ra_f < 360.0 and -90.0 <= dec_f <= 90.0


def _ra_dec_to_gal(ra: float, dec: float) -> tuple[float | None, float | None]:
    """
    DERIVED: equatorial (ICRS) → Galactic coordinate transform via Astropy.

    Returns (None, None) — meaning UNKNOWN — if Astropy is unavailable or the
    input coordinates are not physically valid. Never returns a fabricated
    value: a wrong Galactic coordinate is worse than an absent one.

    Provenance: ICRS → Galactic, astropy.coordinates.SkyCoord.

    Parameters
    ----------
    ra, dec : float
        ICRS coordinates in decimal degrees.

    Returns
    -------
    (l, b) : tuple[float | None, float | None]
        Galactic longitude/latitude in degrees, or (None, None) if UNKNOWN.
    """
    if not _ASTROPY_AVAILABLE or not _valid_radec(ra, dec):
        return None, None
    try:
        gal = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs").galactic
        return round(float(gal.l.deg) % 360.0, 4), round(float(gal.b.deg), 4)
    except Exception as exc:  # pragma: no cover
        print(f"[normalizer] galactic transform failed (ra={ra}, dec={dec}): {exc}")
        return None, None


def _sun_moon_distance(
    ra: float,
    dec: float,
    detection_time_iso: str | None = None,
) -> tuple[float | None, float | None]:
    """
    DERIVED: angular separation (degrees) between the event sky position and
    the Sun / Moon at the moment of detection.

    Uses Astropy's built-in ephemeris via get_body().

    Returns (None, None) — meaning UNKNOWN — if:
      * Astropy is not installed
      * detection_time_iso is None or unparseable
      * the coordinates are not physically valid
      * the ephemeris calculation raises for any reason

    This function MUST NOT invent a separation. It previously returned
    90.0/90.0 on failure, which is indistinguishable from a genuine ~90°
    separation once persisted and silently corrupted the archive.

    Provenance: astropy.coordinates.get_body(), evaluated at the event's
    detection time in UTC.

    Parameters
    ----------
    ra : float
        Right Ascension in decimal degrees (ICRS / J2000).
    dec : float
        Declination in decimal degrees (ICRS / J2000).
    detection_time_iso : str | None
        ISO-8601 UTC timestamp of the event (e.g. "2026-06-07T12:34:56Z").

    Returns
    -------
    (sun_deg, moon_deg) : tuple[float | None, float | None]
        Angular separations in degrees rounded to 4 dp, or (None, None)
        if the quantity is UNKNOWN.
    """
    if not _ASTROPY_AVAILABLE or not detection_time_iso:
        return None, None
    if not _valid_radec(ra, dec):
        return None, None
    try:
        # Astropy Time(iso) requires the string without a tz offset.
        # Strip trailing Z or +00:00 and pass scale="utc" explicitly.
        ts = detection_time_iso.strip()
        if ts.endswith("Z"):
            ts = ts[:-1]
        elif ts.endswith("+00:00"):
            ts = ts[:-6]
        t = Time(ts, format="isot", scale="utc")
        event_coord = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")

        # get_body() returns a GEOCENTRIC (GCRS) position carrying a finite
        # distance (the Sun is ~1 AU away). Taking .separation() directly
        # between a distance-less ICRS (barycentric) coordinate and that GCRS
        # coordinate forces Astropy to reconcile two different origins, which
        # for a nearby solar-system body swings the apparent direction by up
        # to ~150° and yields a physically meaningless angle.
        #
        # The event position must be transformed into GCRS at the observation
        # epoch first, so both coordinates share an origin and epoch.
        #
        # This is what the previously-suppressed NonRotationTransformationWarning
        # was reporting. Do not silence that warning again.
        event_gcrs = event_coord.transform_to(GCRS(obstime=t))
        sun_sep  = round(float(event_gcrs.separation(get_body("sun",  t)).deg), 4)
        moon_sep = round(float(event_gcrs.separation(get_body("moon", t)).deg), 4)
        return sun_sep, moon_sep
    except Exception as exc:  # pragma: no cover
        print(f"[normalizer] sun/moon separation failed ({detection_time_iso}): {exc}")
        return None, None


def _latency_us(detection_time_iso: str) -> int | None:
    """
    Microseconds from detection_time to now.

    Returns None when the detection time cannot be parsed: without it there is
    no latency to report, and 0 would claim the notice arrived at the instant
    of detection. Absence is never zero.
    """
    try:
        dt = datetime.fromisoformat(detection_time_iso.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        return max(0, int((now - dt).total_seconds() * 1_000_000))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Per-topic parsers
# ---------------------------------------------------------------------------

#: Fermi GBM lifecycle: the same trigger is re-issued as its position is
#: refined. Mapped onto the existing lifecycle vocabulary so the revision
#: machinery treats later notices as updates to the same event.
_GBM_LIFECYCLE = {
    "gcn.classic.voevent.FERMI_GBM_ALERT":   "preliminary",
    "gcn.classic.voevent.FERMI_GBM_FLT_POS": "preliminary",
    "gcn.classic.voevent.FERMI_GBM_GND_POS": "update",
    "gcn.classic.voevent.FERMI_GBM_FIN_POS": "confirmed",
}


def _voevent_grb(raw: dict, event_type: str, topic: str = "") -> dict:
    """
    Parser for the VOEvent XML GRB streams (Fermi GBM, SVOM).

    voevent.parse() has already flattened the document; this maps it onto the
    normalized event shape.

    UNIT CONVERSION — the reason this is not a one-liner
    ───────────────────────────────────────────────────
    VOEvent reports Error2Radius in the unit declared on Position2D, which is
    DEGREES in every GCN stream observed. `errorRadius` is ARCMIN everywhere
    in this codebase (see derivations.py, which divides by 60 to get degrees).
    A Fermi flight position of 27.97 deg stored unconverted would claim a
    27.97 arcmin localization — 60x better than the notice reported, and well
    inside the range where the UI would present it as a followable position.
    """
    doc = raw.get("_voevent_doc") or {}
    params = doc.get("params") or {}

    ra = _measured(doc.get("ra"))
    dec = _measured(doc.get("dec"))
    det_time = doc.get("iso_time") or _now_iso()
    if det_time and not det_time.endswith("Z") and "+" not in det_time:
        det_time = det_time + "Z"

    # deg -> arcmin. Only when the source actually declared degrees; an
    # unexpected unit is refused rather than converted by assumption.
    err_deg = _positive_measured(doc.get("error_radius"))
    unit = (doc.get("position_unit") or "deg").lower()
    if err_deg is not None and unit in ("deg", "degree", "degrees"):
        err_arcmin = err_deg * 60.0
    else:
        err_arcmin = None

    gal_lon, gal_lat = _ra_dec_to_gal(ra, dec)
    sun_d, moon_d = _sun_moon_distance(ra, dec, det_time)

    # Identity: TrigID is the stable per-burst key across ALERT/FLT/GND/FIN,
    # so all four notices for one burst collapse onto a single event and are
    # recorded as revisions rather than four separate bursts.
    trig = params.get("TrigID") or params.get("Trigger_ID") or ""
    trig = str(trig).strip()
    if trig in ("", "0x00000000"):
        trig = ""
    prefix = "SVOM" if "svom" in topic else "GRB"
    event_id = f"{prefix}{trig}" if trig else (
        voevent.ivorn_tail(doc.get("ivorn", "")) or _make_event_id(event_type))

    return {
        "eventId":       event_id,
        "detectionTime": det_time,
        "ra":            ra,
        "dec":           dec,
        "errorRadius":   err_arcmin,
        # Fermi states the flight/ground significance in sigma (ucd=stat.snr).
        "snr":           _positive_measured(params.get("Data_Signif")),
        "far":           None,
        "latencyUs":     _latency_us(det_time),
        "galLon":        gal_lon,
        "galLat":        gal_lat,
        "sunDistance":   sun_d,
        "moonDistance":  moon_d,
        "fluence":       None,
        "dm":            None,
        "lifecycle":     _GBM_LIFECYCLE.get(topic),
        # Trig_Timescale is the trigger integration window, NOT T90. Mapping it
        # to t90 would report the detector's timescale as the burst duration.
        **_grb_spectral_fields(params),
    }


def _grb_spectral_fields(raw: dict) -> dict:
    """
    Temporal and spectral quantities the GRB rules consume, plus their errors.

    Shared by every GRB-producing parser so the alias lists exist once.

    WHAT THIS DOES NOT DO
    ─────────────────────
    It does not supply `fluenceBand` from the instrument's nominal bandpass.
    Stamping "15-150 keV" onto a Swift fluence because Swift-BAT nominally
    covers that range would be an assumption of exactly the kind the
    containment-convention rules exist to prevent: the band is only known if
    the notice states it, and a fluence integrated over a different interval
    would silently produce a wrong E_iso. Unstated stays UNKNOWN, and
    grb.validate() then declines to derive the isotropic energy and says why.

    Nor does it supply `eisoBolometric`. That needs a k-correction from a
    fitted spectral model (Zhang eq. 2.45); no notice carries one.
    """
    return {
        # T90 > 0 by definition — a non-positive duration is not a measurement.
        "t90":            _positive_alias(raw, "t90", "T90", "duration",
                                          "burst_duration"),
        "t90Error":       _positive_alias(raw, "t90_error", "t90_err",
                                          "duration_error"),
        # Observed peak energy of the nu-F-nu spectrum (keV).
        "epeak":          _positive_alias(raw, "epeak", "e_peak", "ep",
                                          "peak_energy", "epeak_kev"),
        "epeakError":     _positive_alias(raw, "epeak_error", "epeak_err",
                                          "peak_energy_error"),
        "fluenceError":   _positive_alias(raw, "fluence_error", "fluence_err"),
        # The energy interval the fluence was integrated over, as a string.
        # Never inferred — see the docstring above.
        "fluenceBand":    _text_alias(raw, "fluence_band", "energy_band",
                                      "fluence_energy_range", "energy_range"),
        # Redshift is almost never in a real-time notice; it arrives later by
        # circular. Positive-only: a literal 0 here would be a placeholder, and
        # z = 0 derives a zero luminosity distance and an E_iso of zero.
        "redshift":       _positive_alias(raw, "redshift", "z", "host_redshift"),
        "redshiftError":  _positive_alias(raw, "redshift_error", "redshift_err",
                                          "z_error"),
    }


def _chime_frb(raw: dict, event_type: str) -> dict:
    """
    CHIME/FRB VOEvent-JSON schema.
    Key fields: tns_name, ra, dec, dm, snr, width_ms, detection_time
    """
    ra  = _measured(raw.get("ra"))
    dec = _measured(raw.get("dec"))
    det_time = raw.get("detection_time") or raw.get("event_time") or _now_iso()
    gal_lon, gal_lat = _ra_dec_to_gal(ra, dec)
    sun_d, moon_d    = _sun_moon_distance(ra, dec, det_time)

    return {
        "eventId":       raw.get("tns_name") or raw.get("event_name") or _make_event_id("FRB"),
        "detectionTime": det_time,
        "ra":            ra,
        "dec":           dec,
        "errorRadius":   _positive_measured(raw.get("loc_error")),
        "snr":           _positive_measured(raw.get("snr")),
        "far":           _positive_measured(raw.get("far")),
        "latencyUs":     _latency_us(det_time),
        "galLon":        gal_lon,
        "galLat":        gal_lat,
        "sunDistance":   sun_d,
        "moonDistance":  moon_d,
        "dm":            _measured(raw.get("dm")),
        "fluence":       None,
        # ── Burst properties the FRB rules already validate ─────────────────
        # frb.validate() has had range checks for pulse width, observing
        # frequency and the DM decomposition since Phase 4, but the parser
        # never populated them, so every check was dead code. width_ms is
        # named in this parser's own docstring as a key field of the schema.
        "widthMs":       _positive_alias(raw, "width_ms", "width", "boxcar_width_ms",
                                         "pulse_width_ms"),
        "frequencyMhz":  _positive_alias(raw, "centre_frequency", "center_frequency",
                                         "frequency_mhz", "freq_mhz", "central_freq"),
        "scatteringMs":  _positive_alias(raw, "scattering_time", "scattering_ms",
                                         "scatter_time_ms"),
        "dmError":       _positive_alias(raw, "dm_error", "dm_err", "dm_uncertainty"),
        # Galactic DM foreground. Reported by the source or not at all: the
        # extragalactic excess is only meaningful if this came from an
        # electron-density model the notice names, never one assumed here.
        "dmGalactic":    _positive_alias(raw, "dm_gal", "dm_mw", "galactic_dm",
                                         "dm_galactic"),
        "dmGalacticError": _positive_alias(raw, "dm_gal_error", "dm_mw_error",
                                           "dm_galactic_error"),
        "isRepeater":    _alias(raw, "is_repeater", "repeater", "known_repeater"),
    }


def _einstein_probe(raw: dict, event_type: str) -> dict:
    """
    Einstein Probe WXT alert schema.
    Key fields: ra_obj, dec_obj, err_rad, snr, trigger_time, trigger_id
    """
    ra  = _measured(raw.get("ra_obj",  raw.get("ra")))
    dec = _measured(raw.get("dec_obj", raw.get("dec")))
    det_time = raw.get("trigger_time") or raw.get("t_start") or _now_iso()
    gal_lon, gal_lat = _ra_dec_to_gal(ra, dec)
    sun_d, moon_d    = _sun_moon_distance(ra, dec, det_time)

    # `id` and `event_name` are ARRAYS in the GCN v4 core Event schema.
    # Interpolating the list produced event IDs like "EP['11916655551']".
    trigger = _first_scalar(raw.get("trigger_id"), raw.get("id"),
                            raw.get("event_name"))

    # The GCN v4 core Localization schema names this `ra_dec_error`, in DEGREES,
    # and it may be a scalar radius OR an array describing an ellipse
    # (semi-major, semi-minor, position angle). The parser previously looked
    # only for `err_rad`/`loc_error`, neither of which exists in this schema,
    # so EVERY Einstein Probe localization was silently discarded.
    # errorRadius is arcmin here, hence the x60.
    err_deg = _ellipse_major(raw.get("ra_dec_error", raw.get("err_rad")))
    err_arcmin = err_deg * 60.0 if err_deg is not None else None

    return {
        "eventId":       f"EP{trigger}" if trigger else _make_event_id("GRB"),
        "detectionTime": det_time,
        "ra":            ra,
        "dec":           dec,
        "errorRadius":   err_arcmin,
        # Schema: "Containment probability [dimensionless, 0-1]; if absent,
        # default is 0.9". The default is the PRODUCER's documented convention,
        # not an assumption made here, so it is recorded rather than dropped —
        # otherwise a genuinely-90% radius is treated as unstated and every
        # radius comparison downstream refuses to run.
        "errorRadiusContainment": _containment_key(
            raw.get("containment_probability")),
        "snr":           _positive_measured(raw.get("image_snr", raw.get("snr"))),
        "far":           _positive_measured(raw.get("far")),
        "latencyUs":     _latency_us(det_time),
        "galLon":        gal_lon,
        "galLat":        gal_lat,
        "sunDistance":   sun_d,
        "moonDistance":  moon_d,
        "fluence":       _measured(raw.get("fluence")),
        "dm":            None,
        **_grb_spectral_fields(raw),
    }


def _icecube(raw: dict, event_type: str) -> dict:
    """
    IceCube GOLD/BRONZE and LVK-NuTrack alert schema.
    Key fields: ra, dec, ra_err, dec_err, signalness, far, event_dt
    """
    ra  = _measured(raw.get("ra"))
    dec = _measured(raw.get("dec"))
    det_time  = raw.get("event_dt") or raw.get("time") or _now_iso()
    gal_lon, gal_lat = _ra_dec_to_gal(ra, dec)
    sun_d, moon_d    = _sun_moon_distance(ra, dec, det_time)

    # IceCube uses separate ra_err / dec_err; use the larger for errorRadius.
    # If neither is reported the uncertainty is UNKNOWN — not zero.
    ra_err  = _positive_measured(raw.get("ra_err",  raw.get("ra_uncertainty")))
    dec_err = _positive_measured(raw.get("dec_err", raw.get("dec_uncertainty")))
    _errs = [e for e in (ra_err, dec_err) if e is not None]
    err_radius = max(_errs) if _errs else None

    det_time  = raw.get("event_dt") or raw.get("time") or _now_iso()
    run_id    = raw.get("run_id",   "")
    event_num = raw.get("event_id", raw.get("event_num", ""))
    event_id  = f"IC{run_id}-{event_num}" if run_id and event_num else _make_event_id("NU")

    return {
        "eventId":       event_id,
        "detectionTime": det_time,
        "ra":            ra,
        "dec":           dec,
        "errorRadius":   err_radius,
        # IceCube track alerts do not report a signal-to-noise ratio. This
        # field previously held *signalness* — a 0-1 probability that the
        # event is astrophysical — which is a different physical quantity with
        # different units and is not comparable to the SNR of a GRB or GW.
        # Storing it here made cross-messenger SNR comparisons meaningless.
        "snr":           None,
        "signalness":    _measured(raw.get("signalness", raw.get("signal_trackness"))),
        "far":           _positive_measured(raw.get("far")),
        "latencyUs":     _latency_us(det_time),
        "galLon":        gal_lon,
        "galLat":        gal_lat,
        "sunDistance":   sun_d,
        "moonDistance":  moon_d,
        "fluence":       None,
        "dm":            None,
        # ── Neutrino energy and topology ────────────────────────────────────
        # The unit is carried as a STRING alongside the number and is never
        # assumed: neutrino.py refuses to convert an energy whose unit it was
        # not told (GeV/TeV/PeV differ by three orders of magnitude each).
        "energy":        _positive_alias(raw, "energy", "reco_energy",
                                         "neutrino_energy", "energy_gev"),
        "energyUnit":    _text_alias(raw, "energy_unit", "energyUnits",
                                     "energy_units"),
        "eventTopology": _text_alias(raw, "event_topology", "topology",
                                     "event_type_topology"),
    }


def _igwn(raw: dict, event_type: str) -> dict:
    """
    IGWN Gravitational Wave alert schema (LVK O4 superevents).
    Key fields: superevent_id, event.time, event.far, event.skymap

    FITS / skymap URL extraction
    ----------------------------
    The LVK payload can carry the sky-localisation FITS URL in several places
    depending on GraceDB version and alert type:

      1. event.skymap       — O4 standard location (most common)
      2. skymap             — top-level alias used in some GraceDB notices
      3. fits_url           — older O3-era field name
      4. localization_url   — GraceDB REST API response field

    We try each in order.  If none resolves to a non-empty string, fitsUrl
    is set to None and no localization row will be written downstream.
    """
    event_block = raw.get("event", {}) or {}
    ra  = _measured(event_block.get("ra",  raw.get("ra")))
    dec = _measured(event_block.get("dec", raw.get("dec")))
    det_time = (
        event_block.get("time")
        or raw.get("time_created")
        or raw.get("event_time")
        or _now_iso()
    )
    gal_lon, gal_lat = _ra_dec_to_gal(ra, dec)
    sun_d, moon_d    = _sun_moon_distance(ra, dec, det_time)
    superevent_id = raw.get("superevent_id", _make_event_id("GW"))

    # ── FITS URL extraction ───────────────────────────────────────────────────
    # Try each candidate location; use the first truthy (non-empty) string.
    fits_url: str | None = (
        event_block.get("skymap")
        or raw.get("skymap")
        or raw.get("fits_url")
        or raw.get("localization_url")
        or None
    )
    # Coerce to str or None — reject non-string values (e.g. dicts, lists)
    if fits_url is not None and not isinstance(fits_url, str):
        fits_url = None
    # Empty string → None
    if fits_url is not None and not fits_url.strip():
        fits_url = None

    return {
        "eventId":       superevent_id,
        "detectionTime": det_time,
        "ra":            ra,
        "dec":           dec,
        # `area_90` is a 90% credible AREA in deg2. It was previously used as a
        # fallback for errorRadius, which is an ANGLE in arcmin — so a 100 deg2
        # skymap was recorded as a 100 arcmin (1.67 deg) radius, when the
        # equivalent radius is 5.6 deg. That conflated a unit, a dimension and
        # a containment convention in one assignment. The area now keeps its
        # own field and errorRadius stays UNKNOWN unless genuinely reported.
        "errorRadius":   _positive_measured(event_block.get("error_radius")),
        "area90Deg2":    _positive_measured(
            event_block.get("area_90", raw.get("area_90"))),
        "area50Deg2":    _positive_measured(
            event_block.get("area_50", raw.get("area_50"))),
        # errorRadiusContainment is deliberately left unset. The IGWN payload
        # does not state what its error_radius contains, and inventing "90%"
        # here would be the same class of assumption this field exists to
        # prevent. Unstated is reported as unstated.
        "snr":           _positive_measured(event_block.get("snr",  raw.get("snr"))),
        "far":           _positive_measured(event_block.get("far",  raw.get("far"))),
        "latencyUs":     _latency_us(det_time),
        "galLon":        gal_lon,
        "galLat":        gal_lat,
        "sunDistance":   sun_d,
        "moonDistance":  moon_d,
        "fluence":       None,
        "dm":            None,
        "fitsUrl":       fits_url,
        # ── Binary parameters the GW rules consume ──────────────────────────
        # Usually NOT in the JSON alert: LVK carries distance in the skymap
        # FITS header (DISTMEAN/DISTSTD) and masses in the parameter-estimation
        # products, both downstream of this notice. Extracted opportunistically
        # so that a payload which does carry them is not discarded; absent
        # stays UNKNOWN and gw.py declines the derivations that need them.
        "chirpMass":     _positive_alias(
            event_block, "chirp_mass", "mchirp", "chirp_mass_source") or
            _positive_alias(raw, "chirp_mass", "mchirp"),
        "mass1":         _positive_alias(event_block, "mass1", "mass_1") or
                         _positive_alias(raw, "mass1", "mass_1"),
        "mass2":         _positive_alias(event_block, "mass2", "mass_2") or
                         _positive_alias(raw, "mass2", "mass_2"),
        "mass1Error":    _positive_alias(event_block, "mass1_error", "mass_1_error"),
        "mass2Error":    _positive_alias(event_block, "mass2_error", "mass_2_error"),
        "luminosityDistance": _positive_alias(
            event_block, "luminosity_distance", "distance", "distmean") or
            _positive_alias(raw, "luminosity_distance", "distance", "distmean"),
        "luminosityDistanceError": _positive_alias(
            event_block, "luminosity_distance_error", "distance_error", "diststd") or
            _positive_alias(raw, "luminosity_distance_error", "diststd"),
    }


def _swift_bat(raw: dict, event_type: str) -> dict:
    """
    Swift-BAT GUANO alert schema.
    Key fields: trigger_num, ra, dec, image_snr, image_significance, trigger_time
    """
    ra  = _measured(raw.get("ra"))
    dec = _measured(raw.get("dec"))
    det_time  = raw.get("trigger_time") or raw.get("time") or _now_iso()
    gal_lon, gal_lat = _ra_dec_to_gal(ra, dec)
    sun_d, moon_d    = _sun_moon_distance(ra, dec, det_time)
    trig_num  = raw.get("trigger_num", raw.get("burst_trigger", ""))
    event_id  = f"GRB{trig_num}" if trig_num else _make_event_id("GRB")

    return {
        "eventId":       event_id,
        "detectionTime": det_time,
        "ra":            ra,
        "dec":           dec,
        "errorRadius":   _positive_measured(raw.get("loc_error")),
        "snr":           _positive_measured(raw.get("image_snr", raw.get("snr"))),
        "far":           _positive_measured(raw.get("far")),
        "latencyUs":     _latency_us(det_time),
        "galLon":        gal_lon,
        "galLat":        gal_lat,
        "sunDistance":   sun_d,
        "moonDistance":  moon_d,
        "fluence":       _measured(raw.get("fluence")),
        "dm":            None,
        **_grb_spectral_fields(raw),
    }


def _generic(raw: dict, event_type: str) -> dict:
    """Last-resort parser for unknown topics."""
    ra  = _measured(raw.get("ra"))
    dec = _measured(raw.get("dec"))
    det_time = raw.get("time") or raw.get("detection_time") or _now_iso()
    gal_lon, gal_lat = _ra_dec_to_gal(ra, dec)
    sun_d, moon_d    = _sun_moon_distance(ra, dec, det_time)

    return {
        "eventId":       raw.get("event_id") or _make_event_id(event_type),
        "detectionTime": det_time,
        "ra":            ra,
        "dec":           dec,
        "errorRadius":   _positive_measured(raw.get("loc_error", raw.get("error_radius"))),
        "snr":           _positive_measured(raw.get("snr")),
        "far":           _positive_measured(raw.get("far")),
        "latencyUs":     _latency_us(det_time),
        "galLon":        gal_lon,
        "galLat":        gal_lat,
        "sunDistance":   sun_d,
        "moonDistance":  moon_d,
        # The fallback parser previously discarded fluence outright, so any
        # unrecognised GRB topic lost it even when the payload carried one.
        "fluence":       _measured_alias(raw, "fluence", "burst_fluence"),
        "dm":            _measured_alias(raw, "dm", "dispersion_measure"),
        **_grb_spectral_fields(raw),
    }
