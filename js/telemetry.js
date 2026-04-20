import { SHARE_API_BASE_URL } from "./constants.js";

function getTelemetryEndpoint() {
  try {
    if (window?.SC2_SHARE_TELEMETRY_URL) return String(window.SC2_SHARE_TELEMETRY_URL);
  } catch (_) {}
  return `${SHARE_API_BASE_URL}/api/telemetry/events`;
}

export function trackEvent(event, data = {}) {
  const payload = {
    event,
    data,
    happenedAt: new Date().toISOString(),
  };
  console.info("[share-event]", payload);
  try {
    fetch(getTelemetryEndpoint(), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (_) {}
}
