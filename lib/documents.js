import path from 'node:path';

// Les bibliothèques PDF/Word sont lourdes (pdfjs ~40 Mo) : on ne les charge
// qu'au premier document de ce type, pas au démarrage du serveur.
let pdfParseModule;
let mammothModule;

async function extractPdf(buf) {
  pdfParseModule ??= await import('pdf-parse');
  const parser = new pdfParseModule.PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    // On reconstruit le texte page par page : le séparateur par défaut de
    // pdf-parse ("-- 1 of 3 --") rendrait non vide un PDF scanné sans texte.
    // Le repère de page permet au modèle de citer "page N".
    if (result.pages.every((p) => !p.text.trim())) return '';
    return result.pages
      .map((p) => `[Page ${p.num}/${result.total}]\n${p.text.trim()}`)
      .join('\n\n');
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buf) {
  mammothModule ??= (await import('mammoth')).default;
  const result = await mammothModule.extractRawText({ buffer: buf });
  return result.value;
}

/**
 * Extrait le texte d'un document binaire connu (PDF, Word .docx).
 * Renvoie null si le format n'est pas pris en charge.
 * Un PDF scanné (images sans couche texte) renvoie une chaîne vide :
 * pas d'OCR.
 */
export async function extractDocumentText(buf, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return extractPdf(buf);
  if (ext === '.docx') return extractDocx(buf);
  return null;
}
