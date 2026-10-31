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
    # `telegram` = reports-in (token only); `telegram_channel` = digests-out.
    assert set(body["capabilities"]) == {"telegram", "telegram_channel", "gemma"}


def test_health_does_not_leak_secrets() -> None:
    body = _client().get("/api/health").text.lower()
    for needle in ("token", "api_key", "gemini_api"):
        assert needle not in body


def test_root_serves_pwa_or_fallback() -> None:
    res = _client().get("/")
    assert res.status_code == 200
    # Could be the PWA HTML (if web/ is present) or the JSON fallback
    # Either way, the API health endpoint is linked.
    content_type = res.headers.get("content-type", "")
    if "text/html" in content_type:
        assert "SachetSathi" in res.text
    else:
        assert res.json()["health"] == "/api/health"


# ---- capability split: reports-in needs a token, digests-out need a channel --


def test_token_only_starts_the_poller(tmp_path) -> None:
    """Regression: the poller used to require TELEGRAM_CHANNEL_ID and stayed idle."""
    import dataclasses

    from app.config import get_settings
    from tests.test_ingest import FakeTelegram

    settings = dataclasses.replace(
        get_settings(),
        data_dir=tmp_path,
        database_url="",
        telegram_bot_token="123:abc",
        telegram_channel_id="",
    )
    app = create_app(settings, telegram_client=FakeTelegram())

    with TestClient(app) as client:
        body = client.get("/api/health").json()
        assert body["capabilities"]["telegram"] is True
        assert body["capabilities"]["telegram_channel"] is False
        assert app.state.poller is not None
        assert not app.state.poller.done()

    assert app.state.poller.done()  # cancelled on shutdown


def test_no_token_keeps_the_poller_idle(tmp_path) -> None:
    import dataclasses

    from app.config import get_settings
    from tests.test_ingest import FakeTelegram

    settings = dataclasses.replace(
        get_settings(),
        data_dir=tmp_path,
        database_url="",
        telegram_bot_token="",
        telegram_channel_id="-1001234567890",
    )
    app = create_app(settings, telegram_client=FakeTelegram())

    with TestClient(app):
        assert app.state.poller is None
