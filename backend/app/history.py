"""Read-only execution history (执行历史) for the post-show review.

The rehearsal lead must be able to trace action executions in the order they
happened, instead of seeing only each card's most recent result. This module
serves a newest-first, keyset-paginated, immutable view over action_events.

Pagination model
----------------
* The cursor is the IMMUTABLE action-event id (BIGINT), never an offset.
  Rows are append-only with monotonically increasing ids, so while the lead
  pages backwards, executions committed meanwhile get HIGHER ids and can
  neither duplicate nor skip an already-served record.
* The page unit is a GROUP: a single-action execution is one group; one linked
  run's two events (sharing link_id) are one adjacent group of two.
* A concurrent single-action execution on ANOTHER action can in principle be
  allocated an event id between the two inserts of a linked run. Rows are
  therefore ordered by an explicit ANCHOR: ``max(id)`` of the pair for linked
  events, the row's own id for single events. Both rows of a pair share the
  anchor and sort consecutively (anchor DESC, id DESC), so the group is always
  adjacent; the cursor is that anchor (the pair's newest event id — a real
  immutable event number), and ``anchor < cursor`` starts the next page
  strictly after the whole group, never repeating one half or skipping the
  event of the other action interleaved between the two linked inserts.
* ``limit * 2 + 1`` raw rows reveal the group sitting behind the page boundary
  (every group has at least one row); the cut-off group is re-served whole by
  the following request.

One set-oriented statement joins the session summary, the at-most-one anomaly
record and a set-based pair-anchor aggregate together with the events; related
rows are never filled in one query per event.
"""
from __future__ import annotations

from typing import Any

import psycopg

from . import config, db

# Recognisable business error code for a malformed/forged cursor. The console
# keeps its already-loaded pages when this comes back.


class HistoryError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def parse_cursor(cursor: str | None) -> int | None:
    """Validate the opaque-but-decodable event-id cursor.

    Returns None for the first page (parameter absent). Anything present but
    not a positive bigint decimal integer — a forged string, blank/whitespace,
    a float, zero, a negative or out-of-range value — is
    history_cursor_invalid, which the UI renders without dropping its
    already-loaded pages.
    """
    if cursor is None:
        return None
    text = cursor.strip()
    # An explicitly present but blank cursor is malformed, not "first page".
    if not text or not text.isdigit():
        raise HistoryError(
            "history_cursor_invalid", "历史分页游标非法，请重新打开执行历史", 400
        )
    value = int(text)
    # Event ids are positive BIGINT identity values; reject 0 and anything
    # outside the bigint range here so the database never sees a bad cast.
    if value <= 0 or value > 9_223_372_036_854_775_807:
        raise HistoryError(
            "history_cursor_invalid", "历史分页游标非法，请重新打开执行历史", 400
        )
    return value


def normalise_limit(limit: str | None) -> int:
    """Optional group-page-size override; malformed values fall back to the
    default so a bad query string can never break the read-only view."""
    if limit is None:
        return config.HISTORY_PAGE_GROUPS
    text = limit.strip()
    if not text.isdigit():
        return config.HISTORY_PAGE_GROUPS
    value = int(text)
    if value <= 0:
        return config.HISTORY_PAGE_GROUPS
    return min(value, config.HISTORY_MAX_LIMIT)


# One set-oriented statement: events joined to their session, the at-most-one
# anomaly record of each event, and a SET-BASED pair-anchor aggregate (one
# hash aggregation across all linked runs rather than a subquery per row). No
# per-event follow-up query is issued anywhere in this module.
_PAGE_SELECT = """
    SELECT e.id, e.action_id, e.holder, e.result, e.link_id,
           e.occurred_at, e.session_id,
           s.name AS session_name,
           (s.ended_at IS NULL) AS session_active,
           an.id AS anomaly_id,
           an.category AS anomaly_category,
           an.description AS anomaly_description,
           an.reported_by AS anomaly_reported_by,
           an.reporter_id AS anomaly_reporter_id,
           an.reported_at AS anomaly_reported_at,
           an.status AS anomaly_status,
           an.confirmed_by AS anomaly_confirmed_by,
           an.confirmer_id AS anomaly_confirmer_id,
           an.confirmed_at AS anomaly_confirmed_at,
           COALESCE(la.anchor, e.id) AS anchor
      FROM action_events e
      LEFT JOIN rehearsal_sessions s ON s.id = e.session_id
      LEFT JOIN action_anomalies an ON an.event_id = e.id
      LEFT JOIN (
          SELECT link_id, max(id) AS anchor
            FROM action_events
           WHERE link_id IS NOT NULL
           GROUP BY link_id
      ) la ON la.link_id = e.link_id
     WHERE (%s::bigint IS NULL OR COALESCE(la.anchor, e.id) < %s)
     ORDER BY anchor DESC, e.id DESC
     LIMIT %s
"""


