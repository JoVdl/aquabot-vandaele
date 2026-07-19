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
