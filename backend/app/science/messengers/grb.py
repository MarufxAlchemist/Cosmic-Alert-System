"""
grb.py
------
Gamma-ray burst validation (spec sections 9-13).

The single most important rule here is restraint. A T90 below 2 seconds is
*statistically* associated with compact-binary mergers, but it is not proof of
one: the short/long split is detector-dependent, the distributions overlap
heavily, and well-known counterexamples exist in both directions
(e.g. GRB 211211A — a long burst with a kilonova). So this module classifies
duration and says so explicitly, and never asserts a progenitor.

On isotropic energy the module draws a line rather than an all-or-nothing
refusal. With a redshift, an explicit cosmology (Phase 5) and a *stated* energy
band, the band-limited isotropic energy 4*pi*D_L^2*S/(1+z) is fully defined and
is derived, stamped with the cosmology it assumed. The bolometric E_iso quoted
in catalogues is still NOT derived: it needs a k-correction from a fitted
spectral model that no alert payload carries. The two differ by a factor of
roughly 1.5-5 that is not a constant, so they are never conflated.
"""

from __future__ import annotations

from typing import Any

from app.science import cosmology
from app.science.diagnostics import ValidationReport
from app.science.uncertainty import Measurement

#: Conventional T90 split (Kouveliotou et al. 1993, BATSE 25-350 keV).
#: Instrument-dependent — recorded alongside any classification.
#: Band per Zhang, "The Physics of Gamma-Ray Bursts", section 2.1.2.
T90_SHORT_MAX_S = 2.0

#: Where each population actually peaks (Zhang section 2.1.2). Quoted in the
#: caveat so "short" is never read as "0 s" or "long" as "unbounded".
T90_SHORT_PEAK_S = (0.2, 0.3)
T90_LONG_PEAK_S = (20.0, 30.0)

#: T90 longer than this is extremely unusual and worth a human look.
T90_IMPLAUSIBLE_S = 10_000.0

#: Fluence outside this range (erg/cm2) is almost certainly a unit error.
FLUENCE_MIN, FLUENCE_MAX = 1e-12, 1e-1

#: Observed Epeak range (keV). Outside this suggests a unit mix-up (MeV/keV).
EPEAK_MIN_KEV, EPEAK_MAX_KEV = 1.0, 1e5


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def classify_duration(t90: float) -> dict[str, Any]:
    """
    Duration classification with its caveats attached.

    Returns the class *and* the reason it must not be read as a progenitor
    determination, so no consumer can quote the label without the caveat.
    """
    is_short = t90 < T90_SHORT_MAX_S
    peak = T90_SHORT_PEAK_S if is_short else T90_LONG_PEAK_S
    return {
        "class": "short" if is_short else "long",
        "threshold_s": T90_SHORT_MAX_S,
        "convention": "Kouveliotou et al. 1993 (BATSE 25-350 keV)",
        "definition": (
            "T90 is the interval between the epochs at which 5% and 95% of the "
            "total fluence has been collected."
        ),
        "population_peak_s": peak,
        "caveat": (
            "Duration classes are statistical and detector-dependent; the "
            "short and long populations overlap substantially. This is NOT a "
            "determination of progenitor type."
        ),
        # Each of these changes the measured T90 for the SAME burst, which is
        # why the class must never be treated as an intrinsic property.
        "instrument_dependence": (
            "T90 depends on the detector's energy bandpass (pulses are wider at "
            "lower energies, giving a longer T90) and on its sensitivity (a more "
            "sensitive detector recovers more of the burst above background). "
            "The observed short-to-long ratio is about 1:3 for BATSE but 1:9 for "
            "Swift. Where a burst has widely separated emission episodes, T90 "
            "spans the quiescent gap and overstates the central engine activity."
        ),
        "provenance": "DERIVED",
    }


#: Amati relation (Amati et al. 2002; Amati 2006), as given by Zhang eq. (2.54):
#:
#:     Ep,z / 100 keV = C * (E_iso / 1e52 erg)^m
#:
#: C and m are RANGES in the source, not fitted constants, so the relation
#: defines a band rather than a line. Treating either as a point value would
#: manufacture a precision the correlation does not have.
AMATI_C_RANGE = (0.8, 1.0)
AMATI_M_RANGE = (0.4, 0.6)

AMATI_CAVEAT = (
    "The Amati relation has broad intrinsic scatter and significant outliers "
    "(GRB 980425 is far harder than it predicts). Several authors argue it is "
    "at least partly an observational selection effect. It holds for LONG GRBs "
    "with known redshift: short GRBs form a separate track and are "
    "systematically less energetic at the same Ep,z. It is a population trend, "
    "never a per-burst prediction."
)


