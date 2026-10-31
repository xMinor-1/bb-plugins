#!/bin/sh
# rpc.sh <method> <json-input>: call the plugin's RPC on the bb inside the e2e container.
export BB_SERVER_URL=${BB_SERVER_URL:-http://127.0.0.1:9000}
T=$(/opt/bbv/node_modules/.bin/bb plugin token mcp-catalog)
curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $T" -d "$2" "$BB_SERVER_URL/api/v1/plugins/mcp-catalog/rpc/$1"
