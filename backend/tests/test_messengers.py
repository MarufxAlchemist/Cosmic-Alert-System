"""
test_messengers.py
------------------
Phase 4 tests: per-messenger validation (spec sections 9-18).

Beyond checking each rule, these assert the things the module must REFUSE to
do — classify a progenitor from duration, invent a redshift from DM, guess a
neutrino energy unit, or normalise a non-exhaustive probability set. Those
refusals are the scientific content of this layer.
"""

import pytest

from app.science import validate_event
from app.science.messengers import VALIDATORS, frb, grb, gw, neutrino
from app.science.messengers.neutrino import to_gev

T = "2026-08-10T10:00:00Z"


def base(etype, **over):
    e = {"eventId": "T1", "eventType": etype, "observatory": "Obs",
         "detectionTime": T, "ra": 10.0, "dec": 10.0,
         "snr": 10.0, "far": 1e-7, "errorRadius": 5.0}
    e.update(over)
    return e


def codes(e):
    return set(validate_event(e).codes())


def test_every_messenger_has_a_validator():
    assert set(VALIDATORS) >= {"GRB", "GW", "FRB", "NU"}


def test_unknown_messenger_does_not_raise():
    assert isinstance(codes(base("QUASAR")), set)


# ---------------------------------------------------------------------------
# GRB
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("t90,expected", [(0.5, "short"), (1.99, "short"),
                                          (2.01, "long"), (60.0, "long")])
def test_duration_classification(t90, expected):
    assert grb.classify_duration(t90)["class"] == expected


def test_duration_class_always_carries_its_caveat():
    """The label must never be quotable without the statistical caveat."""
    cls = grb.classify_duration(0.5)
    assert "NOT a determination of progenitor" in cls["caveat"]
    assert cls["convention"]
    assert cls["provenance"] == "DERIVED"


def test_duration_class_states_its_instrument_dependence():
    """
    T90 is not an intrinsic property: the same burst measures differently on a
    different bandpass or a more sensitive detector. The class must carry that,
    or it reads as a fact about the source rather than about the detector.
    """
    cls = grb.classify_duration(30.0)
    assert "5%" in cls["definition"] and "95%" in cls["definition"]
    assert "bandpass" in cls["instrument_dependence"]
    assert cls["population_peak_s"] == grb.T90_LONG_PEAK_S
    assert grb.classify_duration(0.3)["population_peak_s"] == grb.T90_SHORT_PEAK_S


# ── Amati relation (Zhang eq. 2.54) ────────────────────────────────────────

def test_amati_band_is_a_band_not_a_line():
    """
    C and m are quoted as ranges, so the relation predicts an interval. A
    single predicted value would claim a precision the correlation lacks.
    """
    lo, hi = grb.amati_band_kev(1e52)
    # At E_iso = 1e52 erg the (E_iso/1e52)^m factor is exactly 1, so the band
    # collapses to the range of C, scaled by 100 keV.
    assert (lo, hi) == (80.0, 100.0)
    assert grb.amati_band_kev(1e54)[0] < grb.amati_band_kev(1e54)[1]


@pytest.mark.parametrize("bad", [0, -1.0, None, float("nan")])
def test_amati_band_rejects_unusable_energy(bad):
    assert grb.amati_band_kev(bad) is None


def test_amati_is_not_evaluated_on_band_limited_eiso():
    """
    THE point of this check. The Amati relation is defined on the BOLOMETRIC
    E_iso; the pipeline holds only the band-limited one, and they differ by a
    non-constant factor of ~1.5-5. Substituting it would move Ep,z along the
    relation by an unknown amount and could invent or conceal an outlier.
    """
    e = base("GRB", t90=30.0, fluence=1e-5, fluenceBand="10-1000 keV",
             epeak=300.0, redshift=1.0)
    c = codes(e)
    assert "grb_amati_not_evaluated" in c
    assert "grb_amati_outlier" not in c
    assert "grb_amati_consistent" not in c

    msg = next(d.message for d in validate_event(e).diagnostics
               if d.code == "grb_amati_not_evaluated")
    assert "k-correction" in msg


def test_amati_runs_only_when_a_bolometric_eiso_is_supplied():
    e = base("GRB", t90=30.0, fluence=1e-5, fluenceBand="10-1000 keV",
             epeak=45.0, redshift=1.0, eisoBolometric=1e52)
    # Ep,z = 45 * (1+1) = 90 keV, inside the 80-100 keV band.
    assert "grb_amati_consistent" in codes(e)

    outlier = dict(e, epeak=300.0)      # Ep,z = 600 keV, far above the band
    assert "grb_amati_outlier" in codes(outlier)


def test_amati_needs_both_redshift_and_epeak():
    """Without a redshift there is no rest-frame Ep,z, so there is no check."""
    for over in ({"redshift": None}, {"epeak": None}):
        kw = {"t90": 30.0, "fluence": 1e-5, "fluenceBand": "10-1000 keV",
              "epeak": 300.0, "redshift": 1.0, **over}
        assert not any(c.startswith("grb_amati") for c in codes(base("GRB", **kw)))


