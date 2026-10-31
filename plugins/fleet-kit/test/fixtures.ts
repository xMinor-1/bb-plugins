// A small, valid manifest with placeholder hosts. Tests clone and edit it.
export function sampleManifest(): Record<string, unknown> {
  return {
    $schema: "./manifest.schema.json",
    schema: 1,
    name: "Example build",
    version: "1.2.0",
    install: { bb: "0.48.1", opencode: "2.2.5" },
    bb: { minVersion: "0.48.0", settings: { telemetryEnabled: false } },
    marketplaces: [],
    plugins: [
      { id: "fleet-kit", source: "git:https://git.example.test/plugins.git", plugin: "fleet-kit", status: "required" },
      { id: "notes", source: "git:https://git.example.test/plugins.git@semver:notes/:^1.0.0", plugin: "notes", status: "required", config: { greeting: "hello" } },
      { id: "later", source: null, status: "planned", note: "not built yet" },
    ],
    removePlugins: ["old-thing"],
    secrets: [{ name: "gateway-key", title: "Gateway key", hint: "From the gateway portal" }],
    allowedProviders: ["corp"],
    opencode: {
      providers: {
        corp: {
          name: "Corp gateway",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "https://llm.example.test/v1", apiKey: "{secret:gateway-key}" },
          models: { "big-model": { name: "Big" }, "small-model": { name: "Small" } },
        },
      },
      model: "corp/big-model",
      update: "disable",
    },
    mcp: [{ id: "wiki", title: "Wiki", type: "remote", url: null, auth: "token", default: false }],
    skills: [],
  };
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
