"""Phase 0 contract: the app boots and health answers."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import __version__
from app.main import create_app


def _client() -> TestClient:
    return TestClient(create_app())


def test_health_ok() -> None:
    res = _client().get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["app"] == "SachetSathi"
    assert body["version"] == __version__
    assert set(body["capabilities"]) == {"telegram", "gemma"}


def test_health_does_not_leak_secrets() -> None:
    body = _client().get("/api/health").text.lower()
    for needle in ("token", "api_key", "gemini_api"):
        assert needle not in body


def test_root_points_at_health() -> None:
    res = _client().get("/")
    assert res.status_code == 200
    assert res.json()["health"] == "/api/health"
