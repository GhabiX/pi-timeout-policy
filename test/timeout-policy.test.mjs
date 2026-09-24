import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TIMEOUT_SECONDS,
  POLICY_MAX_TIMEOUT_SECONDS,
  alignNativeTimeoutParameter,
  applyNativeTimeoutGuidelines,
  applyNativeTimeoutInput,
  applyTimeoutGuideline,
  captureNativeTimeoutParameter,
  executeWithDeadline,
  markNativeTimeoutParameterAligned,
  restoreNativeTimeoutParameter,
  toolTimeoutGuideline,
  timeoutParameterSchema,
  validateTimeout,
  withTimeoutDescription,
  withTimeoutOverlay,
  withToolGuideline,
  wrapExecuteWithTimeout,
} from "../extensions/timeout-policy.ts";

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

test("default budget is 60s and policy max is 2h", () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 60);
  assert.equal(POLICY_MAX_TIMEOUT_SECONDS, 7200);
});

test("validateTimeout accepts a finite positive budget", () => {
  assert.equal(validateTimeout(60), 60);
  assert.equal(validateTimeout(7200), 7200);
  assert.equal(validateTimeout(0.05), 0.05);
});

test("validateTimeout rejects non-positive or oversized values", () => {
  assert.throws(() => validateTimeout(0), /Invalid timeout/);
  assert.throws(() => validateTimeout(-1), /Invalid timeout/);
  assert.throws(() => validateTimeout(Number.NaN), /Invalid timeout/);
  assert.throws(() => validateTimeout(POLICY_MAX_TIMEOUT_SECONDS + 1), /Invalid timeout/);
});

test("native timeout schema alignment is in-place and idempotent", () => {
  const timeout = { type: "number", description: "Timeout in seconds (optional, no default timeout)" };
  const parameters = { properties: { timeout } };
  const snapshot = captureNativeTimeoutParameter(parameters);
  assert.ok(snapshot);

  assert.equal(alignNativeTimeoutParameter(parameters), true);
  assert.equal(timeout.description, "Wall-clock timeout in seconds (default: 60, max: 7200). Set explicitly when this turn needs stdout/exit beyond 60s.");
  assert.equal(timeout.exclusiveMinimum, 0);
  assert.equal(timeout.maximum, 7200);
  assert.equal(alignNativeTimeoutParameter(parameters), false);

  const aligned = markNativeTimeoutParameterAligned(snapshot);
  assert.equal(restoreNativeTimeoutParameter(aligned), true);
  assert.deepEqual(timeout, {
    type: "number",
    description: "Timeout in seconds (optional, no default timeout)",
  });
});

test("native timeout restoration preserves third-party field changes and restores the rest", () => {
  const timeout = { type: "number", description: "native" };
  const parameters = { properties: { timeout } };
  const snapshot = captureNativeTimeoutParameter(parameters);
  assert.ok(snapshot);
  alignNativeTimeoutParameter(parameters);
  const aligned = markNativeTimeoutParameterAligned(snapshot);

  timeout.description = "third-party override";
  assert.equal(restoreNativeTimeoutParameter(aligned), true);
  assert.equal(timeout.description, "third-party override");
  assert.equal(timeout.type, "number");
  assert.equal(Object.hasOwn(timeout, "exclusiveMinimum"), false);
  assert.equal(Object.hasOwn(timeout, "maximum"), false);

  parameters.properties.timeout = { ...timeout };
  assert.equal(restoreNativeTimeoutParameter(aligned), false);
});

test("native timeout alignment skips missing timeout nodes", () => {
  assert.equal(alignNativeTimeoutParameter({ properties: {} }), false);
  assert.equal(captureNativeTimeoutParameter({ properties: {} }), undefined);
});

test("guidelines are per-tool and append once", () => {
  const bash = toolTimeoutGuideline("bash");
  assert.match(bash, /bash calls default to 60s/);
  assert.match(bash, /max 7200 = 2h/);
  assert.equal(/background_job/.test(bash), false);
  assert.equal(/background_job/.test(toolTimeoutGuideline("grep")), false);
  assert.equal(applyTimeoutGuideline("", bash), bash);
  assert.equal(applyTimeoutGuideline("base prompt", bash), `base prompt\n\n${bash}`);
  assert.equal(applyTimeoutGuideline(`base prompt\n\n${bash}`, bash), `base prompt\n\n${bash}`);
});

