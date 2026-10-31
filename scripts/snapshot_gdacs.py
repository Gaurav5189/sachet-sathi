"""Snapshot the live GDACS RSS feed into `fixtures/`.

Fixture-first rule (RULES §3, PLAN risk register): we build parsers against a
stored response, and the live fetch becomes a thin wrapper around them. Run
this before the demo so `DEMO_MODE=1` has fresh data to replay.

    python scripts/snapshot_gdacs.py            # refresh from live feed
    python scripts/snapshot_gdacs.py --offline  # re-derive JSON from stored XML

Writes:
    fixtures/gdacs-sample.xml   raw RSS, trimmed to the selected items
    fixtures/gdacs-sample.json  normalized alerts (the DEMO_MODE replay shape)
"""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
XML_PATH = FIXTURES / "gdacs-sample.xml"
JSON_PATH = FIXTURES / "gdacs-sample.json"
FEED_URL = "https://www.gdacs.org/xml/rss.xml"

GDACS = "http://www.gdacs.org"
NS = {"gdacs": GDACS}

# Keep the fixture small and relevant: the Odisha/Bay-of-Bengal cyclone plus
# India-wide flood/drought context. Selected by event type + country.
KEEP_IF = (
    # The event the pitch is about.
    lambda e: "ARNAB" in (e.get("event_name") or ""),
    # Any live cyclone — the feed's most newsworthy layer.
    lambda e: e.get("event_type") == "TC",
    # India-wide flood/drought context for the Odisha coast.
    lambda e: e.get("event_type") in {"FL", "DR"} and e.get("area") == "India",
)

SEVERITY_BY_LEVEL = {"red": "severe", "orange": "moderate", "green": "low"}


def _text(node: ET.Element, tag: str) -> str:
    found = node.find(tag, NS)
    return (found.text or "").strip() if found is not None and found.text else ""


def _iso(raw: str) -> str | None:
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        return None


def extract(item: ET.Element) -> dict:
    """Pull the fields we actually render. No interpretation, no invention."""
    g = lambda tag: _text(item, f"gdacs:{tag}")  # noqa: E731
    level = g("alertlevel").lower()
    lat = item.findtext("geo:lat", namespaces={"geo": "http://www.w3.org/2003/01/geo/wgs84_pos#"})
    lon = item.findtext("geo:long", namespaces={"geo": "http://www.w3.org/2003/01/geo/wgs84_pos#"})
    event_id = g("eventid")
    return {
        "id": f"gdacs:{g('eventtype')}{event_id}",
        "source": "gdacs",
        "source_label": "GDACS",
        "event_type": g("eventtype"),
        "event_name": g("eventname"),
        "alert_level": g("alertlevel").lower() or "green",
        "severity": SEVERITY_BY_LEVEL.get(level, "low"),
        "area": g("country") or "Unknown",
        "headline": (item.findtext("title") or "").strip(),
        "body": (item.findtext("description") or "").strip(),
        "url": (item.findtext("link") or "").strip(),
        "glide": g("glide"),
        "lat": float(lat) if lat else None,
        "lon": float(lon) if lon else None,
        "observed_at": _iso(item.findtext("pubDate") or ""),
        "updated_at": _iso(g("datemodified")),
        "expires_at": _iso(g("todate")),
        "is_current": g("iscurrent").lower() == "true",
    }


def fetch(url: str) -> bytes:
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "SachetSathi/0.1 (hackathon)"})
    with urllib.request.urlopen(req, timeout=20) as res:  # noqa: S310 - fixed https URL
        return res.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="reuse the stored XML")
    args = parser.parse_args()

    FIXTURES.mkdir(exist_ok=True)

    if args.offline:
        raw = XML_PATH.read_bytes()
    else:
        raw = fetch(FEED_URL)
        print(f"fetched {len(raw):,} bytes from {FEED_URL}")

    root = ET.fromstring(raw)
    channel = root.find("channel")
    if channel is None:
        print("no <channel> in feed", file=sys.stderr)
        return 1

    selected: list[dict] = []
    kept_items: list[ET.Element] = []
    for item in channel.findall("item"):
        fields = extract(item)
        if any(pred(fields) for pred in KEEP_IF):
            selected.append(fields)
            kept_items.append(item)

    if not selected:
        print("no matching items — refusing to write an empty fixture", file=sys.stderr)
        return 1

    # Rebuild a minimal but structurally faithful RSS document.
    out = ET.Element("rss", {"version": "2.0"})
    new_channel = ET.SubElement(out, "channel")
    for tag in ("title", "link", "description"):
        src = channel.find(tag)
        if src is not None:
            ET.SubElement(new_channel, tag).text = src.text
    for item in kept_items:
        new_channel.append(item)

    ET.indent(out, space="  ")
    XML_PATH.write_bytes(
        b'<?xml version="1.0" encoding="utf-8"?>\n'
        + ET.tostring(out, encoding="utf-8")
    )

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "gdacs",
        "source_url": FEED_URL,
        "note": "Fixture replay for DEMO_MODE. Real GDACS items, snapshotted; not live data.",
        "alerts": selected,
    }
    JSON_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"wrote {XML_PATH.relative_to(ROOT)} ({len(kept_items)} items)")
    print(f"wrote {JSON_PATH.relative_to(ROOT)} ({len(selected)} alerts)")
    for alert in selected:
        print(f"  - [{alert['severity']:8}] {alert['event_type']} {alert['event_name']}: {alert['headline'][:70]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
