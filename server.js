import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';

import { generate } from './lib/providers.js';
import { parseGeneratedFiles } from './lib/fileParser.js';

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_ROOT = path.join(os.tmpdir(), 'groq-nav-uploads');
await fs.mkdir(UPLOAD_ROOT, { recursive: true });

const MAX_CONTEXT_FILE_BYTES = 200 * 1024;
const MAX_UPLOAD_FILES = 20;

const upload = multer({
  dest: UPLOAD_ROOT,
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_UPLOAD_FILES },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

function isTextLikely(buf) {
  const sample = buf.subarray(0, 8000);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return suspicious / Math.max(sample.length, 1) < 0.05;
}

// --- Génération de code ---
app.post('/api/generate', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl, model, prompt, contextFiles } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Le champ "prompt" est requis.' });
    }

    const effectiveApiKey = apiKey || (provider === 'groq' ? process.env.GROQ_API_KEY : process.env.LOCAL_API_KEY) || '';
    const effectiveBaseUrl = baseUrl || process.env.LOCAL_API_URL || '';
    const effectiveModel = model || (provider === 'groq' ? process.env.GROQ_DEFAULT_MODEL : process.env.LOCAL_DEFAULT_MODEL) || '';

    const raw = await generate({
      provider,
      apiKey: effectiveApiKey,
      baseUrl: effectiveBaseUrl,
      model: effectiveModel,
      prompt,
      contextFiles,
    });
    const files = parseGeneratedFiles(raw);
    res.json({ raw, files });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Upload de fichiers de contexte ---
app.post('/api/upload', upload.array('files', MAX_UPLOAD_FILES), async (req, res) => {
  try {
    const results = [];
    for (const f of req.files || []) {
      const buf = await fs.readFile(f.path);
      const text = isTextLikely(buf) ? buf.subarray(0, MAX_CONTEXT_FILE_BYTES).toString('utf8') : null;
      results.push({
        name: f.originalname,
        size: f.size,
        binary: text === null,
        content: text,
        truncated: text !== null && buf.length > MAX_CONTEXT_FILE_BYTES,
      });
      await fs.unlink(f.path).catch(() => {});
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
    if (status.staged.length === 0 && status.created.length === 0 && status.modified.length === 0) {
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

// --- Config par défaut (pré-remplissage de l'interface) ---
app.get('/api/config', (req, res) => {
  res.json({
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    groqDefaultModel: process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile',
    localApiUrl: process.env.LOCAL_API_URL || '',
    localDefaultModel: process.env.LOCAL_DEFAULT_MODEL || '',
  });
});

app.post('/api/generate/effective-key', (req, res) => {
  // Permet au front de savoir si une clé serveur existe sans jamais l'exposer.
  res.json({ hasGroqKey: Boolean(process.env.GROQ_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`Groq Nav démarré sur http://localhost:${PORT}`);
});