def test_amati_outlier_is_not_reported_as_a_data_fault():
    """GRB 980425 is a real burst far off the relation; an outlier is a
    scientific statement, not a validation failure."""
    e = base("GRB", t90=30.0, fluence=1e-5, fluenceBand="10-1000 keV",
             epeak=300.0, redshift=1.0, eisoBolometric=1e52)
    d = next(x for x in validate_event(e).diagnostics
             if x.code == "grb_amati_outlier")
    assert d.level.name == "INFO"
    assert "do not by themselves indicate bad data" in d.message


def test_short_grb_does_not_assert_a_progenitor():
    diag = validate_event(base("GRB", t90=0.5)).diagnostics
    text = " ".join(d.message for d in diag).lower()
    for forbidden in ("is a merger", "is a binary neutron star",
                      "confirmed merger", "definitely"):
        assert forbidden not in text


def test_non_positive_t90_is_an_error():
    assert "grb_t90_non_positive" in codes(base("GRB", t90=0.0))


def test_implausible_t90_is_flagged():
    assert "grb_t90_implausible" in codes(base("GRB", t90=1e6))


def test_missing_t90_is_reported():
    assert "grb_t90_missing" in codes(base("GRB"))


def test_fluence_out_of_catalogue_range_is_flagged():
    assert "grb_fluence_implausible" in codes(base("GRB", t90=10.0, fluence=1e5))


def test_fluence_without_band_is_noticed():
    assert "grb_fluence_band_missing" in codes(
        base("GRB", t90=10.0, fluence=5e-7, fluenceBand=None))


def test_eiso_is_never_derived():
    """E_iso needs a k-correction and a cosmology; it must stay UNKNOWN."""
    c = codes(base("GRB", t90=10.0, fluence=5e-7, redshift=1.0))
    assert "grb_eiso_not_derived" in c


def test_rest_frame_requires_redshift():
    c = codes(base("GRB", t90=10.0))
    assert "grb_rest_frame_unavailable" in c
    assert "grb_rest_frame_t90" not in c


def test_rest_frame_t90_is_derived_when_redshift_present():
    rep = validate_event(base("GRB", t90=30.0, redshift=2.0))
    d = next(x for x in rep.diagnostics if x.code == "grb_rest_frame_t90")
    assert d.value == pytest.approx(10.0)          # 30 / (1 + 2)


def test_rest_frame_epeak_is_blueshifted():
    rep = validate_event(base("GRB", t90=10.0, epeak=300.0, redshift=1.0))
    d = next(x for x in rep.diagnostics if x.code == "grb_rest_frame_epeak")
    assert d.value == pytest.approx(600.0)         # 300 * (1 + 1)


def test_negative_redshift_is_an_error():
    assert "grb_redshift_negative" in codes(base("GRB", t90=10.0, redshift=-0.5))


# ---------------------------------------------------------------------------
# GW
# ---------------------------------------------------------------------------

def gw_ev(**over):
    return base("GW", **over)


def test_exhaustive_partition_must_sum_to_one():
    c = codes(gw_ev(BNS=0.9, NSBH=0.5, BBH=0.2, Terrestrial=0.1))
    assert "gw_partition_sum_invalid" in c


def test_valid_partition_passes():
    c = codes(gw_ev(BNS=0.7, NSBH=0.1, BBH=0.1, Terrestrial=0.1))
    assert "gw_partition_sum_invalid" not in c


def test_incomplete_partition_is_not_normalised():
    """A partial set must be reported, never scaled to sum to 1."""
    c = codes(gw_ev(BNS=0.4))
    assert "gw_partition_incomplete" in c
    assert "gw_partition_sum_invalid" not in c


def test_marginal_probabilities_are_not_part_of_the_partition():
    rep = validate_event(gw_ev(BNS=0.7, NSBH=0.1, BBH=0.1, Terrestrial=0.1,
                               HasNS=0.9))
    assert rep.has("gw_marginal_probability")
    assert not rep.has("gw_partition_sum_invalid")   # HasNS excluded from sum


@pytest.mark.parametrize("p", [-0.1, 1.5])
def test_probabilities_outside_zero_one(p):
    assert "gw_probability_out_of_range" in codes(gw_ev(BNS=p))


def test_chirp_mass_cross_checked_against_components():
    assert "gw_chirp_mass_inconsistent" in codes(
        gw_ev(mass1=30.0, mass2=25.0, chirpMass=5.0))


def test_consistent_chirp_mass_passes():
    # Mc = (m1*m2)^(3/5) / (m1+m2)^(1/5)
    m1, m2 = 1.4, 1.4
    mc = (m1 * m2) ** 0.6 / (m1 + m2) ** 0.2
    assert "gw_chirp_mass_inconsistent" not in codes(
        gw_ev(mass1=m1, mass2=m2, chirpMass=mc))


def test_hasns_inconsistent_with_black_hole_masses():
    assert "gw_hasns_inconsistent" in codes(
        gw_ev(mass1=30.0, mass2=25.0, HasNS=0.9))


def test_mass_ratio_is_reported():
    rep = validate_event(gw_ev(mass1=30.0, mass2=15.0))
    d = next(x for x in rep.diagnostics if x.code == "gw_mass_ratio")
    assert d.value == pytest.approx(0.5)


