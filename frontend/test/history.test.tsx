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

const LIFT = "lift_up";
const LIFT_DOWN = "lift_down";
const HOIST = "hoist_fly_in";
const STOP = "emergency_stop";

const CONSOLE_A = "console-hist-aaaa";
const CONSOLE_B = "console-hist-bbbb";

const openHistory = () => {
  fireEvent.click(screen.getByTestId("btn-open-history"));
  return screen.getByTestId("history-modal");
};
const groupAt = (i: number) =>
  within(screen.getByTestId("history-list")).getAllByTestId("history-group")[i];

async function renderConsole(seat = "联排负责人", consoleId = CONSOLE_A) {
  cleanup();
  sessionStorage.setItem("handover.console-id.v1", consoleId);
  render(<App />);
  fireEvent.change(screen.getByLabelText("本席名称"), {
    target: { value: seat },
  });
  await waitFor(() =>
    expect(
      within(screen.getByTestId(`action-${LIFT}`)).getByTestId("btn-acquire"),
    ).toBeEnabled(),
  );
}

async function executeAction(id: string) {
  const card = screen.getByTestId(`action-${id}`);
  fireEvent.click(within(card).getByTestId("btn-acquire"));
  await waitFor(() =>
    expect(within(card).getByTestId("btn-execute")).toBeInTheDocument(),
  );
  fireEvent.click(within(card).getByTestId("btn-execute"));
  await waitFor(() =>
    expect(within(card).getByTestId("notice")).toHaveTextContent(/执行成功/),
  );
}

