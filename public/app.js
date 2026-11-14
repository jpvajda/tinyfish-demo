const competitorsEl = document.querySelector("#competitors");
const feedEl = document.querySelector("#feed");
const logEl = document.querySelector("#log");
const logMoreButton = document.querySelector("#log-more");
const statusEl = document.querySelector("#status");
const runAllButton = document.querySelector("#run-all");
const running = new Set();
const openEvents = new Set();
const LOG_PAGE = 25;
let latestState = null;
let runningAll = false;
let logShown = LOG_PAGE;

document.querySelector("tbody").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button || button.disabled || runningAll) return;
  runCompetitor(button.dataset.id);
});

runAllButton.addEventListener("click", () => {
  if (runAllButton.disabled || runningAll || running.size > 0) return;
  runAll();
});

logMoreButton.addEventListener("click", () => {
  logShown += LOG_PAGE;
  renderLog(latestState?.logs ?? []);
});

await refresh();
setInterval(refresh, 30_000);

async function refresh() {
  const response = await fetch("/api/state");
  const state = await response.json();
  render(state);
}

function render(state) {
  latestState = state;
  const names = new Map(state.competitors.map((competitor) => [competitor.id, competitor.name]));
  const anyMonitor = state.competitors.some((competitor) => competitor.monitorId);
  runAllButton.textContent = runningAll ? "Running…" : "Run all";
  runAllButton.disabled = runningAll || running.size > 0 || !anyMonitor;
  if (runningAll) runAllButton.dataset.running = "true";
  else delete runAllButton.dataset.running;
  runAllButton.title = anyMonitor ? "" : "Run pnpm run setup first";
  competitorsEl.replaceChildren(...state.competitors.map((competitor) => row(competitor)));
  if (state.events.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No changes yet. Run now checks a page immediately. The daily schedule posts here through the webhook.";
    feedEl.replaceChildren(item);
  } else {
    feedEl.replaceChildren(...state.events.map((event) => feedItem(event, names.get(event.competitorId) || event.competitorId)));
  }
  renderLog(state.logs ?? []);
}

function row(competitor) {
  const tr = document.createElement("tr");
  tr.append(nameCell(competitor), plansCell(competitor), timeCell(competitor.checkedAt), actionCell(competitor));
  return tr;
}

function nameCell(competitor) {
  const td = document.createElement("td");
  const link = document.createElement("a");
  link.href = competitor.pricingUrl;
  link.textContent = competitor.name;
  link.target = "_blank";
  link.rel = "noreferrer";
  td.append(link);
  if (competitor.notes) {
    const notes = document.createElement("p");
    notes.className = "notes";
    notes.textContent = competitor.notes;
    td.append(notes);
  }
  if (!competitor.monitorId) {
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = "No monitor yet";
    td.append(meta);
  }
  return td;
}

function plansCell(competitor) {
  const td = document.createElement("td");
  if (competitor.error) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = competitor.error;
    td.append(error);
    if (competitor.stale && competitor.plansAt) {
      const stale = document.createElement("p");
      stale.className = "notes";
      stale.textContent = `Last successful plans are from ${formatTime(competitor.plansAt)}.`;
      td.append(stale);
    }
  }
  const plans = competitor.plans?.plans ?? [];
  if (plans.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = competitor.error ? "" : "No pricing stored yet.";
    if (!competitor.error) td.append(empty);
    return td;
  }
  const wrap = document.createElement("div");
  wrap.className = "plans";
  for (const plan of plans) wrap.append(planCard(plan));
  td.append(wrap);
  if (competitor.plans?.notes) {
    const notes = document.createElement("p");
    notes.className = "notes";
    notes.textContent = competitor.plans.notes;
    td.append(notes);
  }
  return td;
}

function planCard(plan) {
  const card = document.createElement("article");
  card.className = "plan";
  const name = document.createElement("strong");
  name.textContent = plan.name;
  const price = document.createElement("div");
  price.className = "price";
  price.textContent = plan.price;
  card.append(name, price);
  if (plan.billing_unit) {
    const unit = document.createElement("div");
    unit.className = "meta";
    unit.textContent = plan.billing_unit;
    card.append(unit);
  }
  if (plan.free_tier) {
    const free = document.createElement("div");
    free.className = "meta";
    free.textContent = "Free tier";
    card.append(free);
  }
  if (plan.limits?.length) {
    const list = document.createElement("ul");
    list.className = "limits";
    for (const limit of plan.limits) {
      const item = document.createElement("li");
      item.textContent = limit;
      list.append(item);
    }
    card.append(list);
  }
  return card;
}

