const MAX_CELLS = 250_000;
const MAX_CHARS = 100_000;

export function unifiedDiff(before, after) {
  const previous = before ?? "";
  const current = after ?? "";
  if (previous === current) return null;

  const a = previous.split("\n");
  const b = current.split("\n");
  const ops = a.length * b.length <= MAX_CELLS ? lcsDiff(a, b) : indexDiff(a, b);
  const show = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i][0] === "eq") continue;
    for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) show[k] = true;
  }

  const lines = ["--- previous", "+++ current"];
  let skipping = false;
  for (let i = 0; i < ops.length; i++) {
    if (!show[i]) {
      skipping = true;
      continue;
    }
    if (skipping) {
      lines.push("...");
      skipping = false;
    }
    const prefix = ops[i][0] === "eq" ? " " : ops[i][0] === "del" ? "-" : "+";
    lines.push(prefix + ops[i][1]);
  }

  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n... diff truncated`;
  return text;
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(["eq", a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["del", a[i]]);
      i++;
    } else {
      ops.push(["add", b[j]]);
      j++;
    }
  }
  while (i < n) ops.push(["del", a[i++]]);
  while (j < m) ops.push(["add", b[j++]]);
  return ops;
}

function indexDiff(a, b) {
  const ops = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) {
      if (a[i] != null) ops.push(["eq", a[i]]);
      continue;
    }
    if (i < a.length) ops.push(["del", a[i]]);
    if (i < b.length) ops.push(["add", b[i]]);
  }
  return ops;
}
