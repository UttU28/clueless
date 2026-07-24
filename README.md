# Clueless

Simple **always-on-top AI overlay** for Arch Linux.

- AI chat via your OpenAI-compatible API (Gemma server)
- Local Whisper speech-to-text (faster-whisper)
- Screen capture helper
- No stealth/hide/click-through modes — just a floating panel

## Quick start

```bash
cd ~/Desktop/clueless
npm install
npm approve-scripts electron   # Arch only, once
npm run postinstall            # downloads Electron if needed
npm start
```

## Config (`.env`)

```env
LOCAL_LLM_ENABLED=true
LOCAL_LLM_BASE_URL=http://12.216.3.116:8000/v1/
LOCAL_LLM_MODEL=/root/.cache/huggingface/Gemma-4-31B-IT-NVFP4
LOCAL_LLM_MAX_TOKENS=4096
LOCAL_LLM_CONTEXT_LIMIT=16384
LOCAL_LLM_API_KEY=not-needed
```

## Whisper

Python deps live in a local **`venv/`** (created by `./deploy.sh`):

```bash
./deploy.sh
npm run whisper:probe   # should show device: cuda
```

Manual setup:

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
npm run whisper:probe
```

## Requirements

```bash
sudo pacman -S nodejs npm ffmpeg unzip
```

## Whisper (GPU)

`faster-whisper` needs **CUDA 12 runtime libs** (`libcublas.so.12`). They are installed into `./venv` via `requirements.txt`:

```bash
./deploy.sh
npm run whisper:probe   # should show device: cuda
```

You do **not** need to remove/replace the system `cuda` package.

## AI providers

Toggle **Gemma** / **Gemini** in the app header.

| Provider | Use case | Config |
|----------|----------|--------|
| **Gemma** | Your remote vLLM server | `LOCAL_LLM_*` in `.env` |
| **Gemini** | Interview coaching (Google AI) | `GEMINI_API_KEY` + `GEMINI_MODEL=gemini-2.0-flash` |

Get a Gemini API key: https://aistudio.google.com/apikey

Gemini uses an interview-focused system prompt and can read screenshots when you use **Screen**.

## Usage

- Type a message and press **Send** or Enter
- **Listen** — record mic, Whisper, then AI
- **Screen** — capture screen and ask AI
- **×** — quit

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `+` | Start/stop Listen |
| `-` | Capture screen + ask AI |

Customize in `.env` only if you need global shortcuts with modifiers (e.g. `Control+Shift+L`).
Bare `+` and `-` work when the overlay is focused.

## Cleanup

Clicking **×** runs cleanup automatically (stops Whisper, clears temp files, frees GPU).
