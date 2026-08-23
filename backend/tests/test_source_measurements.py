"""
test_source_measurements.py
---------------------------
Phase 2 regression tests: SOURCE measurements must never be fabricated.

Before these fixes the normalizer coerced every missing measurement to 0.0.
Because (0, 0) is a *valid* sky position and 0 is a plausible-looking SNR,
nothing downstream could distinguish a fabricated value from a real one —
279 of 304 archived events ended up claiming to sit at the celestial origin.

Run:  pytest backend/tests/test_source_measurements.py
"""

import pytest

from app.gcn.normalizer import (
    _measured,
    _positive_measured,
    _safe_float,
    normalize,
)


# ---------------------------------------------------------------------------
# _measured — absent means None, never 0.0
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("val", [None, "", "abc", [], {}, float("nan"), float("inf")])
def test_measured_returns_none_for_unusable(val):
    assert _measured(val) is None


@pytest.mark.parametrize("val,expected", [
    (0, 0.0),          # a genuine zero is preserved
    (0.0, 0.0),
    (12.5, 12.5),
    ("12.5", 12.5),
    (-3.25, -3.25),
])
def test_measured_preserves_real_values(val, expected):
    assert _measured(val) == expected


def test_measured_never_substitutes_zero_for_missing():
    """The exact defect: a missing measurement must not become 0.0."""
    assert _measured(None) is not 0.0  # noqa: F632 - identity is the point
    assert _measured(None) is None
    # _safe_float is the legacy behaviour, retained only where a numeric
    # default is genuinely correct. Confirm the two differ.
    assert _safe_float(None) == 0.0
    assert _measured(None) is None


# ---------------------------------------------------------------------------
# _positive_measured — zero is physically meaningless for SNR / FAR / radius
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("val", [0, 0.0, -1, -0.5, None, "x"])
def test_positive_measured_rejects_non_positive(val):
    assert _positive_measured(val) is None


@pytest.mark.parametrize("val", [0.001, 1, 14.7, 1e-8])
def test_positive_measured_accepts_positive(val):
    assert _positive_measured(val) == float(val)


def test_far_of_zero_is_unknown_not_zero():
    """
    A FAR of exactly 0 Hz would mean 'never a false alarm'. It also produced
    the '1 per Infinity years' text in the UI via an unguarded 1/far.
    """
    assert _positive_measured(0.0) is None


# ---------------------------------------------------------------------------
# normalize() — a parse failure must not emit a fabricated event
# ---------------------------------------------------------------------------

def test_parse_failure_yields_unknown_not_origin():
    """
    An unparseable payload must produce UNKNOWN fields, not an event sitting
    at (0, 0) with SNR 0 — which is what the old base-dict defaults did.
    """
    out = normalize("gcn.notices.chime.frb", {})
    for field in ("ra", "dec", "snr", "far", "errorRadius"):
        assert out[field] is None, f"{field} was fabricated as {out[field]!r}"


def test_parse_failure_yields_no_derived_geometry():
    """Derived geometry must not exist where the position does not."""
    out = normalize("gcn.notices.chime.frb", {})
    for field in ("galLon", "galLat", "sunDistance", "moonDistance"):
        assert out[field] is None


def test_unknown_topic_does_not_fabricate():
    out = normalize("some.unknown.topic", {"nothing": "useful"})
    assert out["ra"] is None and out["dec"] is None
    assert out["snr"] is None and out["far"] is None


def test_real_payload_is_preserved():
    """A payload carrying real values must pass them through unchanged."""
    out = normalize("gcn.notices.chime.frb", {
        "ra": 237.42, "dec": -28.74, "snr": 14.7,
        "far": 3.2e-8, "loc_error": 2.1, "dm": 393.5,
        "timestamp": "2026-06-09T08:23:11Z",
    })
    assert out["ra"] == 237.42
    assert out["dec"] == -28.74
    assert out["snr"] == 14.7
    assert out["far"] == pytest.approx(3.2e-8)
    assert out["errorRadius"] == 2.1
    assert out["dm"] == 393.5


# ---------------------------------------------------------------------------
# IceCube: signalness is not SNR
# ---------------------------------------------------------------------------

def test_icecube_signalness_is_not_stored_as_snr():
    """
    Signalness is a probability in [0,1] that the event is astrophysical.
    SNR is a detection significance in sigma. Storing one as the other made
    cross-messenger SNR comparison meaningless.
    """
    out = normalize("gcn.notices.icecube.gold_bronze_track_alerts", {
        "ra": 100.0, "dec": 20.0, "signalness": 0.87,
        "event_dt": "2026-06-09T08:23:11Z",
    })
    assert out["signalness"] == 0.87
    assert out["snr"] is None, "signalness must not be reported as SNR"


def test_icecube_missing_uncertainty_is_unknown():
    """max(ra_err, dec_err) must not become 0 when neither is reported."""
    out = normalize("gcn.notices.icecube.gold_bronze_track_alerts", {
        "ra": 100.0, "dec": 20.0, "event_dt": "2026-06-09T08:23:11Z",
    })
    assert out["errorRadius"] is None


# ---------------------------------------------------------------------------
# Parser extraction — fields the science layer consumes must reach it
# ---------------------------------------------------------------------------
#
# The science modules read 58 fields off the event dict; the normalizer emitted
# 29. Everything in between was validated by rules that could never fire: the
# CHIME parser named width_ms in its own docstring and dropped it, and no
# parser produced t90, epeak or redshift, so GRB duration classification,
# rest-frame quantities and E_iso were unreachable on live traffic.
#
# These tests assert the extraction happens AND that absence is still UNKNOWN.

