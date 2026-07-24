const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(__dirname, '..', 'scripts', 'whisper_local.py');
const VENV_PYTHON = path.join(__dirname, '..', 'venv', 'bin', 'python3');

function resolvePython() {
  let py = process.env.WHISPER_PYTHON || '';
  if (py.startsWith('./') || py.startsWith('../')) {
    py = path.resolve(path.join(__dirname, '..', py));
  } else if (py && !path.isAbsolute(py)) {
    py = path.resolve(path.join(__dirname, '..', py));
  }
  if (py && fs.existsSync(py)) return py;
  if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
  return 'python3';
}

const PYTHON = () => resolvePython();

let cachedProbe = null;

function pipCudaLibPath(python) {
  const venvLib = path.join(path.dirname(path.dirname(python)), 'lib');
  const dirs = [
    path.join(venvLib, 'python3.14', 'site-packages', 'nvidia', 'cublas', 'lib'),
    path.join(venvLib, 'python3.13', 'site-packages', 'nvidia', 'cublas', 'lib'),
    path.join(venvLib, 'python3.12', 'site-packages', 'nvidia', 'cublas', 'lib'),
    path.join(os.homedir(), '.local', 'lib', 'python3.14', 'site-packages', 'nvidia', 'cublas', 'lib'),
    path.join(os.homedir(), '.local', 'lib', 'python3.13', 'site-packages', 'nvidia', 'cublas', 'lib'),
  ].filter((d) => fs.existsSync(d));

  const cudnnDirs = dirs.map((d) => path.join(path.dirname(d), 'cudnn', 'lib')).filter((d) => fs.existsSync(d));
  return [...dirs, ...cudnnDirs].join(':');
}

function whisperEnv() {
  const python = PYTHON();
  const ldPath = pipCudaLibPath(python);
  const env = {
    ...process.env,
    HOME: process.env.HOME || os.homedir(),
    WHISPER_BACKEND: process.env.WHISPER_BACKEND || 'auto',
    WHISPER_DEVICE: process.env.WHISPER_DEVICE || 'auto',
    WHISPER_MODEL: process.env.WHISPER_MODEL || 'base',
  };
  if (ldPath) env.LD_LIBRARY_PATH = [ldPath, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':');
  return env;
}

async function runPython(args, timeoutMs = 300000) {
  try {
    const { stdout } = await execFileAsync(PYTHON(), [SCRIPT, ...args], {
      timeout: timeoutMs,
      env: whisperEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim());
  } catch (err) {
    const stdout = err.stdout?.toString?.().trim();
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) throw new Error(parsed.error);
        return parsed;
      } catch (e) {
        if (e.message && !e.message.startsWith('Unexpected')) throw e;
      }
    }
    throw new Error(err.stderr?.toString?.().trim() || err.message);
  }
}

async function probeLocalWhisper(force = false) {
  if (cachedProbe && !force) return cachedProbe;
  try {
    cachedProbe = await runPython(['--probe'], 45000);
  } catch (err) {
    cachedProbe = { available: false, message: err.message };
  }
  return cachedProbe;
}

async function transcribeAudio(audioBase64, mimeType) {
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : 'wav';
  const tmpIn = path.join('/tmp', `clueless-audio-${Date.now()}.${ext}`);
  fs.writeFileSync(tmpIn, Buffer.from(audioBase64, 'base64'));
  try {
    const result = await runPython(['--input', tmpIn]);
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
  }
}

module.exports = { probeLocalWhisper, transcribeAudio, resolvePython };
