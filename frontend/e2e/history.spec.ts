import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Execution history (执行历史) against the real FastAPI + PostgreSQL stack.
 *
 * One rehearsal lead runs a SINGLE action and a LINKED cross-device cue
 * inside a named session, reports an on-site anomaly which another seat
 * confirms, then opens the read-only history:
 *   - newest page first: execution time, action, seat and the session;
 *   - the linked cue's two events stay adjacent in one group;
 *   - the anomaly content and its confirmation ride with the owning event;
 *   - older pages append by the immutable event-id cursor with no duplicate
 *     or skipped row (also verified page-by-page straight at the API,
 *     including the history_cursor_invalid boundary);
 *   - after a full page refresh the history still yields the same records.
 */

const LIFT = "lift_up";
const HOIST = "hoist_fly_in";
const STOP = "emergency_stop";

async function openSeat(browser: Browser, seatName: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("本席名称").fill(seatName);
  return { context, page };
}

const card = (page: Page, action: string) =>
  page.getByTestId(`action-${action}`);

async function endAnyActiveSession(page: Page) {
  const current = await (
    await page.request.get("/api/sessions/current")
  ).json();
  if (current.session?.status === "active") {
    await page.request.post("/api/sessions/transition", {
      data: { op: "end" },
    });
  }
}

/** Acquire + execute one single action through the real console. */
async function executeSingle(page: Page, action: string) {
  const c = card(page, action);
  await c.getByTestId("btn-acquire").click();
  await expect(c.getByTestId("btn-execute")).toBeVisible();
  await c.getByTestId("btn-execute").click();
  await expect(c.getByTestId("notice")).toContainText("执行成功");
}

/** Acquire the cross-device pair and submit them as one linked cue. */
async function executeLinkedPair(page: Page) {
  const lift = card(page, LIFT);
  const hoist = card(page, HOIST);
  await lift.getByTestId("btn-acquire").click();
  await expect(lift.getByTestId("btn-execute")).toBeVisible();
  await hoist.getByTestId("btn-acquire").click();
  await expect(hoist.getByTestId("btn-execute")).toBeVisible();
  await page
    .getByTestId("linked-bar")
    .getByTestId("btn-execute-linked")
    .click();
  await expect(lift.getByTestId("notice")).toContainText("联动执行成功");
  await expect(hoist.getByTestId("notice")).toContainText("联动执行成功");
}

test.describe.configure({ mode: "serial" });

