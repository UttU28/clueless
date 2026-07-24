const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clueless', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setProvider: (provider) => ipcRenderer.invoke('set-provider', provider),
  chat: (messages) => ipcRenderer.invoke('chat', { messages }),
  analyzeScreen: (prompt) => ipcRenderer.invoke('analyze-screen', prompt),
  transcribe: (audioBase64, mimeType) => ipcRenderer.invoke('transcribe', { audioBase64, mimeType }),
  quit: () => ipcRenderer.send('window-close'),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, action) => cb(action)),
});
