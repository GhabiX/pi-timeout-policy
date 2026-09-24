import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = join(import.meta.dirname, "..");

function resolvePiIndex() {
  const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  return join(dirname(realpathSync(piBin)), "..", "index.js");
}

const PI_INDEX = pathToFileURL(resolvePiIndex()).href;
const PI_AI_INDEX = pathToFileURL(
  join(dirname(fileURLToPath(PI_INDEX)), "..", "node_modules/@earendil-works/pi-ai/dist/index.js"),
).href;
const GOOGLE_SHARED_INDEX = pathToFileURL(
  join(dirname(fileURLToPath(PI_AI_INDEX)), "api/google-shared.js"),
).href;
const pi = await import(PI_INDEX);
const piAi = await import(PI_AI_INDEX);
const googleShared = await import(GOOGLE_SHARED_INDEX);
const policy = await import(pathToFileURL(join(PLUGIN, "extensions/timeout-policy.ts")).href);

function schemaProperties(schema) {
  return schema?.properties ?? {};
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadPlugin() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-timeout-load-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  return pi.discoverAndLoadExtensions(
    [join(PLUGIN, "extensions/tool-timeout.ts")],
    cwd,
    agentDir,
  );
}

async function createIsolatedSession(tools, { withPlugin = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-timeout-e2e-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, "needle.txt"), "alpha-timeout-token\n");

  const settingsManager = pi.SettingsManager.inMemory({ packages: withPlugin ? [await realpath(PLUGIN)] : [] });
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(),
    modelRuntime: await pi.ModelRuntime.create(),
    ...(tools ? { tools } : {}),
  });
  await session.bindExtensions({});
  return { cwd, session, extensions: resourceLoader.getExtensions() };
}

async function shutdownSession(session, reason = "quit") {
  await session._extensionRunner.emit({ type: "session_shutdown", reason });
  session.dispose?.();
}

function assertAlignedNativeTimeoutSchema(definition) {
  const timeout = schemaProperties(definition.parameters).timeout;
  assert.equal(timeout.type, "number");
  assert.equal(timeout.description, policy.TIMEOUT_PARAMETER_DESCRIPTION);
  assert.equal(timeout.exclusiveMinimum, 0);
  assert.equal(timeout.maximum, 7200);
  assert.equal(definition.parameters.required?.includes("timeout") ?? false, false);
}

test("factory load registers no tools; grep/find overlay waits for session_start", async () => {
  const loaded = await loadPlugin();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);

  const ext = loaded.extensions[0];
  assert.deepEqual(
    [...ext.tools.keys()],
    [],
  );
  assert.equal(ext.handlers.has("session_start"), true);
  assert.equal(ext.handlers.has("session_shutdown"), true);
  assert.equal(ext.handlers.has("tool_call"), true);
  assert.equal(ext.handlers.has("before_agent_start"), true);
});

