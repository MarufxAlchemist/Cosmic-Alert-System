"""
test_circular_hints.py
-----------------------
circular_hints.py wraps a third-party package's regex triage step. The one
invariant that matters here is that nothing about that wrapping can ever
take down the circular Kafka path: a missing package, a bad import, or an
exception inside the package's own regex code must all degrade to
`None`, never propagate.

No network, no credentials, no database — build_regexp_hints is pure text
processing (see the installed package's hints.py).
"""

from pathlib import Path
import sys

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.gcn import circular_hints  # noqa: E402


SUBJECT = "GRB 250531A: GOTO optical observations and afterglow candidate"
BODY = (
    "The GOTO collaboration reports a fading optical source consistent with "
    "the Swift-BAT localization of GRB 250531A. Photometry: r' = 19.3 mag. "
    "Redshift z~1.2 estimated from photometric colors."
)


def test_hints_available_reflects_a_successful_import():
    # This suite installs astro-colibri-circular-parser via requirements.txt,
    # so on a correctly provisioned host this must be True. If it's False the
    # dependency isn't actually installed, which is a real failure to catch
    # here rather than downstream as silently-None hints in production.
    assert circular_hints.hints_available() is True


def test_build_hints_safe_returns_the_package_output_for_a_real_circular():
    hints = circular_hints.build_hints_safe(SUBJECT, BODY)

    assert hints is not None
    assert hints["source_name"] == "GRB 250531A"
    assert hints["likely_optical_followup"] is True
    assert hints["likely_redshift_report"] is True
    assert "GOTO" in hints["matched_terms"]


def test_build_hints_safe_handles_empty_input_without_raising():
    hints = circular_hints.build_hints_safe("", "")
    assert hints is not None
    assert hints["source_name"] == ""


@pytest.mark.parametrize("subject,body", [(None, "text"), ("subject", None), (None, None)])
def test_build_hints_safe_tolerates_none_fields(subject, body):
    # A circular payload with a missing subject/body would otherwise crash
    # the hints step with a TypeError inside the third-party regex code.
    assert circular_hints.build_hints_safe(subject, body) is not None


def test_build_hints_safe_swallows_an_exception_from_the_package(monkeypatch):
    def _boom(_subject, _body):
        raise RuntimeError("simulated parser failure")

    monkeypatch.setattr(circular_hints, "_build_regexp_hints", _boom)
    assert circular_hints.build_hints_safe(SUBJECT, BODY) is None


def test_build_hints_safe_returns_none_when_the_package_is_unavailable(monkeypatch):
    monkeypatch.setattr(circular_hints, "_build_regexp_hints", None)
    assert circular_hints.build_hints_safe(SUBJECT, BODY) is None
