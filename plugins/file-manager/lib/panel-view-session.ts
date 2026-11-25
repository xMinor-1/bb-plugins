import type { ViewMode } from "../contract";

const fallback = new Map<string, string | null>();
const maximumValueLength = 8 * 1024;

function storageKey(scope: string, field: string): string {
  return `bb-plugin-file-manager:panel-view:v1:${JSON.stringify([scope, field])}`;
}

export function readPanelView(scope: string | undefined, field: string): string | null {
  if (scope === undefined) return null;
  const key = storageKey(scope, field);
  if (fallback.has(key)) return fallback.get(key) ?? null;
  try {
    const value = window.sessionStorage.getItem(key);
    return value !== null && value.length <= maximumValueLength ? value : null;
  } catch {
    return null;
  }
}

export function writePanelView(scope: string | undefined, field: string, value: string | null): void {
  if (scope === undefined || (value !== null && value.length > maximumValueLength)) return;
  const key = storageKey(scope, field);
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
    fallback.delete(key);
  } catch {
    fallback.set(key, value);
  }
}

export function readPanelViewMode(scope: string | undefined, field: string): ViewMode | undefined {
  const mode = readPanelView(scope, field);
  return mode === "list" || mode === "gallery" ? mode : undefined;
}
