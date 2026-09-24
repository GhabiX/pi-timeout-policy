export const DEFAULT_TIMEOUT_SECONDS = 60;
export const POLICY_MAX_TIMEOUT_SECONDS = 7200;

export const NATIVE_TIMEOUT_TOOLS = ["bash", "powershell"] as const;
export const WRAPPED_TIMEOUT_TOOLS = ["grep", "find"] as const;

export const TIMEOUT_PARAMETER_DESCRIPTION =
  `Wall-clock timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}, max: ${POLICY_MAX_TIMEOUT_SECONDS}). Set explicitly when this turn needs stdout/exit beyond ${DEFAULT_TIMEOUT_SECONDS}s.`;

export type NativeTimeoutTool = (typeof NATIVE_TIMEOUT_TOOLS)[number];
export type WrappedTimeoutTool = (typeof WRAPPED_TIMEOUT_TOOLS)[number];

export function toolTimeoutGuideline(toolName: string): string {
  return `${toolName} calls default to ${DEFAULT_TIMEOUT_SECONDS}s. If this turn needs stdout/exit and the command may exceed ${DEFAULT_TIMEOUT_SECONDS}s, set timeout in seconds (max ${POLICY_MAX_TIMEOUT_SECONDS} = 2h). timeout<=0 is invalid.`;
}

export function isNativeTimeoutTool(toolName: string): toolName is NativeTimeoutTool {
  return (NATIVE_TIMEOUT_TOOLS as readonly string[]).includes(toolName);
}

export function withTimeoutDescription(description: string, defaultSeconds = DEFAULT_TIMEOUT_SECONDS): string {
  const marker = `${defaultSeconds}s timeout`;
  if (description.includes(marker)) return description;
  return `${description} Defaults to a ${defaultSeconds}s timeout (max ${POLICY_MAX_TIMEOUT_SECONDS}s); set timeout explicitly when this turn must wait longer.`;
}

export function withToolGuideline(guidelines: readonly string[] | undefined, guideline: string): string[] {
  const current = guidelines ?? [];
  return current.includes(guideline) ? [...current] : [...current, guideline];
}

export function timeoutParameterSchema() {
  return {
    type: "number" as const,
    description: TIMEOUT_PARAMETER_DESCRIPTION,
    exclusiveMinimum: 0,
    maximum: POLICY_MAX_TIMEOUT_SECONDS,
  };
}

type TimeoutParameterContainer = { properties?: Record<string, unknown> };
type NativeTimeoutField = "type" | "description" | "exclusiveMinimum" | "maximum";
type NativeTimeoutFieldState = { present: boolean; value: unknown };
type NativeTimeoutFieldStates = Record<NativeTimeoutField, NativeTimeoutFieldState>;

export interface NativeTimeoutParameterSnapshot {
  parameters: TimeoutParameterContainer;
  node: Record<string, unknown>;
  original: NativeTimeoutFieldStates;
  written: NativeTimeoutFieldStates;
}

