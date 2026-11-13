import { MONITOR_PURPOSE, SCHEDULE_CRON, monitorName } from "./competitors.js";
import { insertApiLog } from "./db.js";

const AGENT = "https://agent.tinyfish.ai";
const FETCH = "https://api.fetch.tinyfish.ai";

export function requireApiKey() {
  const key = process.env.TINYFISH_API_KEY?.trim();
  if (!key) {
    throw new Error("TINYFISH_API_KEY is missing. Copy .env.example to .env and paste a personal key from https://agent.tinyfish.ai/api-keys");
  }
  return key;
}

export function desiredWebhookUrl() {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/api/webhooks/tinyfish`;
}

export async function fetchPricingPage(url) {
  const data = await request(FETCH, {
    method: "POST",
    timeoutMs: 150_000,
    body: {
      urls: [url],
      format: "markdown",
      purpose: "Snapshot a competitor pricing page for a daily change tracker",
      ttl: 0,
      per_url_timeout_ms: 90_000,
    },
  });
  const failure = (data.errors ?? []).find((item) => item.url === url) ?? null;
  const page = (data.results ?? []).find((item) => item.url === url) ?? null;
  if (!page || page.text == null) {
    const code = failure?.error || "empty_content";
    throw new Error(`Fetch failed for ${url}: ${code}`);
  }
  const markdown = typeof page.text === "string" ? page.text : JSON.stringify(page.text);
  return { markdown, title: page.title ?? null };
}

export async function listMonitors() {
  const data = await request(`${AGENT}/v1/monitors`, { timeoutMs: 30_000 });
  return data.monitors ?? [];
}

export async function createMonitor(competitor, webhookUrl) {
  const config = {
    url: competitor.pricingUrl,
    format: "markdown",
  };
  if (competitor.includeSelectors?.length) config.include_selectors = competitor.includeSelectors;
  if (competitor.excludeSelectors?.length) config.exclude_selectors = competitor.excludeSelectors;
  const body = {
    type: "fetch",
    name: monitorName(competitor),
    config,
    schedule_cron: SCHEDULE_CRON,
    purpose: MONITOR_PURPOSE,
  };
  if (webhookUrl) body.webhook_url = webhookUrl;
  return request(`${AGENT}/v1/monitors`, {
    method: "POST",
    timeoutMs: 180_000,
    body,
  });
}

export async function updateMonitorWebhook(monitorId, webhookUrl) {
  return request(`${AGENT}/v1/monitors/${monitorId}`, {
    method: "PATCH",
    timeoutMs: 30_000,
    body: { webhook_url: webhookUrl },
  });
}

export async function deleteMonitor(monitorId) {
  return request(`${AGENT}/v1/monitors/${monitorId}`, {
    method: "DELETE",
    timeoutMs: 30_000,
  });
}

export async function runMonitor(monitorId) {
  return request(`${AGENT}/v1/monitors/${monitorId}/runs`, {
    method: "POST",
    timeoutMs: 180_000,
  });
}

export function pageText(run) {
  const page = run?.results?.[0];
  if (!page || page.text == null) return null;
  return typeof page.text === "string" ? page.text : JSON.stringify(page.text);
}

export async function request(url, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const sentAt = new Date();
  const started = performance.now();
  let status = null;
  let errorMessage = null;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": requireApiKey(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      errorMessage = payload?.error?.message || text || response.statusText;
      const error = new Error(`${method} ${new URL(url).pathname} failed (${response.status}): ${errorMessage}`);
      error.status = response.status;
      throw error;
    }
    return payload ?? {};
  } catch (error) {
    if (!errorMessage) errorMessage = error.message;
    throw error;
  } finally {
    insertApiLog({
      sentAt: sentAt.toISOString(),
      returnedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      method,
      url,
      status,
      error: status != null && status < 400 ? null : trimError(errorMessage),
    });
  }
}

function trimError(message) {
  if (!message) return null;
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