def test_distance_without_uncertainty_is_flagged():
    assert "gw_distance_no_uncertainty" in codes(gw_ev(luminosityDistance=400.0))


def test_distance_derived_redshift_is_labelled_model_dependent():
    rep = validate_event(gw_ev(luminosityDistance=400.0, redshift=0.09))
    d = next(x for x in rep.diagnostics if x.code == "gw_redshift_is_model_dependent")
    assert "MODEL-DEPENDENT" in d.message
    assert "spectroscopic" in d.message


def test_credible_areas_cannot_be_inverted():
    assert "gw_credible_area_inverted" in codes(
        gw_ev(area50Deg2=500.0, area90Deg2=100.0))


def test_error_radius_and_credible_region_are_distinguished():
    assert "gw_radius_vs_credible_region" in codes(
        gw_ev(area90Deg2=200.0, errorRadius=10.0))


# ---------------------------------------------------------------------------
# FRB
# ---------------------------------------------------------------------------

def test_galactic_dm_cannot_exceed_total():
    assert "frb_dm_mw_exceeds_total" in codes(
        base("FRB", dm=300.0, dmGalactic=500.0))


def test_dm_excess_is_computed_when_decomposable():
    rep = validate_event(base("FRB", dm=500.0, dmGalactic=100.0))
    d = next(x for x in rep.diagnostics if x.code == "frb_dm_excess")
    assert d.value == pytest.approx(400.0)


def test_dm_excess_inconsistency_is_caught():
    assert "frb_dm_excess_inconsistent" in codes(
        base("FRB", dm=500.0, dmGalactic=100.0, dmExcess=250.0))


def test_dm_decomposition_unavailable_without_a_model():
    c = codes(base("FRB", dm=500.0))
    assert "frb_dm_decomposition_unavailable" in c
    assert "frb_dm_excess" not in c


def test_redshift_is_never_derived_from_dm():
    rep = validate_event(base("FRB", dm=500.0))
    d = next(x for x in rep.diagnostics if x.code == "frb_redshift_not_derived")
    assert "Macquart" in d.message
    assert rep.has("frb_redshift_not_derived")


def test_missing_dm_is_reported():
    assert "frb_dm_missing" in codes(base("FRB"))


@pytest.mark.parametrize("dm", [0.0, -10.0])
def test_non_positive_dm_is_an_error(dm):
    assert "frb_dm_non_positive" in codes(base("FRB", dm=dm))


def test_implausible_dm_flagged():
    assert "frb_dm_implausible" in codes(base("FRB", dm=99999.0))


def test_implausible_pulse_width_flagged():
    assert "frb_width_implausible" in codes(base("FRB", dm=500.0, widthMs=1e6))


# ---------------------------------------------------------------------------
# Neutrino
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("unit,factor", [("GeV", 1), ("TeV", 1e3), ("PeV", 1e6)])
def test_energy_unit_conversion(unit, factor):
    assert to_gev(2.0, unit) == pytest.approx(2.0 * factor)


def test_energy_unit_is_never_guessed():
    """GeV/TeV/PeV differ by 1000x — an unlabelled energy must not be converted."""
    assert to_gev(100.0, None) is None
    assert "nu_energy_unit_unknown" in codes(
        base("NU", snr=None, signalness=0.8, energy=120.0))


def test_unrecognised_unit_is_an_error_not_an_assumption():
    assert "nu_energy_unit_unrecognised" in codes(
        base("NU", snr=None, signalness=0.8, energy=120.0, energyUnit="furlongs"))


def test_energy_converted_when_unit_given():
    rep = validate_event(base("NU", snr=None, signalness=0.8,
                              energy=120.0, energyUnit="TeV"))
    d = next(x for x in rep.diagnostics if x.code == "nu_energy_canonical")
    assert d.value == pytest.approx(1.2e5)


@pytest.mark.parametrize("sig", [-0.1, 1.4])
def test_signalness_range(sig):
    assert "nu_signalness_out_of_range" in codes(base("NU", snr=None, signalness=sig))


def test_signalness_is_not_snr():
    """An SNR on a neutrino alert is suspicious — the Phase 2 conflation."""
    rep = validate_event(base("NU", snr=12.0, signalness=0.8))
    assert rep.has("nu_snr_reported")
    assert "signalness" in " ".join(d.message for d in rep.diagnostics)


def test_missing_signalness_is_reported():
    assert "nu_signalness_missing" in codes(base("NU", snr=None))


def test_invalid_tier():
    assert "nu_tier_invalid" in codes(
        base("NU", snr=None, signalness=0.8, classificationTier="PLATINUM"))


def test_tier_signalness_mismatch():
    assert "nu_tier_signalness_mismatch" in codes(
        base("NU", snr=None, signalness=0.1, classificationTier="GOLD"))


def test_cascade_with_track_like_localization_is_suspicious():
    assert "nu_cascade_localization_suspicious" in codes(
        base("NU", snr=None, signalness=0.8, topology="cascade", errorRadius=5.0))