def _anomaly_from_row(row: dict[str, Any]) -> dict[str, Any] | None:
    if row["anomaly_id"] is None:
        return None
    return {
        "id": row["anomaly_id"],
        "event_id": row["id"],
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


def _event_from_row(row: dict[str, Any]) -> dict[str, Any]:
    session = None
    if row["session_id"] is not None:
        session = {
            "id": row["session_id"],
            "name": row["session_name"],
            "status": "active" if row["session_active"] else "ended",
        }
    return {
        "event_id": row["id"],
        "occurred_at": row["occurred_at"].isoformat(),
        "action_id": row["action_id"],
        # Labels are static configuration, not database relations: filling
        # them here keeps the history a single database round-trip.
        "action_label": config.ACTION_LABELS.get(
            row["action_id"], row["action_id"]
        ),
        "holder": row["holder"],
        "result": row["result"],
        "link_id": row["link_id"],
        "session": session,
        "anomaly": _anomaly_from_row(row),
    }


def fetch_page(cursor: str | None = None, limit: str | None = None) -> dict[str, Any]:
    """Return one newest-first history page keyed by the immutable event id.

    Groups (single execution / linked pair) stay adjacent; the anomaly record
    and confirmation result ride along with the event they belong to.
    """
    cursor_id = parse_cursor(cursor)
    group_limit = normalise_limit(limit)
    # At most two events per group; the +1 raw row reveals another group
    # starting behind the page boundary.
    raw_limit = group_limit * 2 + 1

    with db.get_pool().connection() as conn:
        try:
            rows = conn.execute(
                _PAGE_SELECT, (cursor_id, cursor_id, raw_limit)
            ).fetchall()
        except psycopg.errors.DataError:
            # A digit string outside the bigint range (or any other value the
            # server cannot coerce) is still just a forged/invalid cursor —
            # never a server fault.
            raise HistoryError(
                "history_cursor_invalid",
                "历史分页游标非法，请重新打开执行历史",
                400,
            )

    # Rows arrive (anchor DESC, id DESC): the two rows of a linked group share
    # an anchor and are therefore consecutive; a single event is a group of
    # one. Group explicitly by anchor/id rather than trusting list positions.
    groups: list[dict[str, Any]] = []
    for row in rows:
        event = _event_from_row(row)
        if groups and groups[-1]["anchor"] == row["anchor"]:
            # Linked partner — events inside the group run id ASC
            # (execution order), so insert before the newer partner.
            groups[-1]["events"].insert(0, event)
        else:
            groups.append(
                {
                    "anchor": row["anchor"],
                    "link_id": row["link_id"],
                    "events": [event],
                }
            )

    # The +1 raw row guarantees a (group_limit + 1)th group starting behind
    # the boundary is visible (a group needs at least one row). Cutting at
    # group_limit groups neither skips nor repeats: every row of the cut-off
    # group carries an anchor below the new cursor and is re-served whole by
    # the next page.
    has_more = len(groups) > group_limit
    page_groups = groups[:group_limit]
    next_cursor: str | None = None
    if has_more and page_groups:
        # Anchor of the last served group: the next page starts strictly
        # after the whole group, both halves of a linked pair included.
        next_cursor = str(page_groups[-1]["anchor"])

    return {
        "items": [
            {"link_id": g["link_id"], "events": g["events"]} for g in page_groups
        ],
        "next_cursor": next_cursor,
        "has_more": has_more,
    }
