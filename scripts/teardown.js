import { loadCompetitors } from "../src/competitors.js";
import { deleteMonitorRow, openDb } from "../src/db.js";
import { deleteMonitor, listMonitors } from "../src/tinyfish.js";
import { urlKey } from "../src/urls.js";

const competitors = loadCompetitors();
const wanted = new Map(competitors.map((competitor) => [urlKey(competitor.pricingUrl), competitor]));
const db = openDb();

try {
  await runTeardown();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function runTeardown() {
  const monitors = await listMonitors();
  let failed = 0;

  for (const monitor of monitors) {
    if (monitor.type !== "fetch" || !monitor.config?.url) continue;
    let key;
    try {
      key = urlKey(monitor.config.url);
    } catch {
      continue;
    }
    const competitor = wanted.get(key);
    if (!competitor) continue;
    try {
      await deleteMonitor(monitor.id);
      deleteMonitorRow(db, competitor.id);
      console.log(`deleted ${monitor.id} ${competitor.name}`);
    } catch (error) {
      failed += 1;
      console.log(`failed to delete ${monitor.id}: ${error.message}`);
    }
  }

  if (failed > 0) {
    console.log(`Teardown finished with ${failed} failure(s).`);
    process.exitCode = 1;
  } else {
    console.log("Teardown finished.");
  }
}
