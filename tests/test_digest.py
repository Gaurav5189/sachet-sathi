"""Digest: content honesty + the sent/queued contract."""

from __future__ import annotations

import asyncio
import dataclasses
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import get_settings
from app.digest import build_digest, send_digest
from app.main import create_app
from app.models import Database
from tests.test_ingest import FakeTelegram


def _env(tmp_path: Path, *, channel: str = "-100200300"):
    settings = dataclasses.replace(
        get_settings(),
        data_dir=tmp_path,
        database_url="",
        telegram_bot_token="test-token",
        telegram_channel_id=channel,
    )
    settings.ensure_dirs()
    db = Database(settings.sqlite_path)
    db.init()
    return settings, db


def _triaged(db: Database, caption: str, *, severity: str = "severe", category: str = "flood") -> int:
    incident_id = db.create_incident(
        report_id=f"tg:1:{hash(caption) & 0xFFFF}", reporter_tg_id=1, photo_path=None, caption=caption
    )
    db.save_triage(
        incident_id,
        severity=severity,
        category=category,
        odia_summary="ଓଡ଼ିଆ ସାରାଂଶ",
        next_action="Avoid NH-16, route via Cuttack bypass",
        priority=1,
        triage_mode="gemma",
    )
    return incident_id


def _service(settings, db):
    from app.alerts import AlertsService

    return AlertsService(settings, db)


def test_digest_quotes_the_official_alert_and_labels_ai(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    _triaged(db, "NH-16 flooded near Barang, water knee deep")

    digest = build_digest(db, _service(settings, db), demo=True)

    assert "SACHETSATHI DIGEST" in digest.text
    assert "ARNAB-26" in digest.text
    assert "fixture replay (not live)" in digest.text
    assert "FIELD REPORTS</b> (1)" in digest.text
    assert "NH-16 flooded" in digest.text
    assert "AI-assisted" in digest.text
    assert digest.alert_id == "gdacs:TC1001345"
    assert len(digest.incident_ids) == 1


def test_digest_without_incidents_is_honest(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    digest = build_digest(db, _service(settings, db), demo=True)

    assert "No triaged reports yet." in digest.text
    assert digest.incident_ids == []


def test_send_marks_incidents_sent(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _triaged(db, "Bridge approach washed out")
    client = FakeTelegram()

    result = asyncio.run(
        send_digest(db, client, _service(settings, db), chat_id=settings.telegram_channel_id, demo=True)
    )

    assert result["sent"] is True
    assert result["queued"] is False
    assert client.messages[0][0] == settings.telegram_channel_id
    assert db.get_incident(incident_id)["status"] == "sent"
    # the post carries the Acknowledge / Escalate buttons from the demo pattern
    keyboard = client.markups[0]["inline_keyboard"][0]
    assert [b["callback_data"] for b in keyboard] == ["digest_ack", "digest_escalate"]


def test_failed_send_queues_and_leaves_incidents_triaged(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    incident_id = _triaged(db, "Shelter roof blown off")
    client = FakeTelegram(fail_send=True)

    result = asyncio.run(
        send_digest(db, client, _service(settings, db), chat_id=settings.telegram_channel_id, demo=True)
    )

    assert result["sent"] is False
    assert result["queued"] is True
    assert db.get_incident(incident_id)["status"] == "triaged"  # not lost, will resend
    assert db.pending_outbox()[0]["kind"] == "digest"


def test_digest_endpoint_409_without_channel(tmp_path: Path) -> None:
    settings, _ = _env(tmp_path, channel="")
    client = TestClient(create_app(settings, telegram_client=FakeTelegram()))

    res = client.post("/api/digest", params={"demo": "1"})

    assert res.status_code == 409
    assert res.json()["error"] == "channel_not_configured"


def test_digest_endpoint_posts_to_channel(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    _triaged(db, "Embankment breach at Kalipatna")
    fake = FakeTelegram()
    client = TestClient(create_app(settings, telegram_client=fake))

    res = client.post("/api/digest", params={"demo": "1"})

    assert res.status_code == 200
    body = res.json()
    assert body["sent"] is True
    assert body["incidents"] == 1
    assert "ARNAB-26" in body["text"]
    assert fake.messages and "SACHETSATHI DIGEST" in fake.messages[0][1]


def test_digest_preview_has_no_side_effects(tmp_path: Path) -> None:
    settings, db = _env(tmp_path)
    _triaged(db, "Culvert blocked")
    fake = FakeTelegram()
    client = TestClient(create_app(settings, telegram_client=fake))

    body = client.get("/api/digest/preview", params={"demo": "1"}).json()

    assert "SACHETSATHI DIGEST" in body["text"]
    assert fake.messages == []
    assert db.list_incidents(status="triaged")[0]["status"] == "triaged"


def test_bot_endpoint_returns_identity(tmp_path: Path) -> None:
    settings, _ = _env(tmp_path)
    client = TestClient(create_app(settings, telegram_client=FakeTelegram()))

    body = client.get("/api/telegram/bot").json()

    assert body["username"] == "sachet_bot"
    assert body["deep_link"] == "https://t.me/sachet_bot"


def test_bot_endpoint_503_without_token(tmp_path: Path) -> None:
    settings, _ = _env(tmp_path)
    fake = FakeTelegram()
    fake.configured = False
    client = TestClient(create_app(settings, telegram_client=fake))

    res = client.get("/api/telegram/bot")

    assert res.status_code == 503
    assert res.json()["error"] == "telegram_not_configured"