def amati_band_kev(eiso_bolometric_erg: float) -> tuple[float, float] | None:
    """
    Ep,z band predicted by the Amati relation for a bolometric E_iso.

    Returns (low, high) in keV spanned by the quoted ranges of C and m, or
    None if the input is unusable. The width of the band IS the result: this
    correlation does not support a single predicted value.
    """
    e = _num(eiso_bolometric_erg)
    if e is None or e <= 0:
        return None
    x = e / 1e52
    vals = [c * (x ** m) * 100.0 for c in AMATI_C_RANGE for m in AMATI_M_RANGE]
    return min(vals), max(vals)


def _amati_check(ev: dict[str, Any], rep: ValidationReport,
                 epeak: float | None, z: float | None,
                 fluence: float | None) -> None:
    """
    Evaluate the Amati relation, or state precisely why it cannot be.

    The relation is defined on the BOLOMETRIC isotropic energy — the 1-10^4 keV
    rest-frame quantity of Zhang eq. (2.48), which carries the k-correction
    factor k of eq. (2.45). This pipeline computes only the BAND-LIMITED
    isotropic energy, because k requires a fitted photon spectrum N(E) that no
    alert payload contains. The two differ by a factor of roughly 1.5-5 that is
    not a constant.

    Substituting the band-limited value would therefore shift Ep,z along the
    relation by an unknown amount and could turn a normal burst into an
    apparent outlier, or hide a real one. So it is never substituted: the check
    runs only on a bolometric E_iso supplied from outside, and otherwise
    reports what is missing.
    """
    if epeak is None or epeak <= 0 or z is None or z < 0:
        return

    ep_z = epeak * (1.0 + z)
    eiso_bol = _num(ev.get("eisoBolometric"))

    if eiso_bol is None or eiso_bol <= 0:
        if fluence is not None and fluence > 0:
            rep.info(
                "grb_amati_not_evaluated",
                f"The Amati relation is not evaluated. It is defined on the "
                f"bolometric isotropic energy (rest-frame 1-10^4 keV), which "
                f"requires a k-correction from a fitted spectral model this "
                f"payload does not carry; only a band-limited E_iso is "
                f"available and the two differ by a non-constant factor of "
                f"roughly 1.5-5. Rest-frame Ep,z = {ep_z:.4g} keV is reported "
                f"on its own. {AMATI_CAVEAT}",
                "epeak", ep_z,
            )
        return

    band = amati_band_kev(eiso_bol)
    if band is None:
        return
    lo, hi = band
    inside = lo <= ep_z <= hi
    rep.info(
        "grb_amati_consistent" if inside else "grb_amati_outlier",
        f"Rest-frame Ep,z = {ep_z:.4g} keV "
        f"{'lies within' if inside else 'lies OUTSIDE'} the Amati band "
        f"{lo:.4g}-{hi:.4g} keV predicted for E_iso = {eiso_bol:.3e} erg "
        f"(Ep,z/100 keV = C (E_iso/1e52 erg)^m, "
        f"C = {AMATI_C_RANGE[0]}-{AMATI_C_RANGE[1]}, "
        f"m = {AMATI_M_RANGE[0]}-{AMATI_M_RANGE[1]}). "
        f"{'Consistency is expected and is not evidence of anything in itself.' if inside else 'Outliers are known and do not by themselves indicate bad data.'} "
        f"{AMATI_CAVEAT}",
        "epeak", ep_z,
    )