const NATIVE_TIMEOUT_FIELDS: readonly NativeTimeoutField[] = [
  "type",
  "description",
  "exclusiveMinimum",
  "maximum",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureNativeTimeoutFields(node: Record<string, unknown>): NativeTimeoutFieldStates {
  return Object.fromEntries(
    NATIVE_TIMEOUT_FIELDS.map((field) => [field, { present: Object.hasOwn(node, field), value: node[field] }]),
  ) as NativeTimeoutFieldStates;
}

function sameFieldState(node: Record<string, unknown>, field: NativeTimeoutField, state: NativeTimeoutFieldState): boolean {
  return Object.hasOwn(node, field) === state.present && (!state.present || Object.is(node[field], state.value));
}

function restoreField(node: Record<string, unknown>, field: NativeTimeoutField, state: NativeTimeoutFieldState): void {
  if (state.present) node[field] = state.value;
  else delete node[field];
}

export function captureNativeTimeoutParameter(
  parameters: TimeoutParameterContainer | undefined,
): NativeTimeoutParameterSnapshot | undefined {
  const node = parameters?.properties?.timeout;
  if (!isRecord(node)) return undefined;
  const fields = captureNativeTimeoutFields(node);
  return { parameters: parameters as TimeoutParameterContainer, node, original: fields, written: fields };
}

export function alignNativeTimeoutParameter(parameters: TimeoutParameterContainer | undefined): boolean {
  const timeout = parameters?.properties?.timeout;
  if (!isRecord(timeout)) return false;
  const next = timeoutParameterSchema();
  if (
    timeout.type === next.type &&
    timeout.description === next.description &&
    timeout.exclusiveMinimum === next.exclusiveMinimum &&
    timeout.maximum === next.maximum
  ) {
    return false;
  }
  Object.assign(timeout, next);
  return true;
}

export function markNativeTimeoutParameterAligned(
  snapshot: NativeTimeoutParameterSnapshot,
): NativeTimeoutParameterSnapshot {
  return { ...snapshot, written: captureNativeTimeoutFields(snapshot.node) };
}

export function restoreNativeTimeoutParameter(snapshot: NativeTimeoutParameterSnapshot): boolean {
  if (snapshot.parameters.properties?.timeout !== snapshot.node) return false;
  let restored = false;
  for (const field of NATIVE_TIMEOUT_FIELDS) {
    if (!sameFieldState(snapshot.node, field, snapshot.written[field])) continue;
    restoreField(snapshot.node, field, snapshot.original[field]);
    restored = true;
  }
  return restored;
}

export function applyTimeoutGuideline(systemPrompt: string, guideline: string): string {
  if (systemPrompt.includes(guideline)) return systemPrompt;
  return systemPrompt.length > 0 ? `${systemPrompt}\n\n${guideline}` : guideline;
}

export function applyNativeTimeoutGuidelines(systemPrompt: string, selectedTools: readonly string[] = []): string {
  let next = systemPrompt;
  for (const toolName of NATIVE_TIMEOUT_TOOLS) {
    if (selectedTools.includes(toolName)) {
      next = applyTimeoutGuideline(next, toolTimeoutGuideline(toolName));
    }
  }
  return next;
}

export function validateTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > POLICY_MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: expected 0 < seconds <= ${POLICY_MAX_TIMEOUT_SECONDS}`);
  }
  return timeout;
}

export function applyNativeTimeoutInput(input: { timeout?: unknown }): { block: true; reason: string } | undefined {
  if (input.timeout === undefined) {
    input.timeout = DEFAULT_TIMEOUT_SECONDS;
    return;
  }
  try {
    input.timeout = validateTimeout(input.timeout as number);
  } catch (error) {
    return { block: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeWithDeadline<T>(
  toolName: string,
  timeout: number,
  parentSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = () => new Error(`${toolName} timed out after ${timeout}s`);

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      controller.abort(error);
      reject(error);
    }, timeout * 1000);
  });

  // The owner remains responsible for cleaning up its child after abort. The
  // deadline, however, belongs to this wrapper and must not wait for a
  // cooperative owner to settle. Consume a late rejection so a slow owner
  // cannot become an unhandled rejection after the caller has timed out.
  const owner = Promise.resolve().then(() => execute(controller.signal));
  const ownerResult = owner.then(
    (value) => {
      if (timedOut && !parentSignal?.aborted) throw timeoutError();
      if (parentSignal?.aborted) throw parentSignal.reason ?? new Error("aborted");
      return value;
    },
    (error) => {
      if (timedOut && !parentSignal?.aborted) {
        throw new Error(timeoutError().message, { cause: error });
      }
      throw error;
    },
  );
  ownerResult.catch(() => {});

  let rejectParent!: (reason: unknown) => void;
  const parentAbort = new Promise<never>((_, reject) => {
    rejectParent = reject;
  });
  const onParentReject = () => rejectParent(parentSignal?.reason ?? new Error("aborted"));
  if (parentSignal?.aborted) onParentReject();
  else parentSignal?.addEventListener("abort", onParentReject, { once: true });

  try {
    return await Promise.race([ownerResult, deadline, parentAbort]);
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) {
      throw new Error(timeoutError().message, { cause: error });
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // If the owner wins, the deadline promise is otherwise left pending. A
    // no-op rejection keeps the promise settled without changing the result.
    if (!timedOut) rejectDeadline(new Error("deadline cancelled"));
    parentSignal?.removeEventListener("abort", onParentAbort);
    parentSignal?.removeEventListener("abort", onParentReject);
  }
}

export function wrapExecuteWithTimeout<TExecute extends (...args: any[]) => Promise<unknown>>(
  toolName: string,
  execute: TExecute,
): TExecute {
  const wrapped = async (
    toolCallId: unknown,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => {
    const timeout = validateTimeout((params?.timeout as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS);
    const { timeout: _ignored, ...rest } = params ?? {};
    return executeWithDeadline(toolName, timeout, signal, (deadlineSignal) =>
      execute(toolCallId, rest, deadlineSignal, onUpdate, ctx),
    );
  };
  return wrapped as TExecute;
}

export function withTimeoutOverlay<T extends {
  name: string;
  description: string;
  parameters?: { properties?: Record<string, unknown> };
  promptGuidelines?: string[];
  execute: (...args: any[]) => Promise<unknown>;
}>(definition: T, parameters: T["parameters"]): T {
  const guideline = toolTimeoutGuideline(definition.name);
  return {
    ...definition,
    description: withTimeoutDescription(definition.description),
    parameters,
    promptGuidelines: withToolGuideline(definition.promptGuidelines, guideline),
    execute: wrapExecuteWithTimeout(definition.name, definition.execute),
  };
}
