import type { AnomalyCategory } from "./api";

// Anomaly categories offered on the card; the stored value is the code, the
// snapshot/poll/history render this Chinese label.
export const ANOMALY_CATEGORY_LABELS: Record<AnomalyCategory, string> = {
  equipment: "设备异常",
  operation: "操作异常",
  environment: "环境异常",
  other: "其他异常",
};
