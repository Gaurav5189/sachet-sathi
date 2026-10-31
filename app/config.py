"""Env-driven settings.

Secrets come from `.env` only (RULES §2). We deliberately do NOT pull in
python-dotenv: the loader below is stdlib-only, which keeps the dependency
surface at exactly the approved set.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = BASE_DIR / "fixtures"


def load_dotenv(path: Path) -> None:
    """Load KEY=VALUE pairs from `path` into os.environ without overwriting.

    Minimal on purpose: comments, blank lines, optional `export `, and
    single/double quoted values. Anything fancier belongs in the shell.
    """
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    app_env: str
    demo_mode: bool
    port: int
    data_dir: Path
    database_url: str
    telegram_bot_token: str
    telegram_channel_id: str
    gemini_api_key: str
    gemma_model: str
    gdacs_rss_url: str
    feed_timeout_seconds: float

    @property
    def sqlite_path(self) -> Path:
        """Resolved sqlite file. `DATABASE_URL` wins when it points at sqlite."""
        if self.database_url.startswith("sqlite:///"):
            return Path(self.database_url.removeprefix("sqlite:///")).resolve()
        return (self.data_dir / "sachet.db").resolve()

    @property
    def photos_dir(self) -> Path:
        return self.data_dir / "photos"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.photos_dir.mkdir(parents=True, exist_ok=True)

    def telegram_ready(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_channel_id)

    def ai_ready(self) -> bool:
        return bool(self.gemini_api_key)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    load_dotenv(BASE_DIR / ".env")
    data_dir = Path(os.getenv("DATA_DIR", "").strip() or (BASE_DIR / "data"))
    return Settings(
        app_env=os.getenv("APP_ENV", "local").strip() or "local",
        demo_mode=_flag("DEMO_MODE"),
        port=_int("PORT", 8000),
        data_dir=data_dir,
        database_url=os.getenv("DATABASE_URL", "").strip(),
        telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
        telegram_channel_id=os.getenv("TELEGRAM_CHANNEL_ID", "").strip(),
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        gemma_model=os.getenv("GEMMA_MODEL", "gemma-3-27b-it").strip(),
        gdacs_rss_url=(
            os.getenv("GDACS_RSS_URL", "").strip()
            or "https://www.gdacs.org/xml/rss.xml"
        ),
        feed_timeout_seconds=float(_int("FEED_TIMEOUT_SECONDS", 15)),
    )
