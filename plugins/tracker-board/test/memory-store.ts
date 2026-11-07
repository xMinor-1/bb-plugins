import type { SecretStore } from "../src/host/secret-store";

export function memoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: "file",
    label: "memory",
    directory: null,
    values,
    has: async (name) => values.has(name),
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => void values.set(name, value),
    delete: async (name) => values.delete(name),
  };
}
