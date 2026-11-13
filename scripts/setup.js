import { loadCompetitors, monitorName } from "../src/competitors.js";
import { insertSnapshot, openDb, saveMonitor } from "../src/db.js";
import { extractPricing } from "../src/extract.js";
import {
  createMonitor,
  desiredWebhookUrl,
  fetchPricingPage,
  listMonitors,
  updateMonitorWebhook,
} from "../src/tinyfish.js";
import { urlKey } from "../src/urls.js";

const competitors = loadCompetitors();
const db = openDb();

try {
  await runSetup();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function runSetup() {
  const webhookUrl = desiredWebhookUrl();
  let failed = 0;

  if (!webhookUrl) {
    console.log("PUBLIC_BASE_URL is unset. Monitors will be created without a webhook.");
    console.log("Start a tunnel, set PUBLIC_BASE_URL, and run pnpm run setup again to attach it.");
  }

  const monitors = await listMonitors();

  for (const competitor of competitors) {
    console.log(`\n${competitor.name}`);
    let markdown = null;
    try {
      const page = await fetchPricingPage(competitor.pricingUrl);
      markdown = page.markdown;
      console.log(`fetched ${markdown.length} chars`);
    } catch (error) {
      failed += 1;
      insertSnapshot(db, {
        competitorId: competitor.id,
        fetchedAt: new Date().toISOString(),
        markdown: null,
        structuredJson: null,
        source: "setup",
        error: error.message,
      });
      console.log(`fetch failed: ${error.message}`);
      continue;
    }

    let structured = null;
    let extractError = null;
    try {
      structured = await extractPricing(competitor.pricingUrl);
      console.log(`extracted ${structured.plans.length} plans`);
    } catch (error) {
      extractError = error.message;
      console.log(`extract failed: ${error.message}`);
    }

    insertSnapshot(db, {
      competitorId: competitor.id,
      fetchedAt: new Date().toISOString(),
      markdown,
      structuredJson: structured ? JSON.stringify(structured) : null,
      source: "setup",
      error: extractError,
    });

    try {
      const monitor = await ensureMonitor(competitor, monitors, webhookUrl);
      saveMonitor(db, {
        competitorId: competitor.id,
        monitorId: monitor.id,
        pricingUrl: competitor.pricingUrl,
      });
      console.log(`monitor ${monitor.id}`);
    } catch (error) {
      failed += 1;
      console.log(`monitor failed: ${error.message}`);
    }
  }

  if (failed > 0) {
    console.log(`\nSetup finished with ${failed} failure(s).`);
    process.exitCode = 1;
  } else {
    console.log("\nSetup finished. One monitor per competitor.");
  }
}

async function ensureMonitor(competitor, known, webhookUrl) {
  const key = urlKey(competitor.pricingUrl);
  const name = monitorName(competitor);
  const byUrl = known.find((monitor) => monitor.type === "fetch" && monitor.status !== "cancelled" && urlKey(monitor.config?.url || "") === key);
  if (byUrl) {
    console.log(`reusing monitor for ${competitor.pricingUrl}`);
    await syncWebhook(byUrl, webhookUrl);
    return byUrl;
  }

  const byName = known.find((monitor) => monitor.name === name && monitor.status !== "cancelled");
  if (byName) {
    throw new Error(
      `${name} already watches ${byName.config?.url}. The monitor URL cannot be changed. Run pnpm run teardown, then setup again.`,
    );
  }

  const created = await createMonitor(competitor, webhookUrl);
  known.push(created.monitor);
  console.log(`created monitor for ${competitor.pricingUrl}`);
  return created.monitor;
}

async function syncWebhook(monitor, webhookUrl) {
  if (!webhookUrl || monitor.webhook_url === webhookUrl) return;
  await updateMonitorWebhook(monitor.id, webhookUrl);
  monitor.webhook_url = webhookUrl;
  console.log(`updated webhook to ${webhookUrl}`);
}
