#!/usr/bin/env bash
# Clueless — install, start, and cleanup (Arch Linux)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

VENV="$ROOT/venv"
VENV_PY="$VENV/bin/python3"
VENV_PIP="$VENV/bin/pip"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

pacman_installed() {
  pacman -Q "$1" >/dev/null 2>&1
}

install_pacman() {
  local missing=()
  for pkg in "$@"; do
    pacman_installed "$pkg" || missing+=("$pkg")
  done
  if ((${#missing[@]} == 0)); then
    ok "Pacman packages already installed: $*"
    return 0
  fi
  info "Installing pacman packages: ${missing[*]}"
  if need_cmd sudo; then
    sudo pacman -S --needed --noconfirm "${missing[@]}"
  else
    pacman -S --needed --noconfirm "${missing[@]}"
  fi
  ok "Pacman packages installed"
}

ensure_venv() {
  if [[ -x "$VENV_PY" ]]; then
    ok "Python venv already exists: $VENV"
    return 0
  fi
  info "Creating Python venv…"
  python3 -m venv "$VENV"
  ok "Created venv at $VENV"
}

python_deps_met() {
  [[ -x "$VENV_PY" ]] || return 1
  "$VENV_PY" <<'PY'
import sys
from pathlib import Path
import site

try:
    import faster_whisper  # noqa: F401
except ImportError:
    sys.exit(1)

for root in site.getsitepackages() + [site.getusersitepackages()]:
    if Path(root, "nvidia/cublas/lib/libcublas.so.12").exists():
        sys.exit(0)
sys.exit(1)
PY
}

install_python_deps() {
  ensure_venv

  if python_deps_met; then
    ok "Python venv deps already installed (faster-whisper + CUDA 12 libs)"
    return 0
  fi

  info "Installing Python deps into venv…"
  "$VENV_PIP" install --upgrade pip
  "$VENV_PIP" install -r "$ROOT/requirements.txt"
  ok "Python venv packages installed"
}

ensure_whisper_env_var() {
  if [[ ! -f "$ROOT/.env" ]]; then
    return 0
  fi
  if grep -q '^WHISPER_PYTHON=' "$ROOT/.env" 2>/dev/null; then
    return 0
  fi
  echo 'WHISPER_PYTHON=./venv/bin/python3' >> "$ROOT/.env"
  ok "Added WHISPER_PYTHON to .env"
}

install_npm_deps() {
  info "Installing npm dependencies…"
  npm install
  ok "npm install complete"

  if npm help approve-scripts >/dev/null 2>&1; then
    info "Approving Electron install scripts (Arch npm)…"
    npm approve-scripts electron || warn "Run manually if needed: npm approve-scripts electron"
  fi

  info "Downloading Electron binary…"
  npm run postinstall
  ok "Electron ready"
}

setup_env() {
  if [[ -f "$ROOT/.env" ]]; then
    ok ".env already exists"
    return 0
  fi
  if [[ -f "$ROOT/.env.example" ]]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    ok "Created .env from .env.example — edit LOCAL_LLM_* and GEMINI_API_KEY"
  else
    warn "No .env.example found; create .env manually"
  fi
}

verify_whisper() {
  info "Probing Whisper…"
  local probe
  probe="$(npm run whisper:probe 2>/dev/null || true)"
  echo "$probe"
  if echo "$probe" | grep -q '"available": true'; then
    ok "Whisper available"
    if echo "$probe" | grep -q '"device": "cuda"'; then
      ok "Whisper GPU (CUDA) detected"
    elif echo "$probe" | grep -q '"device": "cpu"'; then
      warn "Whisper running on CPU (GPU libs may still be loading — try again after reboot)"
    fi
  else
    warn "Whisper probe failed — check Python install above"
  fi
}

verify_electron() {
  local electron_bin="$ROOT/node_modules/electron/dist/electron"
  [[ -x "$electron_bin" ]] && ok "Electron binary: $electron_bin" || warn "Electron binary missing — run: npm run postinstall"
}

print_summary() {
  echo
  echo -e "${GREEN}Clueless install finished.${NC}"
  echo
  echo "Edit .env if needed (LOCAL_LLM_* for Gemma, GEMINI_API_KEY for Gemini)."
  echo
  echo "Optional (Wayland screen capture): grim + slurp"
  echo "Optional (system CUDA toolkit):     sudo pacman -S cuda cudnn"
  echo "Whisper GPU uses pip CUDA 12 libs inside ./venv — no need to replace system cuda 13."
  echo
}

start_app() {
  info "Starting Clueless…"
  echo "Press Ctrl+C in this terminal to quit the app."
  echo
  npm start
}

kill_matching() {
  local label="$1"
  local pattern="$2"
  local pids

  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -z "$pids" ]]; then
    ok "No $label processes running"
    return 0
  fi

  local filtered=()
  local pid
  for pid in $pids; do
    [[ "$pid" -eq $$ || "$pid" -eq ${PPID:-0} ]] && continue
    filtered+=("$pid")
  done

  if ((${#filtered[@]} == 0)); then
    ok "No $label processes running"
    return 0
  fi

  info "Stopping $label (PIDs: ${filtered[*]})…"
  kill -TERM "${filtered[@]}" 2>/dev/null || true
  sleep 1

  local remaining=()
  for pid in "${filtered[@]}"; do
    kill -0 "$pid" 2>/dev/null && remaining+=("$pid")
  done

  if ((${#remaining[@]} > 0)); then
    warn "Force-killing $label (PIDs: ${remaining[*]})…"
    kill -KILL "${remaining[@]}" 2>/dev/null || true
  fi

  ok "$label stopped"
}

clean_temp_files() {
  local removed=0
  local f

  for f in /tmp/clueless-audio-* /tmp/clueless-shot-* /tmp/clueless-test.wav; do
    [[ -e "$f" ]] || continue
    rm -f -- "$f" && removed=$((removed + 1))
  done

  if ((removed > 0)); then
    ok "Removed $removed temp file(s) from /tmp"
  else
    ok "No clueless temp files in /tmp"
  fi
}

show_gpu_usage() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    info "GPU memory after cleanup:"
    nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null || true
  fi
}

cmd_cleanup() {
  kill_matching "Whisper (venv python)" "$ROOT/venv/bin/python3.*whisper_local.py"
  kill_matching "Whisper (python script)" "$ROOT/scripts/whisper_local.py"
  clean_temp_files
  show_gpu_usage
}

cmd_install() {
  echo
  info "Clueless installer"
  echo "Directory: $ROOT"
  echo

  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    if [[ "${ID:-}" != "arch" && "${ID_LIKE:-}" != *arch* ]]; then
      warn "This script targets Arch Linux; other distros may need manual steps."
    else
      ok "Detected: ${PRETTY_NAME:-Arch Linux}"
    fi
  fi

  # --- System packages ---
  install_pacman \
    nodejs npm \
    python python-pip \
    ffmpeg unzip \
    grim slurp

  # NVIDIA GPU optional but recommended for Whisper CUDA
  if need_cmd nvidia-smi; then
    ok "NVIDIA GPU detected"
    if ! pacman_installed cuda; then
      warn "System cuda package not installed (optional). Whisper uses pip CUDA 12 libs."
      read -r -p "Install cuda + cudnn from pacman? [y/N] " ans || true
      if [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]]; then
        install_pacman cuda cudnn
      fi
    else
      ok "System cuda package present"
    fi
  else
    warn "nvidia-smi not found — Whisper will use CPU unless GPU drivers are installed"
  fi

  # --- App config ---
  setup_env

  # --- Node ---
  need_cmd node || fail "node not found after pacman install"
  need_cmd npm  || fail "npm not found after pacman install"
  ok "Node $(node -v) · npm $(npm -v)"

  install_npm_deps

  # --- Python / Whisper / CUDA 12 runtime ---
  need_cmd python3 || fail "python3 not found after pacman install"
  ok "Python $(python3 --version)"

  install_python_deps
  ensure_whisper_env_var

  # --- Verify ---
  verify_electron
  verify_whisper

  print_summary
  start_app
}

if [[ "${CLUELESS_CLEANUP:-0}" == "1" ]]; then
  cmd_cleanup
else
  cmd_install
fi
