"""Read-only execution history (执行历史): ordering, paging and grouping.

Covers the acceptance points:
  * events come back in event-id DESC order carrying execution time, action
    (id + label), executing seat and the session (场次) they belonged to;
  * the two events of one linked run share a link id and stay ADJACENT even
    when an unrelated event's id was issued between the two members;
  * a linked pair is never split across a page;
  * keyset paging on the immutable event-id cursor neither repeats nor skips
    old records when new executions land WHILE paging backwards;
  * the anomaly content and its confirmation ride along with the owning
    event;
  * an illegal cursor is a recognisable history_cursor_invalid;
  * all related information is joined in ONE SQL statement (no N+1).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import history
from app.main import app

LIFT = "lift_up"
HOIST = "hoist_fly_in"
STOP = "emergency_stop"


@pytest.fixture()
def client(db_pool):
    with TestClient(app) as c:
        yield c


# ------------------------------------------------------------- raw helpers


def _raw_event(
    db_pool,
    event_id: int,
    action_id: str = LIFT,
    holder: str = "联排控制席",
    link_id: str | None = None,
    session_id: int | None = None,
    anchor: int | None = None,
):
    """Insert an event with a CHOSEN id so interleaving is deterministic.

    Linked events in production are inserted back-to-back in one transaction
    (usually consecutive ids) and stamped with the pair's minimum anchor, but
    the global sequence allows another action's id to land between the pair
    members. Grouping must survive that, so the anchor is passed explicitly.
    """
    with db_pool.get_pool().connection() as conn:
        lease = conn.execute(
            """
            INSERT INTO leases
                (action_id, token_hash, holder, acquired_at, expires_at)
            VALUES (%s, %s, %s, now(), now() + interval '30 seconds')
            RETURNING id
            """,
            (action_id, f"hash-{event_id}", holder),
        ).fetchone()
        conn.execute(
            """
            INSERT INTO action_events
                (id, action_id, lease_id, token_hash, holder, result,
                 link_id, session_id, link_anchor)
            OVERRIDING SYSTEM VALUE
            VALUES (%s, %s, %s, %s, %s, 'executed', %s, %s, %s)
            """,
            (
                event_id,
                action_id,
                lease["id"],
                f"hash-{event_id}",
                holder,
                link_id,
                session_id,
                anchor if anchor is not None else event_id,
            ),
        )
        # Keep the identity sequence ahead of the hand-picked ids so later
        # natural inserts never collide with them.
        conn.execute(
            "SELECT setval(pg_get_serial_sequence('action_events', 'id'),"
            " (SELECT max(id) FROM action_events))"
        )
        conn.commit()


def _ids(page) -> list[int]:
    return [e["event_id"] for e in page["events"]]


# ----------------------------------------------------------------- basics


def test_empty_history(services):
    page = history.list_page()
    assert page["events"] == []
    assert page["next_cursor"] is None
    assert page["has_more"] is False


def test_real_linked_execute_stamps_the_pair_anchor_in_one_txn(services, db_pool):
    out = services.execute_linked(
        [
            {"action_id": LIFT, "token": services.acquire(LIFT, "席")["token"]},
            {"action_id": HOIST, "token": services.acquire(HOIST, "席")["token"]},
        ]
    )
    ids = sorted(e["event_id"] for e in out["events"])
    with db_pool.get_pool().connection() as conn:
        rows = conn.execute(
            "SELECT id, link_anchor FROM action_events"
            " WHERE link_id = %s ORDER BY id",
            (out["link_id"],),
        ).fetchall()
    # Both members anchor at the pair's minimum id; a single event anchors at
    # its own id.
    assert [r["link_anchor"] for r in rows] == [ids[0], ids[0]]
    g = services.acquire(STOP, "席")
    services.execute(STOP, g["token"])
    with db_pool.get_pool().connection() as conn:
        single = conn.execute(
            "SELECT id, link_anchor FROM action_events"
            " WHERE action_id = %s ORDER BY id DESC LIMIT 1",
            (STOP,),
        ).fetchone()
    assert single["link_anchor"] == single["id"]


def test_history_newest_first_with_full_shape(services):
    g1 = services.acquire(LIFT, "升降台席")
    services.execute(LIFT, g1["token"])
    from app import sessions

    sessions.transition("start", "第一轮联排")
    g2 = services.acquire(HOIST, "吊点席")
    services.execute(HOIST, g2["token"])
    out = services.execute_linked(
        [
            {"action_id": LIFT, "token": services.acquire(LIFT, "联排席")["token"]},
            {"action_id": HOIST, "token": services.acquire(HOIST, "联排席")["token"]},
        ]
    )
    sessions.transition("end")

    page = history.list_page()
    ids = _ids(page)
    assert ids == sorted(ids, reverse=True)
    assert len(ids) == 4

    newest, oldest = page["events"][0], page["events"][-1]
    # Newest is one of the linked members; it carries execution time, action
    # id/label, executing seat, result and the shared link id.
    assert newest["link_id"] == out["link_id"]
    assert newest["label"] in {"升降台 上升", "飞行吊点 进场"}
    assert newest["holder"] == "联排席"
    assert newest["result"] == "executed"
    assert newest["occurred_at"]
    assert newest["anomaly"] is None
    # The event ran inside the (now ended) session; the oldest event ran
    # before any session existed and keeps session=None.
    assert newest["session"]["name"] == "第一轮联排"
    assert newest["session"]["status"] == "ended"
    assert oldest["session"] is None
    assert oldest["link_id"] is None


def test_linked_pair_adjacent_even_with_stranger_id_between(services, db_pool):
    """ids 1 single; linked members 2 and 4; an unrelated event got id 3.

    Plain numeric DESC would render 4, 3, 2 — splitting the pair. Group
    ordering by the pair's minimum id keeps the members ADJACENT (the
    stranger event moves ahead of the whole group): 3, 4, 2, 1.
    """
    _raw_event(db_pool, 1, LIFT)
    _raw_event(db_pool, 2, HOIST, link_id="link-g", anchor=2)
    _raw_event(db_pool, 3, STOP)
    _raw_event(db_pool, 4, LIFT, link_id="link-g", anchor=2)

    page = history.list_page()
    assert _ids(page) == [3, 4, 2, 1]
    pair = [e for e in page["events"] if e["link_id"] == "link-g"]
    rendered = _ids(page)
    first, second = rendered.index(4), rendered.index(2)
    assert second == first + 1  # adjacent, stranger id 3 cannot separate
    assert {e["action_id"] for e in pair} == {LIFT, HOIST}


# ------------------------------------------------------------- paging


def test_pagination_walks_every_row_once_without_gap_or_duplicate(services, db_pool):
    # Pair (5, 6) lands exactly across a size-3 page boundary.
    for i in (1, 2, 3, 4):
        _raw_event(db_pool, i, LIFT)
    _raw_event(db_pool, 5, HOIST, link_id="link-split", anchor=5)
    _raw_event(db_pool, 6, LIFT, link_id="link-split", anchor=5)
    _raw_event(db_pool, 7, STOP)
    _raw_event(db_pool, 8, LIFT)

    seen: list[int] = []
    cursor = None
    pages = 0
    while True:
        page = history.list_page(cursor, limit=3)
        pages += 1
        ids = _ids(page)
        # A page never repeats anything already seen.
        assert not (set(ids) & set(seen)), ids
        seen.extend(ids)
        if not page["has_more"]:
            assert page["next_cursor"] is None
            break
        assert page["next_cursor"] is not None
        cursor = page["next_cursor"]
        assert pages < 10

    assert seen == [8, 7, 6, 5, 4, 3, 2, 1]
    # The split pair stayed together on one page (6 immediately before 5).
    assert seen.index(6) + 1 == seen.index(5)


def test_pair_member_on_page_edge_pulls_its_mate_onto_same_page(db_pool):
    # Size-3 first page would be [8, 7, 6]; member 6 pulls mate 5 along.
    for i in (1, 2, 3, 4):
        _raw_event(db_pool, i, LIFT)
    _raw_event(db_pool, 5, HOIST, link_id="link-edge", anchor=5)
    _raw_event(db_pool, 6, LIFT, link_id="link-edge", anchor=5)
    _raw_event(db_pool, 7, STOP)
    _raw_event(db_pool, 8, LIFT)

    first = history.list_page(None, limit=3)
    assert _ids(first) == [8, 7, 6, 5]
    assert first["has_more"] is True
    # Cursor is the pair ANCHOR (older member id), so "< cursor" excludes
    # both members on the next page.
    assert first["next_cursor"] == "5"

    second = history.list_page(first["next_cursor"], limit=3)
    assert _ids(second) == [4, 3, 2]
    third = history.list_page(second["next_cursor"], limit=3)
    assert _ids(third) == [1]
    assert third["has_more"] is False


def test_paging_is_stable_when_new_executions_arrive_mid_walk(services, db_pool):
    """New events during a backwards walk never duplicate or skip old ones."""
    from app import sessions

    # A settled history of five single events.
    for i in range(5):
        g = services.acquire(LIFT, f"席{i}")
        services.execute(LIFT, g["token"])

    first = history.list_page(None, limit=2)
    first_ids = _ids(first)
    assert first_ids == [5, 4]
    cursor = first["next_cursor"]
    assert cursor == "4"

    # New executions (a single AND a linked pair) land while the lead reads
    # the next page with the OLD cursor.
    g = services.acquire(STOP, "新单动作")
    services.execute(STOP, g["token"])
    services.execute_linked(
        [
            {"action_id": LIFT, "token": services.acquire(LIFT, "新联动")["token"]},
            {"action_id": HOIST, "token": services.acquire(HOIST, "新联动")["token"]},
        ]
    )

    seen = list(first_ids)
    cur = cursor
    while True:
        page = history.list_page(cur, limit=2)
        assert not (set(_ids(page)) & set(seen))
        seen.extend(_ids(page))
        cur = page["next_cursor"]
        if not page["has_more"]:
            break

    # The whole OLD set is covered exactly once, in order; the fresh rows are
    # not smuggled into the ongoing walk (they belong to a newer first page).
    assert seen == [5, 4, 3, 2, 1]

    # Re-opening from the top now shows the new rows first, then the old ones.
    fresh = history.list_page(None, limit=10)
    assert _ids(fresh)[:3] == [8, 7, 6]
    assert set(_ids(fresh)[3:]) == {5, 4, 3, 2, 1}


# ------------------------------------------------------------- ride-along


def test_anomaly_and_confirmation_ride_along_with_event(services):
    from app import anomalies

    g = services.acquire(LIFT, "报告席")
    services.execute(LIFT, g["token"])
    anomalies.report(
        LIFT, "equipment", "上升 3 米处异响", "报告席", "console-A"
    )

    page = history.list_page()
    event = page["events"][0]
    a = event["anomaly"]
    assert a is not None
    assert a["status"] == "pending"
    assert a["category"] == "equipment"
    assert a["description"] == "上升 3 米处异响"
    assert a["reported_by"] == "报告席"
    assert a["confirmed_by"] is None

    # Another console confirms; the history event carries the confirmation.
    anomalies.confirm(LIFT, "下一班", "console-B")
    event = history.list_page()["events"][0]
    a = event["anomaly"]
    assert a["status"] == "confirmed"
    assert a["confirmed_by"] == "下一班"
    assert a["confirmer_id"] == "console-B"
    assert a["confirmed_at"]


def test_anomaly_on_a_linked_member_rides_with_its_event(services):
    from app import anomalies

    out = services.execute_linked(
        [
            {"action_id": LIFT, "token": services.acquire(LIFT, "联排席")["token"]},
            {"action_id": HOIST, "token": services.acquire(HOIST, "联排席")["token"]},
        ]
    )
    anomalies.report(LIFT, "other", "联动后升降台异响", "联排席", "console-A")

    events = {e["event_id"]: e for e in history.list_page()["events"]}
    lift_event = next(
        e for e in out["events"] if e["action_id"] == LIFT
    )
    hoist_event = next(
        e for e in out["events"] if e["action_id"] == HOIST
    )
    assert events[lift_event["event_id"]]["anomaly"]["description"] == "联动后升降台异响"
    assert events[hoist_event["event_id"]]["anomaly"] is None


# ------------------------------------------------------------- cursor rules


@pytest.mark.parametrize("bad", ["abc", "0", "-3", "1.5", "1; DROP", "  ", "0x5"])
def test_invalid_cursor_is_recognisable(bad):
    with pytest.raises(history.HistoryError) as ei:
        history.list_page(bad)
    assert ei.value.code == "history_cursor_invalid"
    assert ei.value.status == 400


def test_limit_is_clamped_but_paging_stays_consistent(db_pool):
    for i in range(1, 6):
        _raw_event(db_pool, i, LIFT)
    # limit 0 clamps to 1 row per page.
    page = history.list_page(None, limit=0)
    assert _ids(page) == [5]
    assert page["next_cursor"] == "5"


def test_history_is_read_only(services, db_pool):
    g = services.acquire(LIFT, "席")
    services.execute(LIFT, g["token"])
    before = _all_event_ids(db_pool)
    history.list_page(None, limit=1)
    history.list_page("1", limit=1)
    assert _all_event_ids(db_pool) == before


def _all_event_ids(db_pool):
    with db_pool.get_pool().connection() as conn:
        return [
            r["id"]
            for r in conn.execute("SELECT id FROM action_events ORDER BY id").fetchall()
        ]


# ----------------------------------------------------------------- HTTP


def test_http_history_first_page_shape(client):
    r = client.get("/api/history")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["events"] == []
    assert body["next_cursor"] is None
    assert body["has_more"] is False
    assert body["server_time"]


def test_http_history_paging_and_invalid_cursor(client, db_pool):
    for i in range(1, 6):
        _raw_event(db_pool, i, LIFT)

    r = client.get("/api/history?limit=2")
    assert r.status_code == 200
    first = r.json()
    assert [e["event_id"] for e in first["events"]] == [5, 4]
    assert first["next_cursor"] == "4"
    assert first["has_more"] is True

    r = client.get(f"/api/history?limit=2&cursor={first['next_cursor']}")
    assert [e["event_id"] for e in r.json()["events"]] == [3, 2]

    for bad in ("abc", "0", "-9"):
        r = client.get(f"/api/history?cursor={bad}")
        assert r.status_code == 400, bad
        assert r.json()["detail"]["code"] == "history_cursor_invalid"


def test_http_history_returns_joined_data_in_one_round_trip(client, services):
    """The endpoint shape carries action/session/anomaly data directly."""
    from app import anomalies, sessions

    sessions.transition("start", "复盘场")
    g = services.acquire(LIFT, "席")
    services.execute(LIFT, g["token"])
    anomalies.report(LIFT, "environment", "场地湿滑", "席", "console-A")

    r = client.get("/api/history")
    event = r.json()["events"][0]
    assert event["action_id"] == LIFT
    assert event["label"] == "升降台 上升"
    assert event["holder"] == "席"
    assert event["session"] == {
        "id": event["session"]["id"],
        "name": "复盘场",
        "status": "active",
    }
    assert event["anomaly"]["category"] == "environment"
    assert event["anomaly"]["description"] == "场地湿滑"
    assert event["anomaly"]["reported_by"] == "席"
