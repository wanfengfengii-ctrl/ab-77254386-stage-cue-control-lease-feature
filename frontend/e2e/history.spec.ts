import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Execution history (执行历史) review against the real FastAPI + PostgreSQL.
 *
 * One console plays the rehearsal lead:
 *   - executes a single dangerous action, reports its on-site anomaly and has
 *     another console confirm it;
 *   - submits one linked cross-device run;
 *   - opens the read-only history, sees the newest page first with the linked
 *     pair grouped adjacently and the anomaly riding along with its event,
 *     then pages to older records via the immutable event-id cursor;
 *   - refreshes the page and reopens the history: the same records come back
 *     in the same order.
 *
 * Direct API calls additionally pin down cross-page stability (no duplicate
 * or gap while paging) and the history_cursor_invalid error envelope.
 */

const LIFT = "lift_up";
const LIFT_DOWN = "lift_down";
const HOIST = "hoist_fly_in";
const STOP = "emergency_stop";

const CONSOLE_A_KEY = "handover.console-id.v1";
const CONSOLE_A = "console-hist-e2e-aaaa";
const CONSOLE_B = "console-hist-e2e-bbbb";

async function openSeat(browser: Browser, seatName: string, consoleId?: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  if (consoleId) {
    await page.evaluate(
      ([k, v]) => sessionStorage.setItem(k, v),
      [CONSOLE_A_KEY, consoleId] as const,
    );
  }
  await page.getByLabel("本席名称").fill(seatName);
  return { context, page };
}

const card = (page: Page, action: string) =>
  page.getByTestId(`action-${action}`);

interface ApiGroup {
  link_id: string | null;
  events: {
    event_id: number;
    action_id: string;
    holder: string;
    link_id: string | null;
    session: { id: number; name: string; status: string } | null;
    anomaly: { status: string; confirmed_by: string | null } | null;
  }[];
}

