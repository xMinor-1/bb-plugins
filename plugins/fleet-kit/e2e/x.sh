#!/bin/bash
# Run a shell command inside the throwaway e2e bb container.
exec docker exec -i "${FLEET_KIT_E2E_CONTAINER:-fleet-kit-e2e}" bash -c "$*"
