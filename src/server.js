import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { loadCompetitors } from "./competitors.js";
import {
  getMonitorByCompetitor,
  getMonitorByRemoteId,
  insertEvent,
  insertSnapshot,
  latestMarkdownSnapshot,
  latestStructuredSnapshot,
  openDb,
  readState,
  updateSnapshotExtract,
} from "./db.js";
import { unifiedDiff } from "./diff.js";
import { extractPricing } from "./extract.js";
import { fromRoot } from "./paths.js";
import { pageText, runMonitor } from "./tinyfish.js";

const PORT = Number(process.env.PORT || 3000);
const db = openDb();
const publicDir = fromRoot("public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, currentState());
    }
    const runMatch = url.pathname.match(/^\/api\/competitors\/([a-z0-9-]+)\/run$/);
    if (req.method === "POST" && runMatch) {
      const [status, body] = await runNow(runMatch[1]);
      return sendJson(res, status, body);
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/tinyfish") {
      const raw = await readBody(req);
      const [status, body] = await handleWebhook(raw);
      return sendJson(res, status, body);
    }
    if (req.method === "GET") return serveStatic(res, url.pathname);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Request failed" });
  }
});

server.listen(PORT, () => {
  console.log(`Pricing tracker at http://localhost:${PORT}`);
});

function currentState() {
  return readState(db, loadCompetitors());
}

async function runNow(competitorId) {
  const competitor = loadCompetitors().find((item) => item.id === competitorId);
  if (!competitor) return [404, { error: "Unknown competitor" }];
  const monitor = getMonitorByCompetitor(db, competitor.id);
  if (!monitor) return [409, { error: "No monitor yet. Run pnpm run setup." }];

  let run;
  try {
    const response = await runMonitor(monitor.monitor_id);
    run = response.run;
  } catch (error) {
    recordFailure(competitor.id, error.message);
    return [200, { ok: false, error: error.message, state: currentState() }];
  }

  const markdown = pageText(run);
  const runError = run?.errors?.[0];
  if (!markdown) {
    const message = runError?.error ? `Monitor run failed: ${runError.error}` : "Monitor run returned no page text";
    recordFailure(competitor.id, message, run?.id);
    return [200, { ok: false, error: message, state: currentState() }];
  }

  const previousMarkdown = latestMarkdownSnapshot(db, competitor.id)?.markdown ?? null;
  const previousStructured = latestStructuredSnapshot(db, competitor.id);
  const diff = unifiedDiff(previousMarkdown, markdown);
  const outcome = previousMarkdown == null ? "baseline" : diff ? "changed" : "unchanged";
  const missingPlans = !previousStructured?.structured_json;
  let structuredJson = outcome === "unchanged" ? previousStructured?.structured_json ?? null : null;
  let error = null;
  if (outcome === "changed" || outcome === "baseline" || missingPlans) {
    try {
      structuredJson = JSON.stringify(await extractPricing(competitor.pricingUrl));
    } catch (extractError) {
      error = extractError.message;
    }
  }

  const now = new Date().toISOString();
  insertSnapshot(db, {
    competitorId: competitor.id,
    fetchedAt: now,
    markdown,
    structuredJson,
    source: "run_now",
    error,
  });
  insertEvent(db, {
    id: run?.id || `local-${randomUUID()}`,
    competitorId: competitor.id,
    receivedAt: now,
    outcome,
    diff,
    summary: error
      ? error
      : outcome === "unchanged" && missingPlans
        ? "Plans extracted."
        : outcome === "unchanged"
          ? "No change."
          : outcome === "baseline"
            ? "Baseline captured."
            : "Page content changed.",
    source: "run_now",
  });
  return [200, { ok: !error, error, state: currentState() }];
}

function recordFailure(competitorId, message, runId) {
  const now = new Date().toISOString();
  insertSnapshot(db, {
    competitorId,
    fetchedAt: now,
    markdown: latestMarkdownSnapshot(db, competitorId)?.markdown ?? null,
    structuredJson: null,
    source: "run_now",
    error: message,
  });
  insertEvent(db, {
    id: runId || `local-${randomUUID()}`,
    competitorId,
    receivedAt: now,
    outcome: "error",
    diff: null,
    summary: message,
    source: "run_now",
  });
}

async function handleWebhook(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [400, { error: "Malformed JSON" }];
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [400, { error: "Malformed JSON" }];
  }
  if (typeof payload.fetch_monitor_id !== "string" || typeof payload.id !== "string") {
    return [400, { error: "fetch_monitor_id and id are required" }];
  }
  if (!["baseline", "changed", "unchanged"].includes(payload.outcome)) {
    return [400, { error: "outcome must be baseline, changed, or unchanged" }];
  }

  const monitor = getMonitorByRemoteId(db, payload.fetch_monitor_id);
  if (!monitor) return [200, { ok: true, ignored: true }];

  const competitor = loadCompetitors().find((item) => item.id === monitor.competitor_id);
  if (!competitor) return [200, { ok: true, ignored: true }];

  const inserted = insertEvent(db, {
    id: payload.id,
    competitorId: competitor.id,
    receivedAt: new Date().toISOString(),
    outcome: payload.outcome,
    diff: typeof payload.diff === "string" ? payload.diff : null,
    summary: payload.diff_truncated ? `${summaryFor(payload)} Diff was truncated.` : summaryFor(payload),
    source: "webhook",
  });
  if (!inserted) return [200, { ok: true, duplicate: true }];

  const markdown = pageText(payload);
  const shouldExtract = payload.outcome === "changed" && payload.judgment?.is_relevant !== false && markdown;
  if (payload.outcome === "changed" || payload.outcome === "baseline") {
    const previous = latestStructuredSnapshot(db, competitor.id);
    const snapshotId = insertSnapshot(db, {
      competitorId: competitor.id,
      fetchedAt: new Date().toISOString(),
      markdown: markdown ?? previous?.markdown ?? null,
      structuredJson: previous?.structured_json ?? null,
      source: "webhook",
      error: markdown ? null : "Run did not include page text",
    });
    if (shouldExtract) {
      try {
        const structured = await extractPricing(competitor.pricingUrl);
        updateSnapshotExtract(db, snapshotId, JSON.stringify(structured), null);
      } catch (error) {
        updateSnapshotExtract(db, snapshotId, null, error.message);
      }
    }
  }

  return [200, { ok: true }];
}

function summaryFor(payload) {
  if (typeof payload.judgment?.summary === "string" && payload.judgment.summary) return payload.judgment.summary;
  if (typeof payload.judgment?.error === "string" && payload.judgment.error) return payload.judgment.error;
  if (payload.outcome === "changed") return "Pricing page changed.";
  if (payload.outcome === "unchanged") return "No change.";
  return "Baseline captured.";
}

function readBody(req) {
  const limit = 2_000_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error("Request body is too large");
        error.status = 413;
        reject(error);
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(res, pathname) {
  const requested = (pathname === "/" ? "index.html" : pathname).replace(/^\/+/, "");
  if (requested.split("/").includes("..")) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  const filePath = join(publicDir, requested);
  if (!filePath.startsWith(publicDir + sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
