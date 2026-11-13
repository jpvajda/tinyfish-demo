import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fromRoot } from "./paths.js";

export function openDb() {
  const path = fromRoot("data", "tracker.sqlite");
  mkdirSync(fromRoot("data"), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor_id TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      markdown TEXT,
      structured_json TEXT,
      source TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      competitor_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      diff TEXT,
      summary TEXT,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monitors (
      competitor_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      pricing_url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at TEXT NOT NULL,
      returned_at TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status INTEGER,
      error TEXT
    );
  `);
  return db;
}

export function insertSnapshot(db, row) {
  const result = db.prepare(`
    INSERT INTO snapshots (competitor_id, fetched_at, markdown, structured_json, source, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    row.competitorId,
    row.fetchedAt,
    row.markdown ?? null,
    row.structuredJson ?? null,
    row.source,
    row.error ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function updateSnapshotExtract(db, id, structuredJson, error) {
  db.prepare(`UPDATE snapshots SET structured_json = ?, error = ? WHERE id = ?`).run(
    structuredJson ?? null,
    error ?? null,
    id,
  );
}

export function insertEvent(db, event) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO events (id, competitor_id, received_at, outcome, diff, summary, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.competitorId,
    event.receivedAt,
    event.outcome,
    event.diff ?? null,
    event.summary ?? null,
    event.source,
  );
  return Number(result.changes) === 1;
}

export function saveMonitor(db, row) {
  db.prepare(`
    INSERT INTO monitors (competitor_id, monitor_id, pricing_url)
    VALUES (?, ?, ?)
    ON CONFLICT(competitor_id) DO UPDATE SET
      monitor_id = excluded.monitor_id,
      pricing_url = excluded.pricing_url
  `).run(row.competitorId, row.monitorId, row.pricingUrl);
}

export function deleteMonitorRow(db, competitorId) {
  db.prepare(`DELETE FROM monitors WHERE competitor_id = ?`).run(competitorId);
}

export function getMonitorByCompetitor(db, competitorId) {
  return db.prepare(`SELECT * FROM monitors WHERE competitor_id = ?`).get(competitorId) ?? null;
}

export function getMonitorByRemoteId(db, monitorId) {
  return db.prepare(`SELECT * FROM monitors WHERE monitor_id = ?`).get(monitorId) ?? null;
}

export function latestSnapshot(db, competitorId) {
  return db.prepare(`
    SELECT * FROM snapshots WHERE competitor_id = ? ORDER BY id DESC LIMIT 1
  `).get(competitorId) ?? null;
}

export function latestStructuredSnapshot(db, competitorId) {
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE competitor_id = ? AND structured_json IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(competitorId) ?? null;
}

export function latestMarkdownSnapshot(db, competitorId) {
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE competitor_id = ? AND markdown IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(competitorId) ?? null;
}

export function listEvents(db, limit = 100) {
  return db.prepare(`
    SELECT * FROM events ORDER BY received_at DESC, rowid DESC LIMIT ?
  `).all(limit);
}

export function insertApiLog(entry) {
  let db;
  try {
    db = openDb();
    db.prepare(`
      INSERT INTO api_logs (sent_at, returned_at, latency_ms, method, url, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.sentAt,
      entry.returnedAt,
      entry.latencyMs,
      entry.method,
      entry.url,
      entry.status ?? null,
      entry.error ?? null,
    );
    db.prepare(`
      DELETE FROM api_logs
      WHERE id NOT IN (SELECT id FROM api_logs ORDER BY id DESC LIMIT 300)
    `).run();
  } catch (error) {
    console.error(`API log failed: ${error.message}`);
  } finally {
    db?.close();
  }
}

export function listApiLogs(db, limit = 100) {
  return db.prepare(`
    SELECT * FROM api_logs ORDER BY id DESC LIMIT ?
  `).all(limit);
}

export function readState(db, competitors) {
  const events = listEvents(db);
  return {
    competitors: competitors.map((competitor) => {
      const monitor = getMonitorByCompetitor(db, competitor.id);
      const latest = latestSnapshot(db, competitor.id);
      const structured = latestStructuredSnapshot(db, competitor.id);
      const latestEvent = events.find((event) => event.competitor_id === competitor.id) ?? null;
      const plans = structured ? JSON.parse(structured.structured_json) : null;
      const stale = Boolean(latest?.error && structured && structured.id !== latest.id);
      return {
        id: competitor.id,
        name: competitor.name,
        pricingUrl: competitor.pricingUrl,
        notes: competitor.notes ?? null,
        monitorId: monitor?.monitor_id ?? null,
        plans,
        plansAt: structured?.fetched_at ?? null,
        error: latest?.error ?? null,
        errorAt: latest?.error ? latest.fetched_at : null,
        stale,
        checkedAt: laterIso(latest?.fetched_at, latestEvent?.received_at),
      };
    }),
    events: events.map((event) => ({
      id: event.id,
      competitorId: event.competitor_id,
      receivedAt: event.received_at,
      outcome: event.outcome,
      diff: event.diff,
      summary: event.summary,
      source: event.source,
    })),
    logs: listApiLogs(db).map((entry) => ({
      id: entry.id,
      sentAt: entry.sent_at,
      returnedAt: entry.returned_at,
      latencyMs: entry.latency_ms,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      error: entry.error,
    })),
  };
}

function laterIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}
