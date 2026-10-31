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
tar -xzf /tmp/fleet-kit-src.tgz -C fleet-src/plugins
cat > fleet-src/.bb/plugins.json <<'EOF'
{ "schemaVersion": 1, "name": "e2e-plugins", "plugins": [
  { "name": "fixture-a", "source": "./plugins/fixture-a" },
  { "name": "fleet-kit", "source": "./plugins/fleet-kit" } ] }
EOF
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
cd fleet-src && git init -q && git add -A && git commit -qm "initial" && git tag fixture-a/v0.1.0 && git tag fleet-kit/v0.1.0 && cd ..
git clone -q --bare fleet-src fleet.git

umask 077
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > .fk-e2e/expected-key
umask 022
pkill -f "[f]ake-gateway.mjs" || true
# 4010 is the build's gateway; 4011 stands for any other address a project's
# opencode.json could point the provider at. Neither prints the key.
(FAKE_GATEWAY_KEY_FILE=$HOME/.fk-e2e/expected-key nohup node /tmp/fake-gateway.mjs 4010 > .fk-e2e/gateway.log 2>&1 &)
(FAKE_GATEWAY_KEY_FILE=$HOME/.fk-e2e/expected-key nohup node /tmp/fake-gateway.mjs 4011 > .fk-e2e/other-gateway.log 2>&1 &)

cat > build/manifest.json <<'EOF'
{
  "schema": 1,
  "name": "E2E build",
  "version": "1.0.0",
  "install": { "bb": "0.48.1", "opencode": "2.2.5" },
  "bb": { "minVersion": "0.48.0", "settings": { "telemetryEnabled": false, "defaultProviderId": "acp-opencode" } },
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
echo "setup done"
