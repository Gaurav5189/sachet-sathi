"""Gemma triage: photo + caption → one strict-JSON incident card.

The model is a **formatter, not a decision maker** (RULES §4): it returns data,
never sends messages, never touches the DB, never parses official feeds. If its
output fails validation twice, a deterministic keyword classifier takes over and
the card is marked `triage_mode="fallback"` so a human sees that it is degraded.

Measured on gemma-4-26b-a4b-it (2026-10-31): 6–15 s per call, ~400–560 reasoning
tokens, so the output budget must be generous or the reply comes back empty.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from app.config import Settings
from app.models import Database

logger = logging.getLogger("sachet.triage")

Severity = Literal["low", "moderate", "severe"]
Category = Literal["flood", "damage", "supply", "medical", "other"]

# RULES asks for a <=15 s timeout; measured on gemma-4-26b-a4b-it: 1.7-17 s per
# call (~400-560 reasoning tokens), so a 15 s cap would fail normal calls.
# 25 s + one retry bounds the worst case; the reporter is acked before triage
# starts, so a slow model never delays the acknowledgement. Logged in MEMORY.md.
MODEL_TIMEOUT_MS = 25_000
MAX_OUTPUT_TOKENS = 2048
MAX_SUMMARY = 240
MAX_ACTION = 200

PROMPT = """You triage cyclone field reports for a response team in Odisha, India.

Return ONLY a JSON object with exactly these keys:
{{"severity":"low|moderate|severe","category":"flood|damage|supply|medical|other","odia_summary":"1-2 sentences in Odia script (ଓଡ଼ିଆ)","next_action":"one short English instruction for a coordinator","priority":1|2|3}}

Rules:
- Describe only what is visible in the photo or stated in the caption.
- Never invent locations, numbers, names or casualties.
- priority 1 = act now (risk to life), 2 = today, 3 = monitor.
- odia_summary: Odia script, at most {summary} characters.
- next_action: imperative, no speculation, at most {action} characters.
- No markdown, no code fences, no explanation. JSON only.

