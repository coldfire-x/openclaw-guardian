#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR="$ROOT_DIR/.openclaw-guardian"
ENV_FILE="$STATE_DIR/guardian.env"
CONFIG_PATH="$ROOT_DIR/config/config.yaml"

while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      if [ $# -lt 2 ]; then
        echo "Missing value for --config" >&2
        exit 1
      fi
      CONFIG_PATH="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

case "$CONFIG_PATH" in
  /*) ;;
  *)
    CONFIG_PATH="$ROOT_DIR/$CONFIG_PATH"
    ;;
esac

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

if [ -z "${OPENCLAW_GUARDIAN_LLM_API_KEY:-}" ]; then
  echo "OPENCLAW_GUARDIAN_LLM_API_KEY is empty. Set it in $ENV_FILE or environment." >&2
  exit 1
fi

cd "$ROOT_DIR"
exec node dist/index.js --config "$CONFIG_PATH"