async function fetchHistory(
  page: Page,
  cursor?: string,
  limit?: number,
): Promise<{
  items: ApiGroup[];
  next_cursor: string | null;
  has_more: boolean;
}> {
  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (limit) qs.set("limit", String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return (await (await page.request.get(`/api/history${suffix}`)).json()) as any;
}

/** Walk every page with a small group limit; return flattened events. */
async function walkAllHistory(page: Page, limit = 2) {
  let cursor: string | undefined;
  const groups: ApiGroup[] = [];
  do {
    const pageData = await fetchHistory(page, cursor, limit);
    groups.push(...pageData.items);
    if (!pageData.has_more) {
      expect(pageData.next_cursor).toBeNull();
      break;
    }
    expect(pageData.next_cursor).toBeTruthy();
    cursor = pageData.next_cursor!;
  } while (cursor);
  return groups;
}

test.describe.configure({ mode: "serial" });

test("execution history: single + linked + confirmed anomaly, page through, refresh stays consistent", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const a = await openSeat(browser, "历史复盘席-A", CONSOLE_A);
  const { page } = a;

  // End any round a previous run left active, so this run starts clean.
  const current = await (
    await page.request.get("/api/sessions/current")
  ).json();
  if (current.session?.status === "active") {
    await page.request.post("/api/sessions/transition", { data: { op: "end" } });
  }

  // Older background traffic (well before the interesting events): enough
  // single executions to push the history past one UI page (20 groups).
  const backgroundIds: number[] = [];
  for (let i = 0; i < 22; i++) {
    const holder = `背景执行席-${i}`;
    const token = (
      await (
        await page.request.post(`/api/actions/${STOP}/lease`, {
          data: { holder },
        })
      ).json()
    ).token as string;
    const out = await (
      await page.request.post(`/api/actions/${STOP}/execute`, {
        data: { token },
      })
    ).json();
    backgroundIds.push(out.event_id);
  }

  // Start the round from the console after the background traffic.
  await page.getByTestId("session-name").fill("历史核对场次");
  await page.getByTestId("btn-session-start").click();
  await expect(page.getByTestId("session-summary-status")).toHaveText("进行中");

  // ---- single execution + anomaly report / confirm ----------------------
  const liftCard = card(page, LIFT);
  await liftCard.getByTestId("btn-acquire").click();
  await expect(liftCard.getByTestId("btn-execute")).toBeVisible();
  await liftCard.getByTestId("btn-execute").click();
  await expect(liftCard.getByTestId("notice")).toContainText("执行成功");
  // The newest history record at this point is exactly that single event.
  const singleEventId = (await fetchHistory(page)).items[0].events[0].event_id;

  const panel = liftCard.getByTestId("anomaly-panel");
  await panel.getByTestId("btn-anomaly-open").click();
  await panel.getByTestId("anomaly-category").selectOption("operation");
  await panel
    .getByTestId("anomaly-description")
    .fill("历史核对用：单动作执行后限位反馈延迟");
  await panel.getByTestId("btn-anomaly-submit").click();
  await expect(panel.getByTestId("anomaly-status")).toHaveText("待确认");

  // Another console confirms.
  const b = await openSeat(browser, "下一班确认席-B", CONSOLE_B);
  const panelB = card(b.page, LIFT).getByTestId("anomaly-panel");
  await panelB.getByTestId("btn-anomaly-confirm").click();
  await expect(panelB.getByTestId("anomaly-status")).toHaveText("已确认");

  // ---- linked cross-device run: 升降台下降 + 飞行吊点进场 ---------------
  const downCard = card(page, LIFT_DOWN);
  await downCard.getByTestId("btn-acquire").click();
  await expect(downCard.getByTestId("btn-execute")).toBeVisible();
  const hoistCard = card(page, HOIST);
  await hoistCard.getByTestId("btn-acquire").click();
  await expect(hoistCard.getByTestId("btn-execute")).toBeVisible();
  await page.getByTestId("linked-bar").getByTestId("btn-execute-linked").click();
  await expect(downCard.getByTestId("notice")).toContainText("联动执行成功");
  await expect(hoistCard.getByTestId("notice")).toContainText("联动执行成功");

  // ----------------------------------------------------------- API checks
  // Cross-page stability with small pages: every page is complete groups,
  // anchors strictly descend, and no event id is duplicated or missing.
  const allGroups = await walkAllHistory(page, 2);
  const flatEvents = allGroups.flatMap((g) => g.events);
  const ids = flatEvents.map((e) => e.event_id);
  expect(new Set(ids).size).toBe(ids.length); // no duplicates
  const anchors = allGroups.map((g) =>
    g.link_id ? Math.max(...g.events.map((e) => e.event_id)) : g.events[0].event_id,
  );
  for (let i = 1; i < anchors.length; i++) {
    expect(anchors[i - 1]).toBeGreaterThan(anchors[i]);
  }
  // Every linked group is a complete adjacent pair sharing its link id.
  for (const g of allGroups.filter((x) => x.link_id !== null)) {
    expect(g.events).toHaveLength(2);
    expect(new Set(g.events.map((e) => e.link_id))).toEqual(new Set([g.link_id]));
  }
  // Every background + interesting event the test created is present.
  const ours = new Set<number>([...backgroundIds, singleEventId]);
  for (const e of flatEvents) ours.delete(e.event_id);
  expect(ours.size, "every created event appears in the paged history").toBe(0);

  // The newest group is the linked run; its two events are attributed to the
  // active session and were executed by seat A.
  const newest = allGroups[0];
  expect(newest.link_id).toBeTruthy();
  expect(newest.events).toHaveLength(2);
  expect(new Set(newest.events.map((e) => e.action_id))).toEqual(
    new Set([LIFT_DOWN, HOIST]),
  );
  for (const e of newest.events) {
    expect(e.holder).toBe("历史复盘席-A");
    expect(e.session?.name).toBe("历史核对场次");
  }

  // The single action's event carries its confirmed anomaly and session.
  const singleEvent = flatEvents.find((e) => e.event_id === singleEventId)!;
  expect(singleEvent).toBeTruthy();
  expect(singleEvent.anomaly?.status).toBe("confirmed");
  expect(singleEvent.anomaly?.confirmed_by).toBe("下一班确认席-B");
  expect(singleEvent.session?.name).toBe("历史核对场次");
  // The pre-session background traffic has no session attribution.
  const aBackground = flatEvents.find(
    (e) => e.event_id === backgroundIds[0],
  )!;
  expect(aBackground.session).toBeNull();

  // Pin down stability WHILE paging: a cursor issued BEFORE later commits
  // must return the identical older page afterwards (no duplicate / skip).
  const page1 = await fetchHistory(page, undefined, 2);
  const page1Cursor = page1.next_cursor!;
  const page1Older = await fetchHistory(page, page1Cursor, 2);

  // Illegal cursor: recognisable business error, envelope carries the code.
  const bad = await page.request.get("/api/history?cursor=not-an-id");
  expect(bad.status()).toBe(400);
  expect((await bad.json()).detail.code).toBe("history_cursor_invalid");

  // ------------------------------------------------------------- UI walk
  await page.getByTestId("btn-open-history").click();
  const modal = page.getByTestId("history-modal");
  await expect(modal).toBeVisible();

  // Newest first: the linked group, rendered as one adjacent two-event group.
  await expect(
    modal.getByTestId("history-group").first().getByTestId("history-group-kind"),
  ).toHaveText("联动执行");
  const firstGroup = modal.getByTestId("history-group").first();
  await expect(firstGroup).toHaveAttribute("data-linked", "1");
  expect(await firstGroup.getByTestId("history-event").count()).toBe(2);

  // The single action's confirmed anomaly is shown with its owning event.
  const singleRow = modal
    .getByTestId("history-event")
    .filter({ hasText: "升降台 上升" })
    .first();
  await expect(singleRow.getByTestId("history-anomaly")).toHaveAttribute(
    "data-status",
    "confirmed",
  );
  await expect(
    singleRow.getByTestId("history-anomaly-confirmation"),
  ).toContainText("下一班确认席-B");
  // Session attribution rides along.
  await expect(singleRow.getByTestId("history-event-session")).toContainText(
    "历史核对场次",
  );

  // More than one UI page (22 background groups): page to older records.
  // Already-loaded groups stay in place; nothing is cleared.
  const newestGroupText = await firstGroup.textContent();
  let groupCount = await modal.getByTestId("history-group").count();
  expect(groupCount).toBe(20);
  await modal.getByTestId("btn-history-more").click();
  await expect
    .poll(async () => modal.getByTestId("history-group").count())
    .toBeGreaterThan(20);
  // The previously rendered newest group is untouched, still first.
  await expect(
    modal.getByTestId("history-group").first(),
  ).toHaveText(newestGroupText ?? "");
  // All background events are eventually reachable in the modal. The four
  // oldest background events live on the second (older) page only.
  for (const id of backgroundIds.slice(0, 4)) {
    await expect(
      modal.locator(`[data-event-id="${id}"]`),
    ).toBeVisible();
  }
  groupCount = await modal.getByTestId("history-group").count();

  // Snapshot the event-id sequence currently rendered (anchor order).
  const renderedIds = await modal
    .getByTestId("history-event")
    .evaluateAll((nodes) =>
      nodes.map((n) => Number(n.getAttribute("data-event-id"))),
    );
  expect(new Set(renderedIds).size).toBe(renderedIds.length);

  // A new execution lands WHILE the history is open (during the review): it
  // must not disturb what is already rendered.
  const hoistToken = (
    await (
      await page.request.post(`/api/actions/${HOIST}/lease`, {
        data: { holder: "翻页期间的新席" },
      })
    ).json()
  ).token as string;
  const hoistExec = await (
    await page.request.post(`/api/actions/${HOIST}/execute`, {
      data: { token: hoistToken },
    })
  ).json();
  // Give the (read-only) modal no reason to refetch: its list is unchanged.
  await page.waitForTimeout(300);
  expect(await modal.getByTestId("history-group").count()).toBe(groupCount);
  const stillRendered = await modal
    .getByTestId("history-event")
    .evaluateAll((nodes) =>
      nodes.map((n) => Number(n.getAttribute("data-event-id"))),
    );
  expect(stillRendered).toEqual(renderedIds);

  // Server-side stability: the cursor issued before that new commit answers
  // the same older page before and after the commit (no duplicate / skip).
  const olderBefore = await fetchHistory(page, page1Cursor, 2);
  expect(olderBefore.items).toEqual(page1Older.items);

  // ---- refresh: reopen the history and get records consistent with the
  // server's fresh newest page (the late execution now leads). -----------
  await modal.getByTestId("btn-history-close").click();
  await page.reload();
  await page.getByTestId("btn-open-history").click();
  const modal2 = page.getByTestId("history-modal");

  // The very first group is now the execution that landed during the review.
  await expect(
    modal2.getByTestId("history-group").first().getByTestId("history-group-kind"),
  ).toHaveText("单动作执行");
  await expect(
    modal2.getByTestId("history-event").first(),
  ).toContainText("飞行吊点 进场");

  // The refreshed newest page matches a direct API call one-for-one, in the
  // same group/event order — no duplicate or missing record after refresh.
  const serverPage = await fetchHistory(page);
  const uiIds = await modal2
    .getByTestId("history-event")
    .evaluateAll((nodes) =>
      nodes.map((n) => Number(n.getAttribute("data-event-id"))),
    );
  const serverIds = serverPage.items.flatMap((g) =>
    g.events.map((e) => e.event_id),
  );
  expect(uiIds).toEqual(serverIds);
  expect(new Set(uiIds).size).toBe(uiIds.length);
  // The linked group and the confirmed anomaly are still present on the
  // refreshed page.
  const linkedOnRefresh = modal2
    .getByTestId("history-group")
    .filter({ hasText: "联动执行" })
    .first();
  await expect(linkedOnRefresh).toHaveAttribute("data-linked", "1");
  expect(await linkedOnRefresh.getByTestId("history-event").count()).toBe(2);
  await expect(
    modal2
      .getByTestId("history-event")
      .filter({ hasText: "升降台 上升" })
      .first()
      .getByTestId("history-anomaly-confirmation"),
  ).toContainText("下一班确认席-B");
  // The late execution is the newest record on the refreshed page.
  expect(serverIds[0]).toBe(hoistExec.event_id);

  await a.context.close();
  await b.context.close();
});