def validate(ev: dict[str, Any], rep: ValidationReport) -> None:
    t90 = _num(ev.get("t90"))
    fluence = _num(ev.get("fluence"))
    band = ev.get("fluenceBand")
    epeak = _num(ev.get("epeak"))
    z = _num(ev.get("redshift"))

    # ── Duration ────────────────────────────────────────────────────────────
    if t90 is None:
        rep.warning("grb_t90_missing",
                    "No T90 reported; burst duration and its classification are unavailable.",
                    "t90")
    else:
        if t90 <= 0:
            rep.error("grb_t90_non_positive",
                      f"T90 {t90} s is not positive; a burst duration must exceed zero.",
                      "t90", t90)
        elif t90 > T90_IMPLAUSIBLE_S:
            rep.warning("grb_t90_implausible",
                        f"T90 {t90} s is far longer than any catalogued GRB; "
                        "check the unit (seconds vs milliseconds).", "t90", t90)
        else:
            cls = classify_duration(t90)
            rep.info("grb_duration_class",
                     f"T90 {t90:.2f} s classifies as a {cls['class']} burst under the "
                     f"{cls['convention']} convention. {cls['caveat']}",
                     "t90", cls["class"])

    # ── Fluence ─────────────────────────────────────────────────────────────
    if fluence is not None:
        if fluence <= 0:
            rep.error("grb_fluence_non_positive",
                      f"Fluence {fluence} erg/cm2 is not positive.", "fluence", fluence)
        elif not (FLUENCE_MIN <= fluence <= FLUENCE_MAX):
            rep.warning("grb_fluence_implausible",
                        f"Fluence {fluence:.3e} erg/cm2 is outside the range seen in "
                        f"GRB catalogues ({FLUENCE_MIN:.0e}-{FLUENCE_MAX:.0e}); "
                        "check units.", "fluence", fluence)
        if not band:
            rep.notice("grb_fluence_band_missing",
                       "Fluence is reported without an energy band. Fluences from "
                       "different instruments are not comparable without the band, "
                       "the detector response and the integration interval.",
                       "fluence")

    # ── Spectral peak energy ────────────────────────────────────────────────
    if epeak is not None:
        if epeak <= 0:
            rep.error("grb_epeak_non_positive",
                      f"Epeak {epeak} keV is not positive.", "epeak", epeak)
        elif not (EPEAK_MIN_KEV <= epeak <= EPEAK_MAX_KEV):
            rep.warning("grb_epeak_implausible",
                        f"Epeak {epeak} keV is outside the plausible observed range; "
                        "check for a keV/MeV unit mix-up.", "epeak", epeak)

    # ── Rest-frame quantities (spec section 13) ─────────────────────────────
    # Only derivable with a redshift. Without one these stay UNKNOWN; an
    # invented redshift would silently propagate into every rest-frame number.
    if z is None:
        if t90 is not None or epeak is not None:
            rep.info("grb_rest_frame_unavailable",
                     "No redshift reported, so rest-frame quantities (rest-frame "
                     "T90, rest-frame Epeak, E_iso) cannot be derived. They are "
                     "UNKNOWN rather than estimated.", "redshift")
    else:
        if z < 0:
            rep.error("grb_redshift_negative",
                      f"Redshift {z} is negative.", "redshift", z)
        elif z > 20:
            rep.warning("grb_redshift_implausible",
                        f"Redshift {z} exceeds any confirmed GRB; verify the source.",
                        "redshift", z)
        else:
            z_sig = _num(ev.get("redshiftError"))
            one_plus_z = Measurement(1.0 + z, z_sig)

            if t90 is not None and t90 > 0:
                m = Measurement.of(t90, ev.get("t90Error"))
                r = m.over(one_plus_z) if m else None
                if r is not None:
                    rep.info("grb_rest_frame_t90",
                             f"Rest-frame T90 = {r.render(3, 's')} "
                             f"(T90_obs / (1+z), z = {z}).", "t90", r.value)
            if epeak is not None and epeak > 0:
                m = Measurement.of(epeak, ev.get("epeakError"))
                r = m.times(one_plus_z) if m else None
                if r is not None:
                    rep.info("grb_rest_frame_epeak",
                             f"Rest-frame Epeak = {r.render(4, 'keV')} "
                             f"(Epeak_obs x (1+z), z = {z}).", "epeak", r.value)

        # ── Isotropic energy (spec sections 13, 33) ─────────────────────────
        # With an explicit cosmology the *band-limited* isotropic energy is
        # computable, and only that. The bolometric E_iso of the literature
        # additionally needs a k-correction from a fitted spectral model, which
        # no alert payload carries — so it stays UNKNOWN, and the band-limited
        # value is never labelled "E_iso" without its qualifier.
        if fluence is not None and fluence > 0:
            if not band:
                rep.info("grb_eiso_not_derived",
                         "Isotropic energy is not derived: the fluence has no "
                         "stated energy band, so the result would not be "
                         "comparable to any published value.", "fluence")
            else:
                e, caveat = cosmology.eiso_band_limited(
                    fluence, z, _num(ev.get("fluenceError")),
                    _num(ev.get("redshiftError")))
                st = cosmology.stamp()
                if e is None:
                    rep.info("grb_eiso_not_derived",
                             f"Isotropic energy is not derived: {caveat}", "fluence")
                else:
                    rep.info(
                        "grb_eiso_band_limited",
                        f"Band-limited isotropic energy = {e.render(3, 'erg')} "
                        f"over {band}, assuming {st.name} "
                        f"(H0 = {st.H0} km/s/Mpc, Om0 = {st.Om0}). {caveat}",
                        "fluence", e.value,
                    )
                    _amati_check(ev, rep, epeak, z, fluence)
                    rep.info(
                        "grb_eiso_not_bolometric",
                        "The bolometric E_iso quoted in GRB catalogues is NOT "
                        "derived: it requires a k-correction to a fixed "
                        "rest-frame band (typically 1-10000 keV) from a fitted "
                        "spectral model, which this payload does not carry.",
                        "fluence",
                    )