test("execution history: single + linked + confirmed anomaly, page by page, stable after refresh", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const a = await openSeat(browser, "历史执行席-A");
  const page = a.page;
  await endAnyActiveSession(page);

  // Start a named round from the console.
  const sessionName = `历史复盘场 ${Date.now()}`;
  await page.getByTestId("session-name").fill(sessionName);
  await page.getByTestId("btn-session-start").click();
  await expect(page.getByTestId("session-summary-status")).toHaveText("进行中");

  // Bulk of ordinary single executions first: more than the UI page size
  // (20) so the modal genuinely has an older page to append. Driven straight
  // at the real API (fast); the featured actions below use the console.
  for (let i = 0; i < 22; i++) {
    const acq = await page.request.post(`/api/actions/${LIFT}/lease`, {
      data: { holder: "历史铺垫席" },
    });
    expect(acq.ok()).toBeTruthy();
    const ex = await page.request.post(`/api/actions/${LIFT}/execute`, {
      data: { token: (await acq.json()).token },
    });
    expect(ex.ok()).toBeTruthy();
  }

  // 1) Featured single action.
  await executeSingle(page, LIFT);
  // 2) Linked cross-device cue (+2 events sharing one link id).
  await executeLinkedPair(page);
  // 3) A further single action that will carry the anomaly.
  await executeSingle(page, STOP);

  const snapshot = await (await page.request.get("/api/actions")).json();
  const stateOf = (id: string) =>
    snapshot.actions.find((x: any) => x.action_id === id);
  const stopEventId: number = stateOf(STOP).last_event_id;
  const linkId: string = stateOf(LIFT).last_link_id;
  expect(linkId).toBeTruthy();

  // 4) Report an anomaly on the stop action's just-executed event.
  const panelA = card(page, STOP).getByTestId("anomaly-panel");
  await panelA.getByTestId("btn-anomaly-open").click();
  const formA = panelA.getByTestId("anomaly-form");
  await formA.getByTestId("anomaly-category").selectOption("operation");
  await formA
    .getByTestId("anomaly-description")
    .fill("急停按钮回弹偏慢，需复核");
  await formA.getByTestId("btn-anomaly-submit").click();
  await expect(panelA.getByTestId("anomaly-status")).toHaveText("待确认");

  // 5) Another seat confirms it.
  const b = await openSeat(browser, "历史确认席-B");
  const panelB = card(b.page, STOP).getByTestId("anomaly-panel");
  await expect(panelB.getByTestId("anomaly-status")).toHaveText("待确认");
  await panelB.getByTestId("btn-anomaly-confirm").click();
  await expect(panelB.getByTestId("anomaly-status")).toHaveText("已确认");
  await b.context.close();

  // End the round so the history shows a closed 场次.
  await page.getByTestId("btn-session-end").click();
  await expect(page.getByTestId("session-summary-status")).toHaveText("已结束");

  // ------------------------------------------------ API: page-by-page walk
  // Small pages force many cursor round trips. Every row is seen exactly
  // once; groups (anchored at the pair's minimum id) only move backwards;
  // the linked members are delivered together on the same page.
  const seen: any[] = [];
  const seenIds = new Set<number>();
  let cursor: string | null = null;
  let walkedPages = 0;
  let foundLinkPairTogether = false;
  let foundStopAnomaly = false;
  while (walkedPages < 500) {
    const url = `/api/history?limit=2${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const res = await page.request.get(url);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // No duplicate inside the page or against earlier pages.
    const ids = body.events.map((e: any) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(seenIds.has(id)).toBe(false);

    // Groups only move to older anchors: the minimum link member (or the
    // single event's own id) must be strictly below the previous page's.
    const anchorOf = (e: any) =>
      Math.min(
        ...body.events
          .filter((x: any) => x.link_id && x.link_id === e.link_id)
          .map((x: any) => x.event_id),
        e.event_id,
      );
    if (seen.length) {
      const prevAnchor = seen[seen.length - 1]._anchor;
      expect(anchorOf(body.events[body.events.length - 1])).toBeLessThan(
        prevAnchor,
      );
    }

    // The linked cue's two members must be delivered TOGETHER, adjacent.
    const linkedHere = body.events.filter((e: any) => e.link_id === linkId);
    expect(linkedHere.length).not.toBe(1);
    if (linkedHere.length === 2) {
      foundLinkPairTogether = true;
      const idx = ids.indexOf(linkedHere[0].event_id);
      expect(Math.abs(idx - ids.indexOf(linkedHere[1].event_id))).toBe(1);
      for (const e of linkedHere) {
        expect(e.session.name).toBe(sessionName);
        expect(e.session.status).toBe("ended");
      }
    }

    const stopEvt = body.events.find((e: any) => e.event_id === stopEventId);
    if (stopEvt) {
      foundStopAnomaly = true;
      expect(stopEvt.anomaly.status).toBe("confirmed");
      expect(stopEvt.anomaly.description).toBe("急停按钮回弹偏慢，需复核");
      expect(stopEvt.anomaly.reported_by).toBe("历史执行席-A");
      expect(stopEvt.anomaly.confirmed_by).toBe("历史确认席-B");
      expect(stopEvt.session.name).toBe(sessionName);
    }

    for (const e of body.events) {
      seen.push({ ...e, _anchor: anchorOf(e) });
      seenIds.add(e.event_id);
    }
    walkedPages++;
    cursor = body.next_cursor;
    if (!body.has_more) {
      expect(cursor).toBeNull();
      break;
    }
  }
  expect(foundLinkPairTogether).toBe(true);
  expect(foundStopAnomaly).toBe(true);
  expect(seenIds.has(stopEventId)).toBe(true);
  // The walk reaches the very first event with no gaps.
  expect(seen[seen.length - 1].event_id).toBe(1);
  expect(seenIds.size).toBe(seen.length);

  // Invalid cursor: recognisable code, HTTP 400.
  const bad = await page.request.get("/api/history?cursor=not-an-id");
  expect(bad.status()).toBe(400);
  expect((await bad.json()).detail.code).toBe("history_cursor_invalid");

  // ------------------------------------------------ UI: modal walk-through
  await page.getByTestId("btn-open-history").click();
  const modal = page.getByTestId("history-modal");
  await expect(modal).toBeVisible();

  // Newest row is the stop event and shows time / action / seat.
  let rows = modal.getByTestId("history-item");
  await expect(rows.first()).toContainText(`#${stopEventId}`);
  await expect(rows.first()).toContainText("紧急停止（联排）");
  await expect(rows.first()).toContainText("席位：历史执行席-A");
  await expect(rows.first().getByTestId("history-time")).toContainText("UTC");
  // ...with the confirmed anomaly riding along on the event.
  await expect(
    rows.first().getByTestId("history-anomaly"),
  ).toHaveAttribute("data-status", "confirmed");
  await expect(rows.first()).toContainText("急停按钮回弹偏慢，需复核");
  await expect(
    rows.first().getByTestId("history-anomaly-confirmation"),
  ).toContainText("确认席位：历史确认席-B");
  // The session tag rides along too.
  await expect(rows.first().getByTestId("history-session")).toContainText(
    sessionName,
  );

  // The linked cue renders as ONE adjacent group with both actions.
  const group = modal.locator(`[data-testid="history-group"][data-link-id="${linkId}"]`);
  await expect(group).toBeVisible();
  await expect(group).toContainText("联动执行");
  await expect(group).toContainText("升降台 上升");
  await expect(group).toContainText("飞行吊点 进场");

  // Load one older page through the UI: rows append without dropping the
  // already-loaded newest rows and without repeating an event id.
  const firstScreenIds = await modal
    .getByTestId("history-item")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-event-id")));
  expect(firstScreenIds).toHaveLength(20);
  expect(firstScreenIds[0]).toBe(String(stopEventId));
  await modal.getByTestId("btn-history-more").click();
  await expect
    .poll(async () => (await modal.getByTestId("history-item").all()).length)
    .toBeGreaterThan(20);
  const afterMoreIds = await modal
    .getByTestId("history-item")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-event-id")));
  expect(new Set(afterMoreIds).size).toBe(afterMoreIds.length);
  // Every originally loaded row is still present at the front, same order.
  expect(afterMoreIds.slice(0, firstScreenIds.length)).toEqual(firstScreenIds);

  // Refresh the whole page and reopen: the newest page is identical.
  await page.reload();
  await page.getByLabel("本席名称").fill("历史执行席-A");
  await page.getByTestId("btn-open-history").click();
  const modal2 = page.getByTestId("history-modal");
  await expect(modal2.getByTestId("history-item").first()).toContainText(
    `#${stopEventId}`,
  );
  const refreshedIds = await modal2
    .getByTestId("history-item")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-event-id")));
  expect(refreshedIds).toEqual(firstScreenIds);
  // The confirmed anomaly and the linked group survive the refresh too.
  await expect(
    modal2.getByTestId("history-item").first().getByTestId("history-anomaly"),
  ).toHaveAttribute("data-status", "confirmed");
  await expect(
    modal2.locator(
      `[data-testid="history-group"][data-link-id="${linkId}"]`,
    ),
  ).toBeVisible();

  await a.context.close();
});