/** Acquire without executing — used to set up a linked pair. */
async function acquireOnly(id: string) {
  const card = screen.getByTestId(`action-${id}`);
  fireEvent.click(within(card).getByTestId("btn-acquire"));
  await waitFor(() =>
    expect(within(card).getByTestId("btn-execute")).toBeInTheDocument(),
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

  it("offers the entry even before a seat name is given and shows empty state", async () => {
    render(<App />);
    const modal = openHistory();
    expect(await within(modal).findByTestId("history-empty")).toHaveTextContent(
      "暂无执行记录",
    );
    fireEvent.click(within(modal).getByTestId("btn-history-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("history-modal")).toBeNull(),
    );
  });

  it("lists a single execution newest-first with time, action and seat", async () => {
    await renderConsole("升降台一席");
    await executeAction(LIFT);

    const modal = openHistory();
    const group = await within(modal).findByTestId("history-group");
    expect(group).toHaveAttribute("data-linked", "0");
    expect(within(group).getByTestId("history-group-kind")).toHaveTextContent(
      "单动作执行",
    );
    expect(within(group).getByTestId("history-event-action")).toHaveTextContent(
      "升降台 上升",
    );
    expect(within(group).getByTestId("history-event-holder")).toHaveTextContent(
      "席位：升降台一席",
    );
    expect(within(group).getByTestId("history-event-time")).toHaveTextContent(
      /执行时间：\d{2}:\d{2}:\d{2}/,
    );
    expect(within(modal).getByTestId("history-end")).toBeInTheDocument();
    expect(within(modal).queryByTestId("btn-history-more")).toBeNull();
  });

  it("groups the linked pair adjacently with the shared link id", async () => {
    await renderConsole("联排席");
    // Acquire BOTH cross-device actions without single-executing either;
    // only then does the linked bar appear.
    await acquireOnly(LIFT_DOWN);
    await acquireOnly(HOIST);

    // Linked bar: submit the pair as one run.
    fireEvent.click(screen.getByTestId("btn-execute-linked"));
    await waitFor(() =>
      expect(screen.getAllByText(/联动执行成功/).length).toBeGreaterThan(0),
    );

    const modal = openHistory();
    const groups = await within(modal).findAllByTestId("history-group");
    // Newest first: the linked group is the only (and first) group.
    expect(groups).toHaveLength(1);
    const linkedGroup = groups[0];
    expect(linkedGroup).toHaveAttribute("data-linked", "1");
    expect(
      within(linkedGroup).getByTestId("history-group-kind"),
    ).toHaveTextContent("联动执行");
    const events = within(linkedGroup).getAllByTestId("history-event");
    expect(events).toHaveLength(2);
    const actions = events.map((e) =>
      within(e).getByTestId("history-event-action").textContent,
    );
    expect(actions.sort()).toEqual(["升降台 下降", "飞行吊点 进场"].sort());
    // Both rows show the same link id.
    const links = within(linkedGroup).getAllByTestId("history-group-link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent(/联动标识/);
  });

  it("shows a reported-and-confirmed anomaly with its owning event", async () => {
    await renderConsole("升降台一席", CONSOLE_A);
    await executeAction(LIFT);
    const card = screen.getByTestId(`action-${LIFT}`);
    fireEvent.click(within(card).getByTestId("btn-anomaly-open"));
    fireEvent.change(within(card).getByTestId("anomaly-description"), {
      target: { value: "上升 3 米异响" },
    });
    fireEvent.click(within(card).getByTestId("btn-anomaly-submit"));
    await within(card).findByTestId("anomaly-record");

    // Another console confirms.
    await renderConsole("下一班-B", CONSOLE_B);
    const cardB = screen.getByTestId(`action-${LIFT}`);
    fireEvent.click(within(cardB).getByTestId("btn-anomaly-confirm"));
    await waitFor(() =>
      expect(
        within(cardB).getByTestId("anomaly-confirmation"),
      ).toBeInTheDocument(),
    );

    const modal = openHistory();
    const anomaly = await within(modal).findByTestId("history-anomaly");
    expect(anomaly).toHaveAttribute("data-status", "confirmed");
    expect(
      within(anomaly).getByTestId("history-anomaly-status"),
    ).toHaveTextContent("已确认");
    expect(
      within(anomaly).getByTestId("history-anomaly-description"),
    ).toHaveTextContent("上升 3 米异响");
    const confirmation = within(anomaly).getByTestId(
      "history-anomaly-confirmation",
    );
    expect(confirmation).toHaveTextContent("确认席位：下一班-B");
  });

  it("pages older groups without losing loaded content; tail failure retries; invalid cursor keeps pages", async () => {
    server.historyPageSize = 1;
    await renderConsole();
    // Three single executions => three one-group pages.
    await executeAction(LIFT);
    await executeAction(STOP);
    await executeAction(LIFT_DOWN);

    const modal = openHistory();
    let groups = await within(modal).findAllByTestId("history-group");
    expect(groups).toHaveLength(1);
    expect(
      within(groups[0]).getByTestId("history-event-action"),
    ).toHaveTextContent("升降台 下降");

    // Load page 2.
    fireEvent.click(within(modal).getByTestId("btn-history-more"));
    await waitFor(() =>
      expect(within(modal).getAllByTestId("history-group")).toHaveLength(2),
    );

    // Script ONE failure for the next (page 3) request: a tail error with a
    // retry prompt must NOT clear the two groups already loaded.
    server.historyFailures.push({
      status: 500,
      code: "http_error",
      message: "请求失败（HTTP 500）",
    });
    fireEvent.click(within(modal).getByTestId("btn-history-more"));
    const tailError = await within(modal).findByTestId(
      "history-more-error",
    );
    expect(tailError).toBeInTheDocument();
    expect(within(modal).getAllByTestId("history-group")).toHaveLength(2);

    // Retry succeeds: the oldest group appends, nothing duplicated.
    fireEvent.click(within(modal).getByTestId("btn-history-retry-more"));
    await waitFor(() =>
      expect(within(modal).queryByTestId("history-more-error")).toBeNull(),
    );
    groups = within(modal).getAllByTestId("history-group");
    expect(groups).toHaveLength(3);
    expect(
      within(groups[2]).getByTestId("history-event-action"),
    ).toHaveTextContent("升降台 上升");
    expect(within(modal).getByTestId("history-end")).toBeInTheDocument();
    const eventIds = groups.map(
      (g) =>
        parseInt(
          within(g)
            .getByTestId("history-event")
            .getAttribute("data-event-id")!,
          10,
        ),
    );
    expect(eventIds).toEqual([3, 2, 1]);

    // New execution committed after the walk starts must not disturb the
    // already-rendered records (it only shows up on a fresh reopen).
    await executeAction(HOIST);
    expect(within(modal).getAllByTestId("history-group")).toHaveLength(3);
    fireEvent.click(within(modal).getByTestId("btn-history-close"));
    const reopened = openHistory();
    // The reopened modal reloads the NEWEST page asynchronously.
    const freshGroups = await within(reopened).findAllByTestId(
      "history-group",
    );
    expect(freshGroups[0]).toHaveTextContent("飞行吊点 进场");
  });

  it("history_cursor_invalid keeps the loaded groups and offers reopen", async () => {
    server.historyPageSize = 1;
    await renderConsole();
    await executeAction(LIFT);
    await executeAction(STOP);
    await executeAction(LIFT_DOWN);

    const modal = openHistory();
    await within(modal).findAllByTestId("history-group");
    fireEvent.click(within(modal).getByTestId("btn-history-more"));
    await waitFor(() =>
      expect(within(modal).getAllByTestId("history-group")).toHaveLength(2),
    );

    // The server rejects the cursor for the third page as malformed.
    server.historyFailures.push({
      status: 400,
      code: "history_cursor_invalid",
      message: "历史分页游标非法，请重新打开执行历史",
    });
    fireEvent.click(within(modal).getByTestId("btn-history-more"));

    const invalid = await within(modal).findByTestId(
      "history-cursor-invalid",
    );
    expect(invalid).toHaveTextContent("history_cursor_invalid");
    // Loaded content survives, and paging stops.
    expect(within(modal).getAllByTestId("history-group")).toHaveLength(2);
    expect(within(modal).queryByTestId("btn-history-more")).toBeNull();

    // "重新打开最新一页" restarts cleanly from the newest page.
    fireEvent.click(within(modal).getByTestId("btn-history-reload"));
    await waitFor(() =>
      expect(within(modal).queryByTestId("history-cursor-invalid")).toBeNull(),
    );
    expect(within(modal).getAllByTestId("history-group")).toHaveLength(1);
    expect(
      within(groupAt(0)).getByTestId("history-event-action"),
    ).toHaveTextContent("升降台 下降");
  });

  it("remains consistent after a page refresh (reopened modal shows same records)", async () => {
    await renderConsole("升降台一席");
    await executeAction(LIFT);
    await executeAction(STOP);

    const modal = openHistory();
    let groups = await within(modal).findAllByTestId("history-group");
    const before = groups.map((g) => g.textContent);

    // Full remount simulates a browser refresh.
    fireEvent.click(within(modal).getByTestId("btn-history-close"));
    cleanup();
    render(<App />);
    fireEvent.change(screen.getByLabelText("本席名称"), {
      target: { value: "联排负责人" },
    });
    const reopened = openHistory();
    groups = await within(reopened).findAllByTestId("history-group");
    expect(groups.map((g) => g.textContent)).toEqual(before);
  });
});
