#!/usr/bin/env bash
# pi-tool/install.sh — wire up the hzn-slack listener as a systemd user service.
#
# Contract (see hzn-hub/docs/TOOLS.md):
#   PI_SUPER_ROOT — pi's super-root on the VM (~/repos)
#   HZN_TOOL_DIR  — where this repo was cloned (~/.hzn-tools/hzn-slack-tool)
#
# Required env (typically populated by hzn-hub/startup/40-secrets.sh):
#   SLACK_BOT_TOKEN  — xoxb-... (chat:write, channels:history, app_mentions:read)
#   SLACK_APP_TOKEN  — xapp-... (connections:write, Socket Mode)
#   SLACK_CHANNEL_ID — VM-specific channel; if absent, listener no-ops at startup.
#
# Idempotent: re-runs cleanly on every profile refresh.

set -euo pipefail
: "${PI_SUPER_ROOT:?PI_SUPER_ROOT not set}"
: "${HZN_TOOL_DIR:?HZN_TOOL_DIR not set}"

log() { printf '\033[36m[hzn-slack/install]\033[0m %s\n' "$*" >&2; }

# 1) listener deps
log "installing listener npm deps"
( cd "$HZN_TOOL_DIR/listener" && \
    if [[ -f package-lock.json ]]; then npm ci --omit=dev --silent
    else                                npm install --omit=dev --silent
    fi
)

# 2) systemd user unit
#    enable-linger lets the unit survive logout / SSH disconnect — needed
#    because the listener must outlive any one shell session.
loginctl enable-linger "$USER" 2>/dev/null || \
  log "WARN: could not enable-linger (non-systemd host?). Listener won't survive logout."

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|@TOOL_DIR@|$HZN_TOOL_DIR|g; s|@USER@|$USER|g" \
    "$HZN_TOOL_DIR/systemd/hzn-slack.service" \
    > "$UNIT_DIR/hzn-slack.service"

if command -v systemctl >/dev/null && systemctl --user >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable hzn-slack.service >/dev/null 2>&1 || true
  systemctl --user restart hzn-slack.service || \
    log "WARN: failed to start hzn-slack.service — check 'journalctl --user -u hzn-slack -e'"
  log "service: $(systemctl --user is-active hzn-slack.service 2>/dev/null || echo unknown)"
else
  log "systemctl --user not available; unit dropped at $UNIT_DIR/hzn-slack.service but not started"
fi

# 3) environment sanity (informational only — don't fail the install)
for v in SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_CHANNEL_ID; do
  if [[ -z "${!v:-}" ]]; then
    log "NOTE: $v not set in this shell. Listener reads it from /etc/profile.d/hzn-dev-env.sh on start."
  fi
done

log "done"