function timeCell(value) {
  const td = document.createElement("td");
  td.textContent = value ? formatTime(value) : "Not checked";
  return td;
}

function actionCell(competitor) {
  const td = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.id = competitor.id;
  const busy = running.has(competitor.id);
  button.textContent = busy ? "Running…" : "Run now";
  button.disabled = busy || runningAll || !competitor.monitorId;
  if (busy) button.dataset.running = "true";
  else if (!competitor.monitorId) button.title = "Run pnpm run setup first";
  td.append(button);
  return td;
}

function feedItem(event, name) {
  const item = document.createElement("li");
  const details = document.createElement("details");
  if (openEvents.has(event.id)) details.open = true;
  details.addEventListener("toggle", () => {
    if (details.open) openEvents.add(event.id);
    else openEvents.delete(event.id);
  });
  const head = document.createElement("summary");
  const time = document.createElement("time");
  time.dateTime = event.receivedAt;
  time.textContent = formatTime(event.receivedAt);
  const who = document.createElement("strong");
  who.textContent = name;
  const outcome = document.createElement("span");
  outcome.textContent = labelOutcome(event.outcome);
  head.append(time, who, outcome);
  details.append(head);
  if (event.summary) {
    const summary = document.createElement("p");
    summary.textContent = event.summary;
    details.append(summary);
  }
  if (event.diff) {
    const diff = document.createElement("pre");
    diff.textContent = event.diff;
    details.append(diff);
  }
  item.append(details);
  return item;
}

function renderLog(logs) {
  if (logs.length === 0) {
    const empty = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No API calls yet.";
    empty.append(cell);
    logEl.replaceChildren(empty);
    logMoreButton.hidden = true;
    return;
  }
  const visible = logs.slice(0, logShown);
  logEl.replaceChildren(...visible.map(logRow));
  const remaining = logs.length - visible.length;
  logMoreButton.hidden = remaining <= 0;
  logMoreButton.textContent = remaining > 0 ? `Load more (${remaining})` : "Load more";
}

function logRow(entry) {
  const tr = document.createElement("tr");
  tr.append(requestCell(entry), timeCell(entry.sentAt), timeCell(entry.returnedAt), latencyCell(entry));
  return tr;
}

function requestCell(entry) {
  const td = document.createElement("td");
  const code = document.createElement("code");
  code.textContent = `${entry.method} ${entry.url}`;
  td.append(code);
  if (entry.status == null || entry.status >= 400) {
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = entry.status == null ? (entry.error || "No response") : `${entry.status}${entry.error ? `: ${entry.error}` : ""}`;
    td.append(meta);
  }
  return td;
}

function latencyCell(entry) {
  const td = document.createElement("td");
  td.textContent = formatLatency(entry.latencyMs);
  return td;
}

function formatLatency(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function labelOutcome(outcome) {
  if (outcome === "changed") return "Changed";
  if (outcome === "unchanged") return "No change";
  if (outcome === "baseline") return "Baseline";
  if (outcome === "error") return "Error";
  return outcome;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

async function runAll() {
  const queue = (latestState?.competitors ?? []).filter((competitor) => competitor.monitorId);
  if (queue.length === 0) {
    statusEl.textContent = "No monitors yet. Run pnpm run setup first.";
    return;
  }
  runningAll = true;
  const problems = [];
  for (let index = 0; index < queue.length; index += 1) {
    const competitor = queue[index];
    const message = await runCompetitor(
      competitor.id,
      `Running ${competitor.name} (${index + 1} of ${queue.length})…`,
    );
    if (message) problems.push(`${competitor.name}: ${message}`);
  }
  runningAll = false;
  statusEl.textContent = problems.length ? problems.join(" ") : "Checked every competitor.";
  await refresh();
}

async function runCompetitor(id, statusText) {
  running.add(id);
  statusEl.textContent = statusText || "Running monitor…";
  render(await (await fetch("/api/state")).json());
  let message = "";
  try {
    const response = await fetch(`/api/competitors/${id}/run`, { method: "POST" });
    const body = await response.json();
    if (body.state) render(body.state);
    else await refresh();
    message = body.error || "";
    if (!runningAll) statusEl.textContent = message;
  } catch (error) {
    message = error.message;
    if (!runningAll) statusEl.textContent = message;
  } finally {
    running.delete(id);
    await refresh();
  }
  return message;
}
