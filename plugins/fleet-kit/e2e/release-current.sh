#!/bin/bash
# Runs inside the e2e container: releases the working copy of Fleet Kit (the
# tree run.sh copied in) as a new tag in ~/fleet.git, the way a real release
# tags the monorepo.
set -euo pipefail
cd "$HOME/fleet-src"
rm -rf plugins/fleet-kit
tar -xzf /tmp/fleet-kit-src.tgz -C plugins
version=$(jq -r .version plugins/fleet-kit/package.json)
git add -A
git commit -qm "fleet-kit $version"
git tag "fleet-kit/v$version"
git push -q "$HOME/fleet.git" main --tags
echo "$version"
