import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "../src/App";
import { MockServer } from "./mock-server";

// Execution history (执行历史): newest page first, older pages appended,
// linked pair adjacent/grouped, anomaly + confirmation ride along, failed
// older-page request keeps loaded rows and offers a tail retry — all driven
// through the in-memory test double that mirrors the real keyset rules.

const LIFT = "lift_up";
const HOIST = "hoist_fly_in";
const STOP = "emergency_stop";

const CONSOLE_ID_KEY = "handover.console-id.v1";
const CONSOLE_A = "console-test-aaaa";
const CONSOLE_B = "console-test-bbbb";

const card = (action: string) => screen.getByTestId(`action-${action}`);
const modal = () => screen.getByTestId("history-modal");
const items = () =>
  within(modal()).getAllByTestId("history-item");

async function openApp(seat = "联排负责人") {
  sessionStorage.setItem(CONSOLE_ID_KEY, CONSOLE_A);
  render(<App />);
  fireEvent.change(screen.getByLabelText("本席名称"), {
    target: { value: seat },
  });
  await waitFor(() =>
    expect(
      within(card(LIFT)).getByTestId("btn-acquire"),
    ).toBeEnabled(),
  );
}

describe("App execution history (执行历史)", () => {
  let server: MockServer;

  beforeEach(() => {
    server = new MockServer();
    server.installFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  async function executeSingle(action: string) {
    fireEvent.click(within(card(action)).getByTestId("btn-acquire"));
    await waitFor(() =>
      expect(within(card(action)).getByTestId("btn-execute")).toBeInTheDocument(),
    );
    fireEvent.click(within(card(action)).getByTestId("btn-execute"));
    await waitFor(() =>
      expect(within(card(action)).getByTestId("notice")).toHaveTextContent(
        /执行成功/,
      ),
    );
  }

  it("opens with the newest first: time, action, seat are shown", async () => {
    await openApp();
    await executeSingle(LIFT);

    fireEvent.click(screen.getByTestId("btn-open-history"));
    const rows = await within(modal()).findAllByTestId("history-item");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("#1");
    expect(rows[0]).toHaveTextContent("升降台 上升");
    expect(rows[0]).toHaveTextContent("席位：联排负责人");
    expect(within(rows[0]).getByTestId("history-time")).toHaveTextContent(
      /\d{2}:\d{2}:\d{2}/,
    );
    // Only one page, nothing more to load.
    expect(within(modal()).queryByTestId("btn-history-more")).toBeNull();
    expect(within(modal()).getByTestId("history-end")).toBeInTheDocument();
  });

  it("empty state before any execution", async () => {
    await openApp();
    fireEvent.click(screen.getByTestId("btn-open-history"));
    expect(
      await within(modal()).findByTestId("history-empty"),
    ).toBeInTheDocument();
  });

  it("single + linked executions: the two linked events are adjacent and grouped", async () => {
    await openApp();
    await executeSingle(STOP); // event 1, single

    // One seat holds the cross-device pair and submits them as one cue.
    fireEvent.click(within(card(LIFT)).getByTestId("btn-acquire"));
    await waitFor(() =>
      expect(within(card(LIFT)).getByTestId("btn-execute")).toBeInTheDocument(),
    );
    fireEvent.click(within(card(HOIST)).getByTestId("btn-acquire"));
    await waitFor(() =>
      expect(within(card(HOIST)).getByTestId("btn-execute")).toBeInTheDocument(),
    );
    fireEvent.click(
      within(screen.getByTestId("linked-bar")).getByTestId("btn-execute-linked"),
    );
    await waitFor(() =>
      expect(within(card(LIFT)).getByTestId("notice")).toHaveTextContent(
        /联动执行成功/,
      ),
    );

    fireEvent.click(screen.getByTestId("btn-open-history"));
    await within(modal()).findAllByTestId("history-item");

    // One linked group (events 2+3) then the single event 1.
    const groups = within(modal()).getAllByTestId("history-group");
    expect(groups).toHaveLength(1);
    const groupedRows = within(groups[0]).getAllByTestId("history-item");
    expect(groupedRows).toHaveLength(2);
    const groupedIds = groupedRows.map((r) => r.dataset.eventId);
    expect(groupedIds.sort((a, b) => Number(a) - Number(b))).toEqual(["2", "3"]);
    expect(groups[0]).toHaveTextContent(/联动执行/);

    const all = items();
    expect(all[all.length - 1].dataset.eventId).toBe("1");
  });

  it("groups a linked pair even when a stranger id sits between its members", async () => {
    await openApp();
    // Pair members at ids 2 and 4, unrelated stop event at id 3.
    const link = "link-stranger";
    server.eventLog.push(
      {
        action_id: LIFT,
        session_id: null,
        event_id: 1,
        holder: "席",
        link_id: null,
        occurred_at: new Date(server.serverNow).toISOString(),
      },
      {
        action_id: HOIST,
        session_id: null,
        event_id: 2,
        holder: "席",
        link_id: link,
        occurred_at: new Date(server.serverNow).toISOString(),
      },
      {
        action_id: STOP,
        session_id: null,
        event_id: 3,
        holder: "席",
        link_id: null,
        occurred_at: new Date(server.serverNow).toISOString(),
      },
      {
        action_id: LIFT,
        session_id: null,
        event_id: 4,
        holder: "席",
        link_id: link,
        occurred_at: new Date(server.serverNow).toISOString(),
      },
    );
    // Advance the mock sequence so later real executes get ids past 4.
    (server as any).nextEventId = 5;

    fireEvent.click(screen.getByTestId("btn-open-history"));
    await within(modal()).findAllByTestId("history-item");

    const all = items();
    expect(all.map((r) => r.dataset.eventId)).toEqual(["3", "4", "2", "1"]);
    const group = within(modal()).getByTestId("history-group");
    expect(
      within(group)
        .getAllByTestId("history-item")
        .map((r) => r.dataset.eventId),
    ).toEqual(["4", "2"]);
  });

  it("reports an anomaly, confirms from another console, both ride with the event", async () => {
    await openApp("异常报告席-A");
    await executeSingle(LIFT);

    // Report on the latest event.
    const panel = within(card(LIFT)).getByTestId("anomaly-panel");
    fireEvent.click(within(panel).getByTestId("btn-anomaly-open"));
    fireEvent.change(within(panel).getByTestId("anomaly-description"), {
      target: { value: "上升 3 米处异响" },
    });
    fireEvent.click(within(panel).getByTestId("btn-anomaly-submit"));
    await waitFor(() =>
      expect(within(panel).getByTestId("anomaly-status")).toHaveTextContent("待确认"),
    );

    // Another console confirms.
    cleanup();
    sessionStorage.setItem(CONSOLE_ID_KEY, CONSOLE_B);
    render(<App />);
    fireEvent.change(screen.getByLabelText("本席名称"), {
      target: { value: "接班确认席-B" },
    });
    await waitFor(() =>
      expect(
        within(card(LIFT)).getByTestId("anomaly-panel"),
      ).toBeInTheDocument(),
    );
    const panelB = within(card(LIFT)).getByTestId("anomaly-panel");
    await waitFor(() =>
      expect(within(panelB).getByTestId("anomaly-record")).toBeInTheDocument(),
    );
    fireEvent.click(within(panelB).getByTestId("btn-anomaly-confirm"));
    await waitFor(() =>
      expect(within(panelB).getByTestId("anomaly-status")).toHaveTextContent("已确认"),
    );

    // The history event carries content, report and confirmation.
    fireEvent.click(screen.getByTestId("btn-open-history"));
    const rows = await within(modal()).findAllByTestId("history-item");
    const a = within(rows[0]).getByTestId("history-anomaly");
    expect(a).toHaveAttribute("data-status", "confirmed");
    expect(a).toHaveTextContent("上升 3 米处异响");
    expect(a).toHaveTextContent(/报告人：异常报告席-A/);
    expect(
      within(a).getByTestId("history-anomaly-confirmation"),
    ).toHaveTextContent(/确认席位：接班确认席-B/);
  });

  it("loads older pages by cursor and never drops loaded rows on failure", async () => {
    await openApp();
    // Six executed events; page size is 20 in the UI, so inject more via the
    // log to force paging. Execute one for real (id 1), then add ids 2..26.
    await executeSingle(LIFT);
    for (let id = 2; id <= 26; id++) {
      server.eventLog.push({
        action_id: id % 2 === 0 ? LIFT : HOIST,
        session_id: null,
        event_id: id,
        holder: "席",
        link_id: null,
        occurred_at: new Date(server.serverNow).toISOString(),
      });
    }
    (server as any).nextEventId = 27;

    fireEvent.click(screen.getByTestId("btn-open-history"));
    let rows = await within(modal()).findAllByTestId("history-item");
    expect(rows).toHaveLength(20);
    expect(rows[0].dataset.eventId).toBe("26");
    expect(rows[19].dataset.eventId).toBe("7");
    const more = within(modal()).getByTestId("btn-history-more");

    // The next OLDER-page request fails: loaded rows stay, tail offers retry.
    server.historyNetworkFailuresLeft = 1;
    fireEvent.click(more);
    const tailError = await within(modal()).findByTestId("history-tail-error");
    expect(tailError).toHaveTextContent(/加载失败.*重试|重试/);
    rows = items();
    expect(rows).toHaveLength(20);
    expect(rows[0].dataset.eventId).toBe("26");

    // Retry succeeds; the remaining 6 rows append (no repeats, no gap).
    fireEvent.click(within(modal()).getByTestId("btn-history-more"));
    await waitFor(() =>
      expect(within(modal()).getByTestId("history-end")).toBeInTheDocument(),
    );
    rows = items();
    expect(rows).toHaveLength(26);
    expect(rows.map((r) => Number(r.dataset.eventId))).toEqual(
      Array.from({ length: 26 }, (_, i) => 26 - i),
    );
  });

  it("history_cursor_invalid keeps loaded rows and shows the recognisable tail hint", async () => {
    await openApp();
    await executeSingle(LIFT);
    for (let id = 2; id <= 26; id++) {
      server.eventLog.push({
        action_id: LIFT,
        session_id: null,
        event_id: id,
        holder: "席",
        link_id: null,
        occurred_at: new Date(server.serverNow).toISOString(),
      });
    }
    (server as any).nextEventId = 27;

    fireEvent.click(screen.getByTestId("btn-open-history"));
    await within(modal()).findAllByTestId("history-item");
    expect(items()).toHaveLength(20);

    server.historyInvalidCursor = true;
    fireEvent.click(within(modal()).getByTestId("btn-history-more"));
    const tailError = await within(modal()).findByTestId("history-tail-error");
    expect(tailError).toHaveTextContent(/游标无效/);
    // Loaded content preserved verbatim.
    expect(items()).toHaveLength(20);
    expect(items()[19].dataset.eventId).toBe("7");
  });

  it("closing and reopening starts again from the newest page", async () => {
    await openApp();
    await executeSingle(LIFT);
    fireEvent.click(screen.getByTestId("btn-open-history"));
    await within(modal()).findAllByTestId("history-item");
    fireEvent.click(within(modal()).getByTestId("btn-history-close"));
    expect(screen.queryByTestId("history-modal")).toBeNull();

    fireEvent.click(screen.getByTestId("btn-open-history"));
    const rows = await within(modal()).findAllByTestId("history-item");
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.eventId).toBe("1");
  });
});
