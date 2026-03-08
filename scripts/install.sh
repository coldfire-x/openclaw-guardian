#!/usr/bin/env sh
set -eu

MODE="foreground"
CONFIG_ARG="config/config.yaml"

usage() {
  cat <<EOF
Usage: ./scripts/install.sh [--mode foreground|background] [--config path]

Modes:
  foreground  Install/build and run in current terminal
  background  Install/build and register OS service (launchd/systemd user service)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      if [ $# -lt 2 ]; then
        echo "Missing value for --mode" >&2
        exit 1
      fi
      MODE="$2"
      shift 2
      ;;
    --config)
      if [ $# -lt 2 ]; then
        echo "Missing value for --config" >&2
        exit 1
      fi
      CONFIG_ARG="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ "$MODE" != "foreground" ] && [ "$MODE" != "background" ]; then
  echo "Invalid mode: $MODE" >&2
  usage
  exit 1
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONFIG_DIR="$ROOT_DIR/config"
HOME_STATE_DIR="${HOME}/.openclaw-guardian"
ENV_FILE="$HOME_STATE_DIR/guardian.env"
LOG_FILE="$ROOT_DIR/service.log"
RUNNER="$ROOT_DIR/scripts/run-guardian.sh"
USER_ID=$(id -u)

case "$CONFIG_ARG" in
  /*) CONFIG_PATH="$CONFIG_ARG" ;;
  *) CONFIG_PATH="$ROOT_DIR/$CONFIG_ARG" ;;
esac

ensure_prereqs() {
  command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
  command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
}

prepare_files() {
  cd "$ROOT_DIR"

  echo "[openclaw-guardian] Installing dependencies"
  npm install

  echo "[openclaw-guardian] Building"
  npm run build

  if [ ! -f "$CONFIG_PATH" ] && [ "$CONFIG_PATH" = "$ROOT_DIR/config/config.yaml" ]; then
    cp "$CONFIG_DIR/config.example.yaml" "$CONFIG_PATH"
    echo "[openclaw-guardian] Created config/config.yaml from example"
  fi

  if [ ! -f "$CONFIG_PATH" ]; then
    echo "Config file not found: $CONFIG_PATH" >&2
    exit 1
  fi

  mkdir -p "$HOME_STATE_DIR"
  : > "$LOG_FILE"

  if [ ! -f "$ENV_FILE" ]; then
    {
      echo "# openclaw-guardian runtime environment"
      if [ -n "${OPENCLAW_GUARDIAN_LLM_API_KEY:-}" ]; then
        echo "export OPENCLAW_GUARDIAN_LLM_API_KEY=\"$OPENCLAW_GUARDIAN_LLM_API_KEY\""
      else
        echo "export OPENCLAW_GUARDIAN_LLM_API_KEY=\"\""
      fi
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "[openclaw-guardian] Created $ENV_FILE"
  fi
}

install_linux_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found; cannot install background service mode on Linux." >&2
    exit 1
  fi

  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  UNIT_PATH="$UNIT_DIR/openclaw-guardian.service"
  mkdir -p "$UNIT_DIR"

  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=OpenClaw Guardian
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
ExecStart="$RUNNER" --config "$CONFIG_PATH"
Restart=always
RestartSec=5
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now openclaw-guardian.service
  echo "[openclaw-guardian] Linux user service installed and started"
  echo "Check status: systemctl --user status openclaw-guardian.service"
}

install_macos_service() {
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$PLIST_DIR/com.openclaw.guardian.plist"
  mkdir -p "$PLIST_DIR"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.openclaw.guardian</string>
    <key>ProgramArguments</key>
    <array>
      <string>$RUNNER</string>
      <string>--config</string>
      <string>$CONFIG_PATH</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_FILE</string>
    <key>StandardErrorPath</key>
    <string>$LOG_FILE</string>
  </dict>
</plist>
EOF

  launchctl bootout "gui/$USER_ID/com.openclaw.guardian" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$USER_ID" "$PLIST_PATH"
  launchctl enable "gui/$USER_ID/com.openclaw.guardian"
  launchctl kickstart -k "gui/$USER_ID/com.openclaw.guardian"

  echo "[openclaw-guardian] macOS launch agent installed and started"
  echo "Check status: launchctl print gui/$USER_ID/com.openclaw.guardian"
}

ensure_prereqs
prepare_files

if [ "$MODE" = "foreground" ]; then
  echo "[openclaw-guardian] Starting in foreground mode"
  exec "$RUNNER" --config "$CONFIG_PATH"
fi

OS_NAME=$(uname -s)
case "$OS_NAME" in
  Linux) install_linux_service ;;
  Darwin) install_macos_service ;;
  *)
    echo "Unsupported OS for install.sh background mode: $OS_NAME" >&2
    exit 1
    ;;
esac

echo "[openclaw-guardian] Background mode ready"
echo "Set llm.api_key in $CONFIG_PATH (or keep using $ENV_FILE for env fallback)."
echo "Bind Telegram by sending /bind to your bot."