GRB_TOPIC = "gcn.notices.swift.bat.guano"
FRB_TOPIC = "gcn.notices.chime.frb"
NU_TOPIC = "gcn.notices.icecube.gold_bronze_track_alerts"
GW_TOPIC = "igwn.gwalert"
T = "2026-08-17T00:00:00Z"


def test_grb_spectral_fields_are_extracted():
    ev = normalize(GRB_TOPIC, {
        "trigger_num": "1", "ra": 10.0, "dec": 10.0, "trigger_time": T,
        "t90": 45.0, "t90_error": 2.0, "epeak": 250.0, "epeak_error": 20.0,
        "fluence": 2.5e-5, "fluence_error": 3e-6, "energy_band": "15-150 keV",
        "redshift": 1.2, "redshift_error": 0.01,
    })
    assert ev["t90"] == 45.0 and ev["t90Error"] == 2.0
    assert ev["epeak"] == 250.0 and ev["epeakError"] == 20.0
    assert ev["fluenceBand"] == "15-150 keV"
    assert ev["redshift"] == 1.2


def test_extraction_unblocks_the_whole_grb_chain():
    """
    The point of the change. With these inputs present the GRB rules produce
    the derivations that were previously unreachable.
    """
    ev = normalize(GRB_TOPIC, {
        "trigger_num": "1", "ra": 10.0, "dec": 10.0, "trigger_time": T,
        "t90": 45.0, "epeak": 250.0, "fluence": 2.5e-5,
        "energy_band": "15-150 keV", "redshift": 1.2,
    })
    codes = {d["code"] for d in ev["validation"]["diagnostics"]}
    assert "grb_duration_class" in codes
    assert "grb_rest_frame_t90" in codes
    assert "grb_rest_frame_epeak" in codes
    assert "grb_eiso_band_limited" in codes
    # Still refuses the bolometric quantity it cannot k-correct.
    assert "grb_amati_not_evaluated" in codes


@pytest.mark.parametrize("field", ["t90", "epeak", "redshift", "fluenceBand",
                                   "t90Error", "epeakError"])
def test_absent_grb_fields_stay_unknown(field):
    """A notice that reports none of these must not gain a numeric stand-in."""
    ev = normalize(GRB_TOPIC, {"trigger_num": "1", "ra": 10.0, "dec": 10.0,
                               "trigger_time": T})
    assert ev[field] is None


@pytest.mark.parametrize("field", ["t90", "epeak", "redshift"])
def test_zero_is_rejected_for_quantities_where_it_is_impossible(field):
    """
    A payload writing 0 as its own placeholder must not be believed. T90 = 0
    is not a burst, Epeak = 0 is not a spectrum, and z = 0 would derive a zero
    luminosity distance and an E_iso of exactly zero.
    """
    ev = normalize(GRB_TOPIC, {"trigger_num": "1", "ra": 10.0, "dec": 10.0,
                               "trigger_time": T, field: 0})
    assert ev[field] is None


def test_fluence_band_is_never_inferred_from_the_instrument():
    """
    Swift-BAT nominally covers 15-150 keV, but stamping that onto a fluence the
    notice did not describe would assume the integration interval. Unstated
    stays unstated, and E_iso is then declined rather than mis-derived.
    """
    ev = normalize(GRB_TOPIC, {"trigger_num": "1", "ra": 10.0, "dec": 10.0,
                               "trigger_time": T, "fluence": 2.5e-5,
                               "redshift": 1.0})
    assert ev["fluenceBand"] is None
    codes = {d["code"] for d in ev["validation"]["diagnostics"]}
    assert "grb_eiso_not_derived" in codes
    assert "grb_eiso_band_limited" not in codes


def test_chime_burst_properties_are_extracted():
    ev = normalize(FRB_TOPIC, {
        "tns_name": "FRB20260817A", "ra": 47.4, "dec": 23.9, "dm": 543.0,
        "snr": 16.4, "detection_time": T, "width_ms": 2.5,
        "centre_frequency": 600.0, "dm_error": 0.4, "dm_gal": 45.0,
        "scattering_time": 1.2,
    })
    assert ev["widthMs"] == 2.5
    assert ev["frequencyMhz"] == 600.0
    assert ev["dmError"] == 0.4
    assert ev["dmGalactic"] == 45.0
    assert ev["scatteringMs"] == 1.2


def test_neutrino_energy_unit_is_carried_as_text():
    """The unit must travel with the number: GeV/TeV/PeV differ by 10^3 each,
    and neutrino.py refuses to convert an energy whose unit it was not told."""
    ev = normalize(NU_TOPIC, {"ra": 1.0, "dec": 2.0, "event_dt": T,
                              "run_id": "1", "event_id": "2",
                              "energy": 120.0, "energy_unit": "TeV"})
    assert ev["energy"] == 120.0
    assert ev["energyUnit"] == "TeV"

    bare = normalize(NU_TOPIC, {"ra": 1.0, "dec": 2.0, "event_dt": T,
                                "run_id": "1", "event_id": "3", "energy": 120.0})
    assert bare["energyUnit"] is None


def test_gw_binary_parameters_are_extracted_when_present():
    ev = normalize(GW_TOPIC, {"superevent_id": "S260817a", "event": {
        "time": T, "far": 1e-9, "chirp_mass": 1.4, "mass1": 1.6, "mass2": 1.3,
        "luminosity_distance": 180.0}})
    assert ev["chirpMass"] == 1.4
    assert ev["luminosityDistance"] == 180.0


def test_generic_parser_no_longer_discards_fluence():
    """An unrecognised topic previously lost fluence outright."""
    ev = normalize("gcn.some.unmapped.topic",
                   {"ra": 1.0, "dec": 2.0, "time": T, "fluence": 1e-6})
    assert ev["fluence"] == 1e-6
