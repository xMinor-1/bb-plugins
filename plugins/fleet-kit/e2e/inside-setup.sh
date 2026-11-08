#!/bin/bash
# Runs inside the e2e container. Builds a local "monorepo" with Fleet Kit and
# a fixture plugin, starts the fake gateway, and writes a build manifest.
#   ~/fleet-src   working tree; ~/fleet.git bare repository bb installs from
#   ~/build/manifest.json  the manifest Fleet Kit reads
set -euo pipefail
cd "$HOME"
git config --global user.email e2e@example.test
git config --global user.name e2e
git config --global init.defaultBranch main

rm -rf fleet-src fleet.git build .fk-e2e
mkdir -p fleet-src/plugins fleet-src/.bb build .fk-e2e
if [ -f /tmp/fleet-kit-base.tgz ]; then
  # An earlier release first; release-current.sh releases the working copy later.
  tar -xzf /tmp/fleet-kit-base.tgz -C fleet-src/plugins
else
  tar -xzf /tmp/fleet-kit-src.tgz -C fleet-src/plugins
fi
fleet_kit_version=$(jq -r .version fleet-src/plugins/fleet-kit/package.json)
cat > fleet-src/.bb/plugins.json <<'EOF'
{ "schemaVersion": 1, "name": "e2e-plugins", "plugins": [
  { "name": "fixture-a", "source": "./plugins/fixture-a" },
  { "name": "fixture-acct", "source": "./plugins/fixture-acct" },
  { "name": "fixture-slow1", "source": "./plugins/fixture-slow1" },
  { "name": "fixture-slow2", "source": "./plugins/fixture-slow2" },
  { "name": "fleet-kit", "source": "./plugins/fleet-kit" } ] }
EOF

# For e2e/first-run.mjs (the First run page on a fresh bb, ~/build/first-run.json):
# fixture-acct answers setupStatus and accountSignIn and writes the login it got
# to ~/.fk-e2e/account.json (the password only as its length);
# fixture-slow1 and fixture-slow2 each depend on a tarball the slow server on
# 127.0.0.1:4020 sends after FK_E2E_SLOW_MS, so the page shows the install queue.
mkdir -p fleet-src/plugins/fixture-acct
cat > fleet-src/plugins/fixture-acct/package.json <<'EOF'
{ "name": "bb-plugin-fixture-acct", "version": "0.1.0", "type": "module",
  "bb": { "name": "Fixture Account", "description": "Fixture plugin with a shared sign-in for Fleet Kit e2e.", "branding": { "icon": "User" }, "server": "./server.ts" } }
EOF
cat > fleet-src/plugins/fixture-acct/server.ts <<'EOF'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
// Any value passes: Standard Schema without a dependency.
const any = { "~standard": { version: 1, vendor: "fixture", validate: (value: unknown) => ({ value }) } } as never;
const contract = defineRpcContract({
  setupStatus: { input: any, output: any },
  accountSignIn: { input: any, output: any },
  openSignIn: { input: any, output: any },
});
const dir = `${process.env.HOME}/.fk-e2e`;
const file = `${dir}/account.json`;
export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(contract, {
    setupStatus: () => existsSync(file)
      ? { state: "done", summary: `Signed in as ${JSON.parse(readFileSync(file, "utf8")).user}` }
      : { state: "todo", summary: "Not signed in yet" },
    accountSignIn: (input: { user?: string; password?: string; lang?: string }, context: { experimental_caller: { kind: string; pluginId?: string } }) => {
      const caller = context.experimental_caller;
      appendFileSync(`${dir}/account-calls.log`, `${JSON.stringify({ caller, user: input.user })}\n`);
      if (caller.kind !== "plugin" || caller.pluginId !== "fleet-kit") {
        throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Only Fleet Kit hands out the sign-in." });
      }
      writeFileSync(file, JSON.stringify({ user: input.user, passwordLength: (input.password ?? "").length, lang: input.lang ?? null }));
      return { state: "done", summary: `Signed in as ${input.user}` };
    },
    openSignIn: (input: unknown) => {
      appendFileSync(`${dir}/account-window.log`, `${JSON.stringify(input)}\n`);
      return { opened: true };
    },
  } as never);
}
EOF
for n in 1 2; do
  mkdir -p fleet-src/plugins/fixture-slow$n
  cat > fleet-src/plugins/fixture-slow$n/package.json <<EOF
{ "name": "bb-plugin-fixture-slow$n", "version": "0.1.0", "type": "module",
  "bb": { "name": "Fixture Slow $n", "description": "Fixture plugin with a slow download for Fleet Kit e2e.", "branding": { "icon": "Clock" }, "server": "./server.ts" },
  "dependencies": { "fk-slow-$n": "http://127.0.0.1:4020/fk-slow-$n.tgz" } }
