const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { probeLocalWhisper, transcribeAudio } = require('./whisper');

const execFileAsync = promisify(execFile);

/** @type {BrowserWindow | null} */
let mainWindow = null;
let cleanupDone = false;

function runCleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  const deploy = path.join(__dirname, '..', 'deploy.sh');
  if (!fs.existsSync(deploy)) return;
  spawnSync('bash', [deploy], {
    cwd: path.join(__dirname, '..'),
    stdio: 'ignore',
    env: { ...process.env, CLUELESS_CLEANUP: '1' },
  });
}
/** @type {'gemma' | 'gemini'} */
let aiProvider = process.env.CLUELESS_DEFAULT_PROVIDER === 'gemini' ? 'gemini' : 'gemma';

const INTERVIEW_SYSTEM_PROMPT = `You are an expert interview coach helping someone answer live interview questions.
Give clear, confident answers formatted in Markdown (**bold** key terms, bullet lists, ## headers for sections).
Use this structure when helpful: direct answer first, 2-4 concrete points, brief real-world example, short closing line.
For technical questions: explain the concept simply, mention trade-offs, and note when you'd ask clarifying questions.
For behavioral questions: use concise STAR format (Situation, Task, Action, Result).
Keep answers under 180 words unless the question clearly needs more depth.
Do not mention that you are an AI.`;

const GEMMA_SYSTEM_PROMPT = `You are a concise helpful assistant.
Format every reply in Markdown: use **bold** labels, bullet lists, and short headers (##) when helpful.
Keep answers clear and scannable.`;

function getConfig() {
  const maxTokens = Number.parseInt(process.env.LOCAL_LLM_MAX_TOKENS || '4096', 10);
  const contextLimit = Number.parseInt(process.env.LOCAL_LLM_CONTEXT_LIMIT || '16384', 10);

  return {
    localLlmEnabled: process.env.LOCAL_LLM_ENABLED === 'true',
    localLlmBaseUrl: (process.env.LOCAL_LLM_BASE_URL || '').replace(/\/$/, ''),
    localLlmModel: process.env.LOCAL_LLM_MODEL || '',
    localLlmMaxTokens: Math.min(
      Number.isFinite(maxTokens) ? maxTokens : 4096,
      Number.isFinite(contextLimit) ? Math.max(512, contextLimit - 1024) : 4096,
    ),
    localLlmApiKey: process.env.LOCAL_LLM_API_KEY || 'not-needed',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
  };
}

function shortModelName(modelPath) {
  if (!modelPath) return 'local-llm';
  const parts = modelPath.split(/[/\\]/);
  return parts[parts.length - 1] || modelPath;
}

function activeProvider(cfg, provider = aiProvider) {
  if (provider === 'gemini') {
    if (!cfg.geminiApiKey) {
      throw new Error('Set GEMINI_API_KEY in .env to use Gemini');
    }
    return {
      type: 'gemini',
      model: cfg.geminiModel,
      apiKey: cfg.geminiApiKey,
      maxTokens: 4096,
    };
  }

  if (cfg.localLlmEnabled && cfg.localLlmBaseUrl) {
    return { type: 'local-llm', baseUrl: cfg.localLlmBaseUrl, model: cfg.localLlmModel, apiKey: cfg.localLlmApiKey, maxTokens: cfg.localLlmMaxTokens };
  }
  if (cfg.openaiApiKey) {
    return { type: 'openai', baseUrl: cfg.openaiBaseUrl, model: cfg.openaiModel, apiKey: cfg.openaiApiKey, maxTokens: 4096 };
  }
  return { type: 'ollama', baseUrl: cfg.ollamaUrl, model: cfg.ollamaModel, apiKey: '', maxTokens: 4096 };
}

function providerLabel(cfg, provider = aiProvider) {
  if (provider === 'gemini') return cfg.geminiModel.replace(/^models\//, '');
  if (cfg.localLlmEnabled && cfg.localLlmBaseUrl) return shortModelName(cfg.localLlmModel);
  return activeProvider(cfg, provider).model;
}

function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }
  return contents;
}

function geminiSystemInstruction(messages) {
  const system = messages.find((m) => m.role === 'system');
  return system ? { parts: [{ text: system.content }] } : undefined;
}

