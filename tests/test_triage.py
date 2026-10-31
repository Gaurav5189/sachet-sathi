"""Gemma triage: strict contract, one stricter retry, deterministic floor."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.models import Database
from app.triage import TriageCard, TriageService, classify, extract_json
from tests.test_ingest import FakeTelegram

GOOD = {
    "severity": "severe",
    "category": "flood",
    "odia_summary": "ଗ୍ରାମରେ ପାଣି ପଶିଛି, ଲୋକେ ଛାତ ଉପରେ ଅଛନ୍ତି।",
    "next_action": "Send a boat team; avoid NH-16.",
    "priority": 1,
}


def _env(tmp_path: Path, *, key: str = ""):
    settings = dataclasses.replace(
        get_settings(), data_dir=tmp_path, database_url="", gemini_api_key=key
    )
    settings.ensure_dirs()
    db = Database(settings.sqlite_path)
    db.init()
    return settings, db


def _incident(db: Database, caption: str, *, photo: str | None = None) -> int:
    return db.create_incident(
        report_id=f"tg:1:{abs(hash(caption)) % 100000}",
        reporter_tg_id=1,
        photo_path=photo,
        caption=caption,
    )


class ScriptedModel:
    """Returns canned replies in order; records what it was asked."""

    def __init__(self, *replies: str) -> None:
        self.replies = list(replies)
        self.calls: list[tuple[str, bool]] = []

    def __call__(self, caption: str, photo: bytes | None, strict: bool) -> str:
        self.calls.append((caption, strict))
        return self.replies.pop(0)


# ---- parsing --------------------------------------------------------------

def test_extract_json_tolerates_fences_and_prose() -> None:
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('Here you go: {"a": 1} — done') == {"a": 1}
    with pytest.raises(ValueError):
        extract_json("no json here")
    with pytest.raises(ValueError):
        extract_json('{"a": }')


def test_card_clips_overlong_fields() -> None:
    card = TriageCard.model_validate({**GOOD, "next_action": "x" * 500})
    assert len(card.next_action) == 200


# ---- service --------------------------------------------------------------

def test_valid_reply_is_stored_as_a_card(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _incident(db, "Village flooded, people on roofs")
    model = ScriptedModel(json.dumps(GOOD))
    service = TriageService(settings, db, generate=model)

    import asyncio

    card = asyncio.run(service.triage_incident(incident_id))

    assert card["severity"] == "severe"
    assert card["category"] == "flood"
    assert card["triage_mode"] == "gemma"
    assert card["status"] == "triaged"
    assert card["odia_summary"].startswith("ଗ୍ରାମ")
    assert model.calls == [("Village flooded, people on roofs", False)]
    # RULES §4: every model call is logged
    logged = db.list_ai_calls()
    assert len(logged) == 1 and logged[0]["ok"] == 1 and logged[0]["mode"] == "gemma"


def test_bad_json_gets_one_stricter_retry(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _incident(db, "Road blocked by a fallen tree")
    model = ScriptedModel("I think this is bad, sorry!", json.dumps(GOOD))
    service = TriageService(settings, db, generate=model)

    import asyncio

    card = asyncio.run(service.triage_incident(incident_id))

    assert card["triage_mode"] == "gemma"
    assert [strict for _, strict in model.calls] == [False, True]


def test_two_bad_replies_fall_back_to_rules(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _incident(db, "Family trapped on the roof, water rising")
    model = ScriptedModel("nope", "still nope")
    service = TriageService(settings, db, generate=model)

    import asyncio

    card = asyncio.run(service.triage_incident(incident_id))

    assert card["triage_mode"] == "fallback"
    assert card["severity"] == "severe"  # keyword: trapped
    assert card["priority"] == 1
    assert "review" in card["next_action"].lower()
    assert db.list_ai_calls()[0]["ok"] == 0


def test_model_crash_falls_back_instead_of_raising(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _incident(db, "Water entering the school shelter")

    def boom(caption: str, photo: bytes | None, strict: bool) -> str:
        raise RuntimeError("504 deadline exceeded")

    service = TriageService(settings, db, generate=boom)

    import asyncio

    card = asyncio.run(service.triage_incident(incident_id))

    assert card["triage_mode"] == "fallback"
    assert card["severity"] == "moderate"  # keyword: water
    assert card["status"] == "triaged"


def test_second_call_reuses_the_gemma_card(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _incident(db, "Embankment breach")
    model = ScriptedModel(json.dumps(GOOD))
    service = TriageService(settings, db, generate=model)

    import asyncio

    asyncio.run(service.triage_incident(incident_id))
    again = asyncio.run(service.triage_incident(incident_id))

    assert again["reused"] is True
    assert len(model.calls) == 1  # no second model call


def test_classify_keywords() -> None:
    assert classify("Two people trapped, roof collapsing")[0] == "severe"
    assert classify("NH-16 flooded near Barang")[0] == "moderate"
    assert classify("Everything looks fine here")[0] == "low"
    assert classify("Flooded lane")[1] == "flood"
    assert classify("Bridge washed out")[1] == "damage"
    assert classify("Need drinking water and blankets")[1] == "supply"
    assert classify("Someone injured, need ambulance")[1] == "medical"


def test_synonym_labels_are_mapped_not_rejected() -> None:
    card = TriageCard.model_validate(
        {
            "severity": "High",
            "category": "infrastructure/transportation",
            "odia_summary": "ରାସ୍ତା ବନ୍ଦ ଅଛି।",
            "next_action": "Clear the road.",
            "priority": 5,
        }
    )

    assert (card.severity, card.category, card.priority) == ("severe", "damage", 3)


def test_single_card_wrapped_in_a_list_is_unwrapped() -> None:
    assert extract_json('[{"severity": "low"}]') == {"severity": "low"}
    with pytest.raises(ValueError):
        extract_json('[{"a": 1}, {"b": 2}]')


def test_transport_failure_is_retried_once(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _incident(db, "Water rising near the embankment")
    attempts = {"n": 0}

    def flaky(caption: str, photo: bytes | None, strict: bool) -> str:
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("500 INTERNAL")
        return json.dumps(GOOD)

    import asyncio

    card = asyncio.run(TriageService(settings, db, generate=flaky).triage_incident(incident_id))

    assert attempts["n"] == 2
    assert card["triage_mode"] == "gemma"


# ---- api ------------------------------------------------------------------

def _client(tmp_path: Path, *, generate=None, key: str = ""):
    settings, db = _env(tmp_path, key=key)
    app = create_app(settings, telegram_client=FakeTelegram())
    app.state.triage = TriageService(settings, db, generate=generate)
    return TestClient(app), db


def test_triage_endpoint_returns_card(tmp_path: Path) -> None:
    client, db = _client(tmp_path, generate=ScriptedModel(json.dumps(GOOD)))
    incident_id = _incident(db, "Flooded road at Barang")

    res = client.post(f"/api/incidents/{incident_id}/triage")

    assert res.status_code == 200
    assert res.json()["severity"] == "severe"
    assert client.get("/api/incidents").json()["incidents"][0]["triage_mode"] == "gemma"


def test_triage_endpoint_404_for_unknown_incident(tmp_path: Path) -> None:
    client, _ = _client(tmp_path, generate=ScriptedModel(json.dumps(GOOD)))
    res = client.post("/api/incidents/9999/triage")
    assert res.status_code == 404
    assert res.json()["error"] == "incident_not_found"


def test_triage_endpoint_503_without_key(tmp_path: Path) -> None:
    client, db = _client(tmp_path)  # no key, no injected model
    incident_id = _incident(db, "Flooded road")

    res = client.post(f"/api/incidents/{incident_id}/triage")

    assert res.status_code == 503
    assert res.json()["error"] == "triage_not_configured"
