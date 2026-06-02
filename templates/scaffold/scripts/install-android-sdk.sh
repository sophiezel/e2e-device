#!/usr/bin/env bash
# Install Android SDK (macOS Homebrew path) for Appium UiAutomator2
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$(dirname "$0")/lib/common.sh"
orch_cli install-android-sdk
