// Turning a stored automation back into automations_create input, for undoing a deletion.
// Pure, so the tests run it directly.

/**
 * What automations_create needs to make the automation again, from what
 * automations_get returned. Scripts are stored by bb as a file, so the content
 * is read from it. Null when the stored data cannot be recreated.
 */
export async function recreateInput(a: Record<string, unknown>, readScript: (path: string) => Promise<string>): Promise<Record<string, unknown> | null> {
  if ("problem" in a) return null;
  const execution = a.execution as Record<string, unknown>;
  let nextExecution: Record<string, unknown>;
  if (execution.mode === "agent") {
    const { mode, prompt, providerId, model, reasoningLevel, serviceTier, permissionMode, environment, targetThreadId } = execution;
    nextExecution = Object.fromEntries(
      Object.entries({ mode, prompt, providerId, model, reasoningLevel, serviceTier, permissionMode, environment, targetThreadId }).filter(([, v]) => v !== undefined && v !== null),
    );
  } else {
    const path = execution.storedScriptPath;
    let script = typeof execution.script === "string" ? execution.script : null;
    if (script === null && typeof path === "string") script = await readScript(path).catch(() => null);
    if (!script) return null;
    const { interpreter, timeoutMs, env, workingDirectory } = execution;
    nextExecution = Object.fromEntries(
      Object.entries({ mode: "script", script, interpreter, timeoutMs, env, workingDirectory }).filter(([, v]) => v !== undefined && v !== null),
    );
  }
  return {
    projectId: a.projectId,
    name: a.name,
    enabled: a.enabled,
    trigger: a.trigger,
    execution: nextExecution,
    origin: a.origin ?? "app",
    ...(typeof a.createdByThreadId === "string" ? { createdByThreadId: a.createdByThreadId } : {}),
  };
}
