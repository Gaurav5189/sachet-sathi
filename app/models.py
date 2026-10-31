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

CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id  INTEGER,
    model        TEXT NOT NULL,
    mode         TEXT NOT NULL,              -- gemma | fallback
    latency_ms   INTEGER NOT NULL DEFAULT 0,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    ok           INTEGER NOT NULL DEFAULT 1,
    error        TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls (created_at DESC);
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

    # ---- incidents --------------------------------------------------------
    def create_incident(
        self,
        *,
        report_id: str,
        reporter_tg_id: int | None,
        photo_path: str | None,
        caption: str,
    ) -> int:
        """Idempotent on `report_id` — a replayed Telegram update or a re-flushed
        offline queue entry must not create a second card (RULES §3)."""
        incident_id, _ = self.create_incident_once(
            report_id=report_id,
            reporter_tg_id=reporter_tg_id,
            photo_path=photo_path,
            caption=caption,
        )
        return incident_id

    def create_incident_once(
        self,
        *,
        report_id: str,
        reporter_tg_id: int | None,
        photo_path: str | None,
        caption: str,
    ) -> tuple[int, bool]:
        """Same as `create_incident`, but also says whether this call inserted."""
        with self.connect() as conn:
            cursor = conn.execute(
                "INSERT INTO incidents (report_id, reporter_tg_id, photo_path, caption, status, created_at) "
                "VALUES (?, ?, ?, ?, 'pending', ?) "
                "ON CONFLICT(report_id) DO NOTHING",
                (report_id, reporter_tg_id, photo_path, caption, utcnow()),
            )
            inserted = cursor.rowcount > 0
            row = conn.execute(
                "SELECT id FROM incidents WHERE report_id = ?", (report_id,)
            ).fetchone()
        return int(row["id"]), inserted

    def get_incident(self, incident_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM incidents WHERE id = ?", (incident_id,)
            ).fetchone()
        return dict(row) if row else None

    def get_incident_by_report_id(self, report_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM incidents WHERE report_id = ?", (report_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_incidents(
        self,
        *,
        status: str | None = None,
        severity: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if severity:
            clauses.append("severity = ?")
            params.append(severity)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = (
            f"SELECT * FROM incidents {where} "
            f"ORDER BY {SEVERITY_RANK_SQL} NULLS LAST, created_at DESC LIMIT ?"
        )
        params.append(limit)
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, params)]

    def save_triage(
        self,
        incident_id: int,
        *,
        severity: str,
        category: str,
        odia_summary: str,
        next_action: str,
        priority: int,
        triage_mode: str,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE incidents SET severity=?, category=?, odia_summary=?, next_action=?, "
                "priority=?, triage_mode=?, status='triaged', triaged_at=? WHERE id=?",
                (
                    severity,
                    category,
                    odia_summary,
                    next_action,
                    priority,
                    triage_mode,
                    utcnow(),
                    incident_id,
                ),
            )

    def mark_incidents_sent(self, incident_ids: list[int]) -> None:
        if not incident_ids:
            return
        placeholders = ", ".join("?" for _ in incident_ids)
        with self.connect() as conn:
            conn.execute(
                f"UPDATE incidents SET status='sent', sent_at=? WHERE id IN ({placeholders})",
                [utcnow(), *incident_ids],
            )

    # ---- reporters --------------------------------------------------------
    def upsert_reporter(self, tg_id: int, first_name: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO reporters (tg_id, first_name, first_seen, report_count) "
                "VALUES (?, ?, ?, 1) "
                "ON CONFLICT(tg_id) DO UPDATE SET report_count = report_count + 1, "
                "first_name = excluded.first_name",
                (tg_id, first_name, utcnow()),
            )

    # ---- outbox -----------------------------------------------------------
    def enqueue_outbox(self, chat_id: str, kind: str, payload_json: str) -> int:
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO outbox (chat_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
                (chat_id, kind, payload_json, utcnow()),
            )
            return int(cur.lastrowid)

    def pending_outbox(self, limit: int = 20) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def mark_outbox_sent(self, outbox_id: int) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE outbox SET sent_at = ?, last_error = NULL WHERE id = ?",
                (utcnow(), outbox_id),
            )

    def mark_outbox_failed(self, outbox_id: int, error: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?",
                (error[:500], outbox_id),
            )

    # ---- misc state -------------------------------------------------------
    def get_state(self, key: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def set_state(self, key: str, value: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO state (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    # ---- ai call log (RULES §4: model, latency, honesty) ------------------
    def log_ai_call(
        self,
        *,
        incident_id: int | None,
        model: str,
        mode: str,
        latency_ms: int,
        prompt_chars: int,
        ok: bool,
        error: str | None = None,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO ai_calls (incident_id, model, mode, latency_ms, prompt_chars, ok, error, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    incident_id,
                    model,
                    mode,
                    latency_ms,
                    prompt_chars,
                    1 if ok else 0,
                    (error or "")[:500] or None,
                    utcnow(),
                ),
            )

    def list_ai_calls(self, limit: int = 20) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM ai_calls ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]
