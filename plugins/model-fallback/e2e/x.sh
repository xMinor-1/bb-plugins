#!/bin/bash
# Run a shell command inside the throwaway e2e bb container.
exec docker exec -i "${MODEL_FALLBACK_E2E_CONTAINER:-model-fallback-e2e}" bash -c "$*"
