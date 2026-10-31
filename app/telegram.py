"""Minimal Telegram Bot API client (long polling, no webhooks).

Patterns taken from the `telegram-send-demo` reference (AGENT.md §4):
  * long polling, short poll timeout so relays can hold the request
  * inline keyboard + `answerCallbackQuery` on *every* tap (otherwise the
    client spins for ~30s), then edit-in-place and drop the keyboard so an
    action cannot be taken twice
  * `getMe` for bot identity, `TELEGRAM_API_ROOT` override for hosts that
    block api.telegram.org, and a 409 hint when two pollers share a token

We call the Bot API over httpx instead of grammY/python-telegram-bot's
Application: ~150 lines, no event-loop ownership problem inside FastAPI, and
every call is trivially fakeable in tests (MEMORY.md, 2026-10-31).

RULES §3 applies to every method: timeout ≤15 s, one retry, and callers that
never let a send failure reach the request path.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("sachet.telegram")

API_BASE = "https://api.telegram.org"
LONG_POLL_SECONDS = 10
READ_TIMEOUT_SECONDS = 15.0
ALLOWED_UPDATES = ["message", "callback_query"]


class TelegramError(RuntimeError):
    """Telegram answered with ok=false, or the transport failed twice."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def retryable(self) -> bool:
        if self.status == 409:  # another poller owns this token; retrying won't help
            return False
        return self.status is None or self.status >= 500 or self.status == 429


class TelegramClient:
    def __init__(
        self,
        token: str,
        *,
        api_root: str = API_BASE,
        timeout: float = READ_TIMEOUT_SECONDS,
    ) -> None:
        self.token = token
        self.api_root = (api_root or API_BASE).rstrip("/")
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    # ---- plumbing ---------------------------------------------------------
    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _url(self, method: str) -> str:
        return f"{self.api_root}/bot{self.token}/{method}"

    async def _call(
        self,
        method: str,
        *,
        payload: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        if not self.configured:
            raise TelegramError("no bot token configured", status=401)

        last_error: Exception | None = None
        for attempt in range(2):  # one retry (RULES §3)
            try:
                response = await self._http().post(
                    self._url(method),
                    data=payload,
                    files=files,
                    timeout=timeout or self.timeout,
                )
            except httpx.HTTPError as exc:
                last_error = TelegramError(f"{method} transport error: {exc}")
                logger.warning("%s attempt %d failed: %s", method, attempt + 1, exc)
            else:
                try:
                    body = response.json()
                except ValueError:
                    body = {}
                if response.status_code < 400 and body.get("ok"):
                    return body.get("result")

                description = body.get("description") or response.text[:200]
                if response.status_code == 409:
                    description += (
                        " — another process is long-polling this bot token;"
                        " stop it (or use a second token) before starting this one."
                    )
                last_error = TelegramError(f"{method} failed: {description}", status=response.status_code)
                logger.warning("%s attempt %d rejected: %s", method, attempt + 1, last_error)
                if not last_error.retryable:
                    break
            if attempt == 0:
                await asyncio.sleep(0.5)
        raise last_error or TelegramError(f"{method} failed")

    @staticmethod
    def _markup(reply_markup: dict[str, Any] | None) -> str | None:
        return json.dumps(reply_markup) if reply_markup else None

    # ---- read -------------------------------------------------------------
    async def get_me(self) -> dict[str, Any]:
        return await self._call(method="getMe") or {}

    async def get_updates(self, offset: int | None = None) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "timeout": LONG_POLL_SECONDS,
            "allowed_updates": json.dumps(ALLOWED_UPDATES),
        }
        if offset is not None:
            payload["offset"] = offset
        result = await self._call(method="getUpdates", payload=payload)
        return result if isinstance(result, list) else []

    async def download_file(self, file_id: str) -> bytes:
        info = await self._call(method="getFile", payload={"file_id": file_id})
        file_path = (info or {}).get("file_path")
        if not file_path:
            raise TelegramError("getFile returned no file_path")
        response = await self._http().get(
            f"{self.api_root}/file/bot{self.token}/{file_path}", timeout=self.timeout
        )
        response.raise_for_status()
        return response.content

    # ---- write ------------------------------------------------------------
    async def send_message(
        self,
        chat_id: str | int,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        result = await self._call(
            method="sendMessage",
            payload={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": "true",
                "reply_markup": self._markup(reply_markup),
            },
        )
        return result or {}

    async def send_photo(
        self,
        chat_id: str | int,
        photo: bytes | Path,
        caption: str = "",
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if isinstance(photo, Path):
            photo = photo.read_bytes()
        result = await self._call(
            method="sendPhoto",
            payload={
                "chat_id": chat_id,
                "caption": caption,
                "parse_mode": "HTML",
                "reply_markup": self._markup(reply_markup),
            },
            files={"photo": ("report.jpg", photo, "image/jpeg")},
        )
        return result or {}

    async def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> bool:
        """Always call this on a tap — otherwise the client spinner hangs ~30 s."""
        payload: dict[str, Any] = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text
        await self._call(method="answerCallbackQuery", payload=payload)
        return True

    async def edit_message_text(
        self,
        chat_id: str | int,
        message_id: int,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        result = await self._call(
            method="editMessageText",
            payload={
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": "true",
                "reply_markup": self._markup(reply_markup or {"inline_keyboard": []}),
            },
        )
        return result or {}


# ---- delivery with an outbox floor ----------------------------------------

def _payload_for(
    text: str | None,
    photo_path: str | None,
    caption: str,
    reply_markup: dict[str, Any] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = (
        {"photo_path": photo_path, "caption": caption}
        if photo_path
        else {"text": text or ""}
    )
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return payload


async def deliver(
    db: Any,
    client: TelegramClient,
    *,
    chat_id: str | int,
    kind: str,
    text: str | None = None,
    photo_path: str | None = None,
    caption: str = "",
    reply_markup: dict[str, Any] | None = None,
) -> bool:
    """Send now, or park it in `outbox` for the next poll cycle. Never raises."""
    payload = _payload_for(text, photo_path, caption, reply_markup)
    try:
        if photo_path:
            await client.send_photo(chat_id, Path(photo_path), caption, reply_markup=reply_markup)
        else:
            await client.send_message(chat_id, text or "", reply_markup=reply_markup)
        return True
    except Exception as exc:  # noqa: BLE001 - send failures must not break the caller
        logger.warning("telegram send failed (%s) — queued to outbox", exc)
        db.enqueue_outbox(str(chat_id), kind, json.dumps(payload))
        return False


async def flush_outbox(db: Any, client: TelegramClient, *, limit: int = 20) -> dict[str, int]:
    """Retry parked messages. Called each poll cycle."""
    sent = failed = 0
    for row in db.pending_outbox(limit=limit):
        payload = json.loads(row["payload_json"])
        try:
            if payload.get("photo_path"):
                await client.send_photo(
                    row["chat_id"],
                    Path(payload["photo_path"]),
                    payload.get("caption", ""),
                    reply_markup=payload.get("reply_markup"),
                )
            else:
                await client.send_message(
                    row["chat_id"],
                    payload.get("text", ""),
                    reply_markup=payload.get("reply_markup"),
                )
        except Exception as exc:  # noqa: BLE001
            db.mark_outbox_failed(row["id"], str(exc))
            failed += 1
        else:
            db.mark_outbox_sent(row["id"])
            sent += 1
    if sent or failed:
        logger.info("outbox flush: %d sent, %d failed", sent, failed)
    return {"sent": sent, "failed": failed}
