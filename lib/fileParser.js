const FILE_BLOCK_RE = /===FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)===ENDFILE===/g;

/**
 * Extrait les blocs ===FILE: path=== ... ===ENDFILE=== d'une réponse modèle.
 * Rejette silencieusement les chemins absolus ou contenant "..".
 */
export function parseGeneratedFiles(text) {
  const files = [];
  let match;
  while ((match = FILE_BLOCK_RE.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2].replace(/\n$/, '');
    if (!rawPath || rawPath.includes('..') || rawPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
      continue;
    }
    files.push({ path: rawPath.replace(/\\/g, '/'), content });
  }
  return files;
}
