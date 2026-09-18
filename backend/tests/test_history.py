"""Read-only execution history (执行历史).

Covers the acceptance points:
  * events come back in event-id DESC order, carrying execution time, action,
    seat and the session (场次);
  * the two events of one linked run are returned as one ADJACENT group
    sharing the link id, even when another action's event id was interleaved
    between the two inserts;
  * the anomaly content and its confirmation result ride along with the
    event they belong to;
  * keyset paging by the immutable event id: walking every page reproduces
    the whole event table with neither duplicate nor gap, and executions
    committed WHILE paging (single and linked) never appear on or shift the
    older pages — the lead does not lose or repeat a record mid-walk;
  * the response gives the next-page cursor; the final page reports
    has_more=false / next_cursor=null;
  * an illegal cursor is the recognisable history_cursor_invalid business
    error (HTTP 400), including values outside the bigint range;
  * the page is assembled in ONE set-oriented database round-trip — session
    and anomaly rows are joined in, never filled in per event.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import history
from app.main import app

LIFT_UP = "lift_up"
LIFT_DOWN = "lift_down"
HOIST_IN = "hoist_fly_in"
HOIST_OUT = "hoist_fly_out"
STOP = "emergency_stop"

CONSOLE_A = "console-hist-aaaa"
CONSOLE_B = "console-hist-bbbb"


# ------------------------------------------------------------- helpers


def _run(services, action_id: str, holder="执行席"):
    grant = services.acquire(action_id, holder)
    return services.execute(action_id, grant["token"])


def _linked(services, a: str, b: str, holder="联排席"):
    ga = services.acquire(a, holder)
    gb = services.acquire(b, holder)
    return services.execute_linked(
        [
            {"action_id": a, "token": ga["token"]},
            {"action_id": b, "token": gb["token"]},
        ]
    )


def _all_event_ids(db_pool) -> set[int]:
    with db_pool.get_pool().connection() as conn:
        return {
            r["id"]
            for r in conn.execute("SELECT id FROM action_events").fetchall()
        }


def _walk(cursor=None, limit="3"):
    """Page through the whole history; return (groups, cursors, per-page)."""
    groups: list[dict] = []
    cursors: list[str | None] = []
    pages: list[dict] = []
    while True:
        page = history.fetch_page(cursor, limit)
        pages.append(page)
        groups.extend(page["items"])
        if not page["has_more"]:
            assert page["next_cursor"] is None
            break
        assert page["next_cursor"]
        cursors.append(page["next_cursor"])
        cursor = page["next_cursor"]
    return groups, cursors, pages


def _flatten(groups) -> list[dict]:
    return [ev for g in groups for ev in g["events"]]


@pytest.fixture()
def client(db_pool):
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------- shape


def test_empty_history(client):
    r = client.get("/api/history")
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == []
    assert body["next_cursor"] is None
    assert body["has_more"] is False


def test_events_newest_first_with_time_action_seat_and_session(services):
    from app import sessions

    sessions.transition("start", "晚场联排")
    e1 = _run(services, LIFT_UP, "升降席")
    sessions.transition("end")
    e2 = _run(services, STOP, "急停席")

    page = history.fetch_page()
    assert [g["events"][0]["event_id"] for g in page["items"]] == [
        e2["event_id"],
        e1["event_id"],
    ]
    newest, oldest = page["items"]
    ev_new = newest["events"][0]
    assert ev_new["action_id"] == STOP
    assert ev_new["action_label"] == "紧急停止（联排）"
    assert ev_new["holder"] == "急停席"
    assert ev_new["result"] == "executed"
    assert ev_new["occurred_at"]
    # Executed after the round ended: no session attribution.
    assert ev_new["session"] is None
    # The older event carries its round.
    ev_old = oldest["events"][0]
    assert ev_old["session"] == {
        "id": 1,
        "name": "晚场联排",
        "status": "ended",
    }
    # Single-action events are one-event groups without a link id.
    assert all(g["link_id"] is None and len(g["events"]) == 1
               for g in page["items"])


def test_linked_run_is_one_adjacent_group(services):
    _run(services, LIFT_UP, "升降席")
    linked = _linked(services, LIFT_DOWN, HOIST_IN, "联排席")
    linked_ids = sorted(e["event_id"] for e in linked["events"])

    page = history.fetch_page()
    # Newest group first: the linked pair, then the single run.
    pair_group = page["items"][0]
    assert pair_group["link_id"] == linked["link_id"]
    assert [e["event_id"] for e in pair_group["events"]] == linked_ids
    assert {e["action_id"] for e in pair_group["events"]} == {
        LIFT_DOWN,
        HOIST_IN,
    }
    assert all(e["holder"] == "联排席" for e in pair_group["events"])
    assert all(
        e["link_id"] == linked["link_id"] for e in pair_group["events"]
    )
    # The two linked events are adjacent: the unrelated single event is the
    # next group, not wedged between the pair.
    assert page["items"][1]["link_id"] is None
    assert page["items"][1]["events"][0]["action_id"] == LIFT_UP


def test_linked_group_stays_together_when_another_event_id_interleaves(
    db_pool
):
    """An event id allocated BETWEEN the two linked inserts must not split
    the pair. The linked run normally inserts consecutive ids, so fabricate
    the rare interleaving directly: linked events 1001 and 1003 share a
    link id while a single execution of another action took 1002."""
    link_id = "test-interleaved-link"
    with db_pool.get_pool().connection() as conn:
        def stub_lease(action_id: str) -> int:
            return conn.execute(
                """
                INSERT INTO leases (action_id, token_hash, holder, acquired_at,
                                    expires_at, executed_at)
                VALUES (%s, 'x', %s, now(), now() + interval '1 hour', now())
                RETURNING id
                """,
                (action_id,
                 "联排席" if action_id != STOP else "插队席"),
            ).fetchone()["id"]

        # Low half of the linked run.
        conn.execute(
            """
            INSERT INTO action_events
                (id, action_id, lease_id, token_hash, holder, result, link_id)
            OVERRIDING SYSTEM VALUE
            VALUES (1001, %s, %s, 'x', '联排席', 'executed', %s)
            """,
            (LIFT_DOWN, stub_lease(LIFT_DOWN), link_id),
        )
        # A single execution of ANOTHER action consumes the id in between.
        conn.execute(
            """
            INSERT INTO action_events
                (id, action_id, lease_id, token_hash, holder, result)
            OVERRIDING SYSTEM VALUE
            VALUES (1002, %s, %s, 'x', '插队席', 'executed')
            """,
            (STOP, stub_lease(STOP)),
        )
        # High half of the same linked run.
        conn.execute(
            """
            INSERT INTO action_events
                (id, action_id, lease_id, token_hash, holder, result, link_id)
            OVERRIDING SYSTEM VALUE
            VALUES (1003, %s, %s, 'x', '联排席', 'executed', %s)
            """,
            (HOIST_IN, stub_lease(HOIST_IN), link_id),
        )
        conn.commit()

    # One group per page: the linked pair stays exactly one adjacent group,
    # positioned at the pair's newest anchor (1003); the interleaved single
    # event is the complete next group and is neither skipped nor repeated.
    first = history.fetch_page(None, "1")
    assert first["next_cursor"] == "1003"
    pair_group = first["items"][0]
    assert pair_group["link_id"] == link_id
    assert [e["event_id"] for e in pair_group["events"]] == [1001, 1003]

    second = history.fetch_page(first["next_cursor"], "1")
    # A naive `id < 1003` cursor would have re-served event 1001 here; the
    # anchor cursor excludes the whole linked group instead.
    assert second["has_more"] is False
    assert second["next_cursor"] is None
    assert len(second["items"]) == 1
    assert second["items"][0]["link_id"] is None
    assert second["items"][0]["events"][0]["event_id"] == 1002

    # A cursorless walk also keeps the pair together in the same order.
    groups, _, _ = _walk(limit="5")
    assert [e["event_id"] for e in groups[0]["events"]] == [1001, 1003]
    assert groups[1]["events"][0]["event_id"] == 1002
    assert _anchors_desc(groups)


def test_anomaly_and_confirmation_ride_along_with_event(services):
    from app import anomalies

    older = _run(services, STOP, "急停席")
    newest = _run(services, LIFT_UP, "升降席")
    # Report + confirm on the OLDER event; the newest event has no anomaly.
    anomalies.report(STOP, "equipment", "急停按钮偏软", "急停席", CONSOLE_A)
    anomalies.confirm(STOP, "下一班-B", CONSOLE_B)

    groups, _, _ = _walk(limit="1")
    by_id = {e["event_id"]: e for e in _flatten(groups)}
    assert by_id[newest["event_id"]]["anomaly"] is None
    record = by_id[older["event_id"]]["anomaly"]
    assert record is not None
    assert record["event_id"] == older["event_id"]
    assert record["category"] == "equipment"
    assert record["description"] == "急停按钮偏软"
    assert record["reported_by"] == "急停席"
    assert record["reporter_id"] == CONSOLE_A
    assert record["status"] == "confirmed"
    assert record["confirmed_by"] == "下一班-B"
    assert record["confirmer_id"] == CONSOLE_B
    assert record["confirmed_at"]

    # A pending anomaly rides along just the same.
    pending = _run(services, LIFT_DOWN, "下降席")
    anomalies.report(LIFT_DOWN, "other", "等待确认的情况", "下降席", CONSOLE_A)
    page = history.fetch_page()
    ev = page["items"][0]["events"][0]
    assert ev["event_id"] == pending["event_id"]
    assert ev["anomaly"]["status"] == "pending"
    assert ev["anomaly"]["confirmed_by"] is None
    assert ev["anomaly"]["confirmed_at"] is None


# ----------------------------------------------------------- paging


def test_walk_all_pages_reproduces_every_event_once(db_pool, services):
    from app import sessions

    sessions.transition("start", "通查场次")
    _run(services, LIFT_UP)
    _linked(services, LIFT_DOWN, HOIST_IN)
    _run(services, STOP)
    _linked(services, LIFT_UP, HOIST_OUT)
    _run(services, HOIST_IN)

    groups, _, pages = _walk(limit="2")
    events = _flatten(groups)

    # Group anchors strictly newest-first; ids unique within the walk.
    ids = [e["event_id"] for e in events]
    assert _anchors_desc(groups)
    assert len(ids) == len(set(ids))
    assert set(ids) == _all_event_ids(db_pool)

    # Every linked run stays a single group across the whole walk.
    link_groups = [g for g in groups if g["link_id"] is not None]
    assert len(link_groups) == 2
    assert all(len(g["events"]) == 2 for g in link_groups)
    # Groups never straddle a page boundary: each page's first/last groups
    # are complete (linked groups have two events).
    for page in pages:
        for g in page["items"]:
            if g["link_id"] is not None:
                assert len(g["events"]) == 2


def _anchors_desc(groups) -> bool:
    anchors = [g["events"][-1]["event_id"] if g["link_id"] is None
               else max(e["event_id"] for e in g["events"]) for g in groups]
    # Within a linked group ids may not be globally DESC against an
    # interleaved event; anchor order must be strictly descending.
    return all(a > b for a, b in zip(anchors, anchors[1:]))


def test_new_executions_during_paging_never_shift_older_pages(
    db_pool, services
):
    """Cross-page stability: events committed after page 1 was fetched must
    not duplicate onto or drop out of the older pages reached via cursor."""
    _run(services, LIFT_UP, "早期席")
    _linked(services, LIFT_DOWN, HOIST_IN, "早期联排")
    for _ in range(4):
        _run(services, STOP, "早期急停")

    first = history.fetch_page(None, "2")
    assert first["has_more"] and first["next_cursor"]
    first_ids = {e["event_id"] for e in _flatten(first["items"])}

    # New executions — single AND linked — land WHILE the lead is paging.
    new_single = _run(services, LIFT_UP, "翻页期间的新单动作")
    new_linked = _linked(services, HOIST_OUT, LIFT_UP, "翻页期间的新联动")
    new_ids = {new_single["event_id"]} | {
        e["event_id"] for e in new_linked["events"]
    }

    # Continue with the cursor issued BEFORE the new commits.
    groups, _, _ = _walk(first["next_cursor"], limit="2")
    older_ids = {e["event_id"] for e in _flatten(groups)}

    # The new events never leaked onto an older page ...
    assert older_ids & new_ids == set()
    # ... and nothing that page 1 had was repeated.
    assert older_ids & first_ids == set()
    # Together, pages 1..N cover every event that EXISTED at page-1 time;
    # the late events are simply newer than the walk and excluded by anchors.
    assert first_ids | older_ids == _all_event_ids(db_pool) - new_ids


def test_repeating_the_same_cursor_is_stable(db_pool, services):
    _run(services, LIFT_UP)
    _linked(services, LIFT_DOWN, HOIST_IN)
    _run(services, STOP)

    first = history.fetch_page(None, "1")
    cursor = first["next_cursor"]
    again_a = history.fetch_page(cursor, "1")
    # More commits happen; the same cursor must answer identically.
    _run(services, LIFT_UP, "后来者")
    _linked(services, HOIST_OUT, LIFT_UP, "后来联动")
    again_b = history.fetch_page(cursor, "1")
    assert again_a["items"] == again_b["items"]
    assert again_a["next_cursor"] == again_b["next_cursor"]


def test_final_page_marks_end(services):
    _run(services, LIFT_UP)
    page = history.fetch_page(None, "10")
    assert page["has_more"] is False
    assert page["next_cursor"] is None


# ------------------------------------------------------------- errors


@pytest.mark.parametrize("bad", [
    "abc", "1.5", "-1", "0", "  ", "null", "1e3",
    "999999999999999999999999",  # beyond bigint
])
def test_invalid_cursor_is_recognisable_error(db_pool, bad):
    with pytest.raises(history.HistoryError) as ei:
        history.fetch_page(bad)
    assert ei.value.code == "history_cursor_invalid"
    assert ei.value.status == 400


def test_http_invalid_cursor_envelope(client):
    r = client.get("/api/history?cursor=not-an-id")
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["code"] == "history_cursor_invalid"
    assert detail["message"]


def test_http_history_endpoint_shape_and_paging(client, services):
    _run(services, LIFT_UP, "升降席")
    linked = _linked(services, LIFT_DOWN, HOIST_IN)

    r = client.get("/api/history")
    assert r.status_code == 200
    body = r.json()
    assert {"items", "next_cursor", "has_more"} <= set(body)
    pair = body["items"][0]
    assert pair["link_id"] == linked["link_id"]
    assert len(pair["events"]) == 2

    # A nonsense limit is ignored (default page), never a 4xx.
    assert client.get("/api/history?limit=banana").status_code == 200


def test_history_is_assembled_in_one_database_round_trip(
    db_pool, services, monkeypatch
):
    """Session + anomaly information is JOINed in: filling the page must not
    issue a follow-up query per event."""
    from app import anomalies

    _run(services, LIFT_UP, "席")
    _linked(services, LIFT_DOWN, HOIST_IN)
    anomalies.report(LIFT_UP, "equipment", "说明", "席", CONSOLE_A)
    anomalies.confirm(LIFT_UP, "下一班", CONSOLE_B)

    import psycopg

    real_execute = psycopg.Cursor.execute
    calls = {"n": 0}

    def counting_execute(self, query, params=None, *args, **kwargs):
        calls["n"] += 1
        return real_execute(self, query, params, *args, **kwargs)

    monkeypatch.setattr(psycopg.Cursor, "execute", counting_execute)
    history.fetch_page()
    # One SELECT only — no per-event session/anomaly lookups.
    assert calls["n"] == 1
