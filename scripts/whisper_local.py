#!/usr/bin/env python3
"""Local Whisper STT for Clueless — GPU if available, else CPU."""
from __future__ import annotations

import argparse
import ctypes.util
import json
import os
import shutil
import site
import subprocess
import sys
import warnings
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
warnings.filterwarnings("ignore", message=".*unauthenticated requests to the HF Hub.*")

_cuda_env_ready = False


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def pip_cuda_lib_dirs() -> list[str]:
    """Dirs from `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` (CUDA 12 runtime)."""
    dirs: list[str] = []
    search_roots = site.getsitepackages() + [site.getusersitepackages()]
    for root in search_roots:
        for sub in ("nvidia/cublas/lib", "nvidia/cudnn/lib"):
            path = os.path.join(root, sub)
            if os.path.isdir(path):
                dirs.append(path)
    return dirs


def setup_cuda_env() -> None:
    global _cuda_env_ready
    if _cuda_env_ready:
        return

    pip_dirs = pip_cuda_lib_dirs()
    parts = list(pip_dirs)
    if not pip_dirs:
        parts.extend([
            "/opt/cuda/lib64",
            "/opt/cuda/targets/x86_64-linux/lib",
        ])
    parts = [p for p in parts if os.path.isdir(p)]
    current = os.environ.get("LD_LIBRARY_PATH", "")
    os.environ["LD_LIBRARY_PATH"] = ":".join(parts + ([current] if current else []))
    _cuda_env_ready = True


def has_nvidia_smi() -> bool:
    if not shutil.which("nvidia-smi"):
        return False
    try:
        r = subprocess.run(["nvidia-smi"], capture_output=True, timeout=8)
        return r.returncode == 0
    except OSError:
        return False


def has_cublas12() -> bool:
    setup_cuda_env()
    for libdir in pip_cuda_lib_dirs():
        if os.path.exists(os.path.join(libdir, "libcublas.so.12")):
            return True
    for lib in ("cublas", "cublas.so.12", "libcublas.so.12"):
        if ctypes.util.find_library(lib):
            return True
    for libdir in ("/opt/cuda/lib64", "/opt/cuda/targets/x86_64-linux/lib"):
        if os.path.exists(os.path.join(libdir, "libcublas.so.12")):
            return True
    return False


def cuda_usable() -> tuple[bool, str]:
    setup_cuda_env()
    if not has_nvidia_smi():
        return False, "nvidia-smi not found"
    if not has_cublas12():
        return False, "libcublas.so.12 missing — pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.* --break-system-packages"

    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return True, ""
        return False, "ctranslate2 reports 0 CUDA devices"
    except Exception as err:
        return False, str(err)


def resolve_device(requested: str) -> tuple[str, bool]:
    req = (requested or "auto").lower()
    usable, _ = cuda_usable()
    if req == "cpu":
        return "cpu", False
    if req == "cuda":
        return ("cuda", True) if usable else ("cpu", False)
    return ("cuda", True) if usable else ("cpu", False)


def can_import(name: str) -> bool:
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def pick_backend() -> str | None:
    req = (os.environ.get("WHISPER_BACKEND") or "auto").lower()
    if req == "faster-whisper" and can_import("faster_whisper"):
        return "faster-whisper"
    if req == "openai-whisper" and can_import("whisper"):
        return "openai-whisper"
    if req in ("whisper-cpp", "cpp") and shutil.which("whisper-cli"):
        return "whisper-cpp"
    if req != "auto":
        return None
    if can_import("faster_whisper"):
        return "faster-whisper"
    if can_import("whisper"):
        return "openai-whisper"
    if shutil.which("whisper-cli"):
        return "whisper-cpp"
    return None


def convert_to_wav(src: str) -> str:
    if src.endswith(".wav"):
        return src
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("Install ffmpeg: sudo pacman -S ffmpeg")
    out = str(Path(src).with_suffix(".wav"))
    subprocess.run([ffmpeg, "-y", "-i", src, "-ar", "16000", "-ac", "1", out], check=True, capture_output=True)
    return out


def transcribe_faster_whisper(audio: str, model: str, device: str) -> tuple[str, str, str | None]:
    setup_cuda_env()
    from faster_whisper import WhisperModel

    def run(dev: str) -> tuple[str, str]:
        ct = "float16" if dev == "cuda" else "int8"
        m = WhisperModel(model, device=dev, compute_type=ct)
        segs, _ = m.transcribe(audio, beam_size=5, vad_filter=True)
        return " ".join(s.text.strip() for s in segs).strip(), dev

    try:
        text, dev = run(device)
        return text, dev, None
    except Exception as err:
        if device == "cuda":
            text, dev = run("cpu")
            return text, dev, str(err)
        raise


def probe() -> dict:
    setup_cuda_env()
    backend = pick_backend()
    device, gpu = resolve_device(os.environ.get("WHISPER_DEVICE", "auto"))
    model = os.environ.get("WHISPER_MODEL", "base")
    if not backend:
        return {"available": False, "message": "Install: pip install faster-whisper --break-system-packages"}
    note = ""
    if has_nvidia_smi() and device == "cpu":
        _, reason = cuda_usable()
        if reason:
            note = f" (GPU unavailable — {reason})"
    return {
        "available": True,
        "backend": backend,
        "device": device,
        "gpu": gpu and device == "cuda",
        "model": model,
        "message": f"{backend} ({device}){note}",
    }


def transcribe(path: str) -> dict:
    info = probe()
    if not info["available"]:
        return {"error": info["message"]}
    device, _ = resolve_device(os.environ.get("WHISPER_DEVICE", "auto"))
    model = os.environ.get("WHISPER_MODEL", "base")
    wav = convert_to_wav(path)
    created = wav != path
    try:
        text, device, cuda_error = transcribe_faster_whisper(wav, model, device)
        out = {
            "text": text,
            "backend": info["backend"],
            "device": device,
            "gpu": device == "cuda",
        }
        if cuda_error:
            out["fallback"] = "cuda->cpu"
            out["cuda_error"] = cuda_error
        return out
    finally:
        if created and Path(wav).is_file():
            Path(wav).unlink(missing_ok=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--probe", action="store_true")
    p.add_argument("--input")
    args = p.parse_args()
    if args.probe:
        emit(probe())
        return 0
    if not args.input or not Path(args.input).is_file():
        emit({"error": "Missing --input file"})
        return 1
    try:
        emit(transcribe(args.input))
        return 0
    except Exception as e:
        emit({"error": str(e)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