async function geminiGenerate(cfg, messages, image) {
  const provider = activeProvider(cfg, 'gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${provider.apiKey}`;

  const parts = [{ text: messages.filter((m) => m.role === 'user').at(-1)?.content || 'Help with this.' }];
  if (image?.base64) {
    parts.push({
      inline_data: {
        mime_type: image.mime || 'image/png',
        data: image.base64,
      },
    });
  }

  const payload = {
    contents: image?.base64
      ? [{ role: 'user', parts }]
      : toGeminiContents(messages),
    generationConfig: {
      maxOutputTokens: provider.maxTokens,
      temperature: 0.7,
    },
  };

  const systemInstruction = geminiSystemInstruction(messages);
  if (systemInstruction) payload.systemInstruction = systemInstruction;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Gemini error (${res.status}): ${await res.text()}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

async function chatCompletion(messages, providerOverride = aiProvider) {
  const cfg = getConfig();
  const provider = activeProvider(cfg, providerOverride);

  if (provider.type === 'gemini') {
    return geminiGenerate(cfg, messages);
  }

  if (provider.type === 'ollama') {
    const res = await fetch(`${provider.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: provider.model, messages, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.message?.content || '';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: provider.model, messages, max_tokens: provider.maxTokens }),
  });
  if (!res.ok) throw new Error(`${provider.type} error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function captureScreen() {
  if (process.env.XDG_SESSION_TYPE === 'wayland') {
    try {
      const region = await execFileAsync('slurp', ['-b', '00000000', '-c', '00000080', '-s', 'Crosshair']);
      const geom = region.stdout.trim();
      if (geom) {
        const { stdout } = await execFileAsync('grim', ['-g', geom, '-']);
        return { base64: Buffer.from(stdout).toString('base64'), mime: 'image/png' };
      }
    } catch (err) {
      if (err.code !== 1) { /* cancelled */ }
    }

    try {
      const tmp = path.join('/tmp', `clueless-shot-${Date.now()}.png`);
      await execFileAsync('gdbus', [
        'call', '--session',
        '--dest', 'org.gnome.Shell.Screenshot',
        '--object-path', '/org/gnome/Shell/Screenshot',
        '--method', 'org.gnome.Shell.Screenshot.Screenshot',
        'false', tmp,
      ]);
      const buf = fs.readFileSync(tmp);
      fs.unlinkSync(tmp);
      return { base64: buf.toString('base64'), mime: 'image/png' };
    } catch { /* fall through */ }
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: screen.getPrimaryDisplay().size,
  });
  const primary = sources[0];
  if (!primary?.thumbnail) throw new Error('Screen capture failed. Install grim+slurp or allow screen recording.');
  return { base64: primary.thumbnail.toPNG().toString('base64'), mime: 'image/png' };
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 440,
    height: 580,
    x: width - 460,
    y: 40,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    show: false,
    title: 'Clueless',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  attachKeyboardShortcuts(mainWindow);

  if (process.env.CLUELESS_DEV === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function setupIpc() {
  ipcMain.handle('get-config', async () => {
    const cfg = getConfig();
    const whisper = await probeLocalWhisper();
    return {
      provider: aiProvider,
      modelShort: providerLabel(cfg),
      geminiAvailable: Boolean(cfg.geminiApiKey),
      geminiModel: cfg.geminiModel,
      gemmaModel: shortModelName(cfg.localLlmModel),
      whisper,
      sessionType: process.env.XDG_SESSION_TYPE || 'unknown',
    };
  });

  ipcMain.handle('set-provider', async (_e, provider) => {
    if (provider !== 'gemma' && provider !== 'gemini') {
      throw new Error('Provider must be gemma or gemini');
    }
    const cfg = getConfig();
    if (provider === 'gemini' && !cfg.geminiApiKey) {
      throw new Error('Set GEMINI_API_KEY in .env to use Gemini');
    }
    aiProvider = provider;
    return { provider: aiProvider, modelShort: providerLabel(cfg) };
  });

  ipcMain.handle('chat', async (_e, { messages }) => {
    const systemPrompt = aiProvider === 'gemini' ? INTERVIEW_SYSTEM_PROMPT : GEMMA_SYSTEM_PROMPT;
    const withSystem = messages.some((m) => m.role === 'system')
      ? messages.map((m) => (m.role === 'system' ? { ...m, content: systemPrompt } : m))
      : [{ role: 'system', content: systemPrompt }, ...messages];
    const text = await chatCompletion(withSystem);
    return { text };
  });

  ipcMain.handle('analyze-screen', async (_e, userPrompt) => {
    const shot = await captureScreen();
    const prompt = userPrompt || 'Read the screen and help with whatever is visible.';
    const cfg = getConfig();

    if (aiProvider === 'gemini' && cfg.geminiApiKey) {
      const text = await geminiGenerate(cfg, [
        { role: 'system', content: INTERVIEW_SYSTEM_PROMPT },
        { role: 'user', content: `${prompt}\n\nLook at the screenshot and help me answer any interview question or problem shown.` },
      ], shot);
      return { text, imageIncluded: true };
    }

    const text = await chatCompletion([
      { role: 'system', content: 'You are a helpful assistant. Describe the screen and answer any visible question concisely.' },
      { role: 'user', content: `${prompt}\n\n[Note: screen was captured but this model may be text-only. Describe based on user context if vision unavailable.]` },
    ]);
    return { text, imageIncluded: true };
  });

  ipcMain.handle('transcribe', async (_e, { audioBase64, mimeType }) => {
    return transcribeAudio(audioBase64, mimeType, getConfig());
  });

  ipcMain.on('window-close', () => {
    runCleanup();
    app.quit();
  });
}

function sendShortcut(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('shortcut', action);
}

function registerShortcut(accelerator, action) {
  try {
    const ok = globalShortcut.register(accelerator, () => sendShortcut(action));
    if (!ok) console.warn(`[clueless] Could not register: ${accelerator}`);
    return ok;
  } catch (err) {
    console.warn(`[clueless] Shortcut error (${accelerator}):`, err.message);
    return false;
  }
}

function attachKeyboardShortcuts(_mainWindow) {
  const listenKey = process.env.CLUELESS_SHORTCUT_LISTEN || '';
  const screenKey = process.env.CLUELESS_SHORTCUT_SCREEN || '';
  // Bare + / - cannot be global shortcuts on Linux Electron — handled in src/app.js.
  const bareKeys = new Set(['Plus', 'Minus', '+', '-', '=', 'numadd', 'numsub']);
  if (listenKey && !bareKeys.has(listenKey)) registerShortcut(listenKey, 'listen');
  if (screenKey && !bareKeys.has(screenKey)) registerShortcut(screenKey, 'screen');
}

app.whenReady().then(() => {
  createWindow();
  setupIpc();
});

app.on('will-quit', () => {
  runCleanup();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => app.quit());
