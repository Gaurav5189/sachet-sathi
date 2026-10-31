"""Telegram ingest: one message → one incident, and the loop survives bad input."""

from __future__ import annotations

import asyncio
import dataclasses
from pathlib import Path
from typing import Any

import pytest

from app.config import get_settings
from app.ingest import handle_update, poll_forever
from app.models import Database
from app.telegram import deliver, flush_outbox


class FakeTelegram:
    """Records calls, never touches the network."""

    def __init__(self, *, fail_send: bool = False) -> None:
        self.configured = True
        self.messages: list[tuple[Any, str]] = []
        self.photos: list[tuple[Any, str, str]] = []
        self.markups: list[Any] = []
        self.edits: list[tuple[Any, int, str, Any]] = []
        self.answers: list[tuple[str, str | None]] = []
        self.updates: list[dict[str, Any]] = []
        self.fail_send = fail_send
        self.downloads = {"photo-1": b"JPEGBYTES"}
        self.closed = False

    async def get_me(self) -> dict[str, Any]:
        return {"id": 42, "is_bot": True, "first_name": "SachetSathi", "username": "sachet_bot"}

    async def get_updates(self, offset: int | None = None) -> list[dict[str, Any]]:
        batch, self.updates = self.updates, []
        return batch

    async def download_file(self, file_id: str) -> bytes:
        return self.downloads.get(file_id, b"JPEGBYTES")

    async def send_message(
        self, chat_id: Any, text: str, *, reply_markup: Any = None
    ) -> dict[str, Any]:
        if self.fail_send:
            raise RuntimeError("telegram is down")
        self.messages.append((chat_id, text))
        self.markups.append(reply_markup)
        return {"message_id": 1}

    async def send_photo(
        self, chat_id: Any, photo: Any, caption: str = "", *, reply_markup: Any = None
    ) -> dict[str, Any]:
        if self.fail_send:
            raise RuntimeError("telegram is down")
        self.photos.append((chat_id, str(photo), caption))
        self.markups.append(reply_markup)
        return {"message_id": 2}

    async def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> bool:
        self.answers.append((callback_query_id, text))
        return True

    async def edit_message_text(
        self, chat_id: Any, message_id: int, text: str, *, reply_markup: Any = None
    ) -> dict[str, Any]:
        self.edits.append((chat_id, message_id, text, reply_markup))
        return {}

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture()
def env(tmp_path: Path):
    settings = dataclasses.replace(
        get_settings(), data_dir=tmp_path, database_url="", telegram_bot_token="", telegram_channel_id=""
    )
    settings.ensure_dirs()
    db = Database(settings.sqlite_path)
    db.init()
    return settings, db


def _photo_update(message_id: int = 11, caption: str = "NH-16 flooded near Barang") -> dict:
    return {
        "update_id": 100 + message_id,
        "message": {
            "message_id": message_id,
            "chat": {"id": 777},
            "from": {"id": 777, "first_name": "Asha"},
            "caption": caption,
            "photo": [
                {"file_id": "small", "file_unique_id": "photo-0", "width": 90, "file_size": 1000},
                {"file_id": "photo-1", "file_unique_id": "photo-1", "width": 800, "file_size": 90000},
            ],
        },
    }


def test_photo_report_becomes_a_pending_incident(env) -> None:
    settings, db = env
    client = FakeTelegram()

    outcome = asyncio.run(handle_update(_photo_update(), db=db, client=client, settings=settings))

    assert outcome.incident_id is not None
    incident = db.get_incident(outcome.incident_id)
    assert incident["status"] == "pending"
    assert incident["caption"] == "NH-16 flooded near Barang"
    assert incident["photo_path"] and Path(incident["photo_path"]).exists()
    assert Path(incident["photo_path"]).read_bytes() == b"JPEGBYTES"
    # reporter counted once, ack sent back to the reporter
    assert client.messages and client.messages[0][0] == 777
    assert f"#{outcome.incident_id}" in client.messages[0][1]


def test_text_only_report_is_accepted(env) -> None:
    settings, db = env
    client = FakeTelegram()
    update = {
        "update_id": 200,
        "message": {
            "message_id": 21,
            "chat": {"id": 888},
            "from": {"id": 888, "first_name": "Ravi"},
            "text": "Tree down blocking the school gate",
        },
    }

    outcome = asyncio.run(handle_update(update, db=db, client=client, settings=settings))

    incident = db.get_incident(outcome.incident_id)
    assert incident["photo_path"] is None
    assert "text only" in client.messages[0][1]


def test_empty_message_gets_a_hint_and_creates_nothing(env) -> None:
    settings, db = env
    client = FakeTelegram()
    update = {"update_id": 300, "message": {"message_id": 31, "chat": {"id": 999}, "from": {"id": 999}}}

    outcome = asyncio.run(handle_update(update, db=db, client=client, settings=settings))

    assert outcome.incident_id is None
    assert "Send a photo" in client.messages[0][1]
    assert db.list_incidents() == []


