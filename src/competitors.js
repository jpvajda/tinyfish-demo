import { readFileSync } from "node:fs";
import { fromRoot } from "./paths.js";
import { urlKey } from "./urls.js";

export function loadCompetitors() {
  const list = JSON.parse(readFileSync(fromRoot("competitors.json"), "utf8"));
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("competitors.json must be a non-empty array");
  }
  const ids = new Set();
  const urls = new Set();
  for (const item of list) {
    if (!item || typeof item.id !== "string" || !/^[a-z0-9-]+$/.test(item.id)) {
      throw new Error(`Invalid competitor id: ${item?.id}`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate competitor id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new Error(`Competitor ${item.id} needs a name`);
    }
    let key;
    try {
      key = urlKey(item.pricingUrl);
    } catch {
      throw new Error(`Competitor ${item.id} has an invalid pricingUrl`);
    }
    if (urls.has(key)) throw new Error(`Duplicate pricing URL: ${item.pricingUrl}`);
    urls.add(key);
    for (const field of ["includeSelectors", "excludeSelectors"]) {
      if (item[field] == null) continue;
      if (!Array.isArray(item[field]) || item[field].some((entry) => typeof entry !== "string" || entry.length === 0)) {
        throw new Error(`Competitor ${item.id} ${field} must be an array of CSS selectors`);
      }
    }
  }
  return list;
}

export const MONITOR_PURPOSE =
  "Alert on changes to pricing, plan limits, or free tier. Ignore layout and copy tweaks.";

export const SCHEDULE_CRON = "CRON_TZ=America/Los_Angeles 0 8 * * *";

export function monitorName(competitor) {
  return `pricing:${competitor.id}`.slice(0, 100);
}