test("tool_call fills bash/powershell default 60, preserves explicit values, blocks over 2h", async () => {
  const loaded = await loadPlugin();
  const handler = loaded.extensions[0].handlers.get("tool_call")[0];

  const omitted = { command: "true" };
  assert.equal(await handler({ toolName: "bash", input: omitted }), undefined);
  assert.equal(omitted.timeout, 60);

  const explicit = { command: "true", timeout: 12 };
  assert.equal(await handler({ toolName: "bash", input: explicit }), undefined);
  assert.equal(explicit.timeout, 12);

  const pwsh = { command: "true" };
  await handler({ toolName: "powershell", input: pwsh });
  assert.equal(pwsh.timeout, 60);

  const blocked = await handler({ toolName: "bash", input: { command: "true", timeout: 7201 } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /7200/);

  const grepInput = { pattern: "x" };
  await handler({ toolName: "grep", input: grepInput });
  assert.equal(grepInput.timeout, undefined);
});

test("before_agent_start only injects native-tool guidelines for selected tools", async () => {
  const loaded = await loadPlugin();
  const handler = loaded.extensions[0].handlers.get("before_agent_start")[0];
  const bash = policy.toolTimeoutGuideline("bash");

  const grepOnly = await handler({
    systemPrompt: "base prompt",
    systemPromptOptions: { selectedTools: ["grep", "find"] },
  });
  assert.equal(grepOnly, undefined);

  const result = await handler({
    systemPrompt: "base prompt",
    systemPromptOptions: { selectedTools: ["bash"] },
  });
  assert.equal(result.systemPrompt, `base prompt\n\n${bash}`);

  const second = await handler({
    systemPrompt: result.systemPrompt,
    systemPromptOptions: { selectedTools: ["bash"] },
  });
  assert.equal(second, undefined);
});

test("overlay does not enable grep/find on the default tool set", async () => {
  const { cwd, session } = await createIsolatedSession();
  try {
    const active = session.getActiveToolNames();
    assert.deepEqual(active.includes("bash"), true);
    assert.equal(active.includes("grep"), false);
    assert.equal(active.includes("find"), false);
    const grepDef = session.getToolDefinition("grep");
    const findDef = session.getToolDefinition("find");
    const bashDef = session.getToolDefinition("bash");
    assert.equal(schemaProperties(grepDef.parameters).timeout.type, "number");
    assert.equal(schemaProperties(findDef.parameters).timeout.type, "number");
    assertAlignedNativeTimeoutSchema(bashDef);
    const powershellDef = session.getToolDefinition("powershell");
    if (powershellDef) assertAlignedNativeTimeoutSchema(powershellDef);
    await session._extensionRunner.emit({ type: "session_start", reason: "startup" });
    assertAlignedNativeTimeoutSchema(session.getToolDefinition("bash"));
    assert.equal(/grep calls default to 60s/.test(session.systemPrompt ?? ""), false);
    assert.equal(/find calls default to 60s/.test(session.systemPrompt ?? ""), false);

    const injected = await session._extensionRunner.emitBeforeAgentStart(
      "probe",
      undefined,
      session.systemPrompt ?? "base",
      { cwd, selectedTools: active, promptGuidelines: [] },
    );
    assert.match(injected.systemPrompt, /bash calls default to 60s/);
    assert.equal(/background_job/.test(injected.systemPrompt), false);
    assert.equal(/grep calls default to 60s/.test(injected.systemPrompt), false);

    session.setActiveToolsByName([...active, "grep"]);
    assert.match(session.systemPrompt ?? "", /grep calls default to 60s/);
  } finally {
    await shutdownSession(session);
  }
});

test("native timeout validation uses the aligned live schema", async () => {
  const { session } = await createIsolatedSession(["bash"]);
  try {
    const bashTool = session._toolRegistry.get("bash");
    const powershellDef = session.getToolDefinition("powershell");
    if (powershellDef) assertAlignedNativeTimeoutSchema(powershellDef);
    assert.doesNotThrow(() => piAi.validateToolArguments(bashTool, { name: "bash", arguments: { command: "true" } }));
    assert.doesNotThrow(() => piAi.validateToolArguments(bashTool, { name: "bash", arguments: { command: "true", timeout: 1800 } }));
    assert.doesNotThrow(() => piAi.validateToolArguments(bashTool, { name: "bash", arguments: { command: "true", timeout: 7200 } }));
    const converted = googleShared.convertTools([bashTool])[0].functionDeclarations[0].parametersJsonSchema;
    assertAlignedNativeTimeoutSchema({ parameters: converted });
    for (const timeout of [0, -1, 7201]) {
      assert.throws(
        () => piAi.validateToolArguments(bashTool, { name: "bash", arguments: { command: "true", timeout } }),
        /Validation failed/,
      );
    }
  } finally {
    await shutdownSession(session);
  }
});

test("native schema alignment is restored before a no-plugin session", async () => {
  const pluginSession = await createIsolatedSession(["bash"]);
  try {
    assertAlignedNativeTimeoutSchema(pluginSession.session.getToolDefinition("bash"));
    await shutdownSession(pluginSession.session);
  } catch (error) {
    pluginSession.session.dispose?.();
    throw error;
  }

  const cleanSession = await createIsolatedSession(["bash"], { withPlugin: false });
  try {
    const timeout = schemaProperties(cleanSession.session.getToolDefinition("bash").parameters).timeout;
    assert.equal(timeout.type, "number");
    assert.equal(timeout.description, "Timeout in seconds (optional, no default timeout)");
    assert.equal(Object.hasOwn(timeout, "exclusiveMinimum"), false);
    assert.equal(Object.hasOwn(timeout, "maximum"), false);
    assert.equal(cleanSession.extensions.extensions.length, 0);
  } finally {
    cleanSession.session.dispose?.();
  }
});

test("isolated Pi session overlays grep/find and executes bash/grep/find timeouts", async () => {
  const { cwd, session, extensions } = await createIsolatedSession(["bash", "grep", "find"]);
  try {
    assert.deepEqual(extensions.errors, []);
    assert.equal(
      extensions.extensions.some((ext) => String(ext.path).includes("tool-timeout")),
      true,
    );

    const active = session.getActiveToolNames();
    for (const name of ["bash", "grep", "find"]) assert.equal(active.includes(name), true);

    const bashDef = session.getToolDefinition("bash");
    const grepDef = session.getToolDefinition("grep");
    const findDef = session.getToolDefinition("find");
    assertAlignedNativeTimeoutSchema(bashDef);
    assert.equal(schemaProperties(grepDef.parameters).timeout.type, "number");
    assert.equal(schemaProperties(findDef.parameters).timeout.type, "number");
    assert.match(grepDef.description, /60s timeout/);
    assert.match(findDef.description, /60s timeout/);
    assert.deepEqual(Object.keys(schemaProperties(grepDef.parameters)), [
      "pattern",
      "path",
      "glob",
      "ignoreCase",
      "literal",
      "context",
      "limit",
      "timeout",
    ]);
    assert.match(session.systemPrompt ?? "", /grep calls default to 60s/);
    assert.match(session.systemPrompt ?? "", /find calls default to 60s/);
    assert.equal(/bash calls default to 60s/.test(session.systemPrompt ?? ""), false);

    const injected = await session._extensionRunner.emitBeforeAgentStart(
      "probe",
      undefined,
      session.systemPrompt ?? "base",
      { cwd, promptGuidelines: [], selectedTools: ["bash", "grep", "find"] },
    );
    assert.equal(injected.systemPrompt.includes(policy.toolTimeoutGuideline("bash")), true);

    const bashTool = session._toolRegistry.get("bash");
    const grepTool = session._toolRegistry.get("grep");
    const findTool = session._toolRegistry.get("find");

    const omitted = { command: "echo ok-timeout" };
    const block = await session.agent.beforeToolCall({
      toolCall: { name: "bash", id: "bash-default" },
      args: omitted,
    });
    assert.equal(block, undefined);
    assert.equal(omitted.timeout, 60);

    const bashOk = await withTimeout(
      bashTool.execute("bash-ok", { command: "echo ok-timeout", timeout: 2 }),
      5000,
      "bash success",
    );
    assert.match(JSON.stringify(bashOk), /ok-timeout/);

    const bashTimeoutStart = Date.now();
    await assert.rejects(
      () => withTimeout(
        bashTool.execute("bash-to", { command: "sleep 5", timeout: 0.4 }),
        5000,
        "bash timeout",
      ),
      /timed out after 0\.4 seconds/,
    );
    const bashTimeoutMs = Date.now() - bashTimeoutStart;
    assert.ok(bashTimeoutMs >= 300 && bashTimeoutMs < 2500, `bash timeout ms=${bashTimeoutMs}`);

    const grepOk = await withTimeout(
      grepTool.execute("grep-ok", { pattern: "alpha-timeout-token", path: cwd }),
      5000,
      "grep default timeout success",
    );
    assert.match(JSON.stringify(grepOk), /alpha-timeout-token/);

    const findOk = await withTimeout(
      findTool.execute("find-ok", { pattern: "needle.txt", path: cwd, timeout: 5 }),
      5000,
      "find success",
    );
    assert.match(JSON.stringify(findOk), /needle.txt/);

    const grepHangStart = Date.now();
    await assert.rejects(
      () => withTimeout(
        grepTool.execute("grep-hang", { pattern: "nomatch", path: "/dev/zero", timeout: 0.4 }),
        5000,
        "grep hang",
      ),
      /grep timed out after 0\.4s/,
    );
    const grepHangMs = Date.now() - grepHangStart;
    assert.ok(grepHangMs < 2500, `grep hang ms=${grepHangMs}`);

    const parent = new AbortController();
    const pending = grepTool.execute(
      "grep-parent",
      { pattern: "nomatch", path: "/dev/zero", timeout: 5 },
      parent.signal,
    );
    setTimeout(() => parent.abort(new Error("parent cancelled")), 150);
    await assert.rejects(() => withTimeout(pending, 5000, "grep parent cancel"), (error) => {
      assert.equal(/timed out/i.test(error.message), false);
      assert.match(error.message, /aborted|parent cancelled/i);
      return true;
    });

    const findHangStart = Date.now();
    await assert.rejects(
      () => withTimeout(
        findTool.execute("find-hang", {
          pattern: "zzz-pi-tool-timeout-no-such-file",
          path: "/data",
          timeout: 0.1,
        }),
        5000,
        "find hang",
      ),
      /find timed out after 0\.1s/,
    );
    const findHangMs = Date.now() - findHangStart;
    assert.ok(findHangMs < 2500, `find hang ms=${findHangMs}`);

    await assert.rejects(
      () => grepTool.execute("grep-invalid", { pattern: "x", path: cwd, timeout: 0 }),
      /Invalid timeout/,
    );
  } finally {
    await shutdownSession(session);
  }
});
