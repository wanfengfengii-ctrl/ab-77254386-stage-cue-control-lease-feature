import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ApiError,
  type HistoryGroup,
} from "./api";
import { ANOMALY_CATEGORY_LABELS } from "./anomalyLabels";
import type { AnomalyCategory } from "./api";
import { formatClock } from "./lease";

/**
 * Read-only execution history (执行历史) for the post-show review.
 *
 * Opens on the NEWEST page and loads older pages with an immutable event-id
 * cursor, so new executions committed meanwhile can never duplicate or shift
 * what is already on screen:
 *  - a failed "load older" request only renders a retry prompt at the list
 *    tail; the already-loaded groups stay exactly as they were;
 *  - a forged/illegal cursor comes back as the recognisable
 *    history_cursor_invalid business error: the same rule applies — the
 *    loaded page is kept and only the tail explains that paging stopped.
 */

type Phase =
  | "loading-first"
  | "ready"
  | "loading-more"
  | "failed-first"
  | "failed-more"
  | "invalid-cursor";

export default function HistoryModal({ onClose }: { onClose: () => void }) {
  const [groups, setGroups] = useState<HistoryGroup[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [phase, setPhase] = useState<Phase>("loading-first");
  const [message, setMessage] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    setPhase("loading-first");
    setMessage(null);
    try {
      const page = await api.history(null);
      setGroups(page.items);
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
      setPhase("ready");
    } catch (e) {
      setMessage((e as ApiError).message ?? "执行历史加载失败");
      setPhase("failed-first");
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setPhase("loading-more");
    setMessage(null);
    try {
      const page = await api.history(cursor);
      // Append only; already-rendered groups are never replaced or cleared.
      setGroups((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
      setPhase("ready");
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.message ?? "更早记录加载失败");
      // A malformed cursor is a distinct, recognisable state: keep every
      // loaded group and stop paging; any other tail failure offers retry.
      setPhase(
        err.code === "history_cursor_invalid"
          ? "invalid-cursor"
          : "failed-more",
      );
    }
  }, [cursor]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  return (
    <div
      className="modal-backdrop"
      data-testid="history-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="执行历史">
        <div className="modal-head">
          <h2>执行历史</h2>
          <span className="modal-hint">按事件编号倒序 · 同一次联动归为一组</span>
          <button
            type="button"
            className="modal-close"
            data-testid="btn-history-close"
            onClick={onClose}
            aria-label="关闭执行历史"
          >
            ×
          </button>
        </div>

        <div className="modal-body" data-testid="history-list">
          {phase === "loading-first" && (
            <p className="modal-status" data-testid="history-loading">
              正在加载最新一页…
            </p>
          )}

          {phase === "failed-first" && (
            <div className="modal-status" data-testid="history-first-error">
              <p className="notice error">{message}</p>
              <button
                type="button"
                className="primary"
                data-testid="btn-history-retry-first"
                onClick={() => void loadFirst()}
              >
                重试
              </button>
            </div>
          )}

          {phase !== "loading-first" && groups.length === 0 &&
            phase !== "failed-first" && (
              <p className="modal-status" data-testid="history-empty">
                暂无执行记录。
              </p>
            )}

          {groups.map((group, gi) => (
            <HistoryGroupView key={`${gi}-${group.events[0]?.event_id}`} group={group} />
          ))}

          {/* Tail zone: load-older button, retry prompt, or cursor notice.
              Whatever happens here never clears the groups rendered above. */}
          {hasMore && phase === "ready" && (
            <div className="history-tail">
              <button
                type="button"
                className="primary"
                data-testid="btn-history-more"
                onClick={() => void loadMore()}
              >
                加载更早记录
              </button>
            </div>
          )}
          {phase === "loading-more" && (
            <p className="modal-status" data-testid="history-loading-more">
              正在加载更早记录…
            </p>
          )}
          {phase === "failed-more" && (
            <div className="history-tail" data-testid="history-more-error">
              <p className="notice error">更早记录加载失败：{message}</p>
              <button
                type="button"
                className="primary"
                data-testid="btn-history-retry-more"
                onClick={() => void loadMore()}
              >
                重试
              </button>
            </div>
          )}
          {phase === "invalid-cursor" && (
            <div className="history-tail" data-testid="history-cursor-invalid">
              <p className="notice error">
                历史分页游标非法（history_cursor_invalid），已停止翻页；
                上面已加载的记录保持不变。
              </p>
              <button
                type="button"
                data-testid="btn-history-reload"
                onClick={() => void loadFirst()}
              >
                重新打开最新一页
              </button>
            </div>
          )}
          {!hasMore && phase === "ready" && groups.length > 0 && (
            <p className="modal-status" data-testid="history-end">
              已到最早记录
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryGroupView({ group }: { group: HistoryGroup }) {
  const linked = group.link_id !== null;
  return (
    <section
      className={`history-group ${linked ? "linked" : "single"}`}
      data-testid="history-group"
      data-linked={linked ? "1" : "0"}
      data-link-id={group.link_id ?? ""}
    >
      <header className="history-group-head">
        <span className="history-kind" data-testid="history-group-kind">
          {linked ? "联动执行" : "单动作执行"}
        </span>
        {linked && (
          <span
            className="history-link"
            data-testid="history-group-link"
            title={group.link_id ?? ""}
          >
            联动标识 {group.link_id!.slice(0, 8)}…
          </span>
        )}
      </header>
      {group.events.map((ev) => (
        <article
          key={ev.event_id}
          className="history-event"
          data-testid="history-event"
          data-event-id={ev.event_id}
        >
          <div className="history-event-head">
            <span className="history-action" data-testid="history-event-action">
              {ev.action_label}
            </span>
            <span className="history-event-id">#{ev.event_id}</span>
          </div>
          <div className="history-meta">
            <span data-testid="history-event-time">
              执行时间：{formatClock(ev.occurred_at)} UTC
            </span>
            <span data-testid="history-event-holder">席位：{ev.holder}</span>
            <span>结果：{ev.result === "executed" ? "已执行" : ev.result}</span>
            {ev.session && (
              <span
                className="history-session"
                data-testid="history-event-session"
                data-status={ev.session.status}
              >
                场次：{ev.session.name}
                （{ev.session.status === "active" ? "进行中" : "已结束"}）
              </span>
            )}
          </div>
          {ev.anomaly && <HistoryAnomaly anomaly={ev.anomaly} />}
        </article>
      ))}
    </section>
  );
}

function HistoryAnomaly({ anomaly }: { anomaly: NonNullable<HistoryGroup["events"][number]["anomaly"]> }) {
  return (
    <div
      className={`history-anomaly ${anomaly.status}`}
      data-testid="history-anomaly"
      data-status={anomaly.status}
    >
      <div className="history-anomaly-head">
        <span className="history-anomaly-tag">
          {ANOMALY_CATEGORY_LABELS[anomaly.category as AnomalyCategory] ??
            anomaly.category}
        </span>
        <span data-testid="history-anomaly-status">
          {anomaly.status === "pending" ? "待确认" : "已确认"}
        </span>
      </div>
      <p className="history-anomaly-text" data-testid="history-anomaly-description">
        {anomaly.description}
      </p>
      <div className="history-anomaly-meta">
        <span>报告人：{anomaly.reported_by}</span>
        <span>报告时间：{formatClock(anomaly.reported_at)} UTC</span>
      </div>
      {anomaly.status === "confirmed" && (
        <div className="history-anomaly-meta" data-testid="history-anomaly-confirmation">
          <span>确认席位：{anomaly.confirmed_by}</span>
          <span>确认时间：{formatClock(anomaly.confirmed_at)} UTC</span>
        </div>
      )}
    </div>
  );
}