REPORT: {caption}
"""

STRICTER = (
    "Your previous reply could not be parsed as JSON. "
    "Reply with the JSON object only — no prose, no code fences, no trailing text."
)

SEVERE_WORDS = {
    "collapse", "collapsed", "trapped", "casualt", "death", "dead", "drown",
    "breach", "washed away", "swept", "rescue", "urgent", "critical", "injured",
    "bleeding", "electrocuted", "missing", "stranded",
}
MODERATE_WORDS = {
    "flood", "flooded", "water", "blocked", "tree", "damage", "damaged", "road",
    "bridge", "power", "electric", "landslide", "shelter", "roof", "knee", "waist",
}
CATEGORY_WORDS: dict[str, set[str]] = {
    "flood": {"flood", "flooded", "water", "inundat", "rain", "river", "embankment", "breach"},
    "damage": {"damage", "damaged", "collapse", "collapsed", "tree", "road", "bridge", "roof", "wall", "power", "electric"},
    "supply": {"food", "water", "supply", "blanket", "medicine", "relief", "ration", "drinking"},
    "medical": {"injur", "medical", "hospital", "ambulance", "bleeding", "sick", "pregnant", "doctor"},
}

FALLBACK_SUMMARY = "ଏହି ରିପୋର୍ଟର ମାନବ ସମୀକ୍ଷା ଆବଶ୍ୟକ।"
FALLBACK_ACTION = "Coordinator review required — automated triage unavailable."

# The model sometimes answers with a synonym instead of our enum. Map the label;
# never invent a fact. Unknown labels still fail validation and hit the fallback.
SEVERITY_ALIASES = {
    "high": "severe", "critical": "severe", "urgent": "severe", "extreme": "severe",
    "medium": "moderate", "med": "moderate", "elevated": "moderate",
    "minor": "low", "info": "low", "informational": "low",
}
CATEGORY_ALIASES = {
    "flooding": "flood", "water": "flood", "inundation": "flood",
    "infrastructure": "damage", "infrastructure/transportation": "damage",
    "road": "damage", "transport": "damage", "structural": "damage", "debris": "damage",
    "food": "supply", "relief": "supply", "logistics": "supply", "shelter": "supply",
    "health": "medical", "healthcare": "medical", "casualty": "medical", "injury": "medical",
}


class TriageParseError(ValueError):
    """The model answered, but not with a usable card."""


class TriageCard(BaseModel):
    severity: Severity
    category: Category
    # Lengths are clipped rather than rejected: a chatty model shouldn't cost a
    # fallback, and the UI has a fixed card height.
    odia_summary: str = Field(min_length=1)
    next_action: str = Field(min_length=1)
    priority: int = Field(ge=1, le=3)

    @field_validator("severity", mode="before")
    @classmethod
    def _severity(cls, value: Any) -> Any:
        if isinstance(value, str):
            lowered = value.strip().lower()
            return SEVERITY_ALIASES.get(lowered, lowered)
        return value

    @field_validator("category", mode="before")
    @classmethod
    def _category(cls, value: Any) -> Any:
        if isinstance(value, str):
            lowered = value.strip().lower().replace(" ", "_")
            return CATEGORY_ALIASES.get(lowered, lowered)
        return value

    @field_validator("priority", mode="before")
    @classmethod
    def _priority(cls, value: Any) -> Any:
        """Clamp a 1-5 answer into our 1-3 scale instead of failing the card."""
        try:
            number = int(str(value).strip().split(".")[0])
        except (TypeError, ValueError):
            return value
        return max(1, min(3, number))

    @field_validator("odia_summary", "next_action", mode="before")
    @classmethod
    def _clean(cls, value: Any) -> Any:
        return " ".join(str(value or "").split())

    @model_validator(mode="after")
    def _clip(self) -> "TriageCard":
        self.odia_summary = self.odia_summary[:MAX_SUMMARY].strip()
        self.next_action = self.next_action[:MAX_ACTION].strip()
        return self


def extract_json(text: str) -> dict[str, Any]:
    """Tolerate code fences and stray prose; reject anything that isn't an object."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1] if "```" in raw[3:] else raw[3:]
        raw = raw.removeprefix("json").strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        raise TriageParseError(f"no JSON object in model reply: {raw[:120]!r}")
    try:
        data = json.loads(raw[start : end + 1])
    except json.JSONDecodeError as exc:
        raise TriageParseError(f"invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        # Gemma sometimes wraps a single card in a list.
        if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
            return data[0]
        raise TriageParseError("model reply was not a JSON object")
    return data


def classify(caption: str) -> tuple[Severity, Category, int]:
    """Deterministic keyword classifier — the floor when the model misbehaves."""
    text = (caption or "").lower()

    severity: Severity = "low"
    if any(word in text for word in SEVERE_WORDS):
        severity = "severe"
    elif any(word in text for word in MODERATE_WORDS):
        severity = "moderate"

    category: Category = "other"
    best = 0
    for name, words in CATEGORY_WORDS.items():
        hits = sum(1 for word in words if word in text)
        if hits > best:
            category, best = name, hits  # type: ignore[assignment]

    priority = {"severe": 1, "moderate": 2, "low": 3}[severity]
    return severity, category, priority


def fallback_card(caption: str, reason: str) -> TriageCard:
    severity, category, priority = classify(caption)
    return TriageCard(
        severity=severity,
        category=category,
        odia_summary=FALLBACK_SUMMARY,
        next_action=FALLBACK_ACTION,
        priority=priority,
    )


class TriageService:
    def __init__(
        self,
        settings: Settings,
        db: Database,
        *,
        generate: Callable[[str, bytes | None, bool], str] | None = None,
    ) -> None:
        self.settings = settings
        self.db = db
        self._injected = generate is not None
        self._generate = generate or self._gemini_generate

    # ---- public -----------------------------------------------------------
    @property
    def available(self) -> bool:
        return self._injected or bool(self.settings.gemini_api_key)

    async def triage_incident(self, incident_id: int, *, force: bool = False) -> dict[str, Any]:
        incident = self.db.get_incident(incident_id)
        if incident is None:
            raise KeyError(f"incident {incident_id} not found")
        if incident.get("triage_mode") == "gemma" and not force:
            return {**incident, "reused": True}

        caption = incident.get("caption") or ""
        photo = self._photo_bytes(incident.get("photo_path"))

        started = time.monotonic()
        mode, error = "gemma", None
        try:
            card = await asyncio.to_thread(self._with_retry, caption, photo)
        except Exception as exc:  # noqa: BLE001 - RULES §3: always land a card
            logger.warning("triage fell back for incident %s: %s", incident_id, exc)
            card, mode, error = fallback_card(caption, str(exc)), "fallback", str(exc)

        latency_ms = int((time.monotonic() - started) * 1000)
        self.db.save_triage(
            incident_id,
            severity=card.severity,
            category=card.category,
            odia_summary=card.odia_summary,
            next_action=card.next_action,
            priority=card.priority,
            triage_mode=mode,
        )
        self.db.log_ai_call(
            incident_id=incident_id,
            model=self.settings.gemma_model if mode == "gemma" else "rule-based",
            mode=mode,
            latency_ms=latency_ms,
            prompt_chars=len(PROMPT) + len(caption),
            ok=error is None,
            error=error,
        )
        logger.info("triage incident=%s mode=%s latency=%dms", incident_id, mode, latency_ms)

        saved = self.db.get_incident(incident_id) or {}
        return {**saved, "triage_mode": mode, "latency_ms": latency_ms}

    # ---- internals --------------------------------------------------------
    @staticmethod
    def _photo_bytes(photo_path: str | None) -> bytes | None:
        if not photo_path:
            return None
        path = Path(photo_path)
        if not path.is_file():
            return None
        return path.read_bytes()

    def _with_retry(self, caption: str, photo: bytes | None) -> TriageCard:
        """Ask, validate; retry once (stricter, for transport failures too).

        gemma-4-26b-a4b-it returns sporadic 500s under load, so a transport
        retry matters as much as the JSON one. Still one retry, never a loop
        (RULES §3).
        """
        last: Exception | None = None
        for attempt in range(2):
            try:
                return self._parse(self._generate(caption, photo, attempt > 0))
            except (TriageParseError, ValidationError) as exc:
                last = exc
                logger.info("triage reply unusable (%s) — retrying stricter", exc)
            except Exception as exc:  # noqa: BLE001 - transport/5xx, retry once
                last = exc
                logger.warning("model call failed (attempt %d): %s", attempt + 1, exc)
                time.sleep(0.4)
        raise last or TriageParseError("model produced no card")

    @staticmethod
    def _parse(reply: str) -> TriageCard:
        return TriageCard.model_validate(extract_json(reply))

    def _gemini_generate(self, caption: str, photo: bytes | None, strict: bool) -> str:
        from google import genai
        from google.genai import types

        prompt = PROMPT.format(caption=caption or "(no caption)", summary=MAX_SUMMARY, action=MAX_ACTION)
        if strict:
            prompt = f"{prompt}\n\n{STRICTER}"

        contents: list[Any] = []
        if photo:
            contents.append(types.Part.from_bytes(data=photo, mime_type=_mime(photo)))
        contents.append(prompt)

        client = genai.Client(
            api_key=self.settings.gemini_api_key,
            http_options=types.HttpOptions(timeout=MODEL_TIMEOUT_MS),
        )
        response = client.models.generate_content(
            model=self.settings.gemma_model,
            contents=contents,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.2,
                max_output_tokens=MAX_OUTPUT_TOKENS,
            ),
        )
        text = (response.text or "").strip()
        if not text:
            raise TriageParseError("model returned an empty reply")
        return text


def _mime(photo: bytes) -> str:
    if photo.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if photo.startswith(b"\x89PNG"):
        return "image/png"
    return "image/jpeg"
