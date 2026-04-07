#!/usr/bin/env sh
# Switch to the next or previous session in opensessions sidebar order.
# Usage: switch-relative.sh <-1|1>   (-1 = previous/up, 1 = next/down)

DELTA="${1:?Usage: switch-relative.sh <-1|1>}"

# Block session switching when multiple clients are attached (multi-window mode)
# Each client stays in its own session — no cross-switching allowed
CLIENT_COUNT=$(tmux list-clients -F '#{client_name}' 2>/dev/null | wc -l)
if [ "$CLIENT_COUNT" -gt 1 ]; then
  tmux display-message "⚠ session switch disabled — multiple windows attached"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/server-common.sh"

ensure_server || exit 0

CTX=$(tmux display-message -p '#{client_tty}|#{session_name}|#{window_id}' 2>/dev/null)
curl -s -o /dev/null -X POST "http://${HOST}:${PORT}/switch-relative?delta=${DELTA}" -d "$CTX"
tmux switch-client -T root >/dev/null 2>&1
