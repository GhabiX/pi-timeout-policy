import {
  createFindToolDefinition,
  createGrepToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_SECONDS,
  NATIVE_TIMEOUT_TOOLS,
  POLICY_MAX_TIMEOUT_SECONDS,
  TIMEOUT_PARAMETER_DESCRIPTION,
  WRAPPED_TIMEOUT_TOOLS,
  applyNativeTimeoutGuidelines,
  applyNativeTimeoutInput,
  alignNativeTimeoutParameter,
  isNativeTimeoutTool,
  captureNativeTimeoutParameter,
  markNativeTimeoutParameterAligned,
  restoreNativeTimeoutParameter,
  type NativeTimeoutParameterSnapshot,
  timeoutParameterSchema,
  withTimeoutOverlay,
} from "./timeout-policy.ts";

const WRAP_FACTORIES = {
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
} as const;

function overlayBuiltIn<T extends { parameters: { properties?: Record<string, unknown> } }>(definition: T) {
  return withTimeoutOverlay(
    definition,
    Type.Object({
      ...(definition.parameters.properties ?? {}),
      timeout: Type.Optional(timeoutParameterSchema()),
    }),
  );
}

function installOverlays(pi: ExtensionAPI, cwd: string) {
  const known = new Set(pi.getAllTools().map((tool) => tool.name));
  const active = pi.getActiveTools();
  for (const name of WRAPPED_TIMEOUT_TOOLS) {
    if (!known.has(name)) continue;
    pi.registerTool(overlayBuiltIn(WRAP_FACTORIES[name](cwd)));
  }
  pi.setActiveTools(active);
}

export default function toolTimeout(pi: ExtensionAPI) {
  const nativeSnapshots = new Map<string, NativeTimeoutParameterSnapshot>();
  let overlaysInstalled = false;

  // Native-timeout tools already own execution (shell settings, spawn hooks,
  // other bash extensions). Only fill the omitted default.
  pi.on("tool_call", (event) => {
    if (!isNativeTimeoutTool(event.toolName)) return;
    return applyNativeTimeoutInput(event.input);
  });

  // Register same-name overlays after the default active set exists so this
  // package never enables grep/find. Overlay never changes enablement.
  pi.on("session_start", (_event, ctx) => {
    if (!overlaysInstalled) {
      installOverlays(pi, ctx.cwd);
      overlaysInstalled = true;
    }

    for (const toolName of NATIVE_TIMEOUT_TOOLS) {
      if (nativeSnapshots.has(toolName)) continue;
      const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
      const snapshot = captureNativeTimeoutParameter(tool?.parameters);
      if (!snapshot) continue;
      alignNativeTimeoutParameter(tool.parameters);
      nativeSnapshots.set(toolName, markNativeTimeoutParameterAligned(snapshot));
    }
  });

  pi.on("session_shutdown", () => {
    for (const snapshot of nativeSnapshots.values()) restoreNativeTimeoutParameter(snapshot);
    nativeSnapshots.clear();
    overlaysInstalled = false;
  });

  // Keep the per-tool systemPrompt guideline as a second, human-readable cue.
  // Native schemas are aligned above; grep/find guidelines live on the
  // overlayed tool definitions and are included only when those tools are active.
  pi.on("before_agent_start", (event) => {
    const selectedTools = event.systemPromptOptions.selectedTools ?? [];
    const systemPrompt = applyNativeTimeoutGuidelines(event.systemPrompt, selectedTools);
    if (systemPrompt === event.systemPrompt) return;
    return { systemPrompt };
  });
}

export {
  DEFAULT_TIMEOUT_SECONDS,
  POLICY_MAX_TIMEOUT_SECONDS,
  applyNativeTimeoutGuidelines,
  applyNativeTimeoutInput,
  alignNativeTimeoutParameter,
  captureNativeTimeoutParameter,
  isNativeTimeoutTool,
  restoreNativeTimeoutParameter,
  withTimeoutOverlay,
};
