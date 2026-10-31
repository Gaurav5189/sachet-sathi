"""Alerts pipeline: parser contract + the fallback the demo depends on."""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.alerts import AlertsService, parse_gdacs
from app.config import FIXTURES_DIR, get_settings
from app.main import create_app
from app.models import Database, utcnow

FIXTURE_XML = FIXTURES_DIR / "gdacs-sample.xml"


def _settings(tmp_path: Path):
    return dataclasses.replace(get_settings(), data_dir=tmp_path, database_url="")


def _service(tmp_path: Path) -> AlertsService:
    settings = _settings(tmp_path)
    db = Database(settings.sqlite_path)
    db.init()
    return AlertsService(settings, db)


# ---- parser ---------------------------------------------------------------

def test_parses_fixture_into_alerts() -> None:
    alerts = parse_gdacs(FIXTURE_XML.read_bytes())

    assert len(alerts) == 5
    by_id = {a.id: a for a in alerts}

    arnab = by_id["gdacs:TC1001345"]
    assert arnab.event_name == "ARNAB-26"
    assert arnab.severity == "severe"
    assert arnab.alert_level == "red"
    assert arnab.area == "India"
    assert arnab.event_type == "TC"
    assert arnab.lat == pytest.approx(16.4)
    assert arnab.lon == pytest.approx(81.8)
    assert arnab.observed_at is not None and arnab.observed_at.endswith("+00:00")
    assert arnab.url.startswith("http")

    # Severity comes from the feed's alert level, nothing else.
    assert {a.severity for a in alerts} <= {"low", "moderate", "severe"}


def test_relevance_keeps_the_bay_of_bengal_and_drops_the_pacific() -> None:
    alerts = {a.id: a for a in parse_gdacs(FIXTURE_XML.read_bytes())}

    assert alerts["gdacs:TC1001345"].is_relevant is True   # ARNAB-26, 16.4N 81.8E
    assert alerts["gdacs:TC1001344"].is_relevant is False  # South Pacific
    assert alerts["gdacs:FL1104248"].is_relevant is True   # India flood


def test_parser_rejects_non_rss() -> None:
    with pytest.raises(ValueError):
        parse_gdacs("<html><body>gateway timeout</body></html>")


# ---- service --------------------------------------------------------------

def test_demo_mode_replays_fixture_and_labels_itself(tmp_path: Path) -> None:
    feed = _service(tmp_path).feed(demo=True)

    assert feed.demo is True
    assert feed.stale is False
    assert len(feed.alerts) == 5
    assert "not live data" in feed.note
    # severity-sorted: the red cyclone leads
    assert feed.alerts[0].id == "gdacs:TC1001345"


def test_live_fetch_failure_falls_back_to_fixture_when_db_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import httpx

    def boom(*_args, **_kwargs):
        raise httpx.ConnectTimeout("venue wifi died")

    monkeypatch.setattr(httpx, "get", boom)
    feed = _service(tmp_path).feed(demo=False)

    assert feed.stale is True
    assert feed.demo is True
    assert len(feed.alerts) == 5
    assert "Live fetch failed" in feed.note


def test_live_fetch_failure_serves_last_cached_rows_as_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import httpx

    service = _service(tmp_path)
    seeded = parse_gdacs(FIXTURE_XML.read_bytes())
    now = utcnow()
    for alert in seeded:
        alert.fetched_at = now
    service.db.upsert_alerts(a.to_row() for a in seeded)

    def boom(*_args, **_kwargs):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(httpx, "get", boom)
    feed = service.feed(demo=False)

    assert feed.stale is True
    assert feed.demo is False
    assert len(feed.alerts) == 5
    assert all(a.stale for a in feed.alerts)
    assert "cached" in feed.note


def test_upsert_is_idempotent(tmp_path: Path) -> None:
    service = _service(tmp_path)
    alerts = parse_gdacs(FIXTURE_XML.read_bytes())
    service.db.upsert_alerts(a.to_row() for a in alerts)
    service.db.upsert_alerts(a.to_row() for a in alerts)

    assert service.db.count_alerts() == 5


# ---- api ------------------------------------------------------------------

def test_alerts_endpoint_demo_mode(tmp_path: Path) -> None:
    client = TestClient(create_app(_settings(tmp_path)))
    res = client.get("/api/alerts", params={"demo": "1"})

    assert res.status_code == 200
    body = res.json()
    assert body["demo"] is True
    assert body["count"] == 5
    assert body["alerts"][0]["severity"] == "severe"


def test_alerts_endpoint_filters_by_severity(tmp_path: Path) -> None:
    client = TestClient(create_app(_settings(tmp_path)))
    body = client.get("/api/alerts", params={"demo": "1", "severity": "severe"}).json()

    assert body["count"] == 1
    assert body["alerts"][0]["id"] == "gdacs:TC1001345"


def test_alerts_endpoint_rejects_unknown_severity(tmp_path: Path) -> None:
    client = TestClient(create_app(_settings(tmp_path)))
    res = client.get("/api/alerts", params={"demo": "1", "severity": "apocalyptic"})
    assert res.status_code == 422


def test_alerts_endpoint_relevant_filter(tmp_path: Path) -> None:
    client = TestClient(create_app(_settings(tmp_path)))
    body = client.get("/api/alerts", params={"demo": "1", "relevant": "1"}).json()

    assert body["count"] == 2  # ARNAB-26 + the India flood
    assert body["alerts"][0]["event_name"] == "ARNAB-26"