def test_start_command_welcomes_instead_of_creating_a_report(env) -> None:
    settings, db = env
    client = FakeTelegram()
    update = {
        "update_id": 400,
        "message": {"message_id": 41, "chat": {"id": 555}, "from": {"id": 555}, "text": "/start"},
    }

    outcome = asyncio.run(handle_update(update, db=db, client=client, settings=settings))

    assert outcome.note == "welcome"
    assert "SachetSathi" in client.messages[0][1]
    assert db.list_incidents() == []


def test_replayed_update_does_not_duplicate_the_incident(env) -> None:
    settings, db = env
    client = FakeTelegram()
    update = _photo_update()

    first = asyncio.run(handle_update(update, db=db, client=client, settings=settings))
    second = asyncio.run(handle_update(update, db=db, client=client, settings=settings))

    assert first.incident_id == second.incident_id
    assert len(db.list_incidents()) == 1


def test_failed_ack_is_queued_then_flushed(env) -> None:
    settings, db = env
    client = FakeTelegram(fail_send=True)

    asyncio.run(handle_update(_photo_update(), db=db, client=client, settings=settings))

    pending = db.pending_outbox()
    assert len(pending) == 1
    assert pending[0]["kind"] == "ack"
    assert pending[0]["attempts"] == 0

    client.fail_send = False
    result = asyncio.run(flush_outbox(db, client))

    assert result == {"sent": 1, "failed": 0}
    assert db.pending_outbox() == []
    assert client.messages  # the ack eventually reached the reporter


def test_flush_marks_failures_without_raising(env) -> None:
    settings, db = env
    client = FakeTelegram(fail_send=True)
    asyncio.run(deliver(db, client, chat_id=777, kind="ack", text="hello"))

    result = asyncio.run(flush_outbox(db, client))

    assert result == {"sent": 0, "failed": 1}
    assert db.pending_outbox()[0]["attempts"] == 1


def test_poll_loop_survives_a_failing_poll(env, monkeypatch: pytest.MonkeyPatch) -> None:
    settings, db = env
    calls = {"n": 0}
    stop = asyncio.Event()

    class FlakyClient(FakeTelegram):
        async def get_updates(self, offset: int | None = None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("connection reset")
            stop.set()
            return []

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("app.ingest.asyncio.sleep", no_sleep)

    asyncio.run(
        asyncio.wait_for(
            poll_forever(db=db, client=FlakyClient(), settings=settings, stop=stop),
            timeout=5,
        )
    )

    assert calls["n"] >= 2  # it retried after the failure


# ---- digest buttons (telegram-send-demo pattern) --------------------------

def _callback_update(data: str, *, text: str = "<b>DIGEST</b>\n\nbody") -> dict:
    return {
        "update_id": 900,
        "callback_query": {
            "id": "cq-1",
            "from": {"id": 9, "first_name": "Meera"},
            "data": data,
            "message": {"message_id": 77, "chat": {"id": -100200}, "text": text},
        },
    }


def test_callback_is_answered_and_edited_in_place(env) -> None:
    settings, db = env
    client = FakeTelegram()

    outcome = asyncio.run(
        handle_update(_callback_update("digest_ack"), db=db, client=client, settings=settings)
    )

    assert outcome.note == "callback: acknowledged"
    # answered immediately, or the coordinator's client spins for 30s
    assert client.answers == [("cq-1", "Acknowledged")]
    chat_id, message_id, text, markup = client.edits[0]
    assert (chat_id, message_id) == (-100200, 77)
    assert text.endswith("— Acknowledged by Meera ✅")
    assert markup == {"inline_keyboard": []}  # can't be tapped twice
    assert db.get_state("digest_decision:77") == "digest_ack:Meera"


def test_second_tap_does_not_stack_status_lines(env) -> None:
    settings, db = env
    client = FakeTelegram()
    first = _callback_update("digest_ack")
    asyncio.run(handle_update(first, db=db, client=client, settings=settings))

    edited = client.edits[0][2]
    second = _callback_update("digest_escalate", text=edited)
    asyncio.run(handle_update(second, db=db, client=client, settings=settings))

    text = client.edits[1][2]
    assert text.count("— ") == 1
    assert text.endswith("— Escalated by Meera ⏰")


def test_unknown_callback_is_still_answered(env) -> None:
    settings, db = env
    client = FakeTelegram()

    outcome = asyncio.run(
        handle_update(_callback_update("something_else"), db=db, client=client, settings=settings)
    )

    assert outcome.note == "callback: unknown"
    assert client.answers and client.answers[0][0] == "cq-1"
    assert client.edits == []


def test_callback_without_message_text_does_not_crash(env) -> None:
    settings, db = env
    client = FakeTelegram()
    update = _callback_update("digest_ack", text="")
    update["callback_query"]["message"].pop("text")

    outcome = asyncio.run(handle_update(update, db=db, client=client, settings=settings))

    assert outcome.note == "callback: not editable"
    assert client.answers  # still acknowledged
    assert client.edits == []
