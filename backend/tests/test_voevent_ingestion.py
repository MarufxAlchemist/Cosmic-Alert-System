"""
test_voevent_ingestion.py
-------------------------
Regression tests for the reason no GRB ever reached the dashboard.

Measured against the live broker on 2026-08-17: of the six subscribed topics,
the only dedicated GRB stream (gcn.notices.swift.bat.guano) had ZERO retained
messages, while Fermi GBM carried 158 notices and SVOM 131 — on topics that
were not subscribed, in an encoding the consumer discarded.

The gcn.classic.* family is VOEvent XML. json.loads() failed on it and the
consumer fell through to {"raw_text": ...}, so a Fermi notice normalized to an
event with no position, no time and no significance.

The GRB fixture below is GCN Circular 45377 / trigger 808341387 (GRB 260813A),
so the parser is checked against a published human-readable localization.
"""

import pytest

from app.gcn import voevent
from app.gcn.normalizer import normalize
from app.gcn.topics import TOPICS, TOPIC_METADATA

FERMI_FIN = "gcn.classic.voevent.FERMI_GBM_FIN_POS"
EP_TOPIC = "gcn.notices.einstein_probe.wxt.alert"

# Trimmed from the real notice; structure and values verbatim.
GBM_XML = """<?xml version = '1.0' encoding = 'UTF-8'?>
<voe:VOEvent ivorn="ivo://nasa.gsfc.gcn/Fermi#GBM_Fin_Pos_808341387"
  role="observation" version="2.0" xmlns:voe="http://www.ivoa.net/xml/VOEvent/v2.0">
  <What>
    <Param name="Packet_Type" value="115" />
    <Param name="TrigID" value="808341387" ucd="meta.id" />
    <Param name="Data_Signif" value="17.20" unit="sigma" ucd="stat.snr" />
    <Group name="Trigger_ID">
      <Param name="Def_NOT_a_GRB" value="false" />
      <Param name="Test_Submission" value="false" />
    </Group>
  </What>
  <WhereWhen>
    <ObsDataLocation><ObservationLocation>
      <AstroCoords coord_system_id="UTC-FK5-GEO">
        <Time unit="s"><TimeInstant><ISOTime>2026-08-13T19:16:22.09</ISOTime></TimeInstant></Time>
        <Position2D unit="deg">
          <Value2><C1>231.4200</C1><C2>-57.7500</C2></Value2>
          <Error2Radius>2.4800</Error2Radius>
        </Position2D>
      </AstroCoords>
    </ObservationLocation></ObsDataLocation>
  </WhereWhen>
</voe:VOEvent>"""


def _norm(xml, topic=FERMI_FIN):
    doc = voevent.parse(xml)
    assert doc is not None
    return normalize(topic, {"_voevent_doc": doc})


# ── Topic subscription ──────────────────────────────────────────────────────

def test_fermi_gbm_is_subscribed():
    """The instrument that reports most GRBs must be in the topic list."""
    assert any("FERMI_GBM" in t for t in TOPICS)
    for t in TOPICS:
        if "FERMI_GBM" in t or "svom" in t:
            assert TOPIC_METADATA[t].event_type == "GRB"


# ── VOEvent parsing ─────────────────────────────────────────────────────────

def test_voevent_is_detected_and_parsed():
    assert voevent.looks_like_voevent(GBM_XML)
    doc = voevent.parse(GBM_XML)
    assert doc["role"] == "observation"
    assert doc["params"]["TrigID"] == "808341387"


@pytest.mark.parametrize("junk", ["", "not xml", "<html><body/></html>", "{}"])
def test_unparseable_input_returns_none_rather_than_raising(junk):
    assert voevent.parse(junk) is None


def test_matches_the_published_circular():
    """
    GCN Circular 45377 states: trigger 808341387, RA = 231.4, Dec = -57.8,
    19:16:22 UT on 13 Aug 2026, statistical uncertainty 2.5 degrees.
    """
    ev = _norm(GBM_XML)
    assert ev["eventId"] == "GRB808341387"
    assert ev["eventType"] == "GRB"
    assert ev["observatory"] == "Fermi-GBM"
    assert ev["detectionTime"].startswith("2026-08-13T19:16:22")
    assert ev["ra"] == pytest.approx(231.42, abs=0.01)
    assert ev["dec"] == pytest.approx(-57.75, abs=0.01)
    assert ev["snr"] == pytest.approx(17.2)


