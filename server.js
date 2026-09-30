import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import simpleGit from 'simple-git';

import { generate, chat } from './lib/providers.js';
import { extractDocumentText } from './lib/documents.js';
import { parseGeneratedFiles } from './lib/fileParser.js';

// Chemins résolus depuis l'emplacement de ce fichier, pas depuis le dossier
// courant : sinon lancer "node C:\...\server.js" depuis un autre dossier
// ne trouve ni le .env ni l'interface.
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(APP_DIR, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
// Par défaut on n'écoute que sur la machine locale : /api/run exécute des
// commandes shell et /api/save écrit sur le disque, les exposer au réseau
// local reviendrait à donner un shell à n'importe quel voisin de Wi-Fi.
const HOST = process.env.HOST || '127.0.0.1';
const IS_WINDOWS = process.platform === 'win32';

const UPLOAD_ROOT = path.join(os.tmpdir(), 'groq-nav-uploads');
await fs.mkdir(UPLOAD_ROOT, { recursive: true });

const MAX_CONTEXT_FILE_BYTES = 200 * 1024;
// Texte extrait d'un PDF/Word : plafond de stockage côté navigateur. La
// vraie limite envoyée au modèle est CHAT_MAX_DOC_CHARS, appliquée à
// chaque message de discussion.
const MAX_EXTRACTED_CHARS = 1_000_000;
// ~4 caractères par token : 48 000 caractères ≈ 12 000 tokens de
// documents. À baisser pour un petit modèle local (contexte 8k).
const CHAT_MAX_DOC_CHARS = Number(process.env.CHAT_MAX_DOC_CHARS) || 48_000;
const CHAT_MAX_HISTORY_MESSAGES = 40;
const MAX_UPLOAD_FILES = 20;
const MAX_RUN_OUTPUT_BYTES = 200 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_RUN_TIMEOUT_MS = 120_000;

const upload = multer({
  dest: UPLOAD_ROOT,
  limits: { fileSize: 20 * 1024 * 1024, files: MAX_UPLOAD_FILES },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(APP_DIR, 'public')));

function isTextLikely(buf) {
  const sample = buf.subarray(0, 8000);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return suspicious / Math.max(sample.length, 1) < 0.05;
}

// Complète les paramètres du fournisseur avec les valeurs du .env quand
// l'interface les laisse vides.
function resolveProvider({ provider, apiKey, baseUrl, model }) {
  return {
    provider,
    apiKey: apiKey || (provider === 'groq' ? process.env.GROQ_API_KEY : process.env.LOCAL_API_KEY) || '',
    baseUrl: baseUrl || process.env.LOCAL_API_URL || '',
    model: model || (provider === 'groq' ? process.env.GROQ_DEFAULT_MODEL : process.env.LOCAL_DEFAULT_MODEL) || '',
  };
}

// Répartit le budget de caractères équitablement entre les documents :
// les petits passent en entier, le reste est partagé entre les gros.
function fitDocumentsToBudget(docs, budget) {
  const order = docs
    .map((d, i) => ({ i, len: d.content.length }))
    .sort((a, b) => a.len - b.len);
  const allowed = new Array(docs.length);
  let remaining = budget;
  order.forEach(({ i, len }, pos) => {
    const share = Math.floor(remaining / (order.length - pos));
    allowed[i] = Math.min(len, share);
    remaining -= allowed[i];
  });
  const truncated = [];
  const fitted = docs.map((d, i) => {
    if (allowed[i] >= d.content.length) return d;
    truncated.push(d.name);
    return {
      name: d.name,
      content: `${d.content.slice(0, allowed[i])}\n[... document tronqué : ${allowed[i]} caractères sur ${d.content.length} ...]`,
    };
  });
  return { fitted, truncated };
}

// --- Génération de code ---
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, contextFiles } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Le champ "prompt" est requis.' });
    }

    const raw = await generate({ ...resolveProvider(req.body), prompt, contextFiles });
    const files = parseGeneratedFiles(raw);
    res.json({ raw, files });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Discussion avec documents ---
