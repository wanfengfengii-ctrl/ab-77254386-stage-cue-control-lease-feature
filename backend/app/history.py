"""Read-only execution history (执行历史) for post-show review.

Instead of each card only exposing its most recent result, the rehearsal lead
can trace action executions in occurrence order, newest page first, and keep
loading older pages.

Pagination is keyset-based on IMMUTABLE ids:

  * every action event carries a physical ``link_anchor`` stamped in the same
    transaction that writes it — the event's own id for a single execution,
    the PAIR'S minimum id for a linked run;
  * rows are ordered by ``(link_anchor DESC, id DESC)``: the two events of a
    linked run are always ADJACENT (the higher-id member first, the anchor
    member last), even if an unrelated action's id was issued between them;
  * the page cursor is the id of the OLDEST row actually returned — always
    the anchor member for a linked pair — so the next page asks for
    ``(link_anchor, id) < (cursor, cursor)`` and, the anchor being immutable,
    neither repeats nor skips rows even when new executions land while the
    lead pages backwards;
  * a linked pair is never split across a page boundary: the query
    over-fetches two rows and a spilled mate rides along on the same page.

The ordering is served by the ``(link_anchor DESC, id DESC)`` index, so each
page is a short index walk — no full-table sort. All associated information
(action label, session (场次), linked marker and the event's anomaly with its
confirmation) is fetched in ONE SQL statement via joins; there is no per-row
follow-up query. The endpoint is strictly read-only.
"""
from __future__ import annotations

from typing import Any

from . import db

DEFAULT_LIMIT = 20
MAX_LIMIT = 100

# Business error code (surfaced as detail.code in the HTTP error envelope):
#   history_cursor_invalid 400 — cursor is missing digits, zero, negative or
#                        otherwise not a positive event id; already-loaded
#                        pages stay on screen, the client only shows the hint


class HistoryError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


_PAGE_SELECT = """
    SELECT e.id AS event_id, e.occurred_at, e.action_id, a.label,
           e.holder, e.result, e.link_id,
           s.id AS session_id, s.name AS session_name,
           s.ended_at IS NOT NULL AS session_ended,
           n.id AS anomaly_id, n.event_id AS anomaly_event_id,
           n.category AS anomaly_category,
           n.description AS anomaly_description,
           n.reported_by AS anomaly_reported_by,
           n.reporter_id AS anomaly_reporter_id,
           n.reported_at AS anomaly_reported_at,
           n.status AS anomaly_status,
           n.confirmed_by AS anomaly_confirmed_by,
           n.confirmer_id AS anomaly_confirmer_id,
           n.confirmed_at AS anomaly_confirmed_at
      FROM action_events e
      JOIN actions a ON a.id = e.action_id
      LEFT JOIN rehearsal_sessions s ON s.id = e.session_id
      LEFT JOIN action_anomalies n ON n.event_id = e.id
     WHERE (%s::bigint IS NULL
            OR e.link_anchor < %s
            OR (e.link_anchor = %s AND e.id < %s))
     ORDER BY e.link_anchor DESC, e.id DESC
     LIMIT %s
"""


def parse_cursor(cursor: str | int | None) -> int | None:
    """Validate the opaque event-id cursor.

    Absent/empty means "first page". A malformed, zero or negative value is a
    recognisable history_cursor_invalid, never silently reset to the first
    page — the UI keeps the pages already loaded and only surfaces the hint.
    """
    if cursor is None or cursor == "":
        return None
    if isinstance(cursor, int) and not isinstance(cursor, bool):
        value = cursor
    else:
        text = str(cursor).strip()
        if not text or not text.lstrip("-").isdigit():
            raise HistoryError(
                "history_cursor_invalid",
                "历史分页游标无效：不是合法的事件编号",
                400,
            )
        value = int(text)
    # Event ids are PostgreSQL bigint identity values; an out-of-range value
    # must be the same recognisable business error, not a 500 from the cast.
    if value <= 0 or value > 9_223_372_036_854_775_807:
        raise HistoryError(
            "history_cursor_invalid",
            "历史分页游标无效：事件编号必须为正整数",
            400,
        )
    return value


def _normalise_limit(limit: int | None) -> int:
    # Clamp rather than reject: page size is a hint, the cursor is the
    # contract, so a strange limit can never disturb paging stability.
    if limit is None:
        return DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, int(limit)))


def list_page(cursor: str | int | None = None, limit: int | None = None) -> dict[str, Any]:
    """Return one newest-first history page and the cursor for the next one."""
    cursor_id = parse_cursor(cursor)
    page_size = _normalise_limit(limit)

    # A linked pair can spill at most ONE row past the page size; fetching
    # two extra rows leaves one genuine older row with which to detect
    # "more pages exist" even after the mate is absorbed into this page.
    with db.get_pool().connection() as conn:
        rows = conn.execute(
            _PAGE_SELECT,
            (cursor_id, cursor_id, cursor_id, cursor_id, page_size + 2),
        ).fetchall()

    page_rows: list[dict[str, Any]] = list(rows[:page_size])
    if page_rows:
        last = page_rows[-1]
        # If the page's oldest row is the newer member of a linked pair, the
        # mate is the single immediately-following row in index order — pull
        # it onto THIS page so the pair is never split.
        if last["link_id"] is not None and not any(
            r["link_id"] == last["link_id"] and r["event_id"] != last["event_id"]
            for r in page_rows
        ):
            if len(rows) > len(page_rows):
                mate = rows[len(page_rows)]
                if mate["link_id"] == last["link_id"]:
                    page_rows.append(mate)

    # Anything fetched but not returned is an older row => another page.
    has_more = len(rows) > len(page_rows)
    # The oldest returned id is the next cursor: the pair's anchor id for a
    # linked group (hence "< cursor" excludes BOTH members), its own id for a
    # single event. Immutable ids keep paging stable under concurrent writes.
    next_cursor = str(page_rows[-1]["event_id"]) if has_more else None
    return {
        "events": [_event_from_row(r) for r in page_rows],
        "next_cursor": next_cursor,
        "has_more": has_more,
    }


def _event_from_row(row: dict[str, Any]) -> dict[str, Any]:
    session = None
    if row["session_id"] is not None:
        session = {
            "id": row["session_id"],
            "name": row["session_name"],
            "status": "ended" if row["session_ended"] else "active",
        }
    anomaly = None
    if row["anomaly_id"] is not None:
        anomaly = {
            "id": row["anomaly_id"],
            "event_id": row["anomaly_event_id"],
            "category": row["anomaly_category"],
            "description": row["anomaly_description"],
            "reported_by": row["anomaly_reported_by"],
            "reporter_id": row["anomaly_reporter_id"],
            "reported_at": row["anomaly_reported_at"].isoformat(),
            "status": row["anomaly_status"],
            "confirmed_by": row["anomaly_confirmed_by"],
            "confirmer_id": row["anomaly_confirmer_id"],
            "confirmed_at": row["anomaly_confirmed_at"].isoformat()
            if row["anomaly_confirmed_at"]
            else None,
        }
    return {
        "event_id": row["event_id"],
        "occurred_at": row["occurred_at"].isoformat(),
        "action_id": row["action_id"],
        "label": row["label"],
        "holder": row["holder"],
        "result": row["result"],
        "link_id": row["link_id"],
        "session": session,
        "anomaly": anomaly,
    }
