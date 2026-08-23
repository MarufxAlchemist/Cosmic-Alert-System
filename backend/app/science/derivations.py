"""
derivations.py
--------------
Derived scientific quantities, each carrying its inputs, method and
assumptions (spec sections 19-24, 33-34).

This module is the single place where Transient Event Detection turns observations into
new numbers. Everything it produces obeys three rules:

  1. **A derived value never outlives its inputs.** If an input is UNKNOWN the
     output is UNKNOWN, with a note saying which input was missing. There is
     no "typical value" path.

  2. **The method travels with the number.** Every result records the formula,
     the assumptions (cosmology, isotropy, independence) and its provenance, so
     a researcher can reproduce or reject it without reading this source file.

  3. **Uncertainty is propagated, never invented.** If the inputs have no
     reported errors the result has no error bar and says so — rather than
     printing a bare central value that reads as exact.

The output is a plain dict so it can be persisted as JSONB and rendered by the
frontend without a second modelling layer.
"""

from __future__ import annotations

import math
from typing import Any

from app.science import cosmology, observability
from app.science.uncertainty import (
    INDEPENDENCE_CAVEAT,
    Measurement,
    area_to_radius_deg,
)
from app.science.units import Quantity, unknown


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(f) or math.isinf(f)) else f


def _derived(
    value: float | None,
    unit: str,
    method: str,
    *,
    sigma: float | None = None,
    assumptions: list[str] | None = None,
    inputs: dict[str, Any] | None = None,
    provenance: str = "DERIVED",
    note: str | None = None,
) -> dict[str, Any]:
    q = Quantity(value=value, unit=unit, provenance=provenance,
                 sigma=sigma, note=note)
    out = q.to_dict()
    out["method"] = method
    out["assumptions"] = assumptions or []
    out["inputs"] = inputs or {}
    out["uncertaintyKnown"] = sigma is not None
    return out


def _unavailable(reason: str, needs: list[str] | None = None) -> dict[str, Any]:
    out = unknown(reason).to_dict()
    out["method"] = None
    out["assumptions"] = []
    out["inputs"] = {}
    out["uncertaintyKnown"] = False
    out["requires"] = needs or []
    return out


# ---------------------------------------------------------------------------
# Rest-frame quantities (spec section 13)
# ---------------------------------------------------------------------------

def rest_frame(ev: dict[str, Any]) -> dict[str, Any]:
    """
    Rest-frame T90 and Epeak, with the redshift uncertainty propagated.

    Both are exact kinematic relations — no cosmology is involved, only the
    redshift itself, so these are derivable whenever z is known even when no
    cosmological model is configured.
    """
    z = _num(ev.get("redshift"))
    z_sig = _num(ev.get("redshiftError"))
    out: dict[str, Any] = {}

    if z is None:
        reason = ("No redshift reported, so rest-frame quantities are UNKNOWN. "
                  "They are not estimated from a 'typical' redshift.")
        return {"t90Rest": _unavailable(reason, ["redshift"]),
                "epeakRest": _unavailable(reason, ["redshift"])}
    if z < 0:
        reason = f"Redshift {z} is negative; rest-frame quantities are undefined."
        return {"t90Rest": _unavailable(reason), "epeakRest": _unavailable(reason)}

    one_plus_z = Measurement(1.0 + z, z_sig)

    t90 = Measurement.of(ev.get("t90"), ev.get("t90Error"))
    if t90 is not None and t90.value > 0:
        r = t90.over(one_plus_z)
        out["t90Rest"] = _derived(
            r.value if r else None, "s",
            "T90_rest = T90_obs / (1 + z)",
            sigma=r.sigma if r else None,
            assumptions=[INDEPENDENCE_CAVEAT] if r and r.sigma is not None else [],
            inputs={"t90": t90.value, "redshift": z, "redshiftError": z_sig},
        )
    else:
        out["t90Rest"] = _unavailable(
            "No positive T90 reported.", ["t90"])

    epeak = Measurement.of(ev.get("epeak"), ev.get("epeakError"))
    if epeak is not None and epeak.value > 0:
        r = epeak.times(one_plus_z)
        out["epeakRest"] = _derived(
            r.value, "keV",
            "Epeak_rest = Epeak_obs * (1 + z)",
            sigma=r.sigma,
            assumptions=[INDEPENDENCE_CAVEAT] if r.sigma is not None else [],
            inputs={"epeak": epeak.value, "redshift": z},
        )
    else:
        out["epeakRest"] = _unavailable("No positive Epeak reported.", ["epeak"])

    return out


# ---------------------------------------------------------------------------
# Cosmological quantities (spec section 33)
# ---------------------------------------------------------------------------

