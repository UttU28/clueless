const chat = document.getElementById('chat');
const prompt = document.getElementById('prompt');
const status = document.getElementById('status');
const modelEl = document.getElementById('model');
const btnGemma = document.getElementById('btn-provider-gemma');
const btnGemini = document.getElementById('btn-provider-gemini');
const chatLoader = document.getElementById('chat-loader');
const loaderLabel = document.getElementById('loader-label');
const loaderTime = document.getElementById('loader-time');
const btnSend = document.getElementById('btn-send');
const btnScreen = document.getElementById('btn-screen');
const btnListen = document.getElementById('btn-listen');
const history = [];
let currentProvider = 'gemma';
let isLoading = false;
let loadStart = 0;
let loadBaseLabel = 'Thinking…';
let loaderInterval = null;

function formatElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

function updateLoaderTimer() {
  if (!loadStart) return;
  const elapsed = formatElapsed(performance.now() - loadStart);
  loaderTime.textContent = elapsed;
  status.textContent = `${loadBaseLabel} · ${elapsed}`;
}

function showLoader(label = 'Thinking…', { keepTimer = false } = {}) {
  loadBaseLabel = label;
  if (!keepTimer || !loadStart) loadStart = performance.now();

  isLoading = true;
  loaderLabel.textContent = label;
  chatLoader.classList.remove('hidden');
  chatLoader.setAttribute('aria-busy', 'true');
  btnSend.disabled = true;
  btnScreen.disabled = true;
  btnListen.disabled = true;
  prompt.disabled = true;

  updateLoaderTimer();
  if (!loaderInterval) {
    loaderInterval = setInterval(updateLoaderTimer, 100);
  }
}

function hideLoader() {
  const elapsed = loadStart ? performance.now() - loadStart : 0;
  if (loaderInterval) {
    clearInterval(loaderInterval);
    loaderInterval = null;
  }
  loadStart = 0;
  isLoading = false;
  chatLoader.classList.add('hidden');
  chatLoader.setAttribute('aria-busy', 'false');
  loaderTime.textContent = '0.0s';
  btnSend.disabled = false;
  btnScreen.disabled = false;
  btnListen.disabled = false;
  prompt.disabled = false;
  return elapsed;
}

function updateProviderUi(provider, modelShort) {
  currentProvider = provider;
  modelEl.textContent = modelShort;
  btnGemma.classList.toggle('active', provider === 'gemma');
  btnGemini.classList.toggle('active', provider === 'gemini');
  localStorage.setItem('clueless-provider', provider);
}

async function setProvider(provider) {
  try {
    const result = await window.clueless.setProvider(provider);
    updateProviderUi(result.provider, result.modelShort);
    msg('sys', `AI: ${result.provider === 'gemini' ? 'Gemini (interview mode)' : 'Gemma'}`);
  } catch (e) {
    msg('sys', e.message);
  }
}

btnGemma.onclick = () => setProvider('gemma');
btnGemini.onclick = () => setProvider('gemini');

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    return marked.parse(text, { breaks: true, gfm: true });
  }
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function msg(role, text, opts = {}) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;

  if (role === 'bot') {
    if (opts.elapsedMs != null) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = `⏱ ${formatElapsed(opts.elapsedMs)}`;
      d.appendChild(meta);
    }
    const body = document.createElement('div');
    body.className = 'msg-body md';
    body.innerHTML = renderMarkdown(text);
    d.appendChild(body);
  } else {
    d.textContent = text;
  }

  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  if (role === 'user') history.push({ role: 'user', content: text });
  if (role === 'bot') history.push({ role: 'assistant', content: text });
}