test("native guidelines only attach for selected shell tools", () => {
  const bash = toolTimeoutGuideline("bash");
  const powershell = toolTimeoutGuideline("powershell");
  assert.equal(applyNativeTimeoutGuidelines("base", ["grep", "find"]), "base");
  assert.equal(applyNativeTimeoutGuidelines("base", ["bash"]), `base\n\n${bash}`);
  assert.equal(
    applyNativeTimeoutGuidelines("base", ["bash", "powershell"]),
    `base\n\n${bash}\n\n${powershell}`,
  );
});

test("executeWithDeadline returns when work finishes in budget", async () => {
  const result = await executeWithDeadline("grep", 1, undefined, async () => "ok");
  assert.equal(result, "ok");
});

test("executeWithDeadline rejects at the deadline even when the owner is slow", async () => {
  const started = Date.now();
  await assert.rejects(
    () => executeWithDeadline("grep", 0.05, undefined, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return "owner-settled";
    }),
    /grep timed out after 0\.05s/,
  );
  assert.ok(Date.now() - started < 500);
});

test("executeWithDeadline consumes a late owner rejection", async () => {
  const started = Date.now();
  await assert.rejects(
    () => executeWithDeadline("find", 0.05, undefined, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw new Error("owner failed late");
    }),
    /find timed out after 0\.05s/,
  );
  assert.ok(Date.now() - started < 500);
});

test("executeWithDeadline does not accept a success caused by timeout abort", async () => {
  await assert.rejects(
    () => executeWithDeadline("grep", 0.05, undefined, (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve("settled after abort"), { once: true });
    })),
    /grep timed out after 0\.05s/,
  );
});

test("executeWithDeadline times out when the child honors abort", async () => {
  await assert.rejects(
    () => executeWithDeadline("grep", 0.05, undefined, waitForAbort),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match(error.message, /grep timed out after 0\.05s/);
      return true;
    },
  );
});

test("executeWithDeadline preserves parent cancellation", async () => {
  const parent = new AbortController();
  const pending = executeWithDeadline("find", 1, parent.signal, waitForAbort);
  parent.abort(new Error("parent cancelled"));
  await assert.rejects(pending, /parent cancelled/);
});

test("wrapExecuteWithTimeout strips timeout and enforces a deadline for signal tools", async () => {
  const seen = [];
  const wrapped = wrapExecuteWithTimeout("grep", async (_id, params, signal) => {
    seen.push(params);
    return waitForAbort(signal);
  });
  await assert.rejects(
    () => wrapped("id", { pattern: "x", timeout: 0.05 }, undefined, undefined, {}),
    /grep timed out after 0\.05s/,
  );
  assert.deepEqual(seen[0], { pattern: "x" });
});

test("withTimeoutOverlay adds timeout without becoming a new tool", async () => {
  const overlayed = withTimeoutOverlay({
    name: "grep",
    description: "Search files",
    parameters: { properties: { pattern: { type: "string" } }, required: ["pattern"] },
    promptGuidelines: ["Use grep for content search."],
    async execute(_id, params) {
      return params;
    },
  }, {
    type: "object",
    properties: {
      pattern: { type: "string" },
      timeout: timeoutParameterSchema(),
    },
    required: ["pattern"],
  });

  assert.equal(Object.hasOwn(overlayed.parameters.properties, "timeout"), true);
  assert.match(overlayed.description, /60s timeout/);
  assert.match(overlayed.description, /max 7200s/);
  assert.deepEqual(overlayed.promptGuidelines, [
    "Use grep for content search.",
    toolTimeoutGuideline("grep"),
  ]);
  assert.deepEqual(await overlayed.execute("id", { pattern: "x" }), { pattern: "x" });
  assert.equal(withTimeoutDescription(overlayed.description), overlayed.description);
  assert.deepEqual(
    withToolGuideline(overlayed.promptGuidelines, toolTimeoutGuideline("grep")),
    overlayed.promptGuidelines,
  );
});

test("applyNativeTimeoutInput fills omitted and blocks over policy max", () => {
  const omitted = {};
  assert.equal(applyNativeTimeoutInput(omitted), undefined);
  assert.equal(omitted.timeout, 60);

  const explicit = { timeout: 1800 };
  assert.equal(applyNativeTimeoutInput(explicit), undefined);
  assert.equal(explicit.timeout, 1800);

  const blocked = applyNativeTimeoutInput({ timeout: 7201 });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /7200/);

  const zero = applyNativeTimeoutInput({ timeout: 0 });
  assert.equal(zero.block, true);
});
