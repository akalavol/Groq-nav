const state = {
  contextFiles: [],
  generatedFiles: [],
  selectedFolder: null,
  browsePath: null,
};

const el = (id) => document.getElementById(id);

function setStatus(id, message, kind) {
  const node = el(id);
  node.textContent = message;
  node.className = 'status' + (kind ? ' ' + kind : '');
}

// --- Provider switch ---
document.querySelectorAll('input[name="provider"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const provider = document.querySelector('input[name="provider"]:checked').value;
    el('groq-fields').classList.toggle('hidden', provider !== 'groq');
    el('local-fields').classList.toggle('hidden', provider !== 'local');
  });
});

// --- Local server kind (Ollama / vLLM / autre) : calcule l'URL complète ---
const LOCAL_KIND_DEFAULTS = {
  ollama: { port: '11434', modelHint: 'ex: qwen2.5-coder:32b (voir "ollama list")' },
  vllm: { port: '8000', modelHint: 'ex: Qwen/Qwen2.5-Coder-32B-Instruct (nom servi par vLLM)' },
  custom: { port: '', modelHint: 'nom du modèle exposé par ton API' },
};

function recomputeLocalUrl() {
  const kind = el('local-kind').value;
  const host = el('local-host').value.trim();
  if (kind === 'custom' || !host) return;
  const cleanHost = host.replace(/\/+$/, '');
  el('local-base-url').value = `${cleanHost}/v1/chat/completions`;
}

el('local-kind').addEventListener('change', () => {
  const kind = el('local-kind').value;
  const defaults = LOCAL_KIND_DEFAULTS[kind];
  el('local-model').placeholder = defaults.modelHint;
  if (kind !== 'custom' && !el('local-host').value.trim()) {
    el('local-host').placeholder = `http://192.168.1.50:${defaults.port}`;
  }
  recomputeLocalUrl();
});

el('local-host').addEventListener('input', recomputeLocalUrl);

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    el('groq-model').value = cfg.groqDefaultModel || '';
    if (cfg.hasGroqKey) {
      el('groq-api-key').placeholder = 'Clé serveur déjà configurée (laisser vide pour l\'utiliser)';
    }
    if (cfg.localApiUrl) el('local-base-url').value = cfg.localApiUrl;
    if (cfg.localDefaultModel) el('local-model').value = cfg.localDefaultModel;
  } catch (err) {
    console.error('Impossible de charger la config', err);
  }
}
loadConfig();

// --- Upload de fichiers de contexte ---
el('file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));

  setStatus('generate-status', 'Envoi des fichiers...', '');
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec de l\'upload');

    state.contextFiles.push(...data.files.filter((f) => !f.binary));
    renderFileList();
    setStatus('generate-status', '', '');
  } catch (err) {
    setStatus('generate-status', 'Erreur upload: ' + err.message, 'err');
  }
  e.target.value = '';
});

function renderFileList() {
  const list = el('file-list');
  list.innerHTML = '';
  state.contextFiles.forEach((f, idx) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.style.flexDirection = 'row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.idx = idx;
    checkbox.addEventListener('change', () => { f.included = checkbox.checked; });
    f.included = true;
    label.appendChild(checkbox);
    label.append(` ${f.name} (${f.size} o)${f.truncated ? ' [tronqué]' : ''}`);
    li.appendChild(label);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      state.contextFiles.splice(idx, 1);
      renderFileList();
    });
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
}

// --- Génération ---
el('generate-btn').addEventListener('click', async () => {
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const prompt = el('prompt').value.trim();
  if (!prompt) {
    setStatus('generate-status', 'Écris une demande d\'abord.', 'err');
    return;
  }

  const payload = { provider, prompt };
  if (provider === 'groq') {
    payload.apiKey = el('groq-api-key').value.trim();
    payload.model = el('groq-model').value.trim();
  } else {
    payload.baseUrl = el('local-base-url').value.trim();
    payload.apiKey = el('local-api-key').value.trim();
    payload.model = el('local-model').value.trim();
  }
  payload.contextFiles = state.contextFiles
    .filter((f) => f.included !== false)
    .map((f) => ({ name: f.name, content: f.content }));

  setStatus('generate-status', 'Génération en cours...', '');
  el('generate-btn').disabled = true;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec de la génération');

    el('raw-output').textContent = data.raw;
    state.generatedFiles = data.files.map((f) => ({ ...f, selected: true }));
    renderGeneratedFiles();
    setStatus('generate-status', `Terminé (${data.files.length} fichier(s) détecté(s)).`, 'ok');
  } catch (err) {
    setStatus('generate-status', 'Erreur: ' + err.message, 'err');
  } finally {
    el('generate-btn').disabled = false;
  }
});

