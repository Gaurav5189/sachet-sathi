"""SQLite storage: schema + the helpers we actually use.

Deliberately plain `sqlite3` (RULES §1): no ORM, no migration tool. The schema
below matches DOCS/ARCHITECTURE.md; every write is an upsert on a natural key so
a re-run of the poller can never duplicate a row (RULES §3).
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
    id           TEXT PRIMARY KEY,           -- e.g. gdacs:TC1001345
    source       TEXT NOT NULL,              -- gdacs | imd | sachet
    source_label TEXT NOT NULL DEFAULT '',
    event_type   TEXT NOT NULL DEFAULT '',
    event_name   TEXT NOT NULL DEFAULT '',
    alert_level  TEXT NOT NULL DEFAULT '',
    severity     TEXT NOT NULL,              -- low | moderate | severe
    area         TEXT NOT NULL DEFAULT '',
    headline     TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    url          TEXT NOT NULL DEFAULT '',
    glide        TEXT NOT NULL DEFAULT '',
    lat          REAL,
    lon          REAL,
    observed_at  TEXT,
    updated_at   TEXT,
    expires_at   TEXT,
    is_current   INTEGER NOT NULL DEFAULT 1,
    is_relevant  INTEGER NOT NULL DEFAULT 0,
    fetched_at   TEXT NOT NULL,
    stale        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_observed ON alerts (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts (severity);

CREATE TABLE IF NOT EXISTS incidents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id      TEXT UNIQUE,              -- client idempotency key (P4 offline flush)
    reporter_tg_id INTEGER,
    photo_path     TEXT,
    caption        TEXT NOT NULL DEFAULT '',
    severity       TEXT,
    category       TEXT,
    odia_summary   TEXT,
    next_action    TEXT,
    priority       INTEGER,
    triage_mode    TEXT,                     -- gemma | fallback
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending | triaged | sent
    created_at     TEXT NOT NULL,
    triaged_at     TEXT,
    sent_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents (severity);

CREATE TABLE IF NOT EXISTS reporters (
    tg_id       INTEGER PRIMARY KEY,
    first_name  TEXT NOT NULL DEFAULT '',
    first_seen  TEXT NOT NULL,
    report_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      TEXT NOT NULL,
    kind         TEXT NOT NULL,              -- digest | ack | alert
    payload_json TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (sent_at);
"""

SEVERITY_RANK_SQL = (
    "CASE severity WHEN 'severe' THEN 0 WHEN 'moderate' THEN 1 ELSE 2 END"
)
ALERT_COLUMNS = (
    "id",
    "source",
    "source_label",
    "event_type",
    "event_name",
    "alert_level",
    "severity",
    "area",
    "headline",
    "body",
    "url",
    "glide",
    "lat",
    "lon",
    "observed_at",
    "updated_at",
    "expires_at",
    "is_current",
    "is_relevant",
    "fetched_at",
    "stale",
)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    """One file, short-lived connections, WAL. Enough for a field demo."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    # ---- alerts -----------------------------------------------------------
    def upsert_alerts(self, alerts: Iterable[dict[str, Any]]) -> int:
        rows = [tuple(a.get(col) for col in ALERT_COLUMNS) for a in alerts]
        if not rows:
            return 0
        placeholders = ", ".join("?" for _ in ALERT_COLUMNS)
        updates = ", ".join(
            f"{col}=excluded.{col}" for col in ALERT_COLUMNS if col != "id"
        )
        with self.connect() as conn:
            conn.executemany(
                f"INSERT INTO alerts ({', '.join(ALERT_COLUMNS)}) "
                f"VALUES ({placeholders}) "
                f"ON CONFLICT(id) DO UPDATE SET {updates}",
                rows,
            )
        return len(rows)

    def list_alerts(
        self,
        *,
        severity: str | None = None,
        source: str | None = None,
        current_only: bool = False,
        relevant_only: bool = False,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        if severity:
            clauses.append("severity = ?")
            params.append(severity)
        if source:
            clauses.append("source = ?")
            params.append(source)
        if current_only:
            clauses.append("is_current = 1")
        if relevant_only:
            clauses.append("is_relevant = 1")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = (
            f"SELECT * FROM alerts {where} "
            f"ORDER BY {SEVERITY_RANK_SQL}, is_relevant DESC, observed_at DESC LIMIT ?"
        )
        params.append(limit)
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, params)]

    def count_alerts(self) -> int:
        with self.connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM alerts").fetchone()
        return int(row["n"]) if row else 0

    def mark_all_stale(self) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE alerts SET stale = 1")
