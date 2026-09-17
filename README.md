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
   https://console.groq.com/keys) ou **API locale** (l'URL complète d'un
   endpoint compatible `chat/completions`, par ex. Ollama ou LM Studio
   tournant sur un PC fixe du réseau local).
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