EOF
  printf 'export default async function plugin() {}\n' > fleet-src/plugins/fixture-slow$n/server.ts
done
mkdir -p fleet-src/plugins/fixture-a
fixture() {
  cat > fleet-src/plugins/fixture-a/package.json <<EOF
{ "name": "bb-plugin-fixture-a", "version": "$1", "type": "module",
  "bb": { "name": "Fixture A", "description": "Fixture plugin for Fleet Kit e2e.", "branding": { "icon": "Zap" }, "server": "./server.ts" } }
EOF
  cat > fleet-src/plugins/fixture-a/server.ts <<'EOF'
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    greeting: { type: "string", label: "Greeting", default: "hi" },
    allowedProviders: { type: "string", label: "Allowed providers", default: "" },
  });
}
EOF
}
fixture 0.1.0
cd fleet-src && git init -q && git add -A && git commit -qm "initial" && git tag fixture-a/v0.1.0 && git tag fixture-acct/v0.1.0 && git tag fixture-slow1/v0.1.0 && git tag fixture-slow2/v0.1.0 && git tag "fleet-kit/v$fleet_kit_version" && cd ..
git clone -q --bare fleet-src fleet.git

umask 077
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > .fk-e2e/expected-key
umask 022
pkill -f "[f]ake-gateway.mjs" || true
# 4010 is the build's gateway; 4011 stands for any other address a project's
# opencode.json could point the provider at. Neither prints the key.
mkdir -p .fk-e2e/requests
(FAKE_GATEWAY_DUMP_DIR=$HOME/.fk-e2e/requests FAKE_GATEWAY_KEY_FILE=$HOME/.fk-e2e/expected-key nohup node /tmp/fake-gateway.mjs 4010 > .fk-e2e/gateway.log 2>&1 &)
(FAKE_GATEWAY_KEY_FILE=$HOME/.fk-e2e/expected-key nohup node /tmp/fake-gateway.mjs 4011 > .fk-e2e/other-gateway.log 2>&1 &)

cat > build/manifest.json <<'EOF'
{
  "schema": 1,
  "name": "E2E build",
  "version": "1.0.0",
  "install": { "bb": "0.48.1", "opencode": "2.2.5" },
  "bb": { "minVersion": "0.48.0", "settings": { "telemetryEnabled": false, "defaultProviderId": "acp-opencode" } },
  "aiServices": { "thread-title": "off", "commit-message": "off", "voice": "off" },
  "agents": { "allowed": ["acp-opencode"] },
  "marketplaces": [],
  "plugins": [
    { "id": "fleet-kit", "source": "git:/home/tester/fleet.git@semver:fleet-kit/:^0.1.0", "plugin": "fleet-kit", "status": "required" },
    { "id": "fixture-a", "source": "git:/home/tester/fleet.git@semver:fixture-a/:^0.1.0", "plugin": "fixture-a", "status": "required", "config": { "greeting": "hello from the build" } },
    { "id": "theme-toggle", "source": "git:https://github.com/xMinor-1/bb-plugins.git@semver:theme-toggle/:^0.3.0", "plugin": "theme-toggle", "status": "required" },
    { "id": "someday", "source": null, "status": "planned" }
  ],
  "removePlugins": ["probe"],
  "secrets": [ { "name": "gateway-key", "title": "Gateway key", "hint": "Any value the fake gateway expects" } ],
  "allowedProviders": ["corp"],
  "opencode": {
    "providers": {
      "corp": {
        "name": "Corp gateway (fake)",
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": { "baseURL": "http://127.0.0.1:4010/v1", "apiKey": "{secret:gateway-key}" },
        "models": { "model-large": { "name": "Large" }, "model-small": { "name": "Small" } }
      }
    },
    "model": "corp/model-large",
    "update": "disable"
  },
  "mcp": [],
  "skills": []
}
EOF
# Fleet Kit's range follows the release installed first: ^0.1.0 for 0.1.x.
fk_range="^$(echo "$fleet_kit_version" | cut -d. -f1,2).0"
jq --arg source "git:/home/tester/fleet.git@semver:fleet-kit/:$fk_range" \
  '(.plugins[] | select(.id == "fleet-kit") | .source) = $source' build/manifest.json > build/manifest.tmp && mv build/manifest.tmp build/manifest.json