function renderGeneratedFiles() {
  const container = el('generated-files');
  container.innerHTML = '';
  if (state.generatedFiles.length === 0) {
    container.textContent = 'Aucun fichier structuré détecté dans la réponse (voir la réponse brute ci-dessus).';
    el('save-btn').disabled = true;
    return;
  }

  state.generatedFiles.forEach((f, idx) => {
    const details = document.createElement('details');
    details.className = 'file-card';
    const summary = document.createElement('summary');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.addEventListener('change', () => { f.selected = checkbox.checked; });
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    summary.appendChild(checkbox);
    summary.append(' ' + f.path);
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.textContent = f.content;
    details.appendChild(pre);
    container.appendChild(details);
  });
  el('save-btn').disabled = !state.selectedFolder;
}

// --- Navigation de dossier ---
async function browse(dir) {
  try {
    const url = dir ? `/api/browse?dir=${encodeURIComponent(dir)}` : '/api/browse';
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    state.browsePath = data.path;
    el('browser-current').textContent = data.path;
    el('browser').classList.remove('hidden');
    const list = el('browser-list');
    list.innerHTML = '';
    data.dirs.forEach((name) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = '📁 ' + name;
      btn.addEventListener('click', () => browse(data.path + '/' + name));
      li.appendChild(btn);
      list.appendChild(li);
    });
    el('browser-up').onclick = () => { if (data.parent) browse(data.parent); };
    el('folder-path').value = data.path;
  } catch (err) {
    setStatus('folder-status', 'Erreur: ' + err.message, 'err');
  }
}

el('folder-browse-btn').addEventListener('click', () => browse(el('folder-path').value.trim() || state.browsePath));

el('folder-select-btn').addEventListener('click', async () => {
  const p = el('folder-path').value.trim();
  if (!p) {
    setStatus('folder-status', 'Indique un chemin.', 'err');
    return;
  }
  try {
    const res = await fetch('/api/folder/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, create: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.selectedFolder = data.path;
    setStatus('folder-status', 'Dossier de travail: ' + data.path, 'ok');
    el('save-btn').disabled = state.generatedFiles.length === 0;
  } catch (err) {
    setStatus('folder-status', 'Erreur: ' + err.message, 'err');
  }
});

el('save-btn').addEventListener('click', async () => {
  const files = state.generatedFiles.filter((f) => f.selected !== false).map((f) => ({ path: f.path, content: f.content }));
  if (files.length === 0) {
    setStatus('save-status', 'Aucun fichier sélectionné.', 'err');
    return;
  }
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: state.selectedFolder, files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setStatus('save-status', 'Fichiers enregistrés: ' + data.written.join(', '), 'ok');
  } catch (err) {
    setStatus('save-status', 'Erreur: ' + err.message, 'err');
  }
});

// --- Git ---
el('git-init-btn').addEventListener('click', async () => {
  if (!state.selectedFolder) {
    setStatus('git-status', 'Choisis d\'abord un dossier de travail.', 'err');
    return;
  }
  try {
    const res = await fetch('/api/git/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: state.selectedFolder }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setStatus('git-status', data.alreadyExisted ? 'Dépôt git déjà existant.' : 'Dépôt git initialisé.', 'ok');
  } catch (err) {
    setStatus('git-status', 'Erreur: ' + err.message, 'err');
  }
});

el('git-commit-btn').addEventListener('click', async () => {
  if (!state.selectedFolder) {
    setStatus('git-status', 'Choisis d\'abord un dossier de travail.', 'err');
    return;
  }
  try {
    const res = await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: state.selectedFolder, message: el('git-message').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setStatus('git-status', data.committed ? 'Commit effectué.' : (data.reason || 'Rien à committer.'), data.committed ? 'ok' : '');
  } catch (err) {
    setStatus('git-status', 'Erreur: ' + err.message, 'err');
  }
});