app.post('/api/chat', async (req, res) => {
  try {
    const { history, documents } = req.body || {};
    const cleanHistory = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-CHAT_MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    if (cleanHistory.length === 0 || cleanHistory[cleanHistory.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Le dernier message doit venir de l\'utilisateur.' });
    }

    const cleanDocs = (Array.isArray(documents) ? documents : [])
      .filter((d) => d && typeof d.name === 'string' && typeof d.content === 'string');
    const { fitted, truncated } = fitDocumentsToBudget(cleanDocs, CHAT_MAX_DOC_CHARS);

    const reply = await chat({ ...resolveProvider(req.body), history: cleanHistory, documents: fitted });
    res.json({ reply, truncatedDocuments: truncated, docCharBudget: CHAT_MAX_DOC_CHARS });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Upload de fichiers de contexte ---
app.post('/api/upload', upload.array('files', MAX_UPLOAD_FILES), async (req, res) => {
  try {
    const results = [];
    for (const f of req.files || []) {
      // multer décode le nom en latin1 : "résumé.pdf" arriverait en "rÃ©sumÃ©.pdf".
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        const buf = await fs.readFile(f.path);
        let text = null;
        let truncated = false;
        let error = null;
        let extracted = null;
        try {
          extracted = await extractDocumentText(buf, name);
        } catch (err) {
          error = `Lecture impossible (${err.message}).`;
        }
        if (extracted !== null) {
          text = extracted.trim();
          if (!text) {
            error = 'Aucun texte trouvé : document scanné (images) ? Pas d\'OCR.';
            text = null;
          } else if (text.length > MAX_EXTRACTED_CHARS) {
            text = text.slice(0, MAX_EXTRACTED_CHARS);
            truncated = true;
          }
        } else if (!error && isTextLikely(buf)) {
          text = buf.subarray(0, MAX_CONTEXT_FILE_BYTES).toString('utf8');
          truncated = buf.length > MAX_CONTEXT_FILE_BYTES;
        } else if (!error) {
          error = 'Format binaire non pris en charge (texte, PDF et .docx uniquement).';
        }
        results.push({
          name,
          size: f.size,
          binary: text === null,
          content: text,
          chars: text ? text.length : 0,
          truncated,
          error,
        });
      } finally {
        await fs.unlink(f.path).catch(() => {});
      }
    }
    res.json({ files: results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Navigation dans le système de fichiers pour choisir le dossier de travail ---
app.get('/api/browse', async (req, res) => {
  try {
    const target = path.resolve(req.query.dir ? String(req.query.dir) : os.homedir());
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error('Le chemin donné n\'est pas un dossier.');

    const entries = await fs.readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const parent = path.dirname(target) === target ? null : path.dirname(target);
    res.json({ path: target, parent, dirs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/folder/select', async (req, res) => {
  try {
    const { path: rawPath, create } = req.body || {};
    if (!rawPath) return res.status(400).json({ error: 'Chemin manquant.' });
    const target = path.resolve(String(rawPath));

    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) throw new Error('Le chemin existe mais n\'est pas un dossier.');
    } catch (err) {
      if (err.code === 'ENOENT' && create) {
        await fs.mkdir(target, { recursive: true });
      } else if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Dossier introuvable. Coche "créer" pour le générer.' });
      } else {
        throw err;
      }
    }
    res.json({ path: target });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Écriture des fichiers générés dans le dossier de travail ---
app.post('/api/save', async (req, res) => {
  try {
    const { folder, files } = req.body || {};
    if (!folder || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'folder et files sont requis.' });
    }
    const root = path.resolve(String(folder));
    const rootStat = await fs.stat(root).catch(() => null);
    if (!rootStat || !rootStat.isDirectory()) {
      return res.status(400).json({ error: 'Le dossier de travail est invalide.' });
    }

    const written = [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
      const target = path.resolve(root, f.path);
      if (target !== root && !target.startsWith(root + path.sep)) {
        return res.status(400).json({ error: `Chemin de fichier invalide (hors dossier): ${f.path}` });
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, f.content, 'utf8');
      written.push(f.path);
    }
    res.json({ written });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Git ---
app.post('/api/git/init', async (req, res) => {
  try {
    const { folder } = req.body || {};
    const root = path.resolve(String(folder || ''));
    const stat = await fs.stat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) return res.status(400).json({ error: 'Dossier invalide.' });

    const git = simpleGit(root);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) await git.init();
    res.json({ initialized: true, alreadyExisted: isRepo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/git/commit', async (req, res) => {
  try {
    const { folder, message } = req.body || {};
    const root = path.resolve(String(folder || ''));
    const stat = await fs.stat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) return res.status(400).json({ error: 'Dossier invalide.' });

    const git = simpleGit(root);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return res.status(400).json({ error: 'Ce dossier n\'est pas encore un dépôt git. Initialise-le d\'abord.' });

    await git.add('.');
    const status = await git.status();
    if (status.files.length === 0) {
      return res.json({ committed: false, reason: 'Rien à committer.' });
    }
    const commitMessage = message && message.trim() ? message.trim() : 'Génération de code via Groq Nav';
    const result = await git.commit(commitMessage);
    res.json({ committed: true, summary: result.summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/git/status', async (req, res) => {
  try {
    const root = path.resolve(String(req.query.folder || ''));
    const stat = await fs.stat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) return res.status(400).json({ error: 'Dossier invalide.' });

    const git = simpleGit(root);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return res.json({ isRepo: false });
    const status = await git.status();
    res.json({ isRepo: true, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Exécution du code généré ---
// ATTENTION: exécute une commande shell arbitraire avec les droits de
// l'utilisateur qui fait tourner ce serveur, dans le dossier de travail
// choisi. Aucun sandboxing (pas de conteneur/VM). Ce n'est déclenché que
// par une action explicite de l'utilisateur, jamais automatiquement après
// une génération. Voir README pour l'avertissement complet.
app.post('/api/run', async (req, res) => {
  try {
    const { folder, command, timeoutMs } = req.body || {};
    if (!folder || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: 'folder et command sont requis.' });
    }
    const root = path.resolve(String(folder));
    const stat = await fs.stat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return res.status(400).json({ error: 'Le dossier de travail est invalide.' });
    }

    const effectiveTimeout = Math.min(
      Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_RUN_TIMEOUT_MS,
      MAX_RUN_TIMEOUT_MS,
    );

    const startedAt = Date.now();
    // detached:true place la commande dans son propre groupe de processus.
    // C'est nécessaire pour pouvoir tuer aussi ses éventuels enfants
    // (ex: "sleep 5 && x", "npm start" qui lance node, etc.) : l'option
    // native `timeout` de spawn() ne tue que le shell lui-même et laisse
    // les sous-processus tourner, ce qui rend le timeout inefficace.
    // Sous Windows, detached ouvrirait une nouvelle console et les PID
    // négatifs n'existent pas : on tue l'arbre avec taskkill à la place.
    const child = spawn(command, {
      cwd: root,
      shell: true,
      detached: !IS_WINDOWS,
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const collect = (buf, chunk) => {
      if (buf.length >= MAX_RUN_OUTPUT_BYTES) {
        truncated = true;
        return buf;
      }
      return buf + chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });

    const killGroup = (signal) => {
      if (IS_WINDOWS) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          .on('error', () => { /* déjà terminé */ });
        return;
      }
      try { process.kill(-child.pid, signal); } catch { /* déjà terminé */ }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref();
    }, effectiveTimeout);
    timeoutTimer.unref();

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      res.status(400).json({ error: `Impossible de lancer la commande: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (res.headersSent) return;
      res.json({
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        truncated,
      });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Config par défaut (pré-remplissage de l'interface) ---
app.get('/api/config', (req, res) => {
  res.json({
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    groqDefaultModel: process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile',
    localApiUrl: process.env.LOCAL_API_URL || '',
    localDefaultModel: process.env.LOCAL_DEFAULT_MODEL || '',
    chatMaxDocChars: CHAT_MAX_DOC_CHARS,
  });
});

app.post('/api/generate/effective-key', (req, res) => {
  // Permet au front de savoir si une clé serveur existe sans jamais l'exposer.
  res.json({ hasGroqKey: Boolean(process.env.GROQ_API_KEY) });
});

app.listen(PORT, HOST, () => {
  console.log(`Groq Nav démarré sur http://localhost:${PORT} (écoute sur ${HOST})`);
});
