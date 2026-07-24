# AquaBot Vandaele

Application statique (HTML/CSS/JS vanilla, sans build) déployée via GitHub Pages
depuis la branche `main`.

## Numéro de version dans l'en-tête

`index.html` affiche un numéro de version (`<span id="appVersion">vN</span>`,
sous le logo, à la place de l'ancien texte "Curage autonome · 2026") pour que
l'utilisateur puisse voir en un coup d'œil si son appareil a bien la dernière
version déployée.

**Incrémenter ce numéro de 1 à chaque push vers `main`** (donc à chaque
changement visible par l'utilisateur), même pour un petit correctif. Ne pas
incrémenter pour des changements qui ne touchent pas `main` (travail
intermédiaire sur une branche non encore mergée).

## Cache-busting des assets (`?v=N`)

`index.html` charge `js/app.js` et `css/style.css` avec un paramètre
`?v=N` (ex. `js/app.js?v=86`) — sans lui, le navigateur peut continuer à
servir une version en cache de ces fichiers même après un déploiement
(l'utilisateur voit alors le nouveau numéro de version dans l'en-tête,
mais le code/style réellement exécuté reste l'ancien, silencieusement).

**Mettre ce `N` à jour vers le MÊME numéro que `appVersion` à chaque push
vers `main`**, dans les deux références (`js/app.js?v=N` et
`css/style.css?v=N`) — un seul et même geste que l'incrément d'`appVersion`
ci-dessus, jamais l'un sans l'autre.