def test_error_radius_is_converted_degrees_to_arcmin():
    """
    Error2Radius is in the unit declared on Position2D (deg); errorRadius is
    arcmin everywhere in this codebase. 2.48 deg -> 148.8 arcmin, which is the
    2.5 deg the circular quotes. Storing it unconverted would claim a
    localization 60x better than reported.
    """
    ev = _norm(GBM_XML)
    assert ev["errorRadius"] == pytest.approx(148.8, abs=0.01)
    assert ev["errorRadius"] / 60.0 == pytest.approx(2.48, abs=0.01)


def test_all_four_gbm_stages_collapse_onto_one_event():
    """TrigID is the stable key, so a refined position revises the burst
    instead of creating a second one."""
    ids = set()
    for topic in ["gcn.classic.voevent.FERMI_GBM_ALERT",
                  "gcn.classic.voevent.FERMI_GBM_FLT_POS",
                  "gcn.classic.voevent.FERMI_GBM_GND_POS",
                  FERMI_FIN]:
        ids.add(_norm(GBM_XML, topic)["eventId"])
    assert ids == {"GRB808341387"}


# ── Non-observations must not be ingested ───────────────────────────────────

@pytest.mark.parametrize("mutation,is_control", [
    ('role="observation"', True),
    ('role="test"', False),
    ('role="utility"', False),
])
def test_only_observations_are_accepted(mutation, is_control):
    doc = voevent.parse(GBM_XML.replace('role="observation"', mutation))
    assert voevent.is_observation(doc) is is_control


def test_flagged_non_grb_triggers_are_rejected():
    """A trigger the flight software already attributed to a particle event or
    known source must not be published as a burst."""
    doc = voevent.parse(GBM_XML.replace(
        '<Param name="Def_NOT_a_GRB" value="false" />',
        '<Param name="Def_NOT_a_GRB" value="true" />'))
    assert voevent.is_observation(doc) is False


def test_test_submissions_are_rejected():
    doc = voevent.parse(GBM_XML.replace(
        '<Param name="Test_Submission" value="false" />',
        '<Param name="Test_Submission" value="true" />'))
    assert voevent.is_observation(doc) is False


# ── Einstein Probe schema conformance ───────────────────────────────────────

EP_REAL = {"instrument": "WXT", "trigger_time": "2026-07-23T18:46:56.00Z",
           "id": ["11916655551"], "ra": 2.938, "dec": -12.112,
           "ra_dec_error": 0.05, "image_snr": 6.6}


def test_ep_array_id_does_not_leak_into_the_event_id():
    """`id` is an array in the GCN v4 core Event schema; interpolating it
    produced identifiers like EP-open-bracket-quote-11916655551."""
    assert normalize(EP_TOPIC, EP_REAL)["eventId"] == "EP11916655551"


def test_ep_localization_is_read_and_converted():
    """The field is ra_dec_error in DEGREES, not err_rad/loc_error. The parser
    looked for names that do not exist in this schema, so every Einstein Probe
    localization was silently discarded."""
    assert normalize(EP_TOPIC, EP_REAL)["errorRadius"] == pytest.approx(3.0)


@pytest.mark.parametrize("val,expected_arcmin", [
    (0.05, 3.0),
    ([0.08, 0.04, 30], 4.8),      # semi-major is element 0, NOT max()
    ([0.02, 0.01, 175], 1.2),     # position angle 175 must never win
    ([0.08], 4.8),
])
def test_ellipse_uses_the_semi_major_axis_by_position(val, expected_arcmin):
    """
    The third element is a position angle on the sky, not a length. Taking
    max() would store [0.08, 0.04, 30] as a 1800 arcmin region instead of
    4.8 arcmin — a 375x inflation of the search area.
    """
    ev = normalize(EP_TOPIC, dict(EP_REAL, ra_dec_error=val))
    assert ev["errorRadius"] == pytest.approx(expected_arcmin)


def test_ep_containment_uses_the_schema_default_but_never_guesses():
    assert normalize(EP_TOPIC, EP_REAL)["errorRadiusContainment"] == "90_2D"
    assert normalize(EP_TOPIC, dict(EP_REAL, containment_probability=0.5)
                     )["errorRadiusContainment"] == "50_2D"
    # An unrecognised fraction is reported as unstated, not snapped to the
    # nearest convention — the rescaling between conventions is up to 2.15x.
    assert normalize(EP_TOPIC, dict(EP_REAL, containment_probability=0.77)
                     )["errorRadiusContainment"] is None
