# Groq Nav

Navigateur de programmation local et minimal : tu écris ce que tu veux dans
une zone de texte, tu envoies éventuellement des fichiers de contexte,
l'IA (Groq ou une API compatible OpenAI tournant sur un PC fixe / réseau
local) génère du code, et tu choisis le dossier final où l'écrire puis le
versionner avec git.

C'est une appli web servie localement par un petit serveur Node/Express,
pas une extension de navigateur ni une appli Electron : "navigateur" ici
veut dire que tu l'utilises depuis ton navigateur web habituel, mais le
serveur tourne sur ta machine et a donc accès à ton système de fichiers
et à `git`.

## Installation

```bash
npm install
cp .env.example .env
# édite .env : GROQ_API_KEY et/ou LOCAL_API_URL
npm start
```

Ouvre ensuite `http://localhost:3000`.

## Utilisation

1. Choisis le fournisseur : **Groq** (cloud, nécessite une clé API sur
   https://console.groq.com/keys) ou **API locale** — Ollama ou vLLM
   tournant sur un PC fixe du réseau local, tous deux exposant un endpoint
   `chat/completions` compatible OpenAI. Sélectionne le type de serveur,
   renseigne juste l'hôte (`http://IP:PORT`), l'URL complète est calculée
   automatiquement.

   - **Ollama** : lance `ollama serve` sur le PC fixe (port par défaut
     `11434`), et `ollama pull <modele>` pour récupérer un modèle. L'API
     OpenAI-compatible d'Ollama est servie sur `/v1/chat/completions` sans
     authentification par défaut.
   - **vLLM** : lance par exemple
     `vllm serve <modele> --host 0.0.0.0 --port 8000`
     (ajoute `--api-key <clé>` si tu veux protéger l'accès). Le serveur
     expose aussi `/v1/chat/completions`.

   Dans les deux cas, si le PC fixe n'est pas sur `localhost`, assure-toi
   que le pare-feu autorise le port depuis la machine qui exécute Groq Nav.
2. (Optionnel) envoie des fichiers existants comme contexte — ils sont lus
   côté serveur et injectés dans le prompt envoyé au modèle (fichiers texte
   uniquement, 200 Ko max par fichier, 20 fichiers max).
3. Écris ta demande et clique sur "Générer". Le modèle est instruit pour
   produire ses fichiers dans un format structuré (`===FILE: chemin===` /
   `===ENDFILE===`) que l'appli parse automatiquement.
4. Choisis (ou crée) le dossier de travail final via le champ de chemin ou
   le navigateur de dossiers intégré, puis clique sur "Utiliser ce dossier".
5. Sélectionne les fichiers générés à garder et clique sur "Enregistrer".
6. Initialise git et commit depuis la section correspondante.

## Limites connues

- Le navigateur de dossiers expose l'arborescence du système de fichiers du
  serveur : n'expose pas cette appli sur un réseau non fiable sans y ajouter
  une authentification.
- Le parsing des fichiers générés dépend du respect du format par le
  modèle ; en cas de réponse "libre", seule la réponse brute est affichée
  et rien n'est proposé à l'enregistrement.
- Pas de diff/preview avant écrasement : enregistrer un fichier remplace
  son contenu existant sans confirmation supplémentaire.