# The slow downloads of fixture-slow1 and fixture-slow2 (see above).
mkdir -p .fk-e2e/slow
for n in 1 2; do
  mkdir -p .fk-e2e/slow/pkg$n
  printf '{ "name": "fk-slow-%s", "version": "1.0.0", "main": "index.js" }\n' "$n" > .fk-e2e/slow/pkg$n/package.json
  echo "module.exports = $n;" > .fk-e2e/slow/pkg$n/index.js
  (cd .fk-e2e/slow && npm pack --silent ./pkg$n >/dev/null && mv fk-slow-$n-1.0.0.tgz fk-slow-$n.tgz)
done
cat > .fk-e2e/slow-server.mjs <<'EOF'
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
const dir = `${process.env.HOME}/.fk-e2e/slow`;
const delay = Number(process.env.FK_E2E_SLOW_MS ?? 20000);
createServer((req, res) => {
  const name = (req.url ?? "").replace(/^\//, "");
  appendFileSync(`${dir}/requests.log`, `${new Date().toISOString()} ${req.method} ${name}\n`);
  if (!/^fk-slow-[12]\.tgz$/.test(name)) { res.writeHead(404).end(); return; }
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(`${dir}/${name}`));
  }, delay);
}).listen(4020, "127.0.0.1");
EOF
pkill -f "[s]low-server.mjs" || true
(nohup node .fk-e2e/slow-server.mjs > .fk-e2e/slow-server.log 2>&1 &)

# The First run build for e2e/first-run.mjs, on a bb that has not had a build yet:
# a shared sign-in step, branches with two slow optional plugins and a planned
# one, and the build's sidebar.
jq --arg fk "$(jq -r '.plugins[] | select(.id == "fleet-kit") | .source' build/manifest.json)" '{
  schema: 1, name: "E2E first run", version: "1.0.0",
  install: .install,
  bb: { minVersion: "0.48.0", settings: { telemetryEnabled: false },
        ui: { visiblePluginPanels: ["fleet-kit/fleet-kit"],
              pluginPanelOrder: ["fleet-kit/fleet-kit", "__bb__/extensions", "__bb__/skills", "__bb__/automations"],
              hiddenFooterItems: ["builtin:report-bug"] } },
  marketplaces: [],
  plugins: [
    { id: "fleet-kit", source: $fk, plugin: "fleet-kit", status: "required" },
    { id: "fixture-acct", source: "git:/home/tester/fleet.git@semver:fixture-acct/:^0.1.0", plugin: "fixture-acct", status: "required", title: "Account fixture" },
    { id: "fixture-slow1", source: "git:/home/tester/fleet.git@semver:fixture-slow1/:^0.1.0", plugin: "fixture-slow1", status: "required", title: "Slow one", installNote: "About 20 seconds" },
    { id: "fixture-slow2", source: "git:/home/tester/fleet.git@semver:fixture-slow2/:^0.1.0", plugin: "fixture-slow2", status: "required", title: "Slow two", installNote: "About 20 seconds" },
    { id: "someday", source: null, status: "planned" }
  ],
  secrets: .secrets, allowedProviders: .allowedProviders, opencode: .opencode,
  onboarding: [
    { id: "corp-account", title: "Work account",
      account: { loginHint: "Your work login",
                 plugins: [ { plugin: "fixture-acct", login: "CORP\\{login}" } ],
                 windows: [ { plugin: "fixture-acct", method: "openSignIn" } ] } },
    { id: "slow-two", title: "Set up Slow two", plugin: "fixture-slow2", path: "/plugins/fixture-slow2" }
  ],
  branches: {
    common: ["fixture-acct"],
    optional: [
      { id: "fixture-slow1", title: "Slow one" },
      { id: "fixture-slow2", title: "Slow two" },
      { id: "someday", title: "Someday plugin" }
    ],
    list: [
      { id: "office", title: "Office", plugins: { "fixture-slow1": true, "fixture-slow2": true } },
      { id: "field", title: "Field", plugins: { "fixture-slow1": false, "fixture-slow2": false } }
    ]
  },
  mcp: [], skills: []
}' build/manifest.json > build/first-run.json
echo "setup done"
