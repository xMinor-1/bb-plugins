#!/usr/bin/env bash
# Every plugin's lib/i18n.tsx must be an exact copy of shared/i18n.tsx.
# Usage: scripts/check-i18n.sh          check
#        scripts/check-i18n.sh --sync   copy shared/i18n.tsx over the plugins' copies
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
for copy in plugins/*/lib/i18n.tsx; do
  [ -e "$copy" ] || continue
  if ! cmp -s shared/i18n.tsx "$copy"; then
    if [ "${1:-}" = "--sync" ]; then
      cp shared/i18n.tsx "$copy"
      echo "updated $copy"
    else
      echo "differs from shared/i18n.tsx: $copy"
      status=1
    fi
  fi
done
exit $status
