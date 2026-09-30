const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const FILE_FORMAT_INSTRUCTIONS = `Quand tu dois produire ou modifier des fichiers de code, utilise EXACTEMENT ce format pour chaque fichier, sans rien ajouter autour :

===FILE: chemin/relatif/du/fichier.ext===
<contenu complet et final du fichier>
===ENDFILE===

Tu peux répéter ce bloc pour plusieurs fichiers. Les chemins sont relatifs au dossier de travail choisi par l'utilisateur. N'utilise jamais ".." dans un chemin. En dehors de ces blocs, tu peux ajouter de brèves explications, mais uniquement si l'utilisateur ne demande pas explicitement "que le code".`;

function buildMessages(prompt, contextFiles) {
  const messages = [
    { role: 'system', content: FILE_FORMAT_INSTRUCTIONS },
  ];

  if (contextFiles && contextFiles.length > 0) {
    const contextBlock = contextFiles
      .map((f) => `--- Fichier de contexte: ${f.name} ---\n${f.content}`)
      .join('\n\n');
    messages.push({
      role: 'user',
      content: `Voici des fichiers de contexte fournis par l'utilisateur :\n\n${contextBlock}`,
    });
  }

  messages.push({ role: 'user', content: prompt });
  return messages;
}

async function callChatCompletions(endpoint, apiKey, model, messages) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    });
  } catch (err) {
    // fetch() ne dit que "fetch failed" : la vraie raison est dans err.cause.
    const reason = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`Impossible de joindre l'API ${endpoint} (${reason}). Vérifie l'URL, que le serveur tourne et le pare-feu.`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Réponse non-JSON de l'API (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`Erreur API (${res.status}): ${msg}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Réponse inattendue: pas de contenu de message trouvé.');
  }
  return content;
}

const CHAT_SYSTEM_PROMPT = `Tu es un assistant qui discute avec l'utilisateur et répond à ses questions. Quand des documents sont fournis, appuie-toi dessus en priorité, cite le passage ou le document concerné, et dis clairement quand la réponse ne s'y trouve pas au lieu d'inventer. Réponds dans la langue de l'utilisateur.`;

function resolveEndpoint({ provider, apiKey, baseUrl, model }) {
  if (provider === 'groq') {
    if (!apiKey) throw new Error('Clé API Groq manquante.');
    if (!model) throw new Error('Modèle Groq manquant.');
    return GROQ_ENDPOINT;
  }

  if (provider === 'local') {
    if (!baseUrl) throw new Error("URL de l'API locale (PC fixe) manquante.");
    if (!model) throw new Error('Modèle manquant pour l\'API locale.');
    return baseUrl;
  }

  throw new Error(`Provider inconnu: ${provider}`);
}

export async function generate({ provider, apiKey, baseUrl, model, prompt, contextFiles }) {
  const endpoint = resolveEndpoint({ provider, apiKey, baseUrl, model });
  return callChatCompletions(endpoint, apiKey, model, buildMessages(prompt, contextFiles));
}

/**
 * Discussion libre : history est la liste des messages {role, content}
 * échangés jusqu'ici (le dernier étant la question de l'utilisateur).
 * Les documents sont renvoyés à chaque tour, dans le message système,
 * car les API chat/completions sont sans état.
 */
export async function chat({ provider, apiKey, baseUrl, model, history, documents }) {
  const endpoint = resolveEndpoint({ provider, apiKey, baseUrl, model });

  let system = CHAT_SYSTEM_PROMPT;
  if (documents && documents.length > 0) {
    const docBlock = documents
      .map((d) => `--- Document: ${d.name} ---\n${d.content}\n--- Fin du document: ${d.name} ---`)
      .join('\n\n');
    system += `\n\nDocuments fournis par l'utilisateur :\n\n${docBlock}`;
  }

  const messages = [{ role: 'system', content: system }, ...history];
  return callChatCompletions(endpoint, apiKey, model, messages);
}