async function sendChat(textOverride, skipUser = false) {
  const text = (textOverride ?? prompt.value).trim();
  if (!text || (isLoading && !skipUser)) return;
  prompt.value = '';
  if (!skipUser) msg('user', text);

  if (!isLoading) showLoader('Thinking…');
  else showLoader('Thinking…', { keepTimer: true });

  try {
    const messages = [
      ...history.filter(m => m.role === 'user' || m.role === 'assistant'),
    ];
    const { text: reply } = await window.clueless.chat(messages);
    const elapsedMs = hideLoader();
    msg('bot', reply, { elapsedMs });
    status.textContent = `Ready · ${formatElapsed(elapsedMs)}`;
  } catch (e) {
    hideLoader();
    msg('sys', `Error: ${e.message}`);
    status.textContent = 'Error';
  }
}

async function analyzeScreen() {
  if (isLoading) return;
  const q = prompt.value.trim() || 'Help me with what is on screen.';
  msg('user', `[Screen] ${q}`);
  showLoader('Capturing screen…');

  try {
    showLoader('Analyzing screen…', { keepTimer: true });
    const { text } = await window.clueless.analyzeScreen(q);
    const elapsedMs = hideLoader();
    msg('bot', text, { elapsedMs });
    prompt.value = '';
    status.textContent = `Ready · ${formatElapsed(elapsedMs)}`;
  } catch (e) {
    hideLoader();
    msg('sys', `Screen error: ${e.message}`);
    status.textContent = 'Error';
  }
}

let listening = false;
let recorder = null;
let chunks = [];

async function toggleListen() {
  const btn = document.getElementById('btn-listen');
  if (listening) {
    recorder?.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      listening = false;
      btn.classList.remove('active');
      btn.textContent = '🎤 Listen';
      showLoader('Transcribing…');
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
      try {
        const r = await window.clueless.transcribe(b64, blob.type);
        if (r.text) {
          const tag = r.gpu ? 'GPU' : 'CPU';
          msg('user', `[Voice/${tag}] ${r.text}`);
          if (r.fallback) {
            msg('sys', `Whisper used CPU (CUDA failed): ${r.cuda_error || 'unknown error'}`);
          }
          await sendChat(r.text, true);
        } else {
          hideLoader();
          msg('sys', 'No speech detected.');
          status.textContent = 'Ready';
        }
      } catch (e) {
        hideLoader();
        msg('sys', `Whisper: ${e.message}`);
        status.textContent = 'Error';
      }
    };
    recorder.start();
    listening = true;
    btn.classList.add('active');
    btn.textContent = '⏹ Stop';
    status.textContent = 'Listening…';
  } catch (e) {
    msg('sys', `Mic: ${e.message}`);
  }
}

document.getElementById('btn-send').onclick = () => sendChat();
document.getElementById('btn-screen').onclick = analyzeScreen;
document.getElementById('btn-listen').onclick = toggleListen;
document.getElementById('btn-quit').onclick = () => window.clueless.quit();
prompt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };

window.clueless.onShortcut((action) => {
  if (action === 'listen') toggleListen();
  if (action === 'screen') analyzeScreen();
});

document.addEventListener('keydown', (e) => {
  if (e.target === prompt) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    toggleListen();
  }
  if (e.key === '-') {
    e.preventDefault();
    analyzeScreen();
  }
});

(async () => {
  const cfg = await window.clueless.getConfig();
  btnGemini.disabled = !cfg.geminiAvailable;
  if (!cfg.geminiAvailable) btnGemini.title = 'Set GEMINI_API_KEY in .env';

  const saved = localStorage.getItem('clueless-provider');
  const initial = saved === 'gemini' && cfg.geminiAvailable ? 'gemini' : cfg.provider;
  if (initial !== cfg.provider && (initial !== 'gemini' || cfg.geminiAvailable)) {
    await setProvider(initial);
  } else {
    updateProviderUi(cfg.provider, cfg.modelShort);
  }

  if (cfg.whisper?.available) msg('sys', `Whisper: ${cfg.whisper.message}`);
  else msg('sys', 'Whisper not found — run ./deploy.sh to set up venv');
  msg('sys', 'Shortcuts: + Listen · - Screen');
})();
