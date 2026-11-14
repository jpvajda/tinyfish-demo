import { request, requireApiKey } from "./tinyfish.js";

const AGENT = "https://agent.tinyfish.ai";
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

const PRICING_SCHEMA = {
  type: "object",
  properties: {
    plans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "string" },
          billing_unit: { type: "string" },
          limits: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
          },
          free_tier: { type: "boolean" },
        },
        required: ["name", "price", "billing_unit", "limits", "free_tier"],
      },
    },
    notes: { type: "string", nullable: true },
  },
  required: ["plans", "notes"],
};

const GOAL = [
  "Extract the public pricing plans shown on this page.",
  "Scroll until every plan card and its limits are visible, including cards below the first screen.",
  "Return every plan card. Free, Pay as you go, and Custom are valid prices.",
  "For each plan return the name, the price exactly as written (use Custom when there is no number),",
  "the billing unit such as per month or per browser hour, up to 8 key limits, and whether it is a free tier.",
  "Ignore navigation, testimonials, and FAQs. Do not leave this page.",
].join(" ");

export async function extractPricing(url) {
  requireApiKey();
  const queued = await request(`${AGENT}/v1/automation/run-async`, {
    method: "POST",
    timeoutMs: 30_000,
    body: {
      url,
      goal: GOAL,
      output_schema: PRICING_SCHEMA,
      agent_config: {
        max_steps: 12,
        max_duration_seconds: 90,
      },
    },
  });
  if (queued.error) {
    throw new Error(queued.error.message || "TinyAgent did not start");
  }
  if (!queued.run_id) throw new Error("TinyAgent did not return a run_id");

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const run = await request(`${AGENT}/v1/runs/${queued.run_id}`, { timeoutMs: 30_000 });
    if (!TERMINAL.has(run.status)) {
      await delay(4_000);
      continue;
    }
    if (run.status !== "COMPLETED" || !run.result) {
      throw new Error(run.error?.message || `TinyAgent ${run.status}`);
    }
    return normalizeResult(run.result);
  }
  throw new Error(`TinyAgent run ${queued.run_id} did not finish within 150s`);
}

function normalizeResult(result) {
  const plans = Array.isArray(result.plans) ? result.plans : [];
  const normalized = {
    plans: plans.map((plan) => ({
      name: String(plan?.name ?? "Untitled"),
      price: String(plan?.price ?? "Unknown"),
      billing_unit: String(plan?.billing_unit ?? ""),
      limits: Array.isArray(plan?.limits) ? plan.limits.slice(0, 8).map((item) => String(item)) : [],
      free_tier: Boolean(plan?.free_tier),
    })),
    notes: result.notes == null ? null : String(result.notes),
  };
  if (normalized.plans.length === 0) throw new Error("Extractor returned no plans");
  return normalized;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