def cosmological(ev: dict[str, Any]) -> dict[str, Any]:
    """
    Distance, lookback time and band-limited E_iso under the configured
    cosmology. Every entry is stamped with the model that produced it.
    """
    st = cosmology.stamp()
    out: dict[str, Any] = {"cosmology": st.to_dict()}

    z = _num(ev.get("redshift"))
    z_sig = _num(ev.get("redshiftError"))

    if not st.available:
        reason = st.reason or "No cosmology configured."
        out["luminosityDistance"] = _unavailable(reason)
        out["lookbackTime"] = _unavailable(reason)
        out["eIsoBand"] = _unavailable(reason)
        return out

    if z is None:
        reason = ("No redshift reported. Distance and energy scale cannot be "
                  "derived, and are UNKNOWN rather than assumed.")
        out["luminosityDistance"] = _unavailable(reason, ["redshift"])
        out["lookbackTime"] = _unavailable(reason, ["redshift"])
        out["eIsoBand"] = _unavailable(reason, ["redshift", "fluence"])
        return out

    assumptions = [f"Cosmology: {st.name} (H0 = {st.H0} km/s/Mpc, "
                   f"Om0 = {st.Om0}, flat). {st.reference}"]

    dl = cosmology.luminosity_distance_mpc(z, z_sig)
    if dl is None:
        out["luminosityDistance"] = _unavailable(
            f"Redshift {z} is outside the range where a distance is derived "
            f"[{cosmology.Z_MIN}, {cosmology.Z_MAX}].")
    else:
        out["luminosityDistance"] = _derived(
            dl.value, "Mpc", "D_L(z) integrated under the configured cosmology",
            sigma=dl.sigma, assumptions=assumptions,
            inputs={"redshift": z, "redshiftError": z_sig},
        )

    lb = cosmology.lookback_time_gyr(z)
    out["lookbackTime"] = (
        _derived(lb, "Gyr", "Lookback time under the configured cosmology",
                 assumptions=assumptions, inputs={"redshift": z})
        if lb is not None else
        _unavailable(f"Lookback time not derived for z = {z}.")
    )

    # E_iso: only meaningful with a stated energy band, and even then only in
    # that band. Without the band the number is not comparable to anything.
    fluence = _num(ev.get("fluence"))
    band = ev.get("fluenceBand")
    if fluence is None:
        out["eIsoBand"] = _unavailable(
            "No fluence reported; isotropic energy cannot be derived.", ["fluence"])
    elif not band:
        out["eIsoBand"] = _unavailable(
            "Fluence is reported without an energy band. A band-limited E_iso "
            "computed from an unknown band is not comparable to any published "
            "value, so it is not derived.", ["fluenceBand"])
    else:
        e, caveat = cosmology.eiso_band_limited(
            fluence, z, _num(ev.get("fluenceError")), z_sig)
        if e is None:
            out["eIsoBand"] = _unavailable(caveat)
        else:
            out["eIsoBand"] = _derived(
                e.value, "erg", "E_iso,band = 4*pi*D_L^2*S/(1+z)",
                sigma=e.sigma,
                assumptions=assumptions + [caveat, INDEPENDENCE_CAVEAT],
                inputs={"fluence": fluence, "fluenceBand": band, "redshift": z},
                note=f"Band-limited to {band}; NOT bolometric E_iso.",
            )

    return out


# ---------------------------------------------------------------------------
# Localization (spec sections 16, 23)
# ---------------------------------------------------------------------------

def localization(ev: dict[str, Any]) -> dict[str, Any]:
    """
    What the reported localization actually means, and the equivalent radius
    of any credible area.
    """
    out: dict[str, Any] = {}

    radius_arcmin = _num(ev.get("errorRadius"))
    convention = ev.get("errorRadiusContainment")

    out["reported"] = {
        "radiusArcmin": radius_arcmin,
        "radiusDeg": radius_arcmin / 60.0 if radius_arcmin is not None else None,
        "containment": convention,
        "containmentStated": bool(convention),
        "note": (None if convention else
                 "The containment convention of this radius was not stated by the "
                 "source. A 1-sigma radius and a 90% containment radius differ by "
                 "more than a factor of two, so it must not be assumed."),
    }

    for key, fld in (("area50Deg2", "area50Deg2"), ("area90Deg2", "area90Deg2")):
        area = _num(ev.get(fld))
        if area is None:
            continue
        r = area_to_radius_deg(area)
        out[key] = _derived(
            r, "deg",
            "Equivalent radius of a circular cap of the same area: "
            "A = 2*pi*(1 - cos r)",
            assumptions=[
                "Describes a circle of equal area. A real credible region is "
                "generally non-circular and may be disjoint, so this radius "
                "must not be used as a search radius."
            ],
            inputs={fld: area},
        ) if r is not None else _unavailable(
            f"{fld} = {area} deg2 is not a valid sky area.")

    return out


# ---------------------------------------------------------------------------
# Observability (spec sections 21-22)
# ---------------------------------------------------------------------------

def observing(ev: dict[str, Any]) -> dict[str, Any]:
    obs = observability.compute(ev.get("ra"), ev.get("dec"),
                                ev.get("detectionTime"))
    return obs.to_dict()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def derive_all(ev: dict[str, Any]) -> dict[str, Any]:
    """
    Compute every derived block for an event.

    Each block is isolated: one failing derivation records its own error and
    never suppresses the others or breaks ingestion (spec section 48).
    """
    out: dict[str, Any] = {}
    for name, fn in (("restFrame", rest_frame),
                     ("cosmological", cosmological),
                     ("localization", localization),
                     ("observability", observing)):
        try:
            out[name] = fn(ev)
        except Exception as exc:                   # pragma: no cover - defensive
            out[name] = {"error": f"{type(exc).__name__}: {exc}",
                         "note": "Derivation failed; no value is reported."}
    return out


__all__ = ["derive_all", "rest_frame", "cosmological", "localization", "observing"]
