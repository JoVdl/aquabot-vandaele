'use strict';

// ============================================================
// CLOUD — Firebase Firestore
// ============================================================
const USE_CLOUD = typeof window !== 'undefined' && !!window.db;

// Identifiant unique de cet onglet, stable à travers une actualisation de page (sessionStorage,
// pas un simple random réinitialisé à chaque chargement) — sert à savoir qui calcule
// actuellement la simulation (voir claimSimOwnership ci-dessous). Un seul « cerveau » actif à
// la fois, exactement comme pour le robot réel : les autres appareils ne sont que des vues qui
// reflètent le même état et envoient des commandes, jamais une seconde simulation en parallèle.
// La stabilité au fil des actualisations est cruciale : sans elle, actualiser la page pendant
// qu'on pilote fait apparaître cet onglet comme un « étranger » aux yeux de checkAndResumeSim,
// qui attend alors bêtement l'expiration du délai avant de reprendre — d'où la vitesse qui
// semblait « revenir en arrière » et le robot qui paraissait s'arrêter après actualisation.
// sessionStorage (pas localStorage) pour qu'un second onglet du même navigateur obtienne bien
// un identifiant différent, plutôt que d'entrer en conflit avec le premier.
const _deviceSessionId = (() => {
  try {
    let id = sessionStorage.getItem('aquabot_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
      sessionStorage.setItem('aquabot_device_id', id);
    }
    return id;
  } catch {
    return 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
  }
})();

// Au-delà de ce délai sans nouvelle écriture, on considère qu'un appareil qui prétendait
// piloter est en réalité silencieux (onglet mis en arrière-plan sur mobile, navigateur qui a
// throttle ses timers, perte de connexion...) et qu'un autre appareil peut légitimement
// reprendre la main.
const DRIVER_HEARTBEAT_TIMEOUT_MS = 4000;

// Horodatage de la dernière écriture connue sur aquabot_sim (mis à jour par
// subscribeSimState) — permet à l'affichage de savoir si "robotState: moving" reflète une
// simulation réellement active ou un pilote disparu sans s'arrêter proprement.
let _lastKnownSimHeartbeat = 0;

// Tente de devenir l'unique appareil qui calcule la simulation pour cet étang. Renvoie true si
// la revendication réussit (soit personne d'autre n'est activement en train de piloter là
// maintenant, soit c'est déjà nous) ; false si un autre appareil pilote réellement, là,
// maintenant (heartbeat récent) — dans ce cas on ne démarre PAS de seconde boucle locale.
async function claimSimOwnership(pondId) {
  if (!USE_CLOUD) return true; // pas de cloud = un seul appareil de toute façon
  try {
    const docRef = window.db.collection('aquabot_sim').doc(pondId);
    const snap = await docRef.get();
    const sim = snap.exists ? snap.data() : null;
    const heldByOther = sim?.simRunning && sim.driverId && sim.driverId !== _deviceSessionId
      && (Date.now() - (sim.lastUpdate || 0)) < DRIVER_HEARTBEAT_TIMEOUT_MS;
    if (heldByOther) return false;
    await docRef.set({ driverId: _deviceSessionId, lastUpdate: Date.now() }, { merge: true });
    return true;
  } catch (e) {
    reportFirestoreError(e, 'claimSimOwnership');
    return true; // ne bloque pas l'usage si le réseau/la revendication échoue
  }
}

// Remonte à l'écran une erreur Firestore de type "quota dépassé" (code resource-exhausted),
// même sur un projet passé en Blaze : le quota gratuit y devient un simple seuil de
// facturation plutôt qu'un mur bloquant, mais une limite peut malgré tout être atteinte
// (facturation désactivée, incident Google, etc.) — dans ce cas toute la synchronisation
// cloud s'arrête silencieusement sans que rien ne le signale à l'écran. On limite l'affichage
// à un message toutes les 20s pour ne pas spammer si plusieurs écritures échouent d'un coup.
let _lastQuotaToastAt = 0;
function reportFirestoreError(e, context) {
  console.warn(context + ':', e && e.message);
  const isQuota = e && (e.code === 'resource-exhausted' || /quota/i.test(e.message || ''));
  if (!isQuota || Date.now() - _lastQuotaToastAt < 20000) return;
  _lastQuotaToastAt = Date.now();
  showToast('Limite Firebase atteinte — la synchronisation entre appareils est interrompue pour le moment.', 'error');
}

function updateCloudStatus(status) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  const map = {
    connecting: ['cloud-connecting', 'Connexion au cloud…'],
    online:     ['cloud-online',     'Cloud synchronisé ✓'],
    offline:    ['cloud-offline',    'Mode local (pas de config Firebase)'],
    error:      ['cloud-error',      'Erreur de connexion cloud'],
  };
  const [cls, title] = map[status] || map.offline;
  el.className = `cloud-status ${cls}`;
  el.title = title;
}

// Compact cell-selection encoding: store whichever set (selected vs. deselected) is
// smaller, tagged with its mode. A freshly-created pond has every cell selected, so a
// raw index array would list ALL cells — for a real (non-demo) pond with thousands of
// 0.4m cells this can exceed Firestore's 1MB document limit and silently fail to save.
// "exclude" mode collapses that common case down to an empty array.
function encodeSelection(cells) {
  const total = cells.length;
  let selectedCount = 0;
  for (const c of cells) if (c.selected) selectedCount++;
  if (total - selectedCount <= selectedCount) {
    const idx = [];
    for (let i = 0; i < total; i++) if (!cells[i].selected) idx.push(i);
    return { mode: 'exclude', idx };
  }
  const idx = [];
  for (let i = 0; i < total; i++) if (cells[i].selected) idx.push(i);
  return { mode: 'include', idx };
}

// Decode into a Set of selected indices. `total` is the current cell count (needed to
// expand "exclude" mode). Accepts legacy plain-array docs (pre-compaction) as-is.
// Returns null when there's nothing to restore (caller keeps its default state).
function decodeSelection(encoded, total) {
  if (Array.isArray(encoded)) return new Set(encoded);
  if (!encoded) return null;
  if (encoded.mode === 'exclude') {
    const excl = new Set(encoded.idx || []);
    const set = new Set();
    for (let i = 0; i < total; i++) if (!excl.has(i)) set.add(i);
    return set;
  }
  return new Set(encoded.idx || []);
}

// Compacte le tableau de lectures d'un relevé bathymétrique ({water,mud}|null par case) en un
// buffer binaire (2 octets par valeur, en centimètres, sentinelle 0xFFFF = pas de donnée pour
// cette case), encodé en base64 pour le transport JSON — un objet JSON par case
// ({"water":2.36,"mud":0.15}) pèse environ 5x plus, dans le flux stocké, qu'une paire d'entiers
// binaires : avec plusieurs relevés sur un étang réel de plusieurs milliers de cases, cette seule
// différence suffisait à dépasser la limite de 1 Mo par document Firestore (même limite déjà
// rencontrée pour la sélection de cases, voir encodeSelection ci-dessus). Le centimètre est une
// précision largement suffisante pour une sonde de profondeur simulée.
const BATHY_NULL_CM = 0xFFFF;
function encodeBathyReadings(readings) {
  const list = readings || [];
  const n = list.length;
  const buf = new Uint16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const r = list[i];
    if (r) { buf[i * 2] = Math.round(r.water * 100); buf[i * 2 + 1] = Math.round(r.mud * 100); }
    else   { buf[i * 2] = BATHY_NULL_CM; buf[i * 2 + 1] = BATHY_NULL_CM; }
  }
  const bytes = new Uint8Array(buf.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { n, b64: btoa(bin) };
}
// Accepte aussi les anciens formats (tableau brut {water,mud}|null pré-compaction, ou paire de
// tableaux JSON {w,m} de la compaction précédente) pour ne pas casser les relevés déjà enregistrés.
function decodeBathyReadings(encoded) {
  if (Array.isArray(encoded)) return encoded;
  if (!encoded) return [];
  if (encoded.b64) {
    const bin = atob(encoded.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = new Uint16Array(bytes.buffer);
    const out = new Array(encoded.n);
    for (let i = 0; i < encoded.n; i++) {
      const wCm = buf[i * 2], mCm = buf[i * 2 + 1];
      out[i] = wCm === BATHY_NULL_CM ? null : { water: round3(wCm / 100), mud: round3(mCm / 100) };
    }
    return out;
  }
  if (encoded.w) {
    const { w, m } = encoded;
    return w.map((wCm, i) => (wCm < 0 ? null : { water: round3(wCm / 100), mud: round3(m[i] / 100) }));
  }
  return [];
}

// Convert a local pond object → Firestore document (no cells, compact selections)
function pondToFirestore(pond) {
  return {
    id:       pond.id,
    name:     pond.name,
    origin:   pond.origin   || null,
    polygon:  pond.polygon,
    area:     pond.area     || 0,
    bbox:     pond.bbox,
    hoseAnchor: pond.hoseAnchor || null,
    depositZone: pond.depositZone || null,
    bathySurveys: (pond.bathySurveys || []).map(s => ({ ...s, readings: encodeBathyReadings(s.readings) })),
    lastUsed:   pond.lastUsed   || Date.now(),
    lastResetAt: pond.lastResetAt || 0,
    work: {
      completedCells: pond.work?.completedCells || [],
      volumePumped:   pond.work?.volumePumped   || 0,
      elapsedSec:     pond.work?.elapsedSec     || 0,
      energyWh:       pond.work?.energyWh       || 0,
    },
    // Live selection state (so other devices see which cells are highlighted)
    currentSelectedIndices: encodeSelection(pond.cells || []),
    // Store selections as compact index sets (far smaller than boolean arrays)
    selections: (pond.selections || []).map(s => ({
      id:        s.id,
      name:      s.name,
      timestamp: s.timestamp,
      count:     s.count,
      selectedIndices: s.cellStates
        ? encodeSelection(s.cellStates.map(sel => ({ selected: sel })))
        : { mode: 'include', idx: s.selectedIndices || [] },
    })),
  };
}

// ============================================================
// REAL-TIME STATE SYNC
// ============================================================

// Save robot/simulation state to aquabot_sim/{pondId}
function saveSimState() {
  if (!USE_CLOUD || !state.pond) return;
  const completedIdxs = state.cells.map((c,i) => c.completed ? i : -1).filter(i => i !== -1);
  window.db.collection('aquabot_sim').doc(state.pond.id).set({
    robotState:     state.robot.state,
    simRunning:     state.sim.running,
    x:              state.robot.x,
    y:              state.robot.y,
    currentCellIdx: state.robot.currentCellIdx,
    pumpState:      state.robot.pumpState,
    pumpDepth:      state.robot.pumpDepth,
    pumpTimer:      state.robot.pumpTimer,
    miniCyclesDone: state.robot.miniCyclesDone,
    heading:        state.robot.heading,
    motors:         state.robot.motors,
    elapsedSec:     state.robot.elapsedSec,
    volumePumped:   state.robot.volumePumped,
    energyWh:       state.robot.energyWh,
    plannedPath:    state.plannedPath,
    completedCells: completedIdxs,
    speed:          state.sim.speed,
    workMode:       params.workMode,
    miniCycles:     params.miniCycles,
    driverId:       _deviceSessionId,
    lastUpdate:     Date.now(),
  }).catch(e => reportFirestoreError(e, 'simState save'));
}

// Debounced save of current cell selection (called after user changes selection)
function debouncedSaveSelection() {
  if (!USE_CLOUD || !state.pond) return;
  _localSelChanging = true;
  clearTimeout(_selDebounce);
  _selDebounce = setTimeout(() => {
    window.db.collection('aquabot_ponds').doc(state.pond.id)
      .update({ currentSelectedIndices: encodeSelection(state.cells), lastUsed: Date.now() })
      .catch(e => reportFirestoreError(e, 'selSync'));
    // Keep flag for 2s to absorb our own echo from onSnapshot
    setTimeout(() => { _localSelChanging = false; }, 2000);
  }, 500);
}

// Listen to real-time robot state for the active pond
// Listener passif : synchronise l'affichage quand un AUTRE appareil pilote la sim.
// Ne démarre JAMAIS la boucle locale — c'est le rôle de checkAndResumeSim().
function subscribeSimState(pondId) {
  if (_simUnsubscribe) { _simUnsubscribe(); _simUnsubscribe = null; }
  if (!USE_CLOUD) return;
  _simUnsubscribe = window.db.collection('aquabot_sim').doc(pondId)
    .onSnapshot(doc => {
      if (!doc.exists) return;
      const sim = doc.data();
      if (!sim) return;

      // Dernier battement de cœur connu, pour que updateButtonStates() puisse distinguer
      // « ça tourne vraiment, là, maintenant » de « l'affichage montre encore moving/pumping
      // mais plus personne n'écrit depuis un moment » (pilote disparu sans s'arrêter proprement).
      if (sim.lastUpdate) _lastKnownSimHeartbeat = sim.lastUpdate;

      // Ignorer les données antérieures au dernier RAZ
      const pondResetAt = state.pond?.lastResetAt || 0;
      if (pondResetAt > 0 && (sim.lastUpdate || 0) < pondResetAt) return;

      // Commandes distantes (vitesse, mode de travail) : à appliquer même sur l'appareil qui
      // pilote activement la simulation — sinon un changement fait depuis un autre appareil (ou
      // un onglet resté suiveur) se fait aussitôt écraser par la prochaine sauvegarde
      // périodique du pilote, qui continue de réécrire son ancienne valeur locale sans jamais
      // savoir qu'elle a changé ailleurs. C'était la cause du "la vitesse revient à l'ancienne
      // valeur après actualisation" : le pilote ignorait totalement ces snapshots.
      // Tant qu'une demande de vitesse envoyée par CET appareil n'est pas confirmée (voir
      // _sendRemoteSpeedChange), un écho périmé du pilote (son ancienne écriture périodique,
      // partie avant d'avoir reçu notre demande) ne doit pas s'afficher brièvement ici — nos
      // réémissions vont de toute façon bientôt faire converger le pilote vers la bonne valeur.
      if (_pendingSpeedRequest != null && sim.speed !== _pendingSpeedRequest) {
        // ignoré : écho périmé
      } else if (sim.speed && sim.speed !== state.sim.speed) {
        state.sim.speed = sim.speed;
        _pendingSpeedRequest = null;
        const speedEl = document.getElementById('speedSlider');
        if (speedEl) { speedEl.value = sim.speed; setText('speedValue', sim.speed + '×'); }
      } else if (sim.speed === _pendingSpeedRequest) {
        _pendingSpeedRequest = null;
      }
      if (sim.workMode)   params.workMode   = sim.workMode;
      if (sim.miniCycles) params.miniCycles = sim.miniCycles;

      if (state.sim.running) {
        // Pause/arrêt demandé(e) depuis un autre appareil : c'est justement à l'appareil qui
        // pilote de l'exécuter (lui seul a l'état exact) et de rediffuser le résultat correct —
        // voir pauseSimulation()/stopSimulation() côté appareil non-pilote, qui n'envoient
        // qu'un signal minimal plutôt que d'écraser tout le document avec des valeurs suivies.
        if (sim.simRunning === false) {
          if (sim.robotState === 'stopped') _stopLocally(); else _pauseLocally();
          return;
        }
        // Un autre appareil a pris/repris la main (ex. cet appareil a été mis en arrière-plan
        // assez longtemps pour que son battement de cœur expire, voir DRIVER_HEARTBEAT_TIMEOUT_MS)
        // — on arrête notre propre boucle sans rediffuser, pour ne pas se battre avec le nouveau
        // pilote légitime. Sans ça, revenir au premier plan sur mobile pouvait ressusciter une
        // seconde simulation en parallèle de celle qui avait pris le relai entre-temps.
        if (sim.driverId && sim.driverId !== _deviceSessionId) {
          state.sim.running = false;
          clearInterval(state.sim.intervalId);
          state.sim.intervalId = null;
          // Pas de retour anticipé ici : on laisse la suite du traitement (réservée aux
          // appareils suiveurs) s'appliquer tout de suite avec les données de ce même
          // snapshot, pour refléter sans délai l'état exact du nouveau pilote plutôt que
          // d'attendre une prochaine mise à jour pour sortir de l'affichage figé.
        } else {
          return;
        }
      }

      // Le reste (position, état pompe, cases complétées...) reste réservé aux appareils
      // suiveurs : le pilote ne doit jamais se resynchroniser sur l'écho de ses propres
      // écritures de position/physique, seulement sur les commandes distantes ci-dessus.

      const offlineMs  = Date.now() - (sim.lastUpdate || Date.now());
      const offlineSec = (offlineMs / 1000) * (sim.speed || 1);

      if (sim.simRunning) {
        const completedSet = new Set(sim.completedCells || []);
        state.cells.forEach((c, i) => { c.completed = completedSet.has(i); });
        state.robot.completedCells = completedSet.size;
      } else {
        state.robot.completedCells = state.pond?.work?.completedCells?.length || 0;
      }

      if (sim.plannedPath?.length) state.plannedPath = sim.plannedPath;

      state.robot.state          = sim.robotState  || 'stopped';
      state.robot.elapsedSec     = sim.elapsedSec + (sim.simRunning ? offlineSec : 0);
      state.robot.volumePumped   = sim.volumePumped || 0;
      state.robot.energyWh       = sim.energyWh || 0;
      state.robot.x              = sim.x ?? state.robot.x;
      state.robot.y              = sim.y ?? state.robot.y;
      state.robot.pumpDepth      = sim.pumpDepth  ?? 0;
      state.robot.pumpState      = sim.simRunning ? (sim.pumpState || 'idle') : 'idle';
      state.robot.pumpTimer      = sim.pumpTimer  ?? 0;
      state.robot.miniCyclesDone = sim.miniCyclesDone || 0;
      state.robot.currentCellIdx = sim.currentCellIdx || 0;
      state.robot.heading        = sim.heading ?? state.robot.heading;
      state.robot.motors         = sim.motors  ?? state.robot.motors;

      const btnPause = document.getElementById('btnPause');
      if (sim.simRunning) {
        setLED('green', 'En travail');
        if (btnPause) btnPause.textContent = '⏸ Pause';
      } else if (sim.robotState === 'paused') {
        setLED('yellow', 'En pause');
        if (btnPause) btnPause.textContent = '▶ Reprendre';
      } else {
        setLED('blue', 'Simulation');
        if (btnPause) btnPause.textContent = '⏸ Pause';
      }
      updateButtonStates();
      renderAllPondCanvases();
      renderSectionCanvas();
      updateUI();
      if (_satModeDash && _leafletMapDash) {
        // Mise à jour légère (style des cases + repositionnement robot/tuyau existants) au
        // lieu d'une reconstruction complète des calques à CHAQUE snapshot (jusqu'à 5/s) : un
        // rebuild complet détruit et recrée des milliers de rectangles Leaflet à chaque fois,
        // ce qui rendait l'affichage très saccadé sur les appareils "suiveurs" (non pilotes) —
        // le pilote, lui, ne fait jamais que repositionner (voir updateRobotMarkerDash).
        if (_cellRectsDash.length) _updateCellStylesDash(); else _rebuildCellLayersDash();
        _rebuildPathLayerDash();
        if (_robotSquareDash) _updateDynamicLayersDashPosition(); else _rebuildDynamicLayersDash();
      }
    }, e => reportFirestoreError(e, 'simState listener'));
}

// En-dessous de ce délai depuis la dernière écriture, on considère qu'un AUTRE appareil est
// encore activement en train de piloter la simulation (il écrit toutes les ~200ms tant qu'il
// tourne) — il ne faut surtout pas démarrer une seconde boucle locale concurrente dans ce cas :
// c'était la vraie cause du décalage entre appareils (chacun calculait sa propre progression
// en parallèle, se recopiant l'un sur l'autre au gré des écritures Firestore).
const ACTIVE_DRIVER_THRESHOLD_MS = 4000;

// Lecture unique au chargement : reprend la simulation si elle était en cours ET que
// personne d'autre ne semble activement la piloter en ce moment (voir le seuil ci-dessus).
// Séparé de subscribeSimState pour éviter tout risque de re-entrance.
function checkAndResumeSim(pondId) {
  if (!USE_CLOUD || !state.pond || state.pond.id !== pondId || state.robotMode === 'real') return;
  console.log('[checkAndResumeSim] Lecture aquabot_sim pour', pondId);
  window.db.collection('aquabot_sim').doc(pondId).get().then(doc => {
    // Le pond actif a pu changer pendant la relecture (première lecture ou nouvelle
    // vérification différée après le délai d'inactivité) — ne rien appliquer si ce n'est
    // plus le même étang, sinon on risquerait de reprendre la simulation du mauvais étang.
    if (!doc.exists || state.sim.running || !state.pond || state.pond.id !== pondId) return;
    const sim = doc.data();
    console.log('[checkAndResumeSim] simRunning=', sim?.simRunning, 'lastUpdate=', sim?.lastUpdate, 'plannedPath.length=', sim?.plannedPath?.length, 'completedCells.length=', sim?.completedCells?.length);
    if (!sim || !sim.simRunning) return;

    const pondResetAt = state.pond?.lastResetAt || 0;
    const offlineMs = Date.now() - (sim.lastUpdate || 0);
    console.log('[checkAndResumeSim] pondResetAt=', pondResetAt, 'offlineMs=', offlineMs);
    if (pondResetAt > 0 && (sim.lastUpdate || 0) < pondResetAt) { console.log('[checkAndResumeSim] SKIP: antérieur au RAZ'); return; }
    if (offlineMs > 7200000) { console.log('[checkAndResumeSim] SKIP: trop ancien (>2h)'); return; }

    // Si le document porte déjà NOTRE identifiant (typiquement : cet onglet vient d'être
    // actualisé pendant qu'il pilotait), aucune ambiguïté possible — on reprend tout de suite,
    // sans attendre l'expiration du délai. Sans ça, actualiser la page pendant le pilotage
    // faisait paraître le robot arrêté et la vitesse « revenue en arrière » pendant plusieurs
    // secondes à chaque fois, alors que l'ancien pilote (cet onglet, avant actualisation) est
    // de toute façon définitivement parti.
    if (offlineMs < ACTIVE_DRIVER_THRESHOLD_MS && sim.driverId !== _deviceSessionId) {
      // Un autre appareil écrit encore là, maintenant — rester simple suiveur passif
      // (subscribeSimState s'en charge déjà) et revérifier une fois passé le délai, au cas
      // où cet appareil s'arrêterait entre-temps sans clôturer proprement la simulation.
      console.log('[checkAndResumeSim] Un autre appareil semble piloter activement — nouvelle vérification dans', ACTIVE_DRIVER_THRESHOLD_MS - offlineMs + 500, 'ms');
      setTimeout(() => checkAndResumeSim(pondId), ACTIVE_DRIVER_THRESHOLD_MS - offlineMs + 500);
      return;
    }

    _resumeSimFromCloud(sim);
  }).catch(e => reportFirestoreError(e, 'checkAndResumeSim'));
}

function _resumeSimFromCloud(sim) {
  console.log('[_resumeSimFromCloud] cells=', state.cells.length, 'running=', state.sim.running);
  if (!state.pond || !state.cells.length || state.sim.running) return;

  // Restaurer le parcours planifié
  if (sim.plannedPath?.length) state.plannedPath = sim.plannedPath;
  if (!state.plannedPath.length) {
    console.warn('[resumeSim] Parcours introuvable, reprise impossible');
    return;
  }
  console.log('[_resumeSimFromCloud] plannedPath.length=', state.plannedPath.length, 'currentCellIdx=', sim.currentCellIdx);

  // Restaurer les paramètres de simulation
  if (sim.speed) {
    state.sim.speed = sim.speed;
    // Sans ça, le curseur affiché reste sur sa valeur HTML par défaut (1×) tant que
    // subscribeSimState() n'a pas reçu son propre snapshot — une course selon l'ordre
    // d'arrivée des deux lectures Firestore, d'où la vitesse qui semblait se réinitialiser.
    const speedEl = document.getElementById('speedSlider');
    if (speedEl) { speedEl.value = sim.speed; setText('speedValue', sim.speed + '×'); }
  }
  if (sim.workMode)   params.workMode    = sim.workMode;
  if (sim.miniCycles) params.miniCycles  = sim.miniCycles;

  // Calculer les ghost cells (cases traitées hors-ligne)
  const offlineMs  = Date.now() - (sim.lastUpdate || Date.now());
  const offlineSec = (offlineMs / 1000) * (sim.speed || 1);
  const completedSet = new Set(sim.completedCells || []);

  if (offlineMs > 3000) {
    const doneBefore = sim.completedCells?.length || 0;
    if (doneBefore > 0 && sim.elapsedSec > 0) {
      const secPerCell = sim.elapsedSec / doneBefore;
      const ghostCells = Math.floor(offlineSec / secPerCell);
      const path = sim.plannedPath || [];
      for (let i = doneBefore; i < Math.min(doneBefore + ghostCells, path.length); i++) {
        if (path[i] !== undefined) completedSet.add(path[i]);
      }
      const added = completedSet.size - doneBefore;
      if (added > 0) showToast(`Reprise : ~${added} cases traitées hors ligne`, 'success');
    }
  }

  // Appliquer les cases complétées
  state.cells.forEach((c, i) => { c.completed = completedSet.has(i); });
  state.robot.completedCells = completedSet.size;

  // Restaurer la position et l'état du robot
  state.robot.x              = sim.x ?? state.robot.x;
  state.robot.y              = sim.y ?? state.robot.y;
  state.robot.currentCellIdx = sim.currentCellIdx || 0;
  state.robot.pumpState      = sim.pumpState      || 'idle';
  state.robot.pumpDepth      = sim.pumpDepth      ?? 0;
  state.robot.miniCyclesDone = sim.miniCyclesDone || 0;
  state.robot.pumpTimer      = 0;   // timer inconnu après déconnexion, redémarre le cycle
  state.robot.elapsedSec     = sim.elapsedSec + offlineSec;
  state.robot.volumePumped   = sim.volumePumped || 0;
  state.robot.energyWh       = sim.energyWh || 0;
  state.robot.heading        = sim.heading ?? state.robot.heading;
  state.robot.motors         = sim.motors  ?? state.robot.motors;

  // Avancer currentCellIdx au-delà des cases déjà complétées (y compris ghost cells)
  const path = state.plannedPath;
  while (state.robot.currentCellIdx < path.length && completedSet.has(path[state.robot.currentCellIdx])) {
    state.robot.currentCellIdx++;
  }

  if (state.robot.currentCellIdx >= path.length) {
    finishSimulation();
    return;
  }

  // Persister la progression (ghost cells incluses) avant de reprendre
  if (offlineMs > 3000) saveWork();

  // Relancer la boucle de simulation
  state.robot.state     = 'moving';
  state.sim.running     = true;
  state.sim.lastSimSave = Date.now();
  state.sim.lastTick    = performance.now();
  if (!state.sim.intervalId) {
    state.sim.intervalId = setInterval(simulationTick, SIM_TICK_MS);
  }

  setLED('green', 'En travail');
  const btnPause = document.getElementById('btnPause');
  if (btnPause) btnPause.textContent = '⏸ Pause';
  updateButtonStates();
  renderAllPondCanvases();
  renderSectionCanvas();
  updateUI();
  if (_satModeDash && _leafletMapDash) {
    _rebuildCellLayersDash(); _rebuildPathLayerDash(); _rebuildDynamicLayersDash();
  }
  showToast('Simulation reprise automatiquement', 'success');
}

// ============================================================
// MODE ROBOT RÉEL
// ============================================================

// Bascule simulation ↔ robot réel
function setRobotMode(mode) {
  state.robotMode = mode;
  const isReal = mode === 'real';
  document.getElementById('modeSimBtn')?.classList.toggle('active', !isReal);
  document.getElementById('modeRealBtn')?.classList.toggle('active',  isReal);
  const speedCard = document.getElementById('speedControlCard');
  if (speedCard) speedCard.style.opacity = isReal ? '0.4' : '1';
  setText('ledLabel', isReal ? 'Robot réel' : 'Simulation');

  if (isReal && state.pond) {
    subscribeRobotTelemetry(state.pond.id);
  } else if (_telemetryUnsubscribe) {
    _telemetryUnsubscribe();
    _telemetryUnsubscribe = null;
  }
  updateButtonStates();
}

// Envoyer une commande vers le robot via Firestore
function sendRobotCommand(cmd) {
  if (!USE_CLOUD || !state.pond) return;
  const doc = {
    command:   cmd,
    originLat: state.pond.origin?.lat || 0,
    originLng: state.pond.origin?.lng || 0,
    timestamp: Date.now(),
  };
  if (cmd === 'start' && state.plannedPath.length) {
    doc.plannedPath = state.plannedPath.map(idx => {
      const c = state.cells[idx];
      return { x: c.cx, y: c.cy };
    });
    doc.pumpTime         = params.pumpTime;
    doc.waterDepth       = params.waterDepth;
    doc.mudDepth         = params.mudDepth;
    doc.pumpDescentSpeed = params.pumpDescentSpeed;
    doc.pumpAscentSpeed  = params.pumpAscentSpeed;
    doc.miniCycles       = params.miniCycles;
    doc.pumpFlow         = params.pumpFlow;
  }
  window.db.collection('aquabot_commands').doc(state.pond.id)
    .set(doc)
    .catch(e => reportFirestoreError(e, 'Robot command error'));
  showToast(`Commande "${cmd}" envoyée au robot`, 'success');
}

// Écouter la télémétrie GPS du robot en temps réel
function subscribeRobotTelemetry(pondId) {
  if (_telemetryUnsubscribe) { _telemetryUnsubscribe(); _telemetryUnsubscribe = null; }
  if (!USE_CLOUD) return;
  _telemetryUnsubscribe = window.db.collection('aquabot_telemetry').doc(pondId)
    .onSnapshot(doc => {
      if (!doc.exists) return;
      const t = doc.data();

      // Position robot depuis GPS réel
      state.robot.x         = t.x          ?? state.robot.x;
      state.robot.y         = t.y          ?? state.robot.y;
      state.robot.state     = t.robotState ?? 'stopped';
      state.robot.pumpState = t.pumpState  ?? 'idle';
      state.robot.pumpDepth = t.pumpDepth  ?? 0;
      state.robot.pumpTimer = t.pumpTimer  ?? 0;
      state.robot.energyWh       = t.energyWh      ?? state.robot.energyWh;
      state.robot.volumePumped  = t.volumePumped  ?? state.robot.volumePumped;
      state.robot.miniCyclesDone = t.miniCyclesDone ?? 0;
      state.robot.currentCellIdx = t.currentCellIdx ?? 0;
      state.robot.heading   = t.heading ?? state.robot.heading;
      state.robot.motors    = [t.motor0, t.motor1, t.motor2, t.motor3].map(v => v ?? 0);

      // Statut GPS
      setText('gpsFixLabel',   t.fixLabel  || '—');
      setText('gpsAccuracy',   t.accuracy !== undefined ? `±${(t.accuracy * 100).toFixed(0)} cm` : '—');

      // Cases complétées depuis le robot
      if (t.currentCellIdx > 0 && state.plannedPath.length) {
        for (let i = 0; i < Math.min(t.currentCellIdx, state.plannedPath.length); i++) {
          const idx = state.plannedPath[i];
          if (state.cells[idx]) state.cells[idx].completed = true;
        }
        state.robot.completedCells = t.currentCellIdx;
      }

      // LED selon état robot réel
      if (t.simRunning)              setLED('green',  'En travail');
      else if (t.robotState === 'paused') setLED('yellow', 'En pause');
      else                            setLED('blue',   'Robot réel');

      updateButtonStates();
      renderAllPondCanvases();
      renderSectionCanvas();
      updateUI();
    }, e => reportFirestoreError(e, 'Telemetry listener'));
}

// Rebuild a full local pond object from a Firestore document
function pondFromFirestore(data) {
  const cells = generateGrid(data.polygon);
  const completedSet = new Set(data.work?.completedCells || []);
  cells.forEach((c, i) => { c.completed = completedSet.has(i); });
  // Restore live selection state from remote
  const selectedSet = decodeSelection(data.currentSelectedIndices, cells.length);
  if (selectedSet && selectedSet.size > 0) cells.forEach((c, i) => { c.selected = selectedSet.has(i); });
  return {
    ...data,
    cells,
    lastResetAt: data.lastResetAt || 0,
    bathySurveys: (data.bathySurveys || []).map(s => ({ ...s, readings: decodeBathyReadings(s.readings) })),
    work: data.work || { completedCells: [], volumePumped: 0, elapsedSec: 0, energyWh: 0 },
    selections: (data.selections || []).map(s => {
      const set = decodeSelection(s.selectedIndices, cells.length) || new Set();
      return { ...s, cellStates: cells.map((_, i) => set.has(i)) };
    }),
  };
}

// ============================================================
// CONSTANTS
// ============================================================
const ROBOT_SIZE  = 2.0;
const CELL_SIZE   = 0.4;
const SIM_TICK_MS = 50;
// Intervalle entre deux écritures Firestore de miroir cross-appareils pendant la simulation
// (voir simulationTick). Valeur d'origine (200ms) pour retrouver la fluidité initiale entre
// appareils, maintenant que le plan Blaze facture simplement l'usage au lieu de le bloquer.
const SIM_SAVE_INTERVAL_MS = 200;
const CANVAS_IDS  = ['dashPondCanvas'];

// 4 propulseurs en configuration X (avant-gauche, avant-droit, arrière-gauche, arrière-droit)
const MOTOR_LABELS = ['AV-G', 'AV-D', 'AR-G', 'AR-D'];

// ============================================================
// CONSOMMATION ÉLECTRIQUE (estimation — pas de télémétrie réelle)
// ============================================================
// Puissances nominales estimées par composant, à pleine charge (W). Pompe : moteur 1800W en
// 220V (secteur/onduleur), valeur communiquée pour le robot réel — les autres restent des
// estimations plausibles (propulseurs ROV compacts). Affichées comme telles dans l'UI, pas
// comme des mesures réelles tant qu'aucun capteur de courant n'est câblé sur le robot physique.
const POWER_SPECS = {
  thrusterMaxW:  55,   // W par propulseur (×4), à 100% de poussée
  pumpW:       1800,   // W pompe d'aspiration, moteur 220V — voir computeInstantPowerBreakdown
  pumpVoltage:  220,   // V — alimentation secteur/onduleur, pas du DC batterie direct
  winchW:        80,   // W moteur de profondeur (descente/remontée du bras de pompage)
  bathyProbeW:   80,   // W moteur de sonde bathymétrique (même type que le moteur de pompe :
                       // portail 12V + crémaillère verticale, actionneur dédié séparé)
  electronicsW:   8,   // W électronique de contrôle (ESP32, capteurs, wifi, LED) — en veille
};

// Répartition de la puissance instantanée par composant (W). La poussée d'un propulseur ne
// consomme pas linéairement avec le %, la puissance suit plutôt le cube de la vitesse pour une
// hélice — on prend un exposant 1.5 comme compromis simple et lisible entre linéaire et cubique.
function computeInstantPowerBreakdown(robot) {
  const thrusterWs = (robot.motors || [0, 0, 0, 0]).map(m => {
    const frac = Math.min(1, Math.abs(m) / 100);
    return POWER_SPECS.thrusterMaxW * Math.pow(frac, 1.5);
  });
  const thrustersTotalW = thrusterWs.reduce((a, b) => a + b, 0);
  // La pompe d'aspiration reste allumée en continu tout au long des mini-cycles d'une même
  // case (descente → pompage → remontée partielle → redescente...) — elle ne s'arrête
  // vraiment qu'entre deux cases (pumpState 'idle'). Des coupures courtes et répétées
  // risqueraient de laisser la vase déjà aspirée refluer dans le tuyau à chaque arrêt.
  const pumpActive  = robot.pumpState !== 'idle';
  const winchActive = robot.pumpState === 'descending' || robot.pumpState === 'ascending' || robot.pumpState === 'partial_ascending';
  const pumpW         = pumpActive  ? POWER_SPECS.pumpW  : 0;
  const winchW         = winchActive ? POWER_SPECS.winchW : 0;
  const electronicsW  = POWER_SPECS.electronicsW; // toujours actif tant que le robot est allumé
  const totalW = thrustersTotalW + pumpW + winchW + electronicsW;
  return { thrusterWs, thrustersTotalW, pumpW, winchW, electronicsW, totalW };
}

/// Estimation théorique de l'énergie nécessaire pour traiter UNE case, à partir du modèle de
// puissance et de la durée de chaque phase du mini-cycle (descente → pompage → remontée
// partielle → redescente... → remontée finale). Ignore le déplacement entre cases (quelques
// secondes de propulseurs à 55W max, négligeable face à la pompe à 1800W pendant tout le
// cycle) — sert de base aux estimations "étang complet" / "zone sélectionnée" de l'onglet
// Énergie, avant même d'avoir une seule case réellement terminée pour mesurer un vrai rythme.
function computeCellCycleEnergyWh() {
  const fullDepth    = params.waterDepth + params.mudDepth;
  const partialDepth = params.waterDepth;
  const nbCycles     = effectiveMiniCycles();
  const idle = pumpState => ({ pumpState, motors: [0, 0, 0, 0] });

  const descentTime       = params.pumpDescentSpeed > 0 ? fullDepth / params.pumpDescentSpeed : 0;
  const pumpingTime        = params.pumpTime;
  const partialAscentTime  = params.pumpAscentSpeed > 0 ? (fullDepth - partialDepth) / params.pumpAscentSpeed : 0;
  const finalAscentTime    = params.pumpAscentSpeed > 0 ? fullDepth / params.pumpAscentSpeed : 0;
  const partialAscents     = Math.max(0, nbCycles - 1);

  const pDescent = computeInstantPowerBreakdown(idle('descending')).totalW;
  const pPumping = computeInstantPowerBreakdown(idle('pumping')).totalW;
  const pPartial = computeInstantPowerBreakdown(idle('partial_ascending')).totalW;
  const pFinal   = computeInstantPowerBreakdown(idle('ascending')).totalW;

  const totalWs = (pDescent * descentTime + pPumping * pumpingTime) * nbCycles
                + pPartial * partialAscentTime * partialAscents
                + pFinal * finalAscentTime;
  return (totalWs / 3600) * passes();
}

// Puissance de pointe (pic simultané max : 4 propulseurs à 100% + pompe + treuil + électronique)
// — c'est la capacité minimale que doit fournir l'alimentation/batterie pour ne jamais être
// sous-dimensionnée, pas la consommation "normale" de fonctionnement.
function computePeakPowerW() {
  return POWER_SPECS.thrusterMaxW * 4 + POWER_SPECS.pumpW + POWER_SPECS.winchW
       + POWER_SPECS.bathyProbeW + POWER_SPECS.electronicsW;
}

// Sauvegarde les réglages localement ET les diffuse en direct à tous les appareils connectés
// (onglet Paramètres, tarif, faisabilité solaire...) — exactement le même principe que l'état
// de simulation : on doit voir la même chose partout, sans avoir à recharger la page.
function persistParams() {
  localStorage.setItem('aquabot_params', JSON.stringify(params));
  if (USE_CLOUD) {
    window.db.collection('aquabot_meta').doc('params').set(params)
      .catch(e => reportFirestoreError(e, 'persistParams'));
  }
}

function updateElecTariff(value) {
  const v = parseFloat(value);
  params.elecTariff = Number.isFinite(v) && v >= 0 ? v : 0;
  persistParams();
  updateEnergyTab();
}

function updateSolarParam(key, value) {
  const v = parseFloat(value);
  if (Number.isFinite(v) && v >= 0) params[key] = v;
  // Une fois modifié à la main, l'ensoleillement n'est plus ré-écrasé par l'estimation météo
  // automatique tant qu'un nouvel étang (nouvelle position) n'est pas chargé.
  if (key === 'solarPeakSunHours') params.solarPeakSunHoursAuto = false;
  persistParams();
  updateEnergyTab();
}

// Cache mémoire (pas persisté) de la dernière estimation météo récupérée, par position —
// évite de refaire l'appel réseau à chaque frame ou à chaque passage sur l'onglet.
let _solarIrradianceCache = null;      // { key, peakSunHours, sampleCount, fetchedAt }
let _solarIrradianceFetching = null;   // clé en cours de récupération, pour ne pas dupliquer l'appel

// Estimation de l'ensoleillement exploitable (heures crête/jour) à partir de vraies données
// météo pour la position exacte de l'étang, autour de la date du jour. Utilise l'API Open-Meteo
// (gratuite, sans clé, sans backend nécessaire) : moyenne du rayonnement solaire journalier
// (shortwave_radiation_sum, MJ/m²) sur une fenêtre de ±15 jours autour d'aujourd'hui, sur les
// 3 dernières années — un « aujourd'hui » sur plusieurs années passées pour lisser la météo du
// jour tout en restant représentatif de la saison et du lieu. 1 kWh/m²/jour = 1 heure crête
// (par définition du "peak sun hour" : irradiance de référence 1000 W/m²).
async function fetchSolarPeakSunHours(lat, lng) {
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (_solarIrradianceCache?.key === cacheKey) return _solarIrradianceCache;
  if (_solarIrradianceFetching === cacheKey) return null;
  _solarIrradianceFetching = cacheKey;

  try {
    const today = new Date();
    const fmt = (d) => d.toISOString().slice(0, 10);
    const windowDays = 15;
    const requests = [1, 2, 3].map(yearsAgo => {
      const center = new Date(today.getFullYear() - yearsAgo, today.getMonth(), today.getDate());
      const start = new Date(center); start.setDate(start.getDate() - windowDays);
      const end   = new Date(center); end.setDate(end.getDate() + windowDays);
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}`
        + `&start_date=${fmt(start)}&end_date=${fmt(end)}&daily=shortwave_radiation_sum&timezone=auto`;
      return fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    });
    const results = await Promise.all(requests);
    const values = [];
    for (const res of results) {
      const arr = res?.daily?.shortwave_radiation_sum;
      if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
    _solarIrradianceFetching = null;
    if (!values.length) return null;
    const avgMJ = values.reduce((a, b) => a + b, 0) / values.length;
    _solarIrradianceCache = { key: cacheKey, peakSunHours: avgMJ / 3.6, sampleCount: values.length, fetchedAt: Date.now() };
    return _solarIrradianceCache;
  } catch (e) {
    console.warn('fetchSolarPeakSunHours:', e.message);
    _solarIrradianceFetching = null;
    return null;
  }
}

// Déclenche la récupération météo pour l'étang actif (si position GPS connue) et applique le
// résultat à l'ensoleillement exploitable, sauf si l'utilisateur l'a déjà modifié à la main.
function refreshSolarIrradianceForPond() {
  const origin = state.pond?.origin;
  if (!isValidOrigin(origin) || !params.solarPeakSunHoursAuto) return;
  fetchSolarPeakSunHours(origin.lat, origin.lng).then(result => {
    if (result && params.solarPeakSunHoursAuto) {
      params.solarPeakSunHours = result.peakSunHours;
      persistParams();
    }
    // Réaffiche dans tous les cas (y compris échec) pour sortir du message "Récupération…"
    // même si l'appel météo n'a rien donné.
    updateEnergyTab();
  });
}

// Estimation de faisabilité solaire — panneaux + onduleur + batterie nécessaires pour couvrir
// le travail quotidien estimé. Volontairement indépendant de l'état de la simulation (marche
// même sans étang chargé) : c'est un dimensionnement de l'installation, pas une mesure live.
function computeSolarEstimate() {
  // Puissance moyenne pendant le travail actif — la pompe (quasi continue, voir
  // computeInstantPowerBreakdown) domine très largement le total ; treuil et propulseurs
  // n'interviennent que par intermittence, on ne compte qu'une fraction de leur maximum.
  const avgWorkingW = POWER_SPECS.pumpW + POWER_SPECS.electronicsW
    + POWER_SPECS.winchW * 0.4 + POWER_SPECS.thrusterMaxW * 4 * 0.15;

  const hoursPerDay  = params.solarHoursPerDay    || 0;
  const peakSunHours = params.solarPeakSunHours   || 0;
  const sysEff       = (params.solarSystemEffPct  || 0) / 100;

  const dailyEnergyWh = avgWorkingW * hoursPerDay;
  const peakWc = (peakSunHours > 0 && sysEff > 0) ? dailyEnergyWh / peakSunHours / sysEff : 0;
  const panelCount = Math.ceil(peakWc / 400); // panneaux courants ≈ 400 Wc, ≈ 1.9 m² pièce
  const areaM2 = panelCount * 1.9;

  // Démarrage d'un moteur asynchrone : appel de courant transitoire ≈ 3× la puissance
  // nominale — l'onduleur doit encaisser ce pic, pas seulement la puissance de régime.
  const inverterMinW = POWER_SPECS.pumpW * 3;

  // Batterie tampon pour ~1 jour d'autonomie sans soleil direct (nuit/couvert), avec une
  // marge de décharge utile de 60% (raisonnable pour un compromis plomb/lithium générique).
  const batteryKWh = sysEff > 0 ? (dailyEnergyWh / 1000) / 0.6 : 0;

  return { avgWorkingW, dailyEnergyWh, peakWc, panelCount, areaM2, inverterMinW, batteryKWh };
}

const ENERGY_STATE_LABELS = {
  stopped: 'À l\'arrêt — électronique en veille',
  moving:  'En déplacement',
  pumping: 'En pompage',
  paused:  'En pause',
  error:   'Erreur',
};

// Rafraîchit tout l'onglet Énergie. Appelé depuis updateUI() (donc à chaque tick de simulation
// ET à chaque snapshot Firestore reçu par un appareil suiveur) mais se coupe immédiatement si
// l'onglet n'est pas affiché — pas la peine de reconstruire cette liste à chaque frame pour rien.
function updateEnergyTab() {
  if (state.activeTab !== 'energy') return;
  const elTotal = document.getElementById('energyTotalW');
  if (!elTotal) return;

  const robot = state.robot;
  const hasPond = !!state.pond;
  const breakdown = computeInstantPowerBreakdown(robot);

  // Ne pas écraser la saisie en cours si l'utilisateur est en train de modifier le tarif
  const tariffInput = document.getElementById('pElecTariff');
  if (tariffInput && document.activeElement !== tariffInput) tariffInput.value = params.elecTariff;

  elTotal.textContent = hasPond ? Math.round(breakdown.totalW).toLocaleString('fr-FR') : '0';
  setText('energyLiveStatus', hasPond ? (ENERGY_STATE_LABELS[robot.state] || '—') : 'Aucun étang chargé');

  // Répartition par composant
  const rows = [
    ...MOTOR_LABELS.map((lbl, i) => ({ label: `Propulseur ${lbl}`, w: breakdown.thrusterWs[i], max: POWER_SPECS.thrusterMaxW })),
    { label: 'Pompe d\'aspiration (220V)', w: breakdown.pumpW,       max: POWER_SPECS.pumpW },
    { label: 'Moteur de profondeur',     w: breakdown.winchW,       max: POWER_SPECS.winchW },
    { label: 'Électronique de contrôle', w: breakdown.electronicsW, max: POWER_SPECS.electronicsW },
  ];
  const listEl = document.getElementById('energyComponentList');
  if (listEl) {
    listEl.innerHTML = rows.map(r => {
      const barPct = r.max > 0 ? Math.min(100, (r.w / r.max) * 100) : 0;
      const sharePct = breakdown.totalW > 0 ? (r.w / breakdown.totalW) * 100 : 0;
      return `
        <div class="energy-comp-row">
          <span class="energy-comp-lbl">${r.label}</span>
          <div class="energy-comp-bar-wrap"><div class="energy-comp-bar" style="width:${barPct.toFixed(0)}%"></div></div>
          <span class="energy-comp-val">${r.w.toFixed(1)} W <span class="energy-comp-pct">(${sharePct.toFixed(0)}%)</span></span>
        </div>`;
    }).join('');
  }

  setText('energyIdleW', `${POWER_SPECS.electronicsW} W`);
  setText('energyPeakW', `${computePeakPowerW()} W`);

  // Partie en cours (depuis l'ouverture de cet étang) — dérivée d'un instantané pris au
  // chargement, pas d'un compteur séparé : fonctionne aussi bien sur un appareil suiveur.
  const sessionWh  = Math.max(0, robot.energyWh - state.sim.sessionEnergyBaselineWh);
  const sessionSec = Math.max(0, robot.elapsedSec - state.sim.sessionElapsedBaselineSec);
  const tariff = params.elecTariff || 0;

  // Débit horaire — puissance moyenne réelle de la partie en cours (énergie/durée), pas la
  // puissance instantanée qui saute sans arrêt selon la phase du cycle en cours.
  const avgW = sessionSec > 0 ? (sessionWh * 3600) / sessionSec : 0;
  setText('energyRateHour', avgW > 0 ? `${avgW.toFixed(0)} Wh` : '—');
  setText('energyRateDay',  avgW > 0 ? `${(avgW * 24 / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kWh` : '—');

  setText('energySessionWh',   hasPond ? formatEnergyWh(sessionWh) : '—');
  setText('energySessionCost', hasPond ? formatEnergyCost(sessionWh, tariff) : '—');
  setText('energyTotalWh',     hasPond ? formatEnergyWh(robot.energyWh) : '—');
  setText('energyTotalCost',   hasPond ? formatEnergyCost(robot.energyWh, tariff) : '—');

  // Stats — sur le cumul total de l'étang (plus stable qu'une session qui vient de commencer)
  const doneCells  = robot.completedCells || 0;
  const totalCost  = (robot.energyWh / 1000) * tariff;
  setText('energyCostPerCell', doneCells > 0 ? `${(totalCost / doneCells).toFixed(3)} €` : '—');
  const m3Pumped = (robot.volumePumped || 0) / 1000;
  setText('energyPerM3', m3Pumped > 0.001 ? `${(robot.energyWh / m3Pumped).toFixed(0)} Wh/m³` : '—');
  // Répartition instantanée (pas un cumul par composant, qu'on ne suit pas séparément) — donne
  // une idée de "où part l'énergie" pendant que le robot travaille activement.
  setText('energyPumpVsThrust', breakdown.totalW > 0
    ? `Pompe ${(breakdown.pumpW / breakdown.totalW * 100).toFixed(0)}% · Propulsion ${(breakdown.thrustersTotalW / breakdown.totalW * 100).toFixed(0)}%`
    : '—');

  // Estimations — étang complet / zone actuellement sélectionnée, à partir du modèle de
  // puissance théorique (pas d'un rythme mesuré) : utile dès avant le premier coup de pompe.
  const cellWh        = hasPond ? computeCellCycleEnergyWh() : 0;
  const totalCells    = state.cells.length;
  const selectedCells = state.cells.filter(c => c.selected).length;
  setText('energyEstPondCells', hasPond ? totalCells.toLocaleString('fr-FR') : '—');
  setText('energyEstPondWh',    hasPond ? formatEnergyWh(cellWh * totalCells) : '—');
  setText('energyEstPondCost',  hasPond ? formatEnergyCost(cellWh * totalCells, tariff) : '—');
  setText('energyEstSelCells',  hasPond ? selectedCells.toLocaleString('fr-FR') : '—');
  setText('energyEstSelWh',     hasPond ? formatEnergyWh(cellWh * selectedCells) : '—');
  setText('energyEstSelCost',   hasPond ? formatEnergyCost(cellWh * selectedCells, tariff) : '—');

  // Panneaux solaires — dimensionnement indépendant de l'état de la simulation
  ['pSolarHours', 'pSolarPeakSun', 'pSolarEff'].forEach((id, i) => {
    const el = document.getElementById(id);
    const key = ['solarHoursPerDay', 'solarPeakSunHours', 'solarSystemEffPct'][i];
    if (el && document.activeElement !== el) el.value = Math.round((params[key] || 0) * 10) / 10;
  });
  const solar = computeSolarEstimate();

  // D'où vient la valeur d'ensoleillement affichée — transparence sur l'origine de la donnée.
  const origin = state.pond?.origin;
  let sunSource;
  if (!params.solarPeakSunHoursAuto) {
    sunSource = 'Valeur personnalisée';
  } else if (!isValidOrigin(origin)) {
    sunSource = 'Étang sans position GPS — valeur générique';
  } else {
    const cacheKey = `${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}`;
    if (_solarIrradianceCache?.key === cacheKey) {
      sunSource = `Météo réelle pour cette position (Open-Meteo, ${_solarIrradianceCache.sampleCount} j sur 3 ans autour d'aujourd'hui)`;
    } else if (_solarIrradianceFetching === cacheKey) {
      sunSource = 'Récupération des données météo…';
    } else {
      sunSource = 'Données météo indisponibles — valeur générique';
    }
  }
  setText('solarSunSource', sunSource);

  setText('solarAvgWorkingW', `${solar.avgWorkingW.toFixed(0)} W`);
  setText('solarDailyKWh', `${(solar.dailyEnergyWh / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} kWh`);
  setText('solarPeakWc', solar.peakWc > 0 ? `${solar.peakWc.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} Wc` : '—');
  setText('solarPanelCount', solar.panelCount > 0
    ? `${solar.panelCount} panneau${solar.panelCount > 1 ? 'x' : ''} ≈400 Wc (≈${solar.areaM2.toFixed(1)} m²)`
    : '—');
  setText('solarInverterW', `≥ ${(solar.inverterMinW / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kW (pic démarrage moteur)`);
  setText('solarBatteryKWh', solar.batteryKWh > 0 ? `≈ ${solar.batteryKWh.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kWh utiles (1 jour d'autonomie)` : '—');

  const verdictEl = document.getElementById('solarVerdict');
  if (verdictEl) {
    verdictEl.textContent = solar.panelCount > 0
      ? `Techniquement faisable, mais le dimensionnement est dominé par la pompe 1800W/220V, pas par les panneaux seuls : compter un onduleur costaud (démarrage moteur) et une batterie substantielle pour couvrir les besoins hors ensoleillement direct — un investissement bien plus conséquent que "quelques panneaux".`
      : `Renseignez les heures de travail et l'ensoleillement exploitable ci-dessus pour estimer le dimensionnement.`;
  }
}

function formatEnergyWh(wh) {
  return wh >= 1000 ? `${(wh / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} kWh` : `${wh.toFixed(1)} Wh`;
}
function formatEnergyCost(wh, tariff) {
  return `${((wh / 1000) * tariff).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} €`;
}

// ============================================================
// STATE
// ============================================================
const state = {
  activeTab:  'dashboard',
  robotMode:  'simulation',   // 'simulation' | 'real'
  pond: null,
  ponds: [],
  cells: [],
  plannedPath: [],
  // Vue 3D en direct du tableau de bord — voir renderDash3D(). Partage rotation3D/tilt3D avec
  // l'onglet Bathymétrie (même scène 3D du fond de l'étang), pas de duplication de ces réglages.
  dash3D: { active: false, _lastRenderAt: 0 },
  robot: {
    x: 0, y: 0,
    pumpDepth: 0,
    // idle | descending | pumping | partial_ascending | ascending
    pumpState: 'idle',
    // stopped | moving | pumping | paused | error
    state: 'stopped',
    currentCellIdx: 0,
    completedCells: 0,
    volumePumped: 0,
    energyWh: 0,          // énergie cumulée depuis le dernier RAZ (persistée), voir sessionEnergyWh
    elapsedSec: 0,
    pumpTimer: 0,
    miniCyclesDone: 0,   // mini-cycles completed at current cell
    passNumber: 1,       // for double-pass modes
    heading: 0,          // cap boussole, degrés (0 = Nord)
    motors: [0, 0, 0, 0],// poussée des 4 propulseurs, % (-100..100)
  },
  sim: {
    running: false, speed: 1, intervalId: null, lastTick: 0, sessionElapsedAtStart: 0, lastSimSave: 0,
    // Rythme de travail (secondes/case) pour l'estimation restant/fin — recalculé
    // seulement quand une case vient de se terminer, voir updateUI().
    paceDoneCount: 0, paceSecPerCell: null,
    // Valeur de robot.energyWh au moment de l'ouverture de cet étang — la « partie en cours »
    // affichée est dérivée (energyWh - sessionEnergyBaselineWh), pas accumulée séparément :
    // ça marche aussi bien sur l'appareil qui pilote que sur un appareil suiveur (qui ne fait
    // jamais tourner simulationTick() localement, seulement robot.energyWh via Firestore).
    sessionEnergyBaselineWh: 0,
    // Même principe pour le temps écoulé, afin de calculer une puissance moyenne sur cette
    // partie (énergie / durée) plutôt que d'extrapoler depuis la puissance instantanée, qui
    // fluctue sans arrêt selon la phase du cycle (déplacement/descente/pompage/remontée).
    sessionElapsedBaselineSec: 0,
  },
  view: { offsetX: 0, offsetY: 0, scale: 10, canvasH: 600 },
  drag: { active: false, mode: 'add' }, // for drag-select
  hose: { dragging: false }, // déplacement à la main de l'ancrage du tuyau d'évacuation
  // Relevé bathymétrique — balayage animé de la sélection (comme le curage) qui génère des
  // profondeurs d'eau/vase simulées mais cohérentes par case, voir section BATHYMÉTRIE.
  bathy: {
    running: false, order: [], currentStep: 0, intervalId: null,
    pendingReadings: [], pendingType: null, markerIdx: null,
    // Vue par défaut : 3D / profondeur totale / surface lisse — la plus lisible pour se rendre
    // compte visuellement de l'épaisseur de vase (voir index.html pour les classes/valeurs HTML
    // statiques qui doivent rester synchronisées avec ces valeurs par défaut).
    metric: 'total', mode: '3d', palette: 'classic', rotation3D: 45, show3DMap: true,
    zoom3D: 1, pan3D: { x: 0, y: 0 },
    style3D: 'mesh', tilt3D: 28, // 'columns' | 'mesh' — tilt3D partagé par les deux styles
    selectedSurveyId: null, compareBeforeId: null, compareAfterId: null,
    _lastMin: null, _lastMax: null,
    // Suivi bathymétrique en direct pendant le curage — voir startSimulation()/simulationTick().
    // Actif par défaut (comportement normal du curage : le relevé "en cours" se met à jour case
    // par case et devient le relevé "après travaux" en fin de chantier, voir finishSimulation) —
    // décochable si besoin, mais pas persisté d'une session à l'autre.
    liveDuringWork: true,
    _liveSurveyId: null,
  },
};

// ============================================================
// PARAMETERS
// ============================================================
let params = {
  seuilR: 300, seuilD: 280, nbDepas: 1, nbTours: 60, nbToursMax: 500,
  pwmDemR: 300, pwmDemD: 300, pwmMaxR: 1020, pwmMaxD: 500,
  pasNormR: 25, pasNormD: 25, pasRapR: 100, pasRapD: 100,
  pwmManLR: 400, pwmManLD: 400, pwmManRR: 1020, pwmManRD: 1020,
  miniCycles: 3, toursRedesc: 50, freqTrait: 100,
  waterDepth: 2.0, mudDepth: 0.3, pumpTime: 30,
  pumpDescentSpeed: 0.05, pumpAscentSpeed: 0.08,
  pumpFlow: 500, robotSpeed: 0.20, cellSize: 0.4,
  workMode: 'mini-cycles',   // standard | mini-cycles | double-pass | intensive
  // Objectif de curage — voir getCellBathyBaseline()/simulationTick : si un relevé bathymétrique
  // existe pour une case, le robot cible désormais sa profondeur RÉELLEMENT mesurée plutôt que la
  // profondeur globale uniforme ci-dessus (waterDepth/mudDepth, qui restent le repli pour les
  // cases sans donnée). 'integral' = retire toute la vase mesurée ; 'partiel' = n'en laisse que
  // curageResidualMud (m) d'épaisseur (ex. curage "à -20cm").
  curageMode: 'integral',    // integral | partiel
  curageResidualMud: 0.05,
  wifiType: 'ap', wifiSSID: 'WETAP-ESP8266',
  wifiPassword: '507317123456789', wifiIP: '192.168.42.1',
  elecTariff: 0.20,   // €/kWh — tarif estimé, modifiable dans l'onglet Énergie
  // Faisabilité solaire (onglet Énergie), modifiables
  solarHoursPerDay:    20,   // h de travail effectif estimées par jour — fonctionnement idéal visé
  solarPeakSunHours:    4,   // h crête exploitables par jour — remplacé par une estimation météo
                             // réelle (position + date de l'étang) dès que possible, voir
                             // fetchSolarPeakSunHours() ; valeur générique tant qu'aucune donnée
                             // n'a encore été récupérée ou si l'étang n'a pas de position GPS.
  solarPeakSunHoursAuto: true, // false dès que l'utilisateur modifie le champ à la main
  solarSystemEffPct:  75,    // % — pertes onduleur/régulateur/câblage/batterie cumulées
};

// ============================================================
// WORK MODES
// ============================================================
const WORK_MODES = {
  standard: {
    label: 'Standard — 1 pompage / case',
    icon: '○',
    color: '#0ea5e9',
    desc: 'Une descente dans la vase, un pompage, case suivante. Rapide, pour couche fine < 15 cm.',
  },
  'mini-cycles': {
    label: 'Mini-cycles — N pompages / case',
    icon: '◎',
    color: '#10b981',
    desc: 'N descentes par case avec remontée partielle entre chaque. Idéal pour vase de 15–40 cm.',
  },
  'double-pass': {
    label: 'Double passage — 2 passes complètes',
    icon: '⟳',
    color: '#f59e0b',
    desc: 'Parcourt toute la sélection deux fois (1 pompage/case/passe). Pour vase épaisse ou résistante > 30 cm.',
  },
  intensive: {
    label: 'Intensif — Mini-cycles × double passage',
    icon: '⚡',
    color: '#ef4444',
    desc: 'Combine mini-cycles et 2 passes complètes. Pour vase compactée ou très épaisse > 50 cm.',
  },
};

// ---- Volume helpers ----
function effectiveMiniCycles() {
  return (params.workMode === 'standard') ? 1 : params.miniCycles;
}
function passes() {
  return (params.workMode === 'double-pass' || params.workMode === 'intensive') ? 2 : 1;
}
function volumePerCell() {
  // Litres pompés par case
  return (params.pumpFlow / 60) * params.pumpTime * effectiveMiniCycles();
}
function totalVolumeForCells(n) { return volumePerCell() * n; }
function mudVolumeForCells(n)   { return n * params.cellSize * params.cellSize * params.mudDepth; } // m³

// ============================================================
// UTILS
// ============================================================
function dist(ax, ay, bx, by) { return Math.sqrt((bx-ax)**2 + (by-ay)**2); }

// ============================================================
// PROPULSION — répartition de poussée sur les 4 propulseurs en X
// ============================================================
// vx,vy : vecteur de déplacement souhaité (repère monde) ; headingDeg : cap robot (0=Nord)
// Retourne [AV-G, AV-D, AR-G, AR-D] en % (-100..100).
function computeThrustAllocation(vx, vy, headingDeg) {
  if (!vx && !vy) return [0, 0, 0, 0];
  const mag = Math.min(1, Math.hypot(vx, vy));
  const travelBearing = Math.atan2(vx, vy);
  const rel = travelBearing - (headingDeg || 0) * Math.PI / 180;
  const surge = Math.cos(rel) * mag; // avant/arrière (repère robot)
  const sway  = Math.sin(rel) * mag; // gauche/droite (repère robot)
  const k = Math.SQRT1_2;
  return [
    (surge - sway) * k, // AV-G
    (surge + sway) * k, // AV-D
    (surge + sway) * k, // AR-G
    (surge - sway) * k, // AR-D
  ].map(v => Math.round(v * 100));
}

function latLngToMeters(lat, lng, lat0, lng0) {
  return {
    x: (lng - lng0) * Math.cos((lat0 * Math.PI) / 180) * 111320,
    y: (lat - lat0) * 110540,
  };
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj-xi)*(py-yi))/(yj-yi)+xi) inside = !inside;
  }
  return inside;
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length-1; i < poly.length; j = i++)
    a += (poly[j].x+poly[i].x) * (poly[j].y-poly[i].y);
  return Math.abs(a/2);
}

// Bbox d'un étang — recalculée depuis son polygone si le champ stocké est absent ou
// incomplet (étang enregistré avant l'ajout de ce champ). Ne jamais laisser une bbox
// manquante planter fitPond()/planPath()/les vignettes de la liste des étangs.
function getPondBbox(pond) {
  const b = pond.bbox;
  if (b && b.minX !== undefined && b.maxX !== undefined && b.minY !== undefined && b.maxY !== undefined) return b;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pond.polygon) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
}

// Point le plus proche de (px,py) sur le contour du polygone (la berge) — utilisé pour
// contraindre l'ancre du tuyau à toujours rester physiquement sur le bord de l'étang.
function nearestPointOnPolygon(poly, px, py) {
  let best = null, bestDist = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i+1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx*dx + dy*dy;
    let t = len2 > 0 ? ((px-a.x)*dx + (py-a.y)*dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + t*dx, qy = a.y + t*dy;
    const d = Math.hypot(px-qx, py-qy);
    if (d < bestDist) { bestDist = d; best = { x: qx, y: qy }; }
  }
  return best || { x: px, y: py };
}

// Longueur de tuyau requise pour couvrir tout l'étang (case la plus éloignée), mise en cache
// par updateHoseLengthDisplay() — ne dépend que de l'ancre/des cases, jamais de la position du
// robot, donc pas besoin de la recalculer (coûteux, O(cases)) à chaque frame de rendu.
let _hoseRequiredLenCache = 0;

// Points d'une courbe légèrement sinueuse entre l'ancre (berge) et le robot — un tuyau qui
// flotte ne file jamais droit, il ondule doucement ; l'amplitude retombe à zéro aux deux
// bouts (sin(πt)) pour que la courbe reste toujours accrochée exactement à l'ancre et au robot.
//
// Si targetLen est fourni (longueur physique totale du tuyau déployé — la longueur nécessaire
// pour atteindre la case la plus éloignée), la courbe ondule davantage pour que sa longueur
// réelle approche targetLen même quand le robot est près de l'ancre : un tuyau déjà déroulé sur
// toute sa longueur ne se raccourcit pas quand le robot s'approche du bord, il forme du mou.
function computeHoseCurvePoints(anchor, robot, segments = 24, targetLen = null) {
  const dx = robot.x - anchor.x, dy = robot.y - anchor.y;
  const L  = Math.hypot(dx, dy) || 0.001;
  const ux = dx / L, uy = dy / L;   // direction
  const nx = -uy, ny = ux;          // perpendiculaire

  const slackRatio = targetLen ? Math.max(0, (targetLen - L) / L) : 0;
  const freqScale = 1 + Math.min(slackRatio, 8);
  const segs = slackRatio > 0.15 ? Math.min(Math.round(segments * (1 + Math.min(slackRatio, 8))), 160) : segments;

  const buildPoints = (amp) => {
    const out = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const win  = Math.sin(Math.PI * t);
      const wave = win * (Math.sin(t * 5.3 * freqScale + L * 0.7) * amp + Math.sin(t * 2.1 * freqScale + L * 0.3) * amp * 0.4);
      out.push({ x: anchor.x + dx * t + nx * wave, y: anchor.y + dy * t + ny * wave });
    }
    return out;
  };
  const pointsLen = (pts) => {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y);
    return len;
  };

  let amp = Math.min(L * 0.12, 1.5);
  if (slackRatio > 0) {
    // Recherche par dichotomie de l'amplitude d'ondulation qui donne une longueur de courbe
    // ≈ targetLen ; si même l'amplitude plafond n'y suffit pas (mou très important), on s'y
    // tient plutôt que de faire onduler le tuyau de façon irréaliste. Le plafond suit la
    // longueur totale visée (donc l'échelle de l'étang), pas la distance actuelle au robot —
    // c'est justement quand le robot est proche de l'ancre (distance actuelle minime) qu'il
    // faut le plus de mou pour représenter la longueur déployée.
    const ampCap = Math.min(Math.max(targetLen * 0.2, L * 0.9 + 2), 15);
    if (pointsLen(buildPoints(ampCap)) < targetLen) {
      amp = ampCap;
    } else {
      let lo = 0, hi = ampCap;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (pointsLen(buildPoints(mid)) < targetLen) lo = mid; else hi = mid;
      }
      amp = (lo + hi) / 2;
    }
  }
  return buildPoints(amp);
}

// Longueur réelle de la courbe (pas la distance à vol d'oiseau) entre deux points —
// la longueur physique de tuyau nécessaire suit les ondulations, pas une ligne droite.
function _hoseCurveLength(anchor, target) {
  const pts = computeHoseCurvePoints(anchor, target);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y);
  return len;
}

// Longueur de tuyau flottant nécessaire pour que le robot puisse atteindre n'importe quelle
// case de l'étang depuis le point de sortie actuel sur la berge (hoseAnchor) — le pire cas,
// donc la case la plus éloignée. Se recalcule à chaque déplacement de l'ancre.
function computeRequiredHoseLength(pond) {
  if (!pond?.hoseAnchor || !pond.cells?.length) return 0;
  let maxLen = 0;
  for (const cell of pond.cells) {
    const len = _hoseCurveLength(pond.hoseAnchor, { x: cell.cx, y: cell.cy });
    if (len > maxLen) maxLen = len;
  }
  return maxLen;
}

// Recalcule et affiche la longueur de tuyau nécessaire partout où elle apparaît — appelé
// au chargement de l'étang et chaque fois que l'ancre (ou la zone de dépôt, qui la
// recalcule) bouge, jamais à chaque tick (coût O(cases), inutile de le refaire en continu).
// Affichée dans le mini-widget du tableau de bord, le popover Progression, et — par étang —
// dans la fiche de l'onglet Étangs (updatePondsList()).
function updateHoseLengthDisplay() {
  const dashBadge = document.getElementById('dashHoseLengthBadge');
  const dashStat  = document.getElementById('dashHoseLengthNeeded');
  if (!state.pond) {
    _hoseRequiredLenCache = 0;
    if (dashBadge) dashBadge.textContent = '—';
    if (dashStat)  dashStat.textContent  = '—';
    return;
  }
  const lenM = computeRequiredHoseLength(state.pond);
  _hoseRequiredLenCache = lenM;
  const txt = lenM > 0 ? `${Math.ceil(lenM)} m` : '—';
  if (dashBadge) dashBadge.textContent = lenM > 0 ? Math.ceil(lenM) : '—';
  if (dashStat)  dashStat.textContent  = txt;
}

function formatTime(sec) {
  const s = Math.floor(Math.abs(sec));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const hms = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return days > 0 ? `${days}j ${hms}` : hms;
}

function formatVolume(l) {
  return l >= 1000 ? `${(l/1000).toFixed(2)} m³` : `${Math.round(l)} L`;
}

// Pompé/total avec la même unité pour les deux valeurs — comparer "1 250 L" à
// "4.80 m³" au premier coup d'œil est trompeur, on choisit l'unité selon le total.
function formatVolumePair(pumped, total) {
  if (total >= 1000) return `${(pumped/1000).toFixed(2)} / ${(total/1000).toFixed(2)} m³`;
  return `${Math.round(pumped)} / ${Math.round(total)} L`;
}

function setText(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

// ============================================================
// THEME (clair/sombre)
// ============================================================
function applyThemeIcon() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  setText('themeIcon', isLight ? '☀️' : '🌙');
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('aquabot_theme', next);
  applyThemeIcon();
}

// ============================================================
// KML PARSER
// ============================================================
function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Fichier KML invalide');

  let coordEl = doc.querySelector('coordinates');
  if (!coordEl) throw new Error('Aucune coordonnée trouvée dans le KML');

  const coords = [];
  for (const token of coordEl.textContent.trim().split(/\s+/)) {
    const p = token.split(',');
    if (p.length >= 2) {
      const lng = parseFloat(p[0]), lat = parseFloat(p[1]);
      if (!isNaN(lat) && !isNaN(lng)) coords.push({ lat, lng });
    }
  }
  if (coords.length < 3) throw new Error('Polygone trop petit (< 3 points)');

  const nameEl = doc.querySelector('name');
  const name = nameEl?.textContent.trim() || 'Étang';

  const origin = coords[0];
  const polygon = coords.map(c => latLngToMeters(c.lat, c.lng, origin.lat, origin.lng));
  const first = polygon[0], last = polygon[polygon.length-1];
  if (dist(first.x, first.y, last.x, last.y) > 0.1) polygon.push({ ...first });

  return { name, polygon, origin };
}

// ============================================================
// GRID
// ============================================================
function generateGrid(polygon) {
  const cs = params.cellSize;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX,p.x); maxX = Math.max(maxX,p.x);
    minY = Math.min(minY,p.y); maxY = Math.max(maxY,p.y);
  }
  const cells = [];
  const cols = Math.ceil((maxX-minX)/cs), rows = Math.ceil((maxY-minY)/cs);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = minX + col*cs + cs/2;
      const cy = minY + row*cs + cs/2;
      if (pointInPolygon(cx, cy, polygon))
        cells.push({ col, row, cx, cy, selected: true, completed: false });
    }
  }
  return cells;
}

// ============================================================
// PATH PLANNER — boustrophedon, orienté pour ne jamais enrouler le tuyau
// ============================================================
// Le tuyau relie une ancre fixe (berge) au robot. Pour qu'il ne s'enroule/emmêle jamais,
// le balayage en lignes doit avancer en s'éloignant progressivement de l'ancre, sans jamais
// revenir en arrière : on choisit donc l'axe de balayage (rangées ou colonnes) selon que
// l'ancre est plutôt sur un bord haut/bas ou gauche/droite de l'étang, puis on ordonne les
// lignes de la plus proche de l'ancre à la plus lointaine.
function planPath(cells) {
  const selected = cells.filter(c => c.selected && !c.completed);
  if (!selected.length) return [];

  const anchor = state.pond?.hoseAnchor;
  let useCols = false;
  if (anchor && state.pond?.bbox) {
    const { minX, maxX, minY, maxY } = state.pond.bbox;
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
    const edgeDistX = Math.min(anchor.x - minX, maxX - anchor.x) / spanX;
    const edgeDistY = Math.min(anchor.y - minY, maxY - anchor.y) / spanY;
    useCols = edgeDistX < edgeDistY; // ancre proche d'un bord gauche/droit → balayer par colonnes
  }
  const groupKey = useCols ? 'col' : 'row';
  const sweepKey = useCols ? 'row' : 'col';

  const byGroup = {};
  for (const c of selected) {
    if (!byGroup[c[groupKey]]) byGroup[c[groupKey]] = [];
    byGroup[c[groupKey]].push(c);
  }

  let groupIdxs = Object.keys(byGroup).map(Number);
  if (anchor && state.pond?.bbox) {
    const cs = params.cellSize;
    const { minX, minY } = state.pond.bbox;
    const anchorGroupCoord = useCols ? (anchor.x - minX) / cs : (anchor.y - minY) / cs;
    groupIdxs.sort((a,b) => Math.abs(a - anchorGroupCoord) - Math.abs(b - anchorGroupCoord));
  } else {
    groupIdxs.sort((a,b) => a-b);
  }

  const path = [];
  let forward = true;
  for (const idx of groupIdxs) {
    const group = byGroup[idx].sort((a,b) => forward ? a[sweepKey]-b[sweepKey] : b[sweepKey]-a[sweepKey]);
    path.push(...group.map(c => cells.indexOf(c)));
    forward = !forward;
  }
  return path.filter(i => i !== -1);
}

// ============================================================
// POND MANAGEMENT
// ============================================================
function createPondFromKML({ name, polygon, origin }) {
  const area = polygonArea(polygon);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX,p.x); maxX = Math.max(maxX,p.x);
    minY = Math.min(minY,p.y); maxY = Math.max(maxY,p.y);
  }
  const cells = generateGrid(polygon);
  return {
    id: Date.now().toString(), name, origin, polygon, area, cells,
    work: { completedCells: [], volumePumped: 0, elapsedSec: 0, energyWh: 0 },
    selections: [],
    lastUsed: Date.now(),
    bbox: { minX, maxX, minY, maxY },
    // Point d'entrée par défaut du tuyau d'évacuation (berge la plus proche du bord gauche) —
    // à ajuster ensuite à la main vers l'emplacement réel.
    hoseAnchor: nearestPointOnPolygon(polygon, minX, (minY + maxY) / 2),
  };
}

function loadPond(pond) {
  state.pond = pond;
  // Reprise défensive : un étang enregistré avant l'ajout de ces champs peut ne pas avoir
  // de bbox valide — on la recalcule depuis le polygone pour ne jamais laisser fitPond(),
  // planPath() ou le tuyau silencieusement casser/disparaître sur un vieil étang.
  try {
    pond.bbox = getPondBbox(pond);
    if (!pond.hoseAnchor) {
      const { minX, minY, maxY } = pond.bbox;
      pond.hoseAnchor = nearestPointOnPolygon(pond.polygon, minX, (minY + maxY) / 2);
    }
  } catch (e) { console.warn('bbox/hoseAnchor backfill:', e.message); }
  state.cells = pond.cells.map(c => ({ ...c }));

  // Restore completed cells
  for (const idx of (pond.work.completedCells || [])) {
    if (state.cells[idx]) state.cells[idx].completed = true;
  }

  state.robot.completedCells = pond.work.completedCells?.length || 0;
  state.robot.volumePumped   = pond.work.volumePumped  || 0;
  state.robot.energyWh       = pond.work.energyWh      || 0;
  state.robot.elapsedSec     = pond.work.elapsedSec    || 0;
  state.plannedPath = [];
  // « Partie en cours » : repart de zéro à chaque (ré)ouverture de cet étang, distincte du
  // cumul persistant ci-dessus qui, lui, ne se remet à zéro qu'au RAZ.
  state.sim.sessionEnergyBaselineWh   = state.robot.energyWh;
  state.sim.sessionElapsedBaselineSec = state.robot.elapsedSec;

  // Un nouvel étang mérite une nouvelle estimation météo (position différente) même si
  // l'ensoleillement avait été modifié à la main pour l'étang précédent.
  params.solarPeakSunHoursAuto = true;
  refreshSolarIrradianceForPond();

  subscribeSimState(pond.id);
  checkAndResumeSim(pond.id);
  if (state.robotMode === 'real') subscribeRobotTelemetry(pond.id);
  if (_satModeDash && _leafletMapDash) updateLeafletOverlayDash();
  resizeSectionCanvas();
  requestAnimationFrame(() => fitPond());
  renderSectionCanvas();
  updateUI();
  updateButtonStates();
  updatePondsList();
  renderSelectionHistory();

  const pName = pond.name;
  setText('currentPondName', pName);
  setText('dashPondBadge', pName);

  // Show pond-specific elements
  document.getElementById('dashCanvasEmptyState').style.display = 'none';
  ['btnSelectAll','btnSelectRemaining','btnDeselectAll','btnPlanRoute'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = false;
  });

  setMode('select');
  updateHoseLengthDisplay();

  // Les relevés bathymétriques sont propres à chaque étang — repartir de la dernière sélection
  // de cet étang plutôt que de garder celle de l'étang précédemment ouvert.
  state.bathy.selectedSurveyId = null;
  state.bathy.compareBeforeId  = null;
  state.bathy.compareAfterId   = null;
  if (state.activeTab === 'bathymetry') renderBathyTab();

  showToast(`Étang "${pName}" chargé — ${state.cells.length} cases`, 'success');
}

// ============================================================
// WORK PERSISTENCE
// ============================================================
function saveWork() {
  if (!state.pond) return;
  const completedIdxs = state.cells
    .map((c, i) => c.completed ? i : -1)
    .filter(i => i !== -1);
  state.pond.work = {
    completedCells: completedIdxs,
    volumePumped: state.robot.volumePumped,
    elapsedSec: state.robot.elapsedSec,
    energyWh: state.robot.energyWh,
  };
  // Persist cell completion state into pond.cells
  state.pond.cells = state.cells.map(c => ({ ...c }));
  state.pond.lastUsed = Date.now();
  const idx = state.ponds.findIndex(p => p.id === state.pond.id);
  if (idx !== -1) state.ponds[idx] = state.pond;
  savePonds();
}

function resetWork(pondId) {
  if (!confirm('Remettre à zéro toute la progression de cet étang ?\nCette action est irréversible.')) return;
  const pond = state.ponds.find(p => p.id === pondId);
  if (!pond) return;

  // Arrêter la simulation locale en premier pour éviter que saveWork() réécrive les données
  if (state.sim.running && state.pond?.id === pondId) {
    state.sim.running = false;
    clearInterval(state.sim.intervalId);
    state.sim.intervalId = null;
    state.robot.state = 'stopped';
  }

  pond.work = { completedCells: [], volumePumped: 0, elapsedSec: 0, energyWh: 0 };
  pond.cells?.forEach(c => { c.completed = false; });
  pond.lastResetAt = Date.now();
  pond.lastUsed    = Date.now();

  if (state.pond?.id === pondId) {
    state.pond.lastResetAt = pond.lastResetAt;
    state.pond.work        = pond.work;
    state.cells.forEach(c => { c.completed = false; });
    state.robot.completedCells = 0;
    state.robot.volumePumped   = 0;
    state.robot.energyWh       = 0;
    state.robot.elapsedSec     = 0;
    state.sim.sessionEnergyBaselineWh   = 0;
    state.sim.sessionElapsedBaselineSec = 0;
    state.plannedPath = [];
    renderAllPondCanvases();
    updateUI();
    updateButtonStates();
  }

  // Persiste la progression dans aquabot_ponds
  savePonds();

  // Réinitialise aussi aquabot_sim pour éviter que subscribeSimState restaure l'ancienne progression
  if (USE_CLOUD) {
    window.db.collection('aquabot_sim').doc(pondId).set({
      robotState:     'stopped',
      simRunning:     false,
      completedCells: [],
      volumePumped:   0,
      energyWh:       0,
      elapsedSec:     0,
      pumpDepth:      0,
      pumpState:      'idle',
      miniCyclesDone: 0,
      currentCellIdx: 0,
      plannedPath:    [],
      lastUpdate:     Date.now(),
    }).catch(e => reportFirestoreError(e, 'resetWork sim'));
  }

  if (_satModeDash && _leafletMapDash) { _rebuildPathLayerDash(); _rebuildDynamicLayersDash(); _rebuildCellLayersDash(); }
  updatePondsList();
  showToast('Progression remise à zéro', 'success');
}

// ============================================================
// BATHYMÉTRIE — relevé de profondeur simulé (eau + vase), case par case
// ============================================================
// Pas de sonde réelle branchée pour l'instant (voir arduino/aquabot_esp32/aquabot_esp32.ino,
// mécanisme bathyTick() côté firmware) : les profondeurs sont générées ici par un modèle de
// bruit spatialement cohérent (même principe qu'un terrain procédural), pas mesurées. Chaque
// étang a un "terrain" reproductible (dérivé de pond.id) pour que deux relevés "avant travaux"
// du même étang donnent des valeurs cohérentes entre elles.

const BATHY_SCAN_TICK_MS = 130;

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
// Hash déterministe → pseudo-aléatoire [0,1), pas de dépendance d'état (contrairement à un PRNG
// classique) : reproductible à l'identique pour une même case/seed, quel que soit l'ordre d'appel.
function pseudoRandom01(a, b, seed) {
  const x = Math.sin(a * 127.1 + b * 311.7 + seed * 0.0001 + 1) * 43758.5453;
  return x - Math.floor(x);
}
// Bruit lissé (somme de sinusoïdes déphasées par seed) → relief "naturel" par case plutôt que du
// bruit blanc case à case, qui ne ressemblerait à aucune bathymétrie réelle.
function bathyTerrainNoise(x, y, seed) {
  const p = (seed % 997) * 0.01;
  return Math.sin(x * 0.18 + p * 3.1) * Math.cos(y * 0.14 + p * 1.7) * 0.6
       + Math.sin(x * 0.35 - y * 0.28 + p * 5.3) * 0.25
       + Math.sin(x * 0.8  + y * 0.55 + p * 2.2) * 0.15;
}
function pondBathySeed(pond) { return hashStr(pond?.id || '0'); }

function round3(v) { return Math.round(v * 1000) / 1000; }

// Fond réel bruité (bosses/creux locaux) — indépendant de la répartition eau/vase, voir
// generateBathyBaseReading et computeBathyFloodLevel ci-dessous.
function bathyTerrainTotalDepth(cell, seed) {
  const nFloor  = bathyTerrainNoise(cell.cx, cell.cy, seed + 11);
  const jitterF = (pseudoRandom01(cell.col, cell.row, seed + 5) - 0.5) * 0.05;
  const nominalTotal = params.waterDepth + params.mudDepth;
  return Math.max(0.25, nominalTotal + nFloor * nominalTotal * 0.3 + jitterF);
}
// La vase ne suit PAS les aspérités du fond avec une épaisseur constante : elle comble d'abord les
// creux les plus profonds du fond réel, jusqu'à un niveau commun (mudLevel, une profondeur depuis
// la surface) — sur les hauts-fonds où le fond réel est moins profond que ce niveau, il n'y a pas
// de vase (roche à nu) et le fond réel affleure directement. La surface de la vase (donc la
// profondeur d'eau) est ainsi plate là où il y a de la vase, et ne suit le fond réel que là où
// celui-ci dépasse le niveau — cohérent avec la façon dont un sédiment se dépose et se stabilise
// dans un bassin irrégulier, plutôt qu'une couche d'épaisseur uniforme plaquée sur le relief.
function bathySplitAtLevel(total, level) {
  const MIN_MUD = 0.02, MIN_WATER = 0.05;
  let water = Math.min(total, level);
  let mud = total - water;
  if (mud < MIN_MUD) { mud = MIN_MUD; water = total - mud; }
  if (water < MIN_WATER) { water = MIN_WATER; mud = total - water; }
  return { water: round3(water), mud: round3(mud) };
}
// Recherche par bissection du niveau de nivellement (mudLevel) tel que la vase moyenne obtenue en
// comblant chaque profondeur totale jusqu'à ce niveau corresponde à targetMeanMud — la fonction
// (niveau → vase moyenne) est strictement décroissante, donc la bissection converge toujours.
function computeBathyFloodLevel(totals, targetMeanMud) {
  const valid = totals.filter(t => t != null);
  if (!valid.length) return 0;
  const minTotal = Math.min(...valid), maxTotal = Math.max(...valid);
  let lo = minTotal - (maxTotal - minTotal) - Math.max(targetMeanMud, 1) * 4 - 1;
  let hi = maxTotal;
  const meanMudForLevel = L => valid.reduce((s, t) => s + Math.max(0, t - L), 0) / valid.length;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (meanMudForLevel(mid) > targetMeanMud) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
// mudLevel est précalculé une fois par relevé (voir startBathySurvey) sur l'ensemble des cases
// balayées, pour que la vase moyenne simulée corresponde à params.mudDepth. Repli sans mudLevel
// (appel isolé, hors balayage) : niveau naïf donnant une vase proche de params.mudDepth sans forme
// de nivellement.
function generateBathyBaseReading(cell, seed, mudLevel) {
  const totalDepth = bathyTerrainTotalDepth(cell, seed);
  const level = mudLevel != null ? mudLevel : totalDepth - params.mudDepth;
  return bathySplitAtLevel(totalDepth, level);
}
// Relevé "après travaux" : cases traitées → résidu de vase faible (3-9%), profondeur d'eau
// augmentée d'autant (la vase retirée devient de l'eau) ; cases non traitées → inchangées.
function generateBathyAfterReading(beforeReading, cell, treated, seed) {
  if (!treated) return { ...beforeReading };
  const residualFrac = 0.03 + pseudoRandom01(cell.col, cell.row, seed + 201) * 0.06;
  const residualMud  = round3(beforeReading.mud * residualFrac);
  const water        = round3(beforeReading.water + (beforeReading.mud - residualMud));
  return { water, mud: residualMud };
}

// Passage effectif de la machine sur une zone : retire une épaisseur de vase ABSOLUE (pas un
// pourcentage) — une case à 10cm de vase et une case à 80cm perdent toutes les deux ~reductionAvg
// m, comme un outil qui racle une épaisseur donnée plutôt qu'une proportion. Un tout petit fond
// résiduel est toujours conservé (jamais totalement à sec), comme en réalité.
function generateBathyAfterReadingAbsolute(beforeReading, cell, reductionAvg, seed) {
  const jitter = (pseudoRandom01(cell.col, cell.row, seed + 401) - 0.5) * 0.1; // ± 5 cm autour de la moyenne visée
  const reduction = Math.max(0, reductionAvg + jitter);
  const MIN_MUD = 0.02;
  const residual = Math.max(MIN_MUD, round3(beforeReading.mud * 0.06));
  const mud = Math.max(residual, round3(beforeReading.mud - reduction));
  const water = round3(beforeReading.water + (beforeReading.mud - mud));
  return { water, mud: round3(mud) };
}

// Génère INSTANTANÉMENT (sans balayage animé) un relevé "après travaux" simulé, à partir du
// dernier relevé "avant travaux" de l'étang — pratique pour visualiser rapidement l'effet attendu
// sans relancer un vrai relevé qui prendrait plusieurs minutes case par case.
// scope='zone' : seules les cases déjà nettoyées par le robot dans le chantier en cours
// (cell.completed) sont retravaillées, avec une réduction ABSOLUE de vase (reductionAvg) ; le
// reste de l'étang reste identique au relevé "avant travaux".
// scope='pond'  : la totalité de l'étang est considérée terminée (même modèle que le relevé
// "après travaux" animé existant — résidu de vase variable par endroit, jamais parfaitement à sec).
function generateQuickBathyAfterSurvey(scope, reductionAvg) {
  const pond = state.pond;
  if (!pond) { showToast('Aucun étang chargé', 'error'); return; }
  const before = latestBathySurvey(pond, 'before');
  if (!before) { showToast('Aucun relevé "avant travaux" pour cet étang', 'error'); return; }
  if (scope === 'zone' && !state.cells.some(c => c.completed)) {
    showToast('Aucune case marquée comme nettoyée pour l’instant', 'error');
    return;
  }

  const seed = pondBathySeed(pond);
  const readings = new Array(state.cells.length).fill(null);
  let treatedCount = 0;
  state.cells.forEach((cell, i) => {
    const beforeReading = before.readings[i];
    if (!beforeReading) return;
    const treat = scope === 'pond' || (scope === 'zone' && cell.completed);
    if (!treat) { readings[i] = { ...beforeReading }; return; }
    readings[i] = scope === 'zone'
      ? generateBathyAfterReadingAbsolute(beforeReading, cell, reductionAvg, seed)
      : generateBathyAfterReading(beforeReading, cell, true, seed);
    treatedCount++;
  });

  const dateStr = new Date().toLocaleDateString('fr-FR');
  const label = scope === 'zone'
    ? `Après travaux — zone en cours — ${dateStr}`
    : `Après travaux — étang complet — ${dateStr}`;
  const survey = { id: Date.now().toString(), type: 'after', label, date: Date.now(), readings };
  if (!pond.bathySurveys) pond.bathySurveys = [];
  pond.bathySurveys.push(survey);
  state.bathy.selectedSurveyId = survey.id;
  state.bathy.compareBeforeId  = before.id;
  state.bathy.compareAfterId   = survey.id;
  persistPondSurveys();
  renderBathyTab();
  showToast(`"${label}" généré — ${treatedCount} case(s) traitée(s)`, 'success');
}
function quickBathyAfterZone() {
  const input = prompt(
    'Épaisseur moyenne de vase retirée par le passage de la machine sur la zone déjà traitée (en m) ?\n\nUn tout petit fond résiduel sera toujours conservé, comme en réalité. Le reste de l’étang (zone non encore traitée) reste inchangé.',
    '0.45'
  );
  if (input == null) return;
  const reductionAvg = parseFloat(String(input).replace(',', '.'));
  if (!isFinite(reductionAvg) || reductionAvg < 0) { showToast('Valeur invalide', 'error'); return; }
  generateQuickBathyAfterSurvey('zone', reductionAvg);
}
function quickBathyAfterPond() {
  generateQuickBathyAfterSurvey('pond');
}

function latestBathySurvey(pond, type) {
  const list = (pond?.bathySurveys || []).filter(s => s.type === type);
  return list.length ? list[list.length - 1] : null;
}
// Profondeur eau/vase de référence pour une case donnée, utilisée par le robot pour adapter sa
// cible de curage à la vase réellement présente (voir simulationTick) : le relevé bathymétrique
// le plus RÉCENT (toutes types confondus — avant/contrôle/après/en direct), s'il couvre cette
// case ; à défaut (aucun relevé, ou case non couverte par le plus récent), repli sur la
// profondeur globale uniforme des paramètres — comportement inchangé pour un étang sans
// bathymétrie.
function getCellBathyBaseline(cellIdx) {
  // Le relevé "en direct" (voir startLiveBathySurveyIfEnabled) est une bathymétrie UNIQUE qui
  // évolue au fil des chantiers successifs, pas un instantané isolé du chantier en cours — il doit
  // donc bien participer normalement à "le plus récent", y compris pour une case déjà nettoyée
  // lors d'un chantier précédent (sa vase déjà réduite EST la vraie référence actuelle, pas la
  // valeur d'avant-travaux d'origine).
  const surveys = state.pond?.bathySurveys || [];
  if (surveys.length) {
    const latest = surveys.reduce((a, b) => (b.date > a.date ? b : a));
    const r = latest.readings[cellIdx];
    if (r) return { water: r.water, mud: r.mud };
  }
  return { water: params.waterDepth, mud: params.mudDepth };
}
// Profondeur de la case en cours de travail, pour l'AFFICHAGE (coupe verticale) — recalculée à la
// demande plutôt que lue depuis robot._cellBaseline, qui n'est qu'un cache local à l'appareil
// PILOTANT la simulation (jamais synchronisé via saveSimState/télémétrie) : un appareil simple
// spectateur (voir subscribeSimState), ou ce même appareil après un rechargement de page en plein
// cycle, ne l'aurait sinon jamais et retombait à tort sur les valeurs génériques des paramètres.
function currentWorkingCellBaseline() {
  const path = state.plannedPath, idx = state.robot.currentCellIdx;
  if (state.robot.pumpState !== 'idle' && path && idx < path.length) {
    return getCellBathyBaseline(path[idx]);
  }
  return { water: params.waterDepth, mud: params.mudDepth };
}
// Résultat physique du nettoyage d'une case selon l'objectif de curage courant (params.curageMode)
// — utilisé à la fois pour fixer la profondeur cible du robot (voir simulationTick) et, si le
// suivi bathymétrique en direct est actif, pour enregistrer une lecture réaliste après coup
// (voir _recordLiveBathyReading). La profondeur totale (eau + vase) ne change jamais — seule sa
// répartition eau/vase est modifiée, exactement comme pour un curage réel.
function computeCleaningResult(baseline) {
  const total = baseline.water + baseline.mud;
  const MIN_MUD = 0.02;
  let mud = params.curageMode === 'partiel'
    // Ne peut pas laisser plus de vase qu'il n'y en avait déjà (rien à retirer dans ce cas).
    ? Math.min(baseline.mud, params.curageResidualMud)
    // Curage intégral : petit fond résiduel réaliste, un curage parfait à 0 n'existe pas.
    : Math.max(MIN_MUD, round3(baseline.mud * 0.05));
  mud = Math.min(mud, baseline.mud);
  const water = round3(total - mud);
  return { water, mud: round3(mud) };
}

// Coche/décoche le suivi bathymétrique en direct — pris en compte au PROCHAIN démarrage
// (startLiveBathySurveyIfEnabled), pas rétroactivement sur un travail déjà en cours.
function setBathyLiveDuringWork(checked) {
  state.bathy.liveDuringWork = !!checked;
}

// Bathymétrie "en direct" : une UNIQUE bathymétrie par étang, qui évolue case par case au fil des
// chantiers successifs (voir _recordLiveBathyReading) si l'utilisateur a coché le suivi en direct
// — pas un nouveau relevé à chaque "Démarrer" (voir startSimulation). Les bathymétries manuelles
// (relevé "avant travaux", contrôle, génération rapide) restent des instantanés distincts, propres
// à l'historique ; celle-ci est la seule qui se met à jour en continu et s'affiche comme la
// dernière bathymétrie de l'étang.
function startLiveBathySurveyIfEnabled() {
  if (!state.bathy.liveDuringWork || !state.pond) { state.bathy._liveSurveyId = null; return; }
  const existing = state.pond.bathySurveys?.find(s => s.type === 'live');
  if (existing) {
    // Déjà une bathymétrie en direct pour cet étang (d'un chantier précédent) : on continue de
    // l'alimenter, pas de nouvelle copie.
    state.bathy._liveSurveyId    = existing.id;
    state.bathy.selectedSurveyId = existing.id;
    existing.date  = Date.now();
    existing.label = bathyTypeLabel('live');
    persistPondSurveys();
    return;
  }
  // Toute première bathymétrie en direct pour cet étang : partie d'une COPIE du relevé le plus
  // récent existant, pas d'un tableau vide — sur un petit chantier ne couvrant qu'une poignée de
  // cases, un relevé vide ne contenait ensuite que ces quelques cases, tout le reste de l'étang
  // restant à null, et l'aperçu bathymétrique (qui affiche le DERNIER relevé) se retrouvait quasi
  // vide dès la création, avant même la moindre case nettoyée.
  const latest = state.pond.bathySurveys?.length
    ? state.pond.bathySurveys.reduce((a, b) => (b.date > a.date ? b : a))
    : null;
  const survey = {
    id: Date.now().toString(),
    type: 'live',
    label: bathyTypeLabel('live'),
    date: Date.now(),
    readings: state.cells.map((c, i) => (latest?.readings[i] ? { ...latest.readings[i] } : null)),
  };
  if (!state.pond.bathySurveys) state.pond.bathySurveys = [];
  state.pond.bathySurveys.push(survey);
  state.bathy._liveSurveyId   = survey.id;
  state.bathy.selectedSurveyId = survey.id;
  persistPondSurveys();
}

// Enregistre le résultat du nettoyage d'une case dans le relevé en direct, s'il y en a un —
// appelé par simulationTick() juste après qu'une case soit marquée terminée. Ne persiste pas à
// chaque case (trop coûteux en écritures Firestore) : réutilise le même rythme que la sauvegarde
// périodique de la progression (voir simulationTick, robot.completedCells % 10).
function _recordLiveBathyReading(cellIdx, result) {
  if (!state.bathy._liveSurveyId || !state.pond) return;
  const survey = state.pond.bathySurveys?.find(s => s.id === state.bathy._liveSurveyId);
  if (!survey) { state.bathy._liveSurveyId = null; return; }
  survey.readings[cellIdx] = result;
  // Invalide le cache du fond 3D tableau de bord (voir renderDash3DBackdropCached) dès qu'une case
  // vient d'être relevée, pour que la progression reste visible sans attendre le filet de sécurité.
  state.bathy._liveRevision = (state.bathy._liveRevision || 0) + 1;
  if (state.activeTab === 'bathymetry') { renderBathyCanvas(); updateBathyLegend(); }
}
function bathyTypeLabel(type) {
  const d = new Date();
  const dateStr = d.toLocaleDateString('fr-FR');
  if (type === 'before') return `Avant travaux — ${dateStr}`;
  if (type === 'after')  return `Après travaux — ${dateStr}`;
  if (type === 'live')   return `Suivi en direct — ${dateStr} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  return `Contrôle — ${dateStr} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}
function formatVolM3(m3) { return m3 >= 1 ? m3.toFixed(2) + ' m³' : (m3 * 1000).toFixed(0) + ' L'; }

function persistPondSurveys() {
  // state.pond.cells n'est normalement resynchronisé depuis state.cells que par saveWork() —
  // sans cette ligne, un relevé bathymétrique écrivait un instantané de sélection périmé dans
  // Firestore (currentSelectedIndices), et l'écho du listener onSnapshot revenait alors écraser
  // la sélection en cours localement (voir loadPonds()) : la sélection semblait "annulée" après
  // un relevé alors qu'elle n'avait en fait jamais changé.
  state.pond.cells = state.cells.map(c => ({ ...c }));
  const idx = state.ponds.findIndex(p => p.id === state.pond.id);
  if (idx !== -1) state.ponds[idx] = state.pond;
  savePonds();
  // Avertit tôt (avant même que Firestore ne rejette l'écriture) si l'historique des relevés
  // bathymétriques approche la limite de 1 Mo/document — l'utilisateur peut alors nettoyer
  // immédiatement via cleanupOldBathySurveys() au lieu de découvrir l'échec après coup.
  if (USE_CLOUD && estimateBathyPayloadBytes(state.pond) > BATHY_PAYLOAD_SAFE_BYTES) {
    showToast('Historique des relevés bathymétriques proche de la limite d’enregistrement cloud — cliquez sur "🧹 Réduire l’historique" pour supprimer les plus anciens.', 'error');
  }
}

// Taille (en octets) du document Firestore compacté que produirait cet étang — sert à prévenir
// l'utilisateur AVANT l'échec Firestore ("exceeds the maximum allowed size"), voir persistPondSurveys.
function estimateBathyPayloadBytes(pond) {
  try { return JSON.stringify(pondToFirestore(pond)).length; } catch { return 0; }
}
const BATHY_PAYLOAD_SAFE_BYTES = 900000; // marge sous la limite Firestore de 1 048 576 octets

// Supprime les relevés bathymétriques les plus anciens (par date) jusqu'à repasser sous un budget
// sûr — jamais silencieusement : liste toujours ce qui sera supprimé et demande confirmation.
// Utile quand l'historique accumulé (avant/contrôle/après, y compris les relevés générés
// rapidement) fait dépasser la limite Firestore malgré la compaction (voir encodeBathyReadings).
function cleanupOldBathySurveys() {
  const pond = state.pond;
  if (!pond?.bathySurveys?.length) { showToast('Aucun relevé à nettoyer', ''); return; }
  const sorted = [...pond.bathySurveys].sort((a, b) => a.date - b.date);
  const toDelete = [];
  let remaining = sorted;
  while (remaining.length > 1 && estimateBathyPayloadBytes({ ...pond, bathySurveys: remaining }) > BATHY_PAYLOAD_SAFE_BYTES) {
    toDelete.push(remaining[0]);
    remaining = remaining.slice(1);
  }
  if (!toDelete.length) { showToast('Les relevés actuels tiennent déjà sous la limite d’enregistrement cloud', 'success'); return; }
  const list = toDelete.map(s => `• ${s.label}`).join('\n');
  if (!confirm(`Supprimer ${toDelete.length} relevé(s) — le(s) plus ancien(s) — pour repasser sous la limite d'enregistrement cloud (1 Mo) ?\n\n${list}\n\nCeci ne peut pas être annulé.`)) return;
  const toDeleteIds = new Set(toDelete.map(s => s.id));
  pond.bathySurveys = pond.bathySurveys.filter(s => !toDeleteIds.has(s.id));
  const b = state.bathy;
  if (toDeleteIds.has(b.selectedSurveyId)) b.selectedSurveyId = null;
  if (toDeleteIds.has(b.compareBeforeId))  b.compareBeforeId  = null;
  if (toDeleteIds.has(b.compareAfterId))   b.compareAfterId   = null;
  persistPondSurveys();
  renderBathyTab();
  showToast(`${toDelete.length} ancien(s) relevé(s) supprimé(s) — enregistrement cloud à nouveau possible`, 'success');
}

// Énergie estimée pour un relevé de N cases — même modèle physique que computeCellCycleEnergyWh
// (descente/mesure/remontée), mais avec la puissance du moteur de sonde bathymétrique.
function computeBathySurveyEnergyWh(cellCount) {
  const fullDepth   = params.waterDepth + params.mudDepth;
  const descentTime = params.pumpDescentSpeed > 0 ? fullDepth / params.pumpDescentSpeed : 0;
  const ascentTime  = params.pumpAscentSpeed  > 0 ? fullDepth / params.pumpAscentSpeed  : 0;
  const measureTime = 2; // s — pause de mesure au contact du fond dur
  const probeW      = POWER_SPECS.bathyProbeW + POWER_SPECS.electronicsW;
  const perCellWs   = probeW * (descentTime + ascentTime + measureTime);
  return (perCellWs * cellCount) / 3600;
}

// ── Balayage animé (comme le curage : ordre en boustrophedon partant de l'ancre) ───────────
function startBathySurvey(type) {
  if (!state.pond) { showToast('Aucun étang chargé', 'error'); return; }
  // Le firmware embarque déjà l'équivalent (bathyTick(), voir aquarium_esp32.ino) mais aucune
  // sonde réelle n'est câblée pour l'instant — on garde donc ce relevé simulé uniquement, pour
  // ne pas laisser croire à une mesure réelle en mode "Robot réel".
  if (state.robotMode === 'real') {
    showToast('Relevé réel : sonde bathymétrique non encore câblée — disponible en mode Simulation', 'error');
    return;
  }
  if (state.bathy.running) { showToast('Un relevé est déjà en cours', 'error'); return; }
  const scanCells = state.cells.map(c => ({ ...c, completed: false }));
  const order = planPath(scanCells).filter(i => state.cells[i].selected);
  if (!order.length) { showToast('Aucune case sélectionnée', 'error'); return; }

  const b = state.bathy;
  b.running         = true;
  b.order           = order;
  b.currentStep     = 0;
  b.pendingType     = type;
  b.pendingReadings = new Array(state.cells.length).fill(null);
  b.markerIdx       = order[0];
  // Niveau de nivellement de la vase calculé une seule fois pour tout le relevé (voir
  // bathySplitAtLevel) — pas par case, sinon chaque case choisirait sa propre vase locale au lieu
  // de partager un même niveau commun sur l'ensemble du balayage.
  const seedForLevel = pondBathySeed(state.pond);
  const totalsForLevel = order.map(i => bathyTerrainTotalDepth(state.cells[i], seedForLevel));
  b.mudLevel = computeBathyFloodLevel(totalsForLevel, params.mudDepth);

  const progEl = document.getElementById('bathyScanProgress');
  if (progEl) progEl.style.display = 'flex';
  ['btnBathyBefore', 'btnBathyCheck', 'btnBathyAfter'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = true;
  });

  b.intervalId = setInterval(bathyScanTick, BATHY_SCAN_TICK_MS);
  showToast(`Relevé "${bathyTypeLabel(type)}" démarré — ${order.length} cases`, 'success');
}

function bathyScanTick() {
  const b = state.bathy;
  if (!state.pond) { clearInterval(b.intervalId); b.running = false; return; }
  if (b.currentStep >= b.order.length) { finishBathySurvey(); return; }

  const idx  = b.order[b.currentStep];
  const cell = state.cells[idx];
  const seed = pondBathySeed(state.pond);

  let reading;
  if (b.pendingType === 'after') {
    const before = latestBathySurvey(state.pond, 'before');
    const beforeReading = (before && before.readings[idx]) || generateBathyBaseReading(cell, seed, b.mudLevel);
    reading = generateBathyAfterReading(beforeReading, cell, !!cell.completed, seed);
  } else {
    reading = generateBathyBaseReading(cell, seed, b.mudLevel);
  }
  b.pendingReadings[idx] = reading;
  b.markerIdx = idx;
  b.currentStep++;

  const pct = Math.round((b.currentStep / b.order.length) * 100);
  setText('bathyScanPct', pct + '%');
  setText('bathyScanCellLabel', `Case ${b.currentStep}/${b.order.length}`);
  const bar = document.getElementById('bathyScanBar'); if (bar) bar.style.width = pct + '%';

  renderBathyCanvas();
  updateBathyLegend();
  _updateBathyScanMarker();
}

function finishBathySurvey() {
  const b = state.bathy;
  clearInterval(b.intervalId);
  b.running = false; b.intervalId = null;

  const survey = {
    id: Date.now().toString(),
    type: b.pendingType,
    label: bathyTypeLabel(b.pendingType),
    date: Date.now(),
    readings: b.pendingReadings,
  };
  if (!state.pond.bathySurveys) state.pond.bathySurveys = [];
  state.pond.bathySurveys.push(survey);
  persistPondSurveys();

  b.selectedSurveyId = survey.id;
  if (survey.type === 'before') b.compareBeforeId = survey.id;
  if (survey.type === 'after')  b.compareAfterId  = survey.id;

  const progEl = document.getElementById('bathyScanProgress');
  if (progEl) progEl.style.display = 'none';
  ['btnBathyBefore', 'btnBathyCheck', 'btnBathyAfter'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = false;
  });
  _removeBathyScanMarker();

  showToast(`Relevé "${survey.label}" enregistré — ${b.order.length} cases`, 'success');
  renderBathyTab();
}

function cancelBathySurvey() {
  const b = state.bathy;
  if (!b.running) return;
  clearInterval(b.intervalId);
  b.running = false; b.intervalId = null;
  const progEl = document.getElementById('bathyScanProgress');
  if (progEl) progEl.style.display = 'none';
  ['btnBathyBefore', 'btnBathyCheck', 'btnBathyAfter'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = false;
  });
  _removeBathyScanMarker();
  showToast('Relevé annulé', '');
}

function deleteBathySurvey(id) {
  if (!state.pond?.bathySurveys) return;
  if (!confirm('Supprimer ce relevé ?')) return;
  state.pond.bathySurveys = state.pond.bathySurveys.filter(s => s.id !== id);
  const b = state.bathy;
  if (b.selectedSurveyId === id) b.selectedSurveyId = null;
  if (b.compareBeforeId  === id) b.compareBeforeId  = null;
  if (b.compareAfterId   === id) b.compareAfterId   = null;
  persistPondSurveys();
  renderBathyTab();
  showToast('Relevé supprimé', '');
}

// Recalcule la répartition eau/vase d'un relevé DÉJÀ enregistré, sans nouveau scan : la
// profondeur totale (eau+vase) de chaque case reste inchangée (c'est la mesure, le fond réel).
// Seule la façon dont elle se répartit entre eau et vase est recalculée : la vase comble d'abord
// les creux les plus profonds du fond réel jusqu'à un niveau commun (voir bathySplitAtLevel et
// computeBathyFloodLevel) — pas une épaisseur constante plaquée sur le relief. Sur les hauts-fonds
// (fond réel moins profond que ce niveau), il n'y a pas de vase et le fond affleure directement.
function relevelBathySurveyReadings(readings, targetMeanMud) {
  const totals = readings.map(r => r ? round3(r.water + r.mud) : null);
  const level = computeBathyFloodLevel(totals, targetMeanMud);
  return readings.map((r, i) => r ? bathySplitAtLevel(totals[i], level) : null);
}
function relevelCurrentBathySurvey() {
  const pond = state.pond;
  if (!pond) return;
  const survey = pond.bathySurveys?.find(s => s.id === state.bathy.selectedSurveyId)
              || pond.bathySurveys?.[pond.bathySurveys.length - 1];
  if (!survey) { showToast('Aucun relevé sélectionné', 'error'); return; }

  const currentMuds = survey.readings.filter(Boolean).map(r => r.mud);
  const currentAvgMud = currentMuds.length ? currentMuds.reduce((a, b) => a + b, 0) / currentMuds.length : 0.5;
  const input = prompt(
    `Profondeur moyenne de vase visée pour ce relevé (en m) ?\n\nLa profondeur totale (eau + vase) de chaque case reste inchangée (c'est la mesure du fond réel) — la vase comble d'abord les creux les plus profonds jusqu'à un niveau commun, laissant les hauts-fonds à nu, plutôt qu'une épaisseur constante partout.`,
    currentAvgMud.toFixed(2)
  );
  if (input == null) return;
  const targetMeanMud = parseFloat(String(input).replace(',', '.'));
  if (!isFinite(targetMeanMud) || targetMeanMud < 0) { showToast('Valeur invalide', 'error'); return; }

  if (!confirm(`Relisser la répartition eau/vase du relevé "${survey.label}" autour d'une moyenne de ${targetMeanMud.toFixed(2)} m de vase ?\n\nCeci modifie les données enregistrées de ce relevé.`)) return;
  survey.readings = relevelBathySurveyReadings(survey.readings, targetMeanMud);
  persistPondSurveys();
  renderBathyTab();
  showToast('Répartition eau/vase relissée pour ce relevé', 'success');
}

// ── Vue (2D / 3D), métrique affichée, sélection des relevés comparés ───────────────────────
function setBathyMode(mode) {
  state.bathy.mode = mode;
  document.getElementById('btnBathy2D')?.classList.toggle('active', mode === '2d');
  document.getElementById('btnBathy3D')?.classList.toggle('active', mode === '3d');
  const rotRow = document.getElementById('bathyRotationRow');
  if (rotRow) rotRow.style.display = mode === '3d' ? 'flex' : 'none';
  const styleRow = document.getElementById('bathy3DStyleRow');
  if (styleRow) styleRow.style.display = mode === '3d' ? 'flex' : 'none';
  const tiltRow = document.getElementById('bathyTiltRow');
  if (tiltRow) tiltRow.style.display = mode === '3d' ? 'flex' : 'none';
  const disclaimer = document.getElementById('bathyTiltDisclaimer');
  if (disclaimer) disclaimer.style.display = state.bathy.style3D === 'mesh' ? 'block' : 'none';
  const canvas = document.getElementById('bathyCanvas');
  if (canvas) canvas.style.cursor = mode === '3d' ? 'grab' : '';
  renderBathyCanvas();
}
// Rotation de la vue 3D (isométrique) — mathématiquement correcte à n'importe quel angle, voir
// bathyIsoPoint(). La vue 2D (carte Leaflet réelle) n'est volontairement pas pivotable : sans le
// plugin dédié (leaflet-rotate, non disponible ici), une simple rotation CSS désynchroniserait
// le glisser/zoom de la souris avec l'affichage — pire que pas de rotation du tout.
function setBathy3DRotation(deg) {
  state.bathy.rotation3D = parseFloat(deg) || 0;
  setText('bathyRotationVal', Math.round(state.bathy.rotation3D) + '°');
  renderBathyCanvas();
}
// NB: _syncBathyRotationUI (voir plus bas) fait la même chose que les deux lignes ci-dessus
// mais met aussi à jour le curseur — utilisé par le pivot tactile à deux doigts, qui doit
// garder le curseur synchronisé avec un angle changé par un autre geste que lui.

// Deux styles de vue 3D : "columns" (colonnes extrudées, avec fond satellite et transparence
// eau/vase) et "mesh" (surface continue triangulée + éclairage simulé, façon relevé sonar
// classique — un seul canal de profondeur à la fois). Le fond satellite est disponible dans
// les deux styles : pour "mesh", il est calé sur la même projection (rotation+inclinaison+
// échelle) que le relief lui-même — voir renderBathyMeshSatelliteFloor. L'inclinaison
// (tilt3D) est elle aussi partagée par les deux styles — voir BATHY_COLUMNS_TILT_REF_DEG pour
// comment "columns" reste identique à son rendu historique au réglage par défaut.
function setBathy3DStyle(style) {
  state.bathy.style3D = style;
  document.getElementById('btnBathy3DColumns')?.classList.toggle('active', style === 'columns');
  document.getElementById('btnBathy3DMesh')?.classList.toggle('active', style === 'mesh');
  const disclaimer = document.getElementById('bathyTiltDisclaimer');
  if (disclaimer) disclaimer.style.display = style === 'mesh' ? 'block' : 'none';
  renderBathyCanvas();
}
// Bornes du curseur d'inclinaison, partagées avec bathyMapAlphaForTilt ci-dessous.
const BATHY_TILT_MIN = 5, BATHY_TILT_MAX = 80;
function setBathy3DTilt(deg) {
  // Descendre jusqu'à une quasi vue latérale (coupe du relief) reste utile — le fond satellite
  // s'estompe désormais automatiquement à faible inclinaison (voir bathyMapAlphaForTilt), donc
  // ça ne laisse plus un grand vide gris disgracieux comme quand la carte restait pleinement
  // opaque à un angle aussi rasant.
  state.bathy.tilt3D = Math.max(BATHY_TILT_MIN, Math.min(BATHY_TILT_MAX, parseFloat(deg) || BATHY_TILT_MIN));
  setText('bathyTiltVal', Math.round(state.bathy.tilt3D) + '°');
  renderBathyCanvas();
}

// Le fond satellite s'estompe progressivement aux faibles inclinaisons (vue de relief
// spectaculaire, quasi latérale, où la carte plaquée à plat gênerait plus qu'elle n'aiderait) et
// reste bien visible aux fortes inclinaisons (vue plus "de dessus", où elle sert surtout de
// repère d'orientation réelle) — même comportement pour les styles Colonnes et Surface lisse.
const BATHY_MAP_ALPHA_AT_MIN_TILT = 0.05, BATHY_MAP_ALPHA_AT_MAX_TILT = 1;
function bathyMapAlphaForTilt(tiltDeg) {
  const t = Math.max(0, Math.min(1, (tiltDeg - BATHY_TILT_MIN) / (BATHY_TILT_MAX - BATHY_TILT_MIN)));
  return BATHY_MAP_ALPHA_AT_MIN_TILT + t * (BATHY_MAP_ALPHA_AT_MAX_TILT - BATHY_MAP_ALPHA_AT_MIN_TILT);
}

// ── Zoom / pan / rotation à la souris et au doigt sur la vue 3D isométrique ────────────────
// Un canevas personnalisé n'a pas de zoom/pan natif comme Leaflet : on l'implémente à la main,
// comme une transform globale appliquée par renderBathyCanvas() par-dessus l'ajustement
// automatique de computeBathyIsoLayout (qui reste le cadrage de départ, zoom=1/pan=0).
const BATHY_ZOOM_MIN = 0.15, BATHY_ZOOM_MAX = 6;

function _syncBathyRotationUI(deg) {
  setText('bathyRotationVal', Math.round(deg) + '°');
  const slider = document.getElementById('bathyRotationSlider');
  if (slider) slider.value = deg;
}

function resetBathy3DView() {
  state.bathy.zoom3D = 1;
  state.bathy.pan3D = { x: 0, y: 0 };
  renderBathyCanvas();
}

function _bathyCanvasPoint(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top)  * (canvas.height / rect.height),
  };
}

// Zoom centré sur un point écran donné (curseur ou milieu du pincement) — recalcule le pan
// pour que ce point reste visuellement fixe pendant le zoom, comme une carte/visionneuse photo.
// Point écran (coordonnées canevas déjà mises à l'échelle DPR) → coordonnées "locales", c'est-
// à-dire dans le repère utilisé par computeBathyIsoLayout/renderBathy3DMesh AVANT la transform
// zoom/pan utilisateur appliquée par renderBathyCanvas — inverse exact de cette transform.
function _bathy3DScreenToLocal(sx, sy, canvas) {
  const { zoom3D, pan3D } = state.bathy;
  const W = canvas.width, H = canvas.height;
  return {
    x: (sx - W / 2 - pan3D.x) / zoom3D + W / 2,
    y: (sy - H / 2 - pan3D.y) / zoom3D + H / 2,
  };
}

// Hit-test pour le mode Vue en 3D "Colonnes" : reconstruit le même layout iso qu'au rendu
// (même angle, même formule d'offset selon la métrique) et cherche la case projetée la plus
// proche du clic, dans un rayon raisonnable (sinon : clic hors du relief, on ignore).
function _bathyHitTest3DColumns(px, py, W, H) {
  const theta = state.bathy.rotation3D, maxH = 70, metric = state.bathy.metric;
  const tiltDeg = state.bathy.tilt3D;
  const heightFactor = Math.cos(tiltDeg * Math.PI / 180) / Math.cos(BATHY_COLUMNS_TILT_REF_DEG * Math.PI / 180);
  const layout = computeBathyIsoLayout(W, H, theta, maxH * heightFactor, tiltDeg);
  let offX, offY;
  if (metric === 'total') {
    offX = W / 2 - (layout.minIx + layout.maxIx) / 2;
    offY = H * 0.32 - (layout.minIy + layout.maxIy) / 2;
  } else {
    offX = W / 2 - (layout.minIx + layout.maxIx) / 2;
    offY = H * 0.78 - (layout.minIy + layout.maxIy) / 2 - (maxH * heightFactor) / 2;
  }
  const values = computeBathyDisplayValues();
  if (!values) return null;
  let best = null, bestDist = Infinity;
  for (const p of layout.pts) {
    if (values[p.i] == null) continue;
    const d = Math.hypot(p.ix + offX - px, p.iy + offY - py);
    if (d < bestDist) { bestDist = d; best = p.i; }
  }
  const thresh = Math.max(layout.tileW, layout.tileH) * 1.6;
  return bestDist <= thresh ? best : null;
}

// Hit-test pour le mode Vue en 3D "Surface lisse" : réutilise le layout mis en cache par le
// dernier rendu du maillage (state.bathy._meshLayout, voir renderBathy3DMesh) et la même
// fonction de projection que les sommets du maillage — sinon disponible qu'après un premier
// rendu (toujours le cas ici, le canevas est déjà affiché avant qu'un clic soit possible).
function _bathyHitTest3DMesh(px, py) {
  const L = state.bathy._meshLayout;
  if (!L || !state.pond) return null;
  const thetaRad = state.bathy.rotation3D * Math.PI / 180;
  const tiltRad  = state.bathy.tilt3D     * Math.PI / 180;
  const cs = params.cellSize;
  const values = computeBathyDisplayValues();
  if (!values) return null;
  // En "profondeur totale", le rendu du socle utilise (val - totalMin) comme référence, pas val
  // brut (voir renderBathy3DMeshStacked) — sans reproduire ce même décalage ici, le clic visait
  // une position différente de ce qui est réellement affiché.
  const valOffset = L.totalMin != null ? L.totalMin : 0;
  let best = null, bestDist = Infinity;
  state.cells.forEach((c, i) => {
    if (values[i] == null) return;
    const p = bathyMeshProjectXY(c.col, c.row, values[i] - valOffset, thetaRad, tiltRad, L.heightScale, cs);
    const x = p.x * L.fitScale + L.offX, y = p.y * L.fitScale + L.offY;
    const d = Math.hypot(x - px, y - py);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  const thresh = Math.max(8, cs * L.fitScale * 0.7);
  return bestDist <= thresh ? best : null;
}

// Point d'entrée commun clic (souris/tactile) en 3D — routé vers le hit-test du style actif.
function _handleBathy3DClick(clientX, clientY, canvas) {
  if (!state.pond) return;
  const rect = canvas.getBoundingClientRect();
  const raw = { x: (clientX - rect.left) * (canvas.width / rect.width), y: (clientY - rect.top) * (canvas.height / rect.height) };
  const local = _bathy3DScreenToLocal(raw.x, raw.y, canvas);
  const idx = state.bathy.style3D === 'mesh'
    ? _bathyHitTest3DMesh(local.x, local.y)
    : _bathyHitTest3DColumns(local.x, local.y, canvas.width, canvas.height);
  if (idx != null) showBathyCellInfo(idx); else closeBathyCellInfo();
}

function _zoomBathy3DAt(px, py, canvas, factor, renderFn = renderBathyCanvas) {
  const b = state.bathy;
  const oldZoom = b.zoom3D;
  const newZoom = Math.max(BATHY_ZOOM_MIN, Math.min(BATHY_ZOOM_MAX, oldZoom * factor));
  if (newZoom === oldZoom) return;
  const W = canvas.width, H = canvas.height;
  const wx = (px - W / 2 - b.pan3D.x) / oldZoom;
  const wy = (py - H / 2 - b.pan3D.y) / oldZoom;
  b.pan3D.x = px - W / 2 - wx * newZoom;
  b.pan3D.y = py - H / 2 - wy * newZoom;
  b.zoom3D = newZoom;
  renderFn();
}

let _bathy3DDrag  = null; // glisser souris
let _bathy3DTouch = null; // glisser/pincer tactile

function _initBathy3DPanZoomEvents() {
  const canvas = document.getElementById('bathyCanvas');
  if (!canvas) return;

  canvas.addEventListener('wheel', e => {
    if (state.bathy.mode !== '3d') return;
    e.preventDefault();
    const p = _bathyCanvasPoint(e, canvas);
    _zoomBathy3DAt(p.x, p.y, canvas, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    if (state.bathy.mode !== '3d' || e.button !== 0) return;
    _bathy3DDrag = { startX: e.clientX, startY: e.clientY, panX: state.bathy.pan3D.x, panY: state.bathy.pan3D.y };
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!_bathy3DDrag) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    state.bathy.pan3D.x = _bathy3DDrag.panX + (e.clientX - _bathy3DDrag.startX) * sx;
    state.bathy.pan3D.y = _bathy3DDrag.panY + (e.clientY - _bathy3DDrag.startY) * sy;
    renderBathyCanvas();
  });
  window.addEventListener('mouseup', e => {
    if (_bathy3DDrag) {
      // Distinction clic/glisser : un déplacement minime depuis le mousedown est traité comme
      // un clic (fiche d'info en mode Vue) plutôt qu'un geste de pan, pour rester utilisable
      // sans que le moindre tremblement de souris ne fasse rater le clic.
      const moved = Math.hypot(e.clientX - _bathy3DDrag.startX, e.clientY - _bathy3DDrag.startY);
      _bathy3DDrag = null;
      canvas.style.cursor = state.bathy.mode === '3d' ? 'grab' : '';
      if (moved < 6 && state.bathy.mode === '3d') _handleBathy3DClick(e.clientX, e.clientY, canvas);
    }
  });

  canvas.addEventListener('touchstart', e => {
    if (state.bathy.mode !== '3d') return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      _bathy3DTouch = { mode: 'pan', x: t.clientX, y: t.clientY, panX: state.bathy.pan3D.x, panY: state.bathy.pan3D.y };
    } else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      _bathy3DTouch = {
        mode: 'pinch',
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        zoom: state.bathy.zoom3D,
        // Angle initial entre les deux doigts — tourner les doigts l'un autour de l'autre
        // (comme pivoter une photo) fait tourner la vue 3D, en plus du pincement pour zoomer.
        angle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI,
        rotation: state.bathy.rotation3D,
      };
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', e => {
    if (state.bathy.mode !== '3d' || !_bathy3DTouch) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    if (_bathy3DTouch.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      state.bathy.pan3D.x = _bathy3DTouch.panX + (t.clientX - _bathy3DTouch.x) * sx;
      state.bathy.pan3D.y = _bathy3DTouch.panY + (t.clientY - _bathy3DTouch.y) * sy;
      renderBathyCanvas();
    } else if (_bathy3DTouch.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = e.touches;
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      state.bathy.zoom3D = Math.max(BATHY_ZOOM_MIN, Math.min(BATHY_ZOOM_MAX, _bathy3DTouch.zoom * (dist / _bathy3DTouch.dist)));

      const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI;
      let rotation = (_bathy3DTouch.rotation + (angle - _bathy3DTouch.angle)) % 360;
      if (rotation < 0) rotation += 360;
      state.bathy.rotation3D = rotation;
      _syncBathyRotationUI(rotation);

      renderBathyCanvas();
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    // Tap (déplacement minime depuis touchstart, un seul doigt) = clic → fiche d'info, comme
    // pour la souris ; un vrai glisser/pincement ne déclenche pas la fiche.
    if (_bathy3DTouch && _bathy3DTouch.mode === 'pan' && e.changedTouches.length) {
      const t = e.changedTouches[0];
      const moved = Math.hypot(t.clientX - _bathy3DTouch.x, t.clientY - _bathy3DTouch.y);
      if (moved < 8) _handleBathy3DClick(t.clientX, t.clientY, canvas);
    }
    _bathy3DTouch = null;
  });
}
function setBathyMetric(metric) {
  state.bathy.metric = metric;
  const diffRow = document.getElementById('bathyDiffRow');
  if (diffRow) diffRow.style.display = metric === 'diff' ? 'flex' : 'none';
  renderBathyCanvas();
  updateBathyLegend();
}
function setBathySurvey(id) {
  state.bathy.selectedSurveyId = id;
  renderBathyCanvas();
  updateBathyLegend();
  updateBathySurveyStats();
}
function setBathyCompare(which, id) {
  if (which === 'before') state.bathy.compareBeforeId = id;
  else state.bathy.compareAfterId = id;
  renderBathyCanvas();
  updateBathyLegend();
  updateBathyCompareStats();
}

function getBathyMetricValue(reading, metric) {
  if (!reading) return null;
  if (metric === 'water') return reading.water;
  if (metric === 'mud')   return reading.mud;
  if (metric === 'total') return reading.water + reading.mud;
  return null;
}
function computeBathyDisplayValues() {
  const pond = state.pond, b = state.bathy;
  if (!pond) return null;
  if (b.metric === 'diff') {
    const before = pond.bathySurveys?.find(s => s.id === b.compareBeforeId);
    const after  = pond.bathySurveys?.find(s => s.id === b.compareAfterId);
    if (!before || !after) return null;
    return state.cells.map((c, i) => {
      const rb = before.readings[i], ra = after.readings[i];
      return (rb && ra) ? Math.max(0, rb.mud - ra.mud) : null;
    });
  }
  const survey = pond.bathySurveys?.find(s => s.id === b.selectedSurveyId)
              || pond.bathySurveys?.[pond.bathySurveys.length - 1];
  if (!survey) return null;
  return state.cells.map((c, i) => getBathyMetricValue(survey.readings[i], b.metric));
}
// Lectures brutes {water,mud} du relevé actuellement affiché — utilisé par la vue 3D empilée
// "profondeur totale" (voir renderBathy3DStacked), qui a besoin des deux composantes séparément.
function computeBathyRawReadings() {
  const pond = state.pond, b = state.bathy;
  if (!pond) return null;
  const survey = pond.bathySurveys?.find(s => s.id === b.selectedSurveyId)
              || pond.bathySurveys?.[pond.bathySurveys.length - 1];
  return survey ? survey.readings : null;
}

// ── Fiche d'information d'une case (mode Vue) — coordonnées + profondeurs du relevé affiché,
// plus la comparaison avant/après si les deux relevés existent pour cette case. Disponible en
// 2D (carte réelle ou repli canevas) et en 3D (colonnes ou surface lisse) — voir les points
// d'entrée showBathyCellInfo() (appelé après un hit-test propre à chaque vue).
function bathyCellInfoHTML(idx) {
  const cell = state.cells[idx];
  const pond = state.pond;
  if (!cell || !pond) return '';
  const fmt = v => v.toFixed(2) + ' m';

  let html = `<div class="bathy-cell-info-coords">Case (col ${cell.col}, ligne ${cell.row}) — ${cell.cx.toFixed(1)} m, ${cell.cy.toFixed(1)} m</div>`;

  const survey = pond.bathySurveys?.find(s => s.id === state.bathy.selectedSurveyId)
              || pond.bathySurveys?.[pond.bathySurveys.length - 1];
  const current = survey ? survey.readings[idx] : null;
  if (current) {
    html += `<div class="bathy-cell-info-row"><span>💧 Eau</span><b>${fmt(current.water)}</b></div>`;
    html += `<div class="bathy-cell-info-row"><span>🟤 Vase</span><b>${fmt(current.mud)}</b></div>`;
  } else {
    html += `<div class="bathy-cell-info-empty">Aucun relevé pour cette case.</div>`;
  }

  const before = latestBathySurvey(pond, 'before');
  const after  = latestBathySurvey(pond, 'after');
  const rb = before?.readings[idx], ra = after?.readings[idx];
  if (rb || ra) {
    html += `<div class="bathy-cell-info-sep"></div>`;
    if (rb) html += `<div class="bathy-cell-info-row"><span>📍 Avant — eau / vase</span><b>${rb.water.toFixed(2)} / ${rb.mud.toFixed(2)} m</b></div>`;
    if (ra) html += `<div class="bathy-cell-info-row"><span>✅ Après — eau / vase</span><b>${ra.water.toFixed(2)} / ${ra.mud.toFixed(2)} m</b></div>`;
    if (rb && ra) {
      // Diff calculée à partir des valeurs déjà arrondies à 2 décimales (celles affichées
      // ci-dessus) — sinon l'utilisateur voit deux nombres qui ne "s'additionnent" pas
      // exactement à cause du bruit de précision flottante sous-jacent.
      const rbMud = Math.round(rb.mud * 100) / 100, raMud = Math.round(ra.mud * 100) / 100;
      const diffMud = rbMud - raMud;
      const sign = diffMud >= 0 ? '−' : '+';
      html += `<div class="bathy-cell-info-row bathy-cell-info-diff"><span>Vase retirée</span><b>${sign}${Math.abs(diffMud).toFixed(2)} m</b></div>`;
    }
  }
  return html;
}
function showBathyCellInfo(idx) {
  const card = document.getElementById('bathyCellInfo');
  const body = document.getElementById('bathyCellInfoBody');
  if (!card || !body) return;
  body.innerHTML = bathyCellInfoHTML(idx);
  card.style.display = 'block';
}
function closeBathyCellInfo() {
  const card = document.getElementById('bathyCellInfo');
  if (card) card.style.display = 'none';
}

// ── Échelle de couleurs — plusieurs jeux de couleurs sélectionnables ───────────────────────
// "classic" garde une teinte HSL dédiée par métrique (bleu eau / brun vase / sarcelle total /
// vert différence). "rainbow"/"viridis" sont des dégradés multi-teintes universels (mêmes
// couleurs quelle que soit la métrique), calqués sur les logiciels de bathymétrie classiques
// (rouge/orange peu profond → bleu foncé profond, voir légende).
const BATHY_HSL_SCALES = {
  water: { h0: 205, h1: 215, s: 70, lMin: 84, lMax: 30 },
  mud:   { h0: 38,  h1: 22,  s: 62, lMin: 84, lMax: 24 },
  total: { h0: 172, h1: 190, s: 55, lMin: 84, lMax: 26 },
  diff:  { h0: 140, h1: 140, s: 55, lMin: 90, lMax: 30 },
};
const BATHY_PALETTES = {
  classic: { label: 'Classique (bleu / brun)', kind: 'per-metric' },
  rainbow: {
    label: 'Bathymétrique (arc-en-ciel)', kind: 'stops',
    stops: [
      [0.00, '#c62828'], [0.15, '#ef6c00'], [0.30, '#fdd835'],
      [0.45, '#9ccc65'], [0.60, '#26a69a'], [0.75, '#29b6f6'],
      [0.90, '#1565c0'], [1.00, '#0d1b6e'],
    ],
  },
  viridis: {
    label: 'Viridis', kind: 'stops',
    stops: [
      [0.00, '#440154'], [0.25, '#3b528b'], [0.50, '#21908c'],
      [0.75, '#5dc963'], [1.00, '#fde725'],
    ],
  },
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}
function lerpRgb(c0, c1, t) {
  return { r: c0.r + (c1.r - c0.r) * t, g: c0.g + (c1.g - c0.g) * t, b: c0.b + (c1.b - c0.b) * t };
}
function rgbCss(c) { return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`; }
function rgbShade(c, factor) { return { r: c.r * factor, g: c.g * factor, b: c.b * factor }; }

// Couleur (objet {r,g,b}) pour une métrique donnée et une fraction [0,1] de sa plage de valeurs,
// selon la palette actuellement choisie (state.bathy.palette).
function bathyColorRGB(metric, frac) {
  frac = Math.max(0, Math.min(1, frac));
  const palette = BATHY_PALETTES[state.bathy.palette] || BATHY_PALETTES.classic;
  if (palette.kind === 'per-metric') {
    const s = BATHY_HSL_SCALES[metric] || BATHY_HSL_SCALES.mud;
    const h = s.h0 + (s.h1 - s.h0) * frac;
    const l = (s.lMin + (s.lMax - s.lMin) * frac) / 100;
    return hslToRgb(h, s.s / 100, l);
  }
  const stops = palette.stops;
  for (let i = 0; i < stops.length - 1; i++) {
    const [f0, c0] = stops[i], [f1, c1] = stops[i + 1];
    if (frac >= f0 && frac <= f1) return lerpRgb(hexToRgb(c0), hexToRgb(c1), (frac - f0) / ((f1 - f0) || 1));
  }
  return hexToRgb(stops[stops.length - 1][1]);
}
function bathyColorForFrac(metric, frac) { return rgbCss(bathyColorRGB(metric, frac)); }

// Dégradé CSS multi-arrêts pour la légende, cohérent avec la palette/métrique choisie
function bathyLegendGradientCSS(metric) {
  const steps = 8;
  const stops = [];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    stops.push(`${rgbCss(bathyColorRGB(metric, frac))} ${(frac * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function bathyMetricUnit(metric)  { return metric === 'diff' ? 'm retirés' : 'm'; }
function bathyMetricLabel(metric) {
  return { water: "Profondeur d'eau", mud: 'Profondeur de vase', total: 'Profondeur totale', diff: 'Vase retirée' }[metric] || '';
}
function setBathyPalette(palette) {
  state.bathy.palette = palette;
  document.querySelectorAll('.bathy-palette-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.palette === palette));
  renderBathyCanvas();
  updateBathyLegend();
  if (_leafletMapBathy) _updateBathyCellStyles();
  if (state.dash3D.active) renderDash3D();
}

// Aperçus de couleurs des 3 boutons de palette (voir index.html) — construits une fois au
// chargement à partir de BATHY_PALETTES/BATHY_HSL_SCALES (source unique), plutôt que de dupliquer
// les valeurs de couleur dans le HTML : un simple nom dans une liste déroulante n'indiquait pas à
// quoi ressemblait réellement chaque palette avant de la choisir.
function initBathyPaletteButtons() {
  const stopsToGradient = stops => `linear-gradient(90deg, ${stops.map(([f, c]) => `${c} ${f * 100}%`).join(', ')})`;
  const waterC = f => rgbCss(bathyColorRGBForScale(BATHY_HSL_SCALES.water, f));
  const mudC   = f => rgbCss(bathyColorRGBForScale(BATHY_HSL_SCALES.mud, f));
  // "Classique" module la teinte par métrique (bleu pour l'eau, brun pour la vase) plutôt qu'une
  // seule échelle fixe — l'aperçu montre donc les deux còte à còte, fidèle au nom "bleu / brun".
  for (const prefix of ['bathyPaletteSwatch', 'dash3DPaletteSwatch']) {
    const rainbow = document.getElementById(prefix + 'Rainbow');
    if (rainbow) rainbow.style.background = stopsToGradient(BATHY_PALETTES.rainbow.stops);
    const viridis = document.getElementById(prefix + 'Viridis');
    if (viridis) viridis.style.background = stopsToGradient(BATHY_PALETTES.viridis.stops);
    const classic = document.getElementById(prefix + 'Classic');
    if (classic) classic.style.background = `linear-gradient(90deg, ${waterC(0)} 0%, ${waterC(1)} 46%, ${mudC(0)} 54%, ${mudC(1)} 100%)`;
  }
}
function bathyColorRGBForScale(s, frac) {
  const h = s.h0 + (s.h1 - s.h0) * frac;
  const l = (s.lMin + (s.lMax - s.lMin) * frac) / 100;
  return hslToRgb(h, s.s / 100, l);
}

// ── Rendu canevas (2D à plat ou 3D isométrique — pas de WebGL, juste un canevas 2D extrudé) ─
// Vue 2D : vraie carte satellite/plan (Leaflet, mêmes fonds que le tableau de bord) quand
// l'étang a une position GPS valide — zoom/pan natifs, à l'échelle. Sans position (repli), un
// rendu canevas simple est utilisé à la place. La vue 3D reste toujours un rendu canevas isométrique.
function renderBathyCanvas() {
  const pond = state.pond;
  const wrap = document.getElementById('bathyCanvasWrap');
  const canvas = document.getElementById('bathyCanvas');
  const leafletDiv = document.getElementById('leaflet-container-bathy');
  if (!wrap || !canvas) return;
  if (!wrap.clientWidth) return; // onglet caché — rien à dessiner pour l'instant

  const values = pond ? computeBathyDisplayValues() : null;
  const empty = document.getElementById('bathyEmptyState');
  if (empty) empty.style.display = values ? 'none' : 'flex';

  const defined = values ? values.filter(v => v != null) : [];
  state.bathy._lastMin = defined.length ? Math.min(...defined) : null;
  state.bathy._lastMax = defined.length ? Math.max(...defined) : null;

  // Repli sur le rendu canevas si Leaflet n'a pas pu charger (CDN indisponible) — mieux qu'une
  // zone vide silencieuse.
  const useLeaflet = state.bathy.mode === '2d' && pond && isValidOrigin(pond.origin) && typeof L !== 'undefined';
  if (leafletDiv) leafletDiv.style.display = useLeaflet ? 'block' : 'none';
  canvas.style.display = useLeaflet ? 'none' : 'block';

  if (useLeaflet) {
    initLeafletMapBathy();
    _updateBathyCellStyles();
    return;
  }

  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight || 320;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!pond || !defined.length) return;

  const min = state.bathy._lastMin;
  const range = (state.bathy._lastMax - min) || (Math.abs(state.bathy._lastMax) || 1) * 0.05 || 1;

  if (state.bathy.mode === '3d') {
    // Zoom/pan utilisateur — appliqués comme une transform globale autour du centre du
    // canevas, par-dessus la mise à l'échelle automatique de computeBathyIsoLayout (qui reste
    // le point de départ par défaut). Voir _initBathy3DPanZoomEvents pour les gestes.
    const { zoom3D, pan3D } = state.bathy;
    ctx.save();
    ctx.translate(canvas.width / 2 + pan3D.x, canvas.height / 2 + pan3D.y);
    ctx.scale(zoom3D, zoom3D);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
    state.bathy._floorTilesDrawn = 0;
    if (state.bathy.style3D === 'mesh') renderBathy3DMesh(ctx, canvas.width, canvas.height, values, min, range);
    else                                 renderBathy3D(ctx, canvas.width, canvas.height, values, min, range);
    ctx.restore();
    // Le voile d'assombrissement du fond satellite se dessine hors de la transform zoom/pan
    // (espace identité) pour toujours couvrir tout le canevas physique, quel que soit le niveau
    // de zoom/pan courant.
    if (state.bathy._floorTilesDrawn) {
      ctx.fillStyle = 'rgba(8,12,20,0.32)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  } else {
    renderBathy2D(ctx, canvas.width, canvas.height, values, min, range);
  }
}

// Repli sans position GPS : rendu canevas 2D simple (mêmes couleurs, pas de fond satellite,
// pas de zoom/pan — juste le contour de l'étang à plat).
// Transform monde→écran du repli canevas (2D sans position GPS) — factorisé pour rester
// identique entre le dessin (renderBathy2D) et la détection de clic (_initBathyCanvasSelectionEvents).
function _bathyCanvasFallbackTransform(W, H) {
  const bbox = getPondBbox(state.pond);
  const bw = (bbox.maxX - bbox.minX) || 1, bh = (bbox.maxY - bbox.minY) || 1;
  const scale = Math.min(W / bw, H / bh) * 0.9;
  const offX = W / 2 - ((bbox.minX + bbox.maxX) / 2) * scale;
  const offY = H / 2 + ((bbox.minY + bbox.maxY) / 2) * scale;
  return {
    scale,
    toScreen: (x, y) => ({ x: x * scale + offX, y: offY - y * scale }),
    toWorld:  (sx, sy) => ({ x: (sx - offX) / scale, y: (offY - sy) / scale }),
  };
}

function renderBathy2D(ctx, W, H, values, min, range) {
  const { scale, toScreen } = _bathyCanvasFallbackTransform(W, H);
  const cs = params.cellSize, cpx = cs * scale, metric = state.bathy.metric;

  state.cells.forEach((cell, i) => {
    const v = values[i];
    const s = toScreen(cell.cx - cs / 2, cell.cy + cs / 2);
    if (v == null) ctx.fillStyle = 'rgba(255,255,255,0.04)';
    else ctx.fillStyle = bathyColorForFrac(metric, Math.max(0, Math.min(1, (v - min) / range)));
    ctx.fillRect(s.x, s.y, cpx, cpx);
    if (cell.selected) {
      ctx.strokeStyle = '#0ea5e9'; ctx.lineWidth = Math.max(1, cpx * 0.08);
      ctx.strokeRect(s.x, s.y, cpx, cpx);
    }
  });

  ctx.beginPath();
  state.pond.polygon.forEach((p, i) => {
    const s = toScreen(p.x, p.y);
    i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();

  if (state.bathy.running && state.bathy.markerIdx != null) {
    const cell = state.cells[state.bathy.markerIdx];
    if (cell) {
      const s = toScreen(cell.cx, cell.cy);
      ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(4, cpx * 0.35), 0, Math.PI * 2);
      ctx.fillStyle = '#f59e0b'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
}

// Sélection au clic sur le repli canevas (étang sans position GPS, ou Leaflet indisponible) —
// quand la vraie carte est utilisée, c'est _addSelectionHandlersBathy() qui gère la sélection.
function _initBathyCanvasSelectionEvents() {
  const canvas = document.getElementById('bathyCanvas');
  if (!canvas) return;
  canvas.addEventListener('click', e => {
    if (state.bathy.mode !== '2d' || !state.pond) return;
    if (isValidOrigin(state.pond.origin) && typeof L !== 'undefined') return; // géré par la carte Leaflet
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const { toWorld } = _bathyCanvasFallbackTransform(canvas.width, canvas.height);
    const w = toWorld(sx, sy);
    const hcs = params.cellSize / 2;
    const idx = state.cells.findIndex(c => Math.abs(c.cx - w.x) <= hcs && Math.abs(c.cy - w.y) <= hcs);

    if (state.view.mode === 'view') {
      if (idx !== -1) showBathyCellInfo(idx); else closeBathyCellInfo();
      return;
    }
    if (state.view.mode !== 'select' || idx === -1) return;
    const cell = state.cells[idx];
    cell.selected = !cell.selected;
    renderBathyCanvas();
    renderAllPondCanvases();
    if (_satModeDash && typeof L !== 'undefined') _rebuildCellLayersDash();
    debouncedSaveSelection();
  });
}

// Projection isométrique paramétrée par un angle de vue (rotation autour de l'axe vertical) —
// rotation continue mathématiquement correcte : on tourne les coordonnées de grille (col,row)
// AVANT d'appliquer l'aplatissement iso fixe (tileW/tileH), plutôt que de tourner les points déjà
// projetés (ce qui déformerait la vue à tout angle qui n'est pas un multiple de 90°).
// Réglage par défaut du curseur d'inclinaison partagé (state.bathy.tilt3D) — à cette valeur,
// le style "Colonnes" reproduit EXACTEMENT son rendu iso fixe historique (aucune régression
// pour qui ne touche pas le curseur). L'ajuster change la "pente" du plan de sol (comme pour
// le style Surface lisse), voir tiltFactor ci-dessous.
const BATHY_COLUMNS_TILT_REF_DEG = 28;
function bathyIsoPoint(col, row, thetaDeg, tileW, tileH, tiltDeg = BATHY_COLUMNS_TILT_REF_DEG) {
  const rad = thetaDeg * Math.PI / 180;
  const rx = col * Math.cos(rad) - row * Math.sin(rad);
  const ry = col * Math.sin(rad) + row * Math.cos(rad);
  const tiltFactor = Math.sin(tiltDeg * Math.PI / 180) / Math.sin(BATHY_COLUMNS_TILT_REF_DEG * Math.PI / 180);
  return { ix: rx * tileW, iy: ry * tileH * tiltFactor };
}

// La rotation change la forme de l'empreinte projetée à l'écran (une grille rectangulaire
// tournée peut devenir bien plus large ou plus haute) : on calcule donc une échelle de tuile
// adaptée à l'angle courant pour que l'étang tienne toujours dans le canevas, quel que soit
// l'angle de vue — sans ça, certains angles débordaient hors cadre.
function computeBathyIsoLayout(W, H, thetaDeg, maxH, tiltDeg = BATHY_COLUMNS_TILT_REF_DEG) {
  const unitW = 2, unitH = 1;
  const rawPts = state.cells.map(c => bathyIsoPoint(c.col, c.row, thetaDeg, unitW, unitH, tiltDeg));
  const rxs = rawPts.map(p => p.ix), rys = rawPts.map(p => p.iy);
  const spanX = (Math.max(...rxs) - Math.min(...rxs)) || 1;
  const spanY = (Math.max(...rys) - Math.min(...rys)) || 1;
  const availW = W * 0.90;
  const availH = Math.max(40, H * 0.85 - maxH);
  const fitScale = Math.max(1.5, Math.min(availW / spanX, availH / spanY));
  const tileW = unitW * fitScale, tileH = unitH * fitScale;

  const pts = state.cells.map((c, i) => {
    const { ix, iy } = bathyIsoPoint(c.col, c.row, thetaDeg, tileW, tileH, tiltDeg);
    return { ix, iy, c, i };
  });
  const pxs = pts.map(p => p.ix), pys = pts.map(p => p.iy);
  return {
    tileW, tileH, pts,
    minIx: Math.min(...pxs), maxIx: Math.max(...pxs),
    minIy: Math.min(...pys), maxIy: Math.max(...pys),
  };
}

// ── Fond satellite plaqué sur le plan de sol isométrique 3D ────────────────────────────────
// Principe : une tuile satellite est une image carrée alignée nord/est en lat/lng. Le plan de
// sol isométrique est une transformation LINÉAIRE des mètres locaux (voir bathyIsoPoint), donc
// l'image d'un rectangle par cette transformation est un parallélogramme — exactement ce que
// canvas sait dessiner nativement via setTransform (3 coins suffisent, le 4ème est impliqué).
// Pas de déformation manuelle pixel par pixel : c'est canvas qui fait l'interpolation.
function lonLatToTileXY(lng, lat, z) {
  const n = 2 ** z;
  const x = (lng + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}
function tileXYToLonLat(tx, ty, z) {
  const n = 2 ** z;
  const lng = tx / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n)));
  return { lng, lat: latRad * 180 / Math.PI };
}

const _bathy3DTileCache = new Map(); // "z/x/y" → { img, loaded, failed, tx, ty, z }
let _bathy3DTileList     = [];
let _bathy3DTilesReady   = false;
let _bathy3DTileZ        = null;
let _bathy3DTilesPondId  = null;

// Récupère (une seule fois par étang) les tuiles couvrant l'emprise de l'étang, au zoom natif
// maximal du fond de carte choisi (mêmes fonds que le tableau de bord/la carte 2D). Un étang
// résidentiel classique ne demande que quelques tuiles à ce zoom.
function ensureBathy3DTiles() {
  const pond = state.pond;
  if (!pond || !isValidOrigin(pond.origin)) { _bathy3DTileList = []; return; }
  const style = MAP_STYLES[_currentMapStyle];
  const z = style.maxNativeZoom;
  if (_bathy3DTilesPondId === pond.id && _bathy3DTileZ === z && _bathy3DTilesReady) return;
  _bathy3DTilesPondId = pond.id; _bathy3DTileZ = z;

  const bbox = getPondBbox(pond);
  const corners = [
    { x: bbox.minX, y: bbox.minY }, { x: bbox.maxX, y: bbox.minY },
    { x: bbox.minX, y: bbox.maxY }, { x: bbox.maxX, y: bbox.maxY },
  ].map(p => metersToLatLng(p.x, p.y)).filter(Boolean);
  if (!corners.length) { _bathy3DTileList = []; return; }

  let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
  corners.forEach(c => {
    const t = lonLatToTileXY(c.lng, c.lat, z);
    minTx = Math.min(minTx, Math.floor(t.x)); maxTx = Math.max(maxTx, Math.floor(t.x));
    minTy = Math.min(minTy, Math.floor(t.y)); maxTy = Math.max(maxTy, Math.floor(t.y));
  });
  minTx--; minTy--; maxTx++; maxTy++; // marge d'une tuile pour ne pas couper les bords

  // Garde-fou : un étang anormalement grand (ou un zoom mal calculé) ne doit jamais déclencher
  // des dizaines de requêtes d'un coup.
  if ((maxTx - minTx + 1) * (maxTy - minTy + 1) > 60) { _bathy3DTileList = []; return; }

  const list = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const key = `${z}/${tx}/${ty}`;
      if (!_bathy3DTileCache.has(key)) {
        const img = new Image(); // pas de crossOrigin : on affiche, on ne relit pas les pixels
        const entry = { img, loaded: false, failed: false, tx, ty, z };
        img.onload  = () => { entry.loaded = true; renderBathyCanvas(); };
        img.onerror = () => { entry.failed = true; };
        img.src = style.url.replace('{z}', z).replace('{y}', ty).replace('{x}', tx);
        _bathy3DTileCache.set(key, entry);
      }
      list.push(_bathy3DTileCache.get(key));
    }
  }
  _bathy3DTileList = list;
  _bathy3DTilesReady = true;
}

// Mètres locaux → point écran isométrique — même transform linéaire que les colonnes (col,row
// = mètres/cellSize ; ça reste valable pour des points hors grille comme les coins de tuiles).
function bathyWorldToIso(wx, wy, thetaDeg, tileW, tileH, offX, offY, tiltDeg = BATHY_COLUMNS_TILT_REF_DEG) {
  // Les colonnes utilisent cell.col/row, pas des mètres bruts divisés par cellSize — et
  // generateGrid() calcule cx = bbox.minX + col*cellSize + cellSize/2 (voir plus haut), donc
  // col = (cx - bbox.minX)/cellSize - 0.5. Sans ce même décalage ici, le plancher satellite et
  // les colonnes mesurées étaient chacun dans un repère différent (décalage constant visible à
  // l'écran, la vase et l'eau du fond satellite ne coïncidaient jamais avec les colonnes).
  const bbox = getPondBbox(state.pond);
  const cs = params.cellSize;
  const colEquiv = (wx - bbox.minX) / cs - 0.5;
  const rowEquiv = (wy - bbox.minY) / cs - 0.5;
  const p = bathyIsoPoint(colEquiv, rowEquiv, thetaDeg, tileW, tileH, tiltDeg);
  return { x: p.ix + offX, y: p.iy + offY };
}

function renderBathy3DSatelliteFloor(ctx, thetaDeg, tileW, tileH, offX, offY, tiltDeg = BATHY_COLUMNS_TILT_REF_DEG) {
  const pond = state.pond;
  if (!state.bathy.show3DMap || !pond || !isValidOrigin(pond.origin)) return;
  ensureBathy3DTiles();
  if (!_bathy3DTileList.length) return;
  const origin = pond.origin;
  const size = 256;
  let drawn = 0;
  const mapAlpha = bathyMapAlphaForTilt(tiltDeg);

  for (const tile of _bathy3DTileList) {
    if (!tile.loaded || tile.failed) continue;
    drawn++;
    const nw = tileXYToLonLat(tile.tx,     tile.ty,     tile.z);
    const ne = tileXYToLonLat(tile.tx + 1, tile.ty,     tile.z);
    const sw = tileXYToLonLat(tile.tx,     tile.ty + 1, tile.z);
    const mNw = latLngToMeters(nw.lat, nw.lng, origin.lat, origin.lng);
    const mNe = latLngToMeters(ne.lat, ne.lng, origin.lat, origin.lng);
    const mSw = latLngToMeters(sw.lat, sw.lng, origin.lat, origin.lng);
    const P00 = bathyWorldToIso(mNw.x, mNw.y, thetaDeg, tileW, tileH, offX, offY, tiltDeg);
    const P10 = bathyWorldToIso(mNe.x, mNe.y, thetaDeg, tileW, tileH, offX, offY, tiltDeg);
    const P01 = bathyWorldToIso(mSw.x, mSw.y, thetaDeg, tileW, tileH, offX, offY, tiltDeg);

    // Transform affine : 3 coins suffisent (a,b = vecteur colonne image ; c,d = vecteur ligne
    // image ; e,f = origine) — le 4ème coin du parallélogramme en découle automatiquement.
    // ctx.transform() (pas setTransform) : on compose sur la transform déjà active plutôt que
    // de l'écraser, pour que le zoom/pan utilisateur (voir renderBathyCanvas) s'applique aussi
    // au fond satellite, pas seulement aux colonnes.
    const a = (P10.x - P00.x) / size, b = (P10.y - P00.y) / size;
    const c = (P01.x - P00.x) / size, d = (P01.y - P00.y) / size;
    ctx.save();
    ctx.globalAlpha = mapAlpha;
    ctx.transform(a, b, c, d, P00.x, P00.y);
    ctx.drawImage(tile.img, 0, 0, size, size);
    ctx.restore();
  }
  // Le voile d'assombrissement est dessiné par l'appelant (renderBathyCanvas), hors de la
  // transform zoom/pan, pour couvrir tout le canevas quel que soit le niveau de zoom courant.
  state.bathy._floorTilesDrawn = drawn;
}
function setBathy3DSatellite(checked) {
  state.bathy.show3DMap = checked;
  renderBathyCanvas();
}

// Dessine un segment de colonne isométrique (faces gauche/droite assombries + éventuel plafond
// coloré) entre deux hauteurs d'écran — brique de base réutilisée pour les colonnes simples
// (une seule teinte) et les colonnes empilées eau+vase à plafond plat (voir renderBathy3DStacked).
function drawIsoColumnSegment(ctx, x, yTopScreen, yBottomScreen, tileW, tileH, colorRGB, capTop, alpha = 1) {
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * alpha;

  ctx.fillStyle = rgbCss(rgbShade(colorRGB, 0.72));
  ctx.beginPath();
  ctx.moveTo(x - tileW, yBottomScreen); ctx.lineTo(x, yBottomScreen + tileH);
  ctx.lineTo(x, yTopScreen + tileH);    ctx.lineTo(x - tileW, yTopScreen);
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = rgbCss(rgbShade(colorRGB, 0.55));
  ctx.beginPath();
  ctx.moveTo(x, yBottomScreen + tileH); ctx.lineTo(x + tileW, yBottomScreen);
  ctx.lineTo(x + tileW, yTopScreen);    ctx.lineTo(x, yTopScreen + tileH);
  ctx.closePath(); ctx.fill();

  if (capTop) {
    ctx.fillStyle = rgbCss(colorRGB);
    ctx.beginPath();
    ctx.moveTo(x, yTopScreen - tileH); ctx.lineTo(x + tileW, yTopScreen);
    ctx.lineTo(x, yTopScreen + tileH); ctx.lineTo(x - tileW, yTopScreen);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 0.5; ctx.stroke();
  }

  ctx.globalAlpha = prevAlpha;
}

// Isométrique : chaque case devient une petite colonne extrudée (hauteur = profondeur), triée
// arrière→avant pour un empilement visuel correct. Pas une vraie 3D (aucun WebGL/three.js
// disponible ici), mais un rendu canevas 2D classique qui donne un vrai effet de relief lisible.
// "Profondeur totale" est un cas particulier : voir renderBathy3DStacked (surface d'eau plate).
function renderBathy3D(ctx, W, H, values, min, range) {
  const metric = state.bathy.metric;
  const theta  = state.bathy.rotation3D;
  const tiltDeg = state.bathy.tilt3D;
  // Comme pour le style Surface lisse : à l'inclinaison de référence, facteur = 1 (rendu
  // historique inchangé) ; s'incliner plus (vue plus de dessus) aplatit les colonnes, s'incliner
  // moins (vue plus rasante) les accentue — cohérent avec l'effet sur le plan de sol.
  const heightFactor = Math.cos(tiltDeg * Math.PI / 180) / Math.cos(BATHY_COLUMNS_TILT_REF_DEG * Math.PI / 180);
  const maxH = 70;

  if (metric === 'total') {
    const raw = computeBathyRawReadings();
    if (raw) { renderBathy3DStacked(ctx, W, H, raw, theta, maxH, tiltDeg); return; }
  }

  const layout = computeBathyIsoLayout(W, H, theta, maxH * heightFactor, tiltDeg);
  const { tileW, tileH } = layout;
  const offX = W / 2 - (layout.minIx + layout.maxIx) / 2;
  const offY = H * 0.78 - (layout.minIy + layout.maxIy) / 2 - (maxH * heightFactor) / 2;

  renderBathy3DSatelliteFloor(ctx, theta, tileW, tileH, offX, offY, tiltDeg);

  const pts = layout.pts.map(p => ({ ...p, v: values[p.i] }));
  // Tri par profondeur écran (valable à n'importe quel angle de rotation, contrairement à un
  // tri fixe sur col+row qui ne fonctionnait que pour la vue à 45°).
  pts.sort((a, b) => a.iy - b.iy);

  for (const p of pts) {
    if (p.v == null) continue;
    const frac = Math.max(0, Math.min(1, (p.v - min) / range));
    const h = (4 + frac * maxH) * heightFactor;
    const x = p.ix + offX, yBase = p.iy + offY, yTop = yBase - h;
    drawIsoColumnSegment(ctx, x, yTop, yBase, tileW, tileH, bathyColorRGB(metric, frac), true);
  }
}

// "Profondeur totale" empile les deux couches (vase sous l'eau) avec un plafond commun plat —
// la surface de l'eau étant globalement de niveau, seul le fond varie d'une case à l'autre.
function renderBathy3DStacked(ctx, W, H, raw, theta, maxH, tiltDeg = BATHY_COLUMNS_TILT_REF_DEG) {
  const waterVals = [], mudVals = [], totalVals = [];
  raw.forEach(r => { if (r) { waterVals.push(r.water); mudVals.push(r.mud); totalVals.push(r.water + r.mud); } });
  if (!totalVals.length) return;
  const wMin = Math.min(...waterVals), wRange = (Math.max(...waterVals) - wMin) || 1;
  const mMin = Math.min(...mudVals),   mRange = (Math.max(...mudVals)   - mMin) || 1;
  const maxTotal = Math.max(...totalVals) || 1;
  const heightFactor = Math.cos(tiltDeg * Math.PI / 180) / Math.cos(BATHY_COLUMNS_TILT_REF_DEG * Math.PI / 180);

  const layout = computeBathyIsoLayout(W, H, theta, maxH * heightFactor, tiltDeg);
  const { tileW, tileH } = layout;
  const offX = W / 2 - (layout.minIx + layout.maxIx) / 2;
  // Les colonnes pendent SOUS le plafond plat (surface) au lieu de monter depuis une base —
  // on décale donc la référence vers le haut du canevas pour laisser la place en dessous.
  const offY = H * 0.32 - (layout.minIy + layout.maxIy) / 2;

  renderBathy3DSatelliteFloor(ctx, theta, tileW, tileH, offX, offY, tiltDeg);

  const pts = layout.pts.map(p => ({ ...p, r: raw[p.i] }));
  pts.sort((a, b) => a.iy - b.iy);

  // L'eau est semi-transparente : on voit la vase par transparence, comme si on regardait à
  // l'intérieur de l'étang — pour ça, la colonne "vase" est dessinée sur toute la hauteur (pas
  // seulement sa propre épaisseur), et le voile d'eau translucide vient juste se superposer par
  // dessus sur la partie eau. Sans cette pleine hauteur en dessous, il n'y aurait rien à voir
  // en transparence : juste le fond du canevas.
  const WATER_ALPHA = 0.14;
  for (const p of pts) {
    if (!p.r) continue;
    const total = p.r.water + p.r.mud;
    const colH   = (4 + (total / maxTotal) * maxH) * heightFactor;
    const waterH = total > 0 ? colH * (p.r.water / total) : 0;

    const x = p.ix + offX, yTop = p.iy + offY; // plafond plat commun — surface de l'eau
    const yWaterBottom = yTop + waterH;
    const yMudBottom   = yTop + colH;

    const waterFrac = (p.r.water - wMin) / wRange;
    const mudFrac   = (p.r.mud   - mMin) / mRange;

    drawIsoColumnSegment(ctx, x, yTop, yMudBottom,    tileW, tileH, bathyColorRGB('mud', mudFrac), false);
    drawIsoColumnSegment(ctx, x, yTop, yWaterBottom,  tileW, tileH, bathyColorRGB('water', waterFrac), true, WATER_ALPHA);
  }

  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('surface de l\'eau (plafond plat)', 8, layout.minIy + offY - 6);
}

// ── Style "Surface lisse" — maillage triangulé continu + éclairage simulé, façon relevé
// bathymétrique sonar classique (une seule teinte de profondeur à la fois, ombrage selon la
// pente locale). Pas de transparence eau/vase combinée ici — voir renderBathy3D /
// renderBathy3DStacked pour le style "Colonnes" qui a cette fonctionnalité.
//
// Fond satellite : contrairement aux colonnes (plan de sol fixe, iso à angle fixe), le
// maillage utilise sa propre projection (rotation + inclinaison variable + échelle ajustée à
// l'étendue du relief). Pour que le relief ait l'air réellement "creusé" dans la vraie carte
// (et pas posé au-dessus d'un rectangle séparé), les tuiles satellite sont projetées avec
// EXACTEMENT la même fonction et la même échelle que les sommets du maillage — voir
// renderBathyMeshSatelliteFloor(), appelée depuis renderBathy3DMesh avec son "project" local.
function renderBathyMeshSatelliteFloor(ctx, project, fitScale, offX, offY) {
  const pond = state.pond;
  if (!state.bathy.show3DMap || !pond || !isValidOrigin(pond.origin)) return;
  ensureBathy3DTiles();
  if (!_bathy3DTileList.length) return;
  const origin = pond.origin;
  const bbox = getPondBbox(pond);
  const cs = params.cellSize;
  const size = 256;
  let drawn = 0;
  const mapAlpha = bathyMapAlphaForTilt(state.bathy.tilt3D);

  // Même conversion mètres→col/row que bathyWorldToIso, mais projetée via la fonction du
  // maillage (val=0 : le plan de sol correspond à une profondeur nulle) plutôt que via
  // bathyIsoPoint — c'est ce qui garantit l'alignement avec le relief.
  function toScreen(wx, wy) {
    const colEquiv = (wx - bbox.minX) / cs - 0.5;
    const rowEquiv = (wy - bbox.minY) / cs - 0.5;
    const p = project(colEquiv, rowEquiv, 0);
    return { x: p.x * fitScale + offX, y: p.y * fitScale + offY };
  }

  for (const tile of _bathy3DTileList) {
    if (!tile.loaded || tile.failed) continue;
    drawn++;
    const nw = tileXYToLonLat(tile.tx,     tile.ty,     tile.z);
    const ne = tileXYToLonLat(tile.tx + 1, tile.ty,     tile.z);
    const sw = tileXYToLonLat(tile.tx,     tile.ty + 1, tile.z);
    const mNw = latLngToMeters(nw.lat, nw.lng, origin.lat, origin.lng);
    const mNe = latLngToMeters(ne.lat, ne.lng, origin.lat, origin.lng);
    const mSw = latLngToMeters(sw.lat, sw.lng, origin.lat, origin.lng);
    const P00 = toScreen(mNw.x, mNw.y);
    const P10 = toScreen(mNe.x, mNe.y);
    const P01 = toScreen(mSw.x, mSw.y);

    const a = (P10.x - P00.x) / size, b = (P10.y - P00.y) / size;
    const c = (P01.x - P00.x) / size, d = (P01.y - P00.y) / size;
    ctx.save();
    ctx.globalAlpha = mapAlpha;
    ctx.transform(a, b, c, d, P00.x, P00.y);
    ctx.drawImage(tile.img, 0, 0, size, size);
    ctx.restore();
  }
  state.bathy._floorTilesDrawn = drawn;
}

const BATHY_MESH_LIGHT = (() => {
  const v = { x: -0.4, y: -0.55, z: 0.73 }; // lumière fixe côté caméra (pas le monde), depuis le
                                             // haut-gauche — reste cohérente quel que soit l'angle
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
})();

// Projection (col,row,val) → point écran (avant échelle/offset de rendu) — fonction pure,
// partagée entre le rendu du maillage (project(), ci-dessous) et le hit-test au clic
// (_bathyHitTest3DMesh) : les deux DOIVENT utiliser exactement la même formule, sous peine de
// désynchronisation entre ce qui est affiché et la case retrouvée au clic.
function bathyMeshProjectXY(col, row, val, thetaRad, tiltRad, heightScale, cs) {
  const wx = col * cs, wy = row * cs;
  const rx = wx * Math.cos(thetaRad) - wy * Math.sin(thetaRad);
  const ry = wx * Math.sin(thetaRad) + wy * Math.cos(thetaRad);
  const z  = -val * heightScale; // plus profond → vers le bas, comme un vrai creux
  return { x: rx, y: ry * Math.sin(tiltRad) - z * Math.cos(tiltRad), rx, ry, z };
}

// Colonnes/lignes de la zone de chantier en cours (state.plannedPath), pour forcer une résolution
// fine LOCALE dans le maillage principal sans passage superposé (voir bathyAdaptiveSampleAxis) —
// sur un grand étang, le pas d'échantillonnage uniforme (stride > 1) saute la plupart des cases :
// une case tout juste nettoyée par le robot ne coïncide presque jamais avec un sommet échantillonné
// et son changement de profondeur/couleur reste invisible, même si la donnée sous-jacente est bien
// à jour (signalé par l'utilisateur sur les deux onglets, Tableau de bord ET Bathymétrie). Renvoie
// null si aucun chantier actif.
function bathyJobPriorityColsRows() {
  const path = state.plannedPath;
  if (!path || !path.length) return null;
  const cols = new Set(), rows = new Set();
  for (const idx of path) {
    const c = state.cells[idx];
    if (!c) continue;
    cols.add(c.col); rows.add(c.row);
  }
  return cols.size ? { cols, rows } : null;
}

// Axe d'échantillonnage adaptatif : le pas uniforme habituel (stride, pour rester fluide sur un
// grand étang), complété par les colonnes/lignes exactes de la zone de chantier en cours — un seul
// maillage continu (les quads se forment entre valeurs ADJACENTES de ce tableau, uniforme ou non),
// donc pas de couture ni de double calcul d'échelle : juste des quads plus petits localement, là où
// le travail est en cours, et plus grands ailleurs.
function bathyAdaptiveSampleAxis(minV, maxV, stride, priority) {
  const set = new Set();
  for (let v = minV; v <= maxV; v += stride) set.add(v);
  if (priority) for (const v of priority) if (v >= minV && v <= maxV) set.add(v);
  return Array.from(set).sort((a, b) => a - b);
}

// Position (val, dans le même repère décalé par totalMin que projectVal) de la surface de vase —
// juste au-dessus du socle, à une distance du socle proportionnelle à l'épaisseur de vase
// (mud/total), avec une exagération modérée pour rester perceptible même quand elle est fine
// comparée à la hauteur d'eau au-dessus. Partagée entre renderBathy3DMeshStacked (le maillage
// lui-même) et drawDashRobot3D (pour que le robot pénètre visuellement la vase exactement là où
// sa surface est réellement dessinée, pas une approximation indépendante).
const MUD_LAYER_EXAGGERATION = 1.6;
function bathyMudTopVal(water, mud, totalMin) {
  const total = water + mud;
  if (total <= 0) return totalMin;
  const mudFraction = Math.min(1, (mud / total) * MUD_LAYER_EXAGGERATION);
  return totalMin + (total - totalMin) * (1 - mudFraction);
}

// "Profondeur totale" pour le maillage : le fond dur (relief coloré par la vase — pour qu'elle
// reste bien visible et perceptible, comme demandé) est dessiné sous un plafond d'eau plat et
// semi-transparent, façon vraie photo de fond marin peu profond où l'on voit le relief à
// travers l'eau turquoise. Même principe physique que renderBathy3DStacked pour les Colonnes
// (la surface de l'eau est globalement de niveau, seul le fond dur varie d'une case à l'autre),
// porté au style Surface lisse.
function renderBathy3DMeshStacked(ctx, W, H, raw, thetaRad, tiltRad, cs) {
  const pond = state.pond;
  const waterVals = [], mudVals = [], totalVals = [];
  raw.forEach(r => { if (r) { waterVals.push(r.water); mudVals.push(r.mud); totalVals.push(r.water + r.mud); } });
  if (!totalVals.length) return;
  const wMin = Math.min(...waterVals);
  const wRange = (Math.max(...waterVals) - wMin) || 1;
  const mMin = Math.min(...mudVals);
  const mRange = (Math.max(...mudVals) - mMin) || 1;
  const totalMin = Math.min(...totalVals);
  const totalRange = (Math.max(...totalVals) - totalMin) || 1;

  // Emprise des seules cases relevées (pas tout l'étang) — voir renderBathy3DMesh pour le
  // raisonnement complet ; même souci ici pour l'exagération verticale et la décimation.
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  const gridWater = new Map(), gridMud = new Map();
  state.cells.forEach((c, i) => {
    const r = raw[i];
    gridWater.set(c.col + ',' + c.row, r ? r.water : null);
    gridMud.set(c.col + ',' + c.row, r ? r.mud : null);
    if (!r) return;
    minCol = Math.min(minCol, c.col); maxCol = Math.max(maxCol, c.col);
    minRow = Math.min(minRow, c.row); maxRow = Math.max(maxRow, c.row);
  });
  if (!isFinite(minCol)) return;

  const horizontalSpan = Math.max((maxCol - minCol) * cs, (maxRow - minRow) * cs) || 1;
  const heightScale = totalRange > 0 ? (horizontalSpan * 0.22) / totalRange : 1;

  const spanCols = maxCol - minCol + 1, spanRows = maxRow - minRow + 1;
  const stride = Math.max(1, Math.ceil(Math.sqrt((spanCols * spanRows) / 3000)));
  const priority = bathyJobPriorityColsRows();
  const sampleCols = bathyAdaptiveSampleAxis(minCol, maxCol, stride, priority?.cols);
  const sampleRows = bathyAdaptiveSampleAxis(minRow, maxRow, stride, priority?.rows);

  // val est compté à partir de totalMin (la case la moins profonde), pas de zéro absolu — sinon
  // le fond (creusé de plusieurs mètres en valeur absolue) et le plafond d'eau (val=0 littéral)
  // se retrouvaient à des altitudes totalement différentes une fois inclinés/projetés, comme
  // deux formes disjointes au lieu d'une eau qui recouvre le relief. Avec ce décalage, la case
  // la moins profonde touche presque le plafond d'eau, et seul l'écart de profondeur RELATIF
  // (exagéré par heightScale) enfonce le fond en dessous — c'est cet écart qui doit être visible,
  // pas la profondeur absolue de l'étang.
  function projectVal(col, row, val) {
    const p = bathyMeshProjectXY(col, row, val - totalMin, thetaRad, tiltRad, heightScale, cs);
    return { x: p.x, y: p.y, depth: p.ry * Math.cos(tiltRad) + p.z * Math.sin(tiltRad), rx: p.rx, ry: p.ry, z: p.z };
  }

  // Trois maillages avec la même topologie (mêmes cases, mêmes trous) : le fond dur/socle de
  // l'étang (val = eau+vase, plus profond = plus creux), la surface de la vase (le dessus du
  // sédiment, entre le socle et l'eau claire — pour qu'on perçoive l'épaisseur de vase comme un
  // vrai volume, pas juste une teinte) et la surface de l'eau (val = totalMin partout — plafond
  // plat commun au niveau de la case la moins profonde, l'eau trouve son niveau).
  //
  // La position de la surface de vase est calculée comme une fraction du chemin entre l'eau
  // (0) et le socle (offset_floor), proportionnelle à mud/(eau+vase) — comme pour les Colonnes
  // (waterH = colH*(water/total)) plutôt qu'avec la profondeur de vase absolue : les valeurs
  // d'eau et de vase n'ont pas la même échelle (l'eau domine largement en valeur absolue), donc
  // un simple val=mud aurait recréé le même décalage réglé plus haut entre plancher et relief.
  const floorTris = [], mudTopTris = [], waterTris = [];
  for (let ci = 0; ci < sampleCols.length - 1; ci++) {
    const c0 = sampleCols[ci], c1 = sampleCols[ci + 1];
    for (let ri = 0; ri < sampleRows.length - 1; ri++) {
      const r0 = sampleRows[ri], r1 = sampleRows[ri + 1];
      const w00 = gridWater.get(c0 + ',' + r0), w10 = gridWater.get(c1 + ',' + r0);
      const w01 = gridWater.get(c0 + ',' + r1), w11 = gridWater.get(c1 + ',' + r1);
      const m00 = gridMud.get(c0 + ',' + r0), m10 = gridMud.get(c1 + ',' + r0);
      const m01 = gridMud.get(c0 + ',' + r1), m11 = gridMud.get(c1 + ',' + r1);
      if (w00 == null || w10 == null || w01 == null || w11 == null) continue;

      const b00 = projectVal(c0, r0, w00 + m00), b10 = projectVal(c1, r0, w10 + m10);
      const b01 = projectVal(c0, r1, w01 + m01), b11 = projectVal(c1, r1, w11 + m11);
      floorTris.push({ a: b00, b: b10, c: b01 });
      floorTris.push({ a: b10, b: b11, c: b01 });

      // La surface de vase — voir bathyMudTopVal — se situe juste au-dessus du socle, à une
      // distance proportionnelle à l'épaisseur de vase (mud/total), avec une exagération
      // modérée pour rester perceptible même quand elle est fine comparée à la hauteur d'eau.
      const mudTopVal = (w, m) => bathyMudTopVal(w, m, totalMin);
      const t00 = projectVal(c0, r0, mudTopVal(w00, m00)), t10 = projectVal(c1, r0, mudTopVal(w10, m10));
      const t01 = projectVal(c0, r1, mudTopVal(w01, m01)), t11 = projectVal(c1, r1, mudTopVal(w11, m11));
      mudTopTris.push({ a: t00, b: t10, c: t01, val: (m00 + m10 + m01) / 3 });
      mudTopTris.push({ a: t10, b: t11, c: t01, val: (m10 + m11 + m01) / 3 });

      const s00 = projectVal(c0, r0, totalMin), s10 = projectVal(c1, r0, totalMin);
      const s01 = projectVal(c0, r1, totalMin), s11 = projectVal(c1, r1, totalMin);
      waterTris.push({ a: s00, b: s10, c: s01, val: (w00 + w10 + w01) / 3 });
      waterTris.push({ a: s10, b: s11, c: s01, val: (w10 + w11 + w01) / 3 });
    }
  }
  if (!floorTris.length) return;

  function shadeAndSort(tris) {
    for (const t of tris) {
      const e1x = t.b.rx - t.a.rx, e1y = t.b.ry - t.a.ry, e1z = t.b.z - t.a.z;
      const e2x = t.c.rx - t.a.rx, e2y = t.c.ry - t.a.ry, e2z = t.c.z - t.a.z;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      nx /= nLen; ny /= nLen; nz /= nLen;
      let dot = nx * BATHY_MESH_LIGHT.x + ny * BATHY_MESH_LIGHT.y + nz * BATHY_MESH_LIGHT.z;
      if (dot < 0) dot = -dot;
      t.shade = Math.max(0.35, Math.min(1, dot));
      t.screenDepth = (t.a.depth + t.b.depth + t.c.depth) / 3;
    }
    tris.sort((p, q) => p.screenDepth - q.screenDepth);
  }
  shadeAndSort(floorTris);
  shadeAndSort(mudTopTris);
  shadeAndSort(waterTris);

  // Ajustement à l'échelle : les trois maillages (socle + vase + eau) et, si le fond satellite
  // est actif, l'emprise réelle de l'étang — voir renderBathy3DMesh pour le raisonnement complet.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const tris of [floorTris, mudTopTris, waterTris]) {
    for (const t of tris) {
      for (const p of [t.a, t.b, t.c]) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
    }
  }
  if (state.bathy.show3DMap && isValidOrigin(pond.origin)) {
    const pbbox = getPondBbox(pond);
    const corners = [
      [pbbox.minX, pbbox.minY], [pbbox.maxX, pbbox.minY],
      [pbbox.minX, pbbox.maxY], [pbbox.maxX, pbbox.maxY],
    ];
    for (const [wx, wy] of corners) {
      const colEquiv = (wx - pbbox.minX) / cs - 0.5;
      const rowEquiv = (wy - pbbox.minY) / cs - 0.5;
      const p = projectVal(colEquiv, rowEquiv, totalMin); // même référence que le plafond d'eau
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
  const fitScale = Math.min((W * 0.88) / spanX, (H * 0.82) / spanY);
  const offX = W / 2 - ((minX + maxX) / 2) * fitScale;
  const offY = H / 2 - ((minY + maxY) / 2) * fitScale;

  // totalMin mis en cache pour le hit-test au clic (_bathyHitTest3DMesh) — le rendu du socle
  // utilise (val - totalMin), pas val brut ; sans ce décalage aussi côté hit-test, le clic
  // visait une position complètement différente de ce qui est réellement affiché ici.
  state.bathy._meshLayout = { heightScale, fitScale, offX, offY, totalMin, wMin, wRange, mMin, mRange, totalRange };

  // Le plancher satellite se cale lui aussi sur le plafond d'eau (val=0 demandé par
  // renderBathyMeshSatelliteFloor → correspond ici à totalMin, pas à zéro absolu).
  function projectForFloor(col, row, val) { return projectVal(col, row, val + totalMin); }
  renderBathyMeshSatelliteFloor(ctx, projectForFloor, fitScale, offX, offY);

  // Trois passes, du plus profond au plus proche : le socle (roche/argile d'origine, opaque,
  // teinte neutre — sert de référence "fond de l'étang", pas de la vase), la surface de vase
  // (semi-transparente, teinte marron habituelle — laisse deviner le socle en dessous, donnant
  // une vraie impression d'épaisseur) puis l'eau (très transparente, teinte bleue, par-dessus
  // tout). Même stratégie de superposition que drawIsoColumnSegment pour les Colonnes.
  const drawLayer = (tris, alpha, stroke) => {
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * alpha;
    for (const t of tris.fill) {
      ctx.fillStyle = t.color;
      if (stroke) { ctx.strokeStyle = t.color; ctx.lineWidth = 0.75; }
      ctx.beginPath();
      ctx.moveTo(t.a.x * fitScale + offX, t.a.y * fitScale + offY);
      ctx.lineTo(t.b.x * fitScale + offX, t.b.y * fitScale + offY);
      ctx.lineTo(t.c.x * fitScale + offX, t.c.y * fitScale + offY);
      ctx.closePath(); ctx.fill();
      if (stroke) ctx.stroke();
    }
    ctx.globalAlpha = prevAlpha;
  };

  // Teinte grise/bleutée nettement différente du marron de la vase (sinon les deux couches se
  // confondent visuellement en "beaucoup de vase" à l'oeil, même quand la vase est fine) — et
  // un ombrage borné (jamais en dessous de 0.6) pour que le socle reste identifiable comme un
  // vrai fond neutre plutôt que de virer au noir aux pentes les plus sombres.
  const BATHY_FLOOR_RGB = { r: 100, g: 104, b: 110 };
  drawLayer({ fill: floorTris.map(t => ({ ...t, color: rgbCss(rgbShade(BATHY_FLOOR_RGB, Math.max(0.6, t.shade))) })) }, 1, true);

  const mudFrac = v => Math.max(0, Math.min(1, (v - mMin) / mRange));
  const MUD_TOP_ALPHA = 0.78;
  drawLayer({ fill: mudTopTris.map(t => ({ ...t, color: rgbCss(rgbShade(bathyColorRGB('mud', mudFrac(t.val)), t.shade)) })) }, MUD_TOP_ALPHA, true);

  // Beaucoup plus transparente que la vase, et un ombrage aplati (pas la pleine variation de
  // pente) : une eau plate qui bouge peu de teinte facette à facette lit comme une nappe d'eau
  // lisse plutôt que comme un maillage texturé — pas de trait de contour, pour éviter l'effet
  // grille/quadrillage.
  const WATER_ALPHA = 0.16;
  const waterFrac = v => Math.max(0, Math.min(1, (v - wMin) / wRange));
  drawLayer({ fill: waterTris.map(t => ({ ...t, color: rgbCss(rgbShade(bathyColorRGB('water', waterFrac(t.val)), 0.8 + t.shade * 0.2)) })) }, WATER_ALPHA, false);
}

function renderBathy3DMesh(ctx, W, H, values, min, range) {
  const pond = state.pond;
  if (!pond) return;
  const metric = state.bathy.metric;
  const thetaRad = state.bathy.rotation3D * Math.PI / 180;
  const tiltRad  = state.bathy.tilt3D     * Math.PI / 180;
  const cs = params.cellSize;

  if (metric === 'total') {
    const raw = computeBathyRawReadings();
    if (raw) { renderBathy3DMeshStacked(ctx, W, H, raw, thetaRad, tiltRad, cs); return; }
  }

  // Emprise des SEULES cases avec une donnée (pas tout l'étang) — l'exagération verticale et
  // la décimation doivent correspondre à ce qui est réellement dessiné. Se baser sur l'étang
  // entier ici produisait un relief démesurément exagéré dès qu'un petit relevé ne couvre
  // qu'une fraction d'un grand étang (un pic minuscule traité comme s'il occupait tout
  // l'étang), qui devenait visuellement incohérent avec le fond satellite (voir
  // renderBathyMeshSatelliteFloor, lui bien calé sur l'emprise réelle) — surtout marqué à
  // faible inclinaison, où le plancher se compresse mais pas ce relief surexagéré.
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  const grid = new Map();
  state.cells.forEach((c, i) => {
    grid.set(c.col + ',' + c.row, values[i]);
    if (values[i] == null) return;
    minCol = Math.min(minCol, c.col); maxCol = Math.max(maxCol, c.col);
    minRow = Math.min(minRow, c.row); maxRow = Math.max(maxRow, c.row);
  });
  if (!isFinite(minCol)) return;

  const horizontalSpan = Math.max((maxCol - minCol) * cs, (maxRow - minRow) * cs) || 1;
  const heightScale = range > 0 ? (horizontalSpan * 0.22) / range : 1;

  // Décimation si la grille est très dense, pour rester fluide pendant la rotation/le zoom —
  // un triangle par case n'est pas nécessaire pour lire le relief global. Les colonnes/lignes de
  // la zone de chantier en cours (voir bathyJobPriorityColsRows) sont ajoutées telles quelles à
  // cette grille par ailleurs uniforme (voir bathyAdaptiveSampleAxis) : un seul maillage continu,
  // localement plus fin là où le robot travaille, sans passage superposé ni couture.
  const spanCols = maxCol - minCol + 1, spanRows = maxRow - minRow + 1;
  const stride = Math.max(1, Math.ceil(Math.sqrt((spanCols * spanRows) / 3000)));
  const priority = bathyJobPriorityColsRows();
  const sampleCols = bathyAdaptiveSampleAxis(minCol, maxCol, stride, priority?.cols);
  const sampleRows = bathyAdaptiveSampleAxis(minRow, maxRow, stride, priority?.rows);

  function project(col, row, val) {
    const p = bathyMeshProjectXY(col, row, val, thetaRad, tiltRad, heightScale, cs);
    return {
      x: p.x, y: p.y,
      depth: p.ry * Math.cos(tiltRad) + p.z * Math.sin(tiltRad), // pour le tri peintre
      rx: p.rx, ry: p.ry, z: p.z,
    };
  }

  // Deux triangles par quad de 4 cases voisines — seulement si les 4 coins ont une valeur (un
  // trou dans la sélection/le relevé laisse un vrai trou dans le maillage, pas une valeur inventée).
  const tris = [];
  for (let ci = 0; ci < sampleCols.length - 1; ci++) {
    const c0 = sampleCols[ci], c1 = sampleCols[ci + 1];
    for (let ri = 0; ri < sampleRows.length - 1; ri++) {
      const r0 = sampleRows[ri], r1 = sampleRows[ri + 1];
      const v00 = grid.get(c0 + ',' + r0), v10 = grid.get(c1 + ',' + r0);
      const v01 = grid.get(c0 + ',' + r1), v11 = grid.get(c1 + ',' + r1);
      if (v00 == null || v10 == null || v01 == null || v11 == null) continue;
      const p00 = project(c0, r0, v00), p10 = project(c1, r0, v10);
      const p01 = project(c0, r1, v01), p11 = project(c1, r1, v11);
      tris.push({ a: p00, b: p10, c: p01, val: (v00 + v10 + v01) / 3 });
      tris.push({ a: p10, b: p11, c: p01, val: (v10 + v11 + v01) / 3 });
    }
  }
  if (!tris.length) return;

  // Éclairage : normale par triangle (produit vectoriel de deux arêtes en repère "caméra",
  // c'est-à-dire après rotation d'azimut mais avant inclinaison), produit scalaire avec la
  // lumière fixe → plus la pente fait face à la lumière, plus la facette est claire.
  for (const t of tris) {
    const e1x = t.b.rx - t.a.rx, e1y = t.b.ry - t.a.ry, e1z = t.b.z - t.a.z;
    const e2x = t.c.rx - t.a.rx, e2y = t.c.ry - t.a.ry, e2z = t.c.z - t.a.z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;
    let dot = nx * BATHY_MESH_LIGHT.x + ny * BATHY_MESH_LIGHT.y + nz * BATHY_MESH_LIGHT.z;
    if (dot < 0) dot = -dot; // pas de "face arrière" visible sur un maillage de terrain
    t.shade = Math.max(0.35, Math.min(1, dot));
    t.screenDepth = (t.a.depth + t.b.depth + t.c.depth) / 3;
  }
  tris.sort((p, q) => p.screenDepth - q.screenDepth); // peintre : loin → près

  // Ajustement à l'échelle du canevas (min/max calculés à la main, pas par spread — jusqu'à
  // ~18 000 points pour une grosse grille, l'opérateur spread s'y risquerait inutilement).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tris) {
    for (const p of [t.a, t.b, t.c]) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  // Si le fond satellite est actif, l'emprise réelle de l'étang entre aussi dans le calcul
  // d'échelle — pas seulement les cases relevées. Sans ça, quand seule une petite partie de
  // l'étang a un relevé, le maillage (petit) fixe l'échelle tout seul et le plancher satellite
  // (toute l'emprise réelle, généralement bien plus grande) se retrouve à une échelle
  // incohérente avec lui : le sol déborde du cadre ou semble décalé par rapport au relief,
  // un décalage qui varie avec l'inclinaison puisque la hauteur du relief (via z) et l'étendue
  // au sol (via ry) ne sont pas affectées de la même façon par sin/cos(inclinaison).
  if (state.bathy.show3DMap && isValidOrigin(pond.origin)) {
    const pbbox = getPondBbox(pond);
    const corners = [
      [pbbox.minX, pbbox.minY], [pbbox.maxX, pbbox.minY],
      [pbbox.minX, pbbox.maxY], [pbbox.maxX, pbbox.maxY],
    ];
    for (const [wx, wy] of corners) {
      const colEquiv = (wx - pbbox.minX) / cs - 0.5;
      const rowEquiv = (wy - pbbox.minY) / cs - 0.5;
      const p = bathyMeshProjectXY(colEquiv, rowEquiv, 0, thetaRad, tiltRad, heightScale, cs);
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
  const fitScale = Math.min((W * 0.88) / spanX, (H * 0.82) / spanY);
  const offX = W / 2 - ((minX + maxX) / 2) * fitScale;
  const offY = H / 2 - ((minY + maxY) / 2) * fitScale;

  // Mis en cache pour le hit-test au clic (mode Vue, voir _bathyHitTest3DMesh) — même échelle
  // et mêmes paramètres qu'à l'instant du rendu, pour retrouver la bonne case sous le clic.
  state.bathy._meshLayout = { heightScale, fitScale, offX, offY };

  // Dessiné avant le relief : la vraie carte n'apparaît qu'aux endroits sans triangle
  // (bords de l'étendue relevée, trous de sélection) — c'est ce qui donne l'impression que le
  // relief est creusé dans la carte plutôt que posé par-dessus.
  renderBathyMeshSatelliteFloor(ctx, project, fitScale, offX, offY);

  const frac = v => Math.max(0, Math.min(1, (v - min) / range));
  for (const t of tris) {
    const shaded = rgbCss(rgbShade(bathyColorRGB(metric, frac(t.val)), t.shade));
    ctx.fillStyle = shaded;
    ctx.strokeStyle = shaded; // masque les fines coutures d'antialiasing entre triangles voisins
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(t.a.x * fitScale + offX, t.a.y * fitScale + offY);
    ctx.lineTo(t.b.x * fitScale + offX, t.b.y * fitScale + offY);
    ctx.lineTo(t.c.x * fitScale + offX, t.c.y * fitScale + offY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

// ============================================================
// TABLEAU DE BORD — VUE 3D EN DIRECT (vase qui évolue en direct + robot qui plonge)
// ============================================================
// Réutilise la même projection isométrique que la bathymétrie (bathyMeshProjectXY) mais avec son
// propre pipeline de rendu, volontairement indépendant de state.bathy.metric/selectedSurveyId
// (choix de l'onglet Bathymétrie, pas forcément pertinents ici) : source de données = le relevé
// "en cours" pendant un chantier actif (state.bathy._liveSurveyId), sinon le dernier "avant
// travaux" connu, sinon rien (juste le contour de l'étang). Partage rotation3D/tilt3D avec
// l'onglet Bathymétrie (voir state.dash3D) — c'est la même scène 3D du fond de l'étang.
// Rendu volontairement throttlé (DASH3D_THROTTLE_MS) : la triangulation d'un maillage de
// plusieurs milliers de cases n'est pas gratuite, inutile de la refaire à chaque tick de
// simulation (50ms) — le ralentissement du navigateur constaté plus tôt dans ce projet vient
// justement de rendus coûteux répétés sans nécessité.
const DASH3D_THROTTLE_MS = 200;

function toggleDash3D() {
  state.dash3D.active = !state.dash3D.active;
  document.getElementById('btnDash3D')?.classList.toggle('active', state.dash3D.active);
  const controls = document.getElementById('dash3DControlsGroup');
  if (controls) controls.style.display = state.dash3D.active ? 'flex' : 'none';
  const canvas = document.getElementById('dashPondCanvas');
  const leafletDiv = document.getElementById('leaflet-container-dash');
  const schemaZoom = document.getElementById('dashSchemaZoom');
  const styleGroupDash = document.getElementById('dashMapStyleGroup');
  if (state.dash3D.active) {
    document.getElementById('btnSchemaViewDash')?.classList.remove('active');
    document.getElementById('btnSatViewDash')?.classList.remove('active');
    if (leafletDiv)     leafletDiv.style.display = 'none';
    if (canvas)         canvas.style.visibility = '';
    if (schemaZoom)     schemaZoom.style.display = 'none';
    if (styleGroupDash) styleGroupDash.style.display = 'none';
    setText('dash3DTiltVal', Math.round(state.bathy.tilt3D) + '°');
    setText('dash3DRotationVal', Math.round(state.bathy.rotation3D) + '°');
    const tiltEl = document.getElementById('dash3DTiltSlider'); if (tiltEl) tiltEl.value = state.bathy.tilt3D;
    const rotEl  = document.getElementById('dash3DRotationSlider'); if (rotEl) rotEl.value = state.bathy.rotation3D;
    if (canvas) canvas.style.cursor = 'grab';
    state.dash3D._lastRenderAt = 0; // force un rendu immédiat plutôt que d'attendre le throttle
    renderDash3D();
  } else {
    if (canvas) canvas.style.cursor = '';
    closeDashCellInfo();
    // Restaure proprement l'affichage 2D précédent (Schéma ou Satellite) — réutilise la logique
    // déjà en place plutôt que de la dupliquer.
    toggleSatelliteViewDash(_satModeDash);
  }
}

function setDash3DRotation(deg) {
  state.bathy.rotation3D = parseFloat(deg) || 0;
  setText('dash3DRotationVal', Math.round(state.bathy.rotation3D) + '°');
  const rotEl = document.getElementById('bathyRotationSlider'); if (rotEl) rotEl.value = state.bathy.rotation3D;
  setText('bathyRotationVal', Math.round(state.bathy.rotation3D) + '°');
  state.dash3D._lastRenderAt = 0;
  renderDash3D();
}
function setDash3DTilt(deg) {
  state.bathy.tilt3D = Math.max(BATHY_TILT_MIN, Math.min(BATHY_TILT_MAX, parseFloat(deg) || BATHY_TILT_MIN));
  setText('dash3DTiltVal', Math.round(state.bathy.tilt3D) + '°');
  const tiltEl = document.getElementById('bathyTiltSlider'); if (tiltEl) tiltEl.value = state.bathy.tilt3D;
  setText('bathyTiltVal', Math.round(state.bathy.tilt3D) + '°');
  state.dash3D._lastRenderAt = 0;
  renderDash3D();
}

// Profondeur eau/vase par case pour la vue 3D en direct — le relevé le plus récent, tous types
// confondus, pour l'étang ENTIER. La bathymétrie "en direct" (voir startLiveBathySurveyIfEnabled)
// est une bathymétrie UNIQUE, toujours complète (jamais de case à null), dont la date se
// rafraîchit à chaque chantier : elle ressort donc naturellement comme "la plus récente" pendant
// et après un chantier suivi, sans logique de fusion séparée à maintenir ici.
function computeDashLiveRawReadings() {
  const pond = state.pond;
  if (!pond?.bathySurveys?.length) return null;
  const latest = pond.bathySurveys.reduce((a, b) => (b.date > a.date ? b : a));
  return latest.readings;
}

// Rendu de l'étang ENTIER (une seule résolution, un seul passage — comme l'onglet Bathymétrie)
// mis en cache sur un canevas hors-écran, en espace LOCAL (zoom3D=1, pan3D={0,0}) — le zoom/pan
// utilisateur s'applique à la COMPOSITION (ctx.drawImage, à l'intérieur de la même transform que
// le reste), pas au calcul, donc zoomer/déplacer la vue ne force jamais un recalcul. Recalculé
// quand la caméra (rotation/inclinaison), la taille du canevas, la palette ou l'étang changent,
// OU dès qu'une case vient d'être relevée pendant le travail (state.bathy._liveRevision, incrémenté
// par _recordLiveBathyReading) — mais pas plus souvent que MIN_REFRESH_MS même si des cases se
// terminent en continu (chantier rapide sur un grand étang) : un maillage fin superposé au maillage
// grossier a déjà été essayé (v77) pour donner un retour instantané case par case, mais crée une
// "couture" visible à la frontière (facettes fines et texturées d'un côté, larges facettes lisses
// de l'autre) même une fois couleur/hauteur/cadrage unifiés — signalé explicitement par l'utilisateur.
// Un seul passage, une seule résolution (comme l'onglet Bathymétrie), rafraîchi fréquemment plutôt
// que superposé : la couture disparaît, la mise à jour reste visible en quelques centaines de ms.
const DASH3D_BG_MIN_REFRESH_MS = 500;
const DASH3D_BG_MAX_STALE_MS = 3000;
function renderDash3DBackdropCached(W, H, raw, thetaRad, tiltRad, cs) {
  const key = [state.pond?.id, W, H, thetaRad.toFixed(3), tiltRad.toFixed(3), state.bathy.palette, state.bathy.show3DMap].join('|');
  const now = performance.now();
  const cache = state.dash3D._bg;
  const rev = state.bathy._liveRevision || 0;
  if (cache && cache.key === key) {
    const age = now - cache.at;
    const dataUnchanged = cache.rev === rev;
    if (age < DASH3D_BG_MAX_STALE_MS && (dataUnchanged || age < DASH3D_BG_MIN_REFRESH_MS)) return cache;
  }
  if (!state.dash3D._bgCanvas) state.dash3D._bgCanvas = document.createElement('canvas');
  const bgCanvas = state.dash3D._bgCanvas;
  bgCanvas.width = W; bgCanvas.height = H;
  const bctx = bgCanvas.getContext('2d');
  bctx.clearRect(0, 0, W, H);
  state.bathy._floorTilesDrawn = 0;
  renderBathy3DMeshStacked(bctx, W, H, raw, thetaRad, tiltRad, cs);
  const next = { key, at: now, rev, canvas: bgCanvas, floorTilesDrawn: state.bathy._floorTilesDrawn };
  state.dash3D._bg = next;
  return next;
}

// Vue 3D du tableau de bord — réutilise directement renderBathy3DMeshStacked (socle + vase +
// eau, fond satellite qui s'estompe avec l'inclinaison, palette courante) : même rendu que
// l'onglet Bathymétrie en "Profondeur totale", pas une réimplémentation séparée. state.bathy._
// meshLayout (posé par cette fonction) donne ensuite le repère exact (totalMin compris) pour
// placer le robot au bon niveau, y compris à l'intérieur de la vase.
function renderDash3D() {
  const canvas = document.getElementById('dashPondCanvas');
  const wrap   = document.getElementById('dashCanvasWrap');
  if (!canvas || !wrap || !state.dash3D.active) return;
  if (!wrap.clientWidth) return; // onglet caché — rien à dessiner pour l'instant

  const now = performance.now();
  if (now - state.dash3D._lastRenderAt < DASH3D_THROTTLE_MS) return;
  state.dash3D._lastRenderAt = now;

  canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#0d1424'; ctx.fillRect(0, 0, W, H);

  const pond = state.pond;
  if (!pond || !state.cells.length) return;

  const thetaRad = state.bathy.rotation3D * Math.PI / 180;
  const tiltRad  = state.bathy.tilt3D     * Math.PI / 180;
  const cs = params.cellSize;
  const bbox = getPondBbox(pond);
  const raw = computeDashLiveRawReadings();

  // Zoom/pan utilisateur — même transform et mêmes valeurs partagées (state.bathy.zoom3D/pan3D)
  // que l'onglet Bathymétrie (voir renderBathyCanvas) : zoomer/déplacer la vue 3D depuis l'un des
  // deux onglets se retrouve dans l'autre, comme une seule et même caméra 3D.
  const { zoom3D, pan3D } = state.bathy;
  ctx.save();
  ctx.translate(W / 2 + pan3D.x, H / 2 + pan3D.y);
  ctx.scale(zoom3D, zoom3D);
  ctx.translate(-W / 2, -H / 2);
  state.bathy._floorTilesDrawn = 0;

  if (!raw || !raw.some(Boolean)) {
    renderDash3DFlatFallback(ctx, W, H, thetaRad, tiltRad, cs, bbox);
  } else {
    // Étang entier, un seul passage à une seule résolution — mis en cache (voir
    // renderDash3DBackdropCached) car ce passage coûte ~150-400ms sur un grand étang réel (même
    // décimé, il doit parcourir chaque case pour connaître l'emprise et les valeurs), bien trop
    // pour le refaire à chaque tick throttlé (~200ms). Se rafraîchit tout seul au bout de 3s pour
    // rester "vivant" pendant un chantier, sans le défaut d'un second maillage plus fin superposé
    // (testé en v77 : même une fois couleur/hauteur/cadrage unifiés entre les deux passages, la
    // différence de résolution des mailles créait encore une "couture" visible à la frontière —
    // signalé par l'utilisateur, qui disparaissait dès que ce second passage ne se déclenchait
    // plus, une fois la zone terminée). Un seul passage, comme l'onglet Bathymétrie.
    const bg = renderDash3DBackdropCached(W, H, raw, thetaRad, tiltRad, cs);
    ctx.drawImage(bg.canvas, 0, 0);
    state.bathy._floorTilesDrawn = state.bathy._floorTilesDrawn || bg.floorTilesDrawn;
    const layout = state.bathy._meshLayout;
    if (layout) {
      drawDashRobot3D(ctx, thetaRad, tiltRad, layout.heightScale, cs, bbox, layout.fitScale, layout.offX, layout.offY, layout.totalMin ?? 0, raw);
    }
  }
  ctx.restore();

  // Voile d'assombrissement du fond satellite hors de la transform zoom/pan (espace identité),
  // pour toujours couvrir tout le canevas physique quel que soit le niveau de zoom/pan courant —
  // même raisonnement que renderBathyCanvas.
  if (state.bathy._floorTilesDrawn) {
    ctx.fillStyle = 'rgba(8,12,20,0.32)';
    ctx.fillRect(0, 0, W, H);
  }
}

// Repli quand aucun relevé bathymétrique n'est disponible : juste le contour de l'étang à plat,
// pour situer le robot malgré tout plutôt que de laisser un écran vide.
function renderDash3DFlatFallback(ctx, W, H, thetaRad, tiltRad, cs, bbox) {
  const corners = [[bbox.minX, bbox.minY], [bbox.maxX, bbox.minY], [bbox.maxX, bbox.maxY], [bbox.minX, bbox.maxY]];
  const pts = corners.map(([wx, wy]) => {
    const colF = (wx - bbox.minX) / cs - 0.5, rowF = (wy - bbox.minY) / cs - 0.5;
    return bathyMeshProjectXY(colF, rowF, 0, thetaRad, tiltRad, 1, cs);
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
  const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
  const fitScale = Math.min((W * 0.86) / spanX, (H * 0.78) / spanY);
  const offX = W / 2 - ((minX + maxX) / 2) * fitScale;
  const offY = H / 2 - ((minY + maxY) / 2) * fitScale;
  ctx.fillStyle = 'rgba(56,189,248,0.12)';
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => { const x = p.x * fitScale + offX, y = p.y * fitScale + offY; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.closePath(); ctx.fill(); ctx.stroke();
  drawDashRobot3D(ctx, thetaRad, tiltRad, 1, cs, bbox, fitScale, offX, offY, 0, null);
}

// Offsets (en "cases") des flotteurs individuels de la plateforme réelle du robot — plusieurs
// pontons rectangulaires séparés par un fin espace (photo fournie par le client : plateforme
// modulaire, pas un simple carré plein) — 2 rangées de 3 flotteurs.
const DASH_ROBOT_PONTOONS = (() => {
  const half = 0.55, gap = 0.06, cols = 3, rows = 2;
  const cellW = (2 * half - gap * (cols - 1)) / cols;
  const cellH = (2 * half - gap * (rows - 1)) / rows;
  const out = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const dcMin = -half + i * (cellW + gap), drMin = -half + j * (cellH + gap);
      out.push([[dcMin, drMin], [dcMin + cellW, drMin], [dcMin + cellW, drMin + cellH], [dcMin, drMin + cellH]]);
    }
  }
  return out;
})();

// Modélise le robot en 3D à la surface de l'eau (plateforme modulaire à flotteurs + mât/antenne,
// d'après la photo du robot réel) + pompe qui descend/remonte en direct, projetée dans le MÊME
// repère (val - totalMin) que le maillage à 3 couches — la pompe pénètre donc visuellement la
// vase exactement au niveau où sa surface est réellement dessinée (bathyMudTopVal), pas une
// approximation indépendante : sous la profondeur d'eau réelle de cette case, on interpole entre
// la surface de vase (affichée, donc exagérée) et le socle selon la fraction de vase déjà traversée.
function drawDashRobot3D(ctx, thetaRad, tiltRad, heightScale, cs, bbox, fitScale, offX, offY, totalMin, raw) {
  const robot = state.robot;
  if (!Number.isFinite(robot.x) || !Number.isFinite(robot.y)) return;
  const colF = (robot.x - bbox.minX) / cs - 0.5;
  const rowF = (robot.y - bbox.minY) / cs - 0.5;

  let waterHere = params.waterDepth, mudHere = params.mudDepth;
  if (raw) {
    const nearestCol = Math.round(colF), nearestRow = Math.round(rowF);
    for (let i = 0; i < state.cells.length; i++) {
      const c = state.cells[i];
      if (c.col === nearestCol && c.row === nearestRow && raw[i]) { waterHere = raw[i].water; mudHere = raw[i].mud; break; }
    }
  }

  function screenAt(val) {
    const p = bathyMeshProjectXY(colF, rowF, val - totalMin, thetaRad, tiltRad, heightScale, cs);
    return { x: p.x * fitScale + offX, y: p.y * fitScale + offY };
  }

  const center = screenAt(totalMin);

  // L'icône du robot (flotteurs/mât/pompe) est dessinée comme un repère orienté par la rotation
  // (thetaRad), mais PAS déformé par l'inclinaison (tiltRad) comme une vraie face du maillage.
  // Une plateforme est plate (mêmes 4 coins à la même hauteur) : projetée avec la formule exacte
  // du relief, elle s'écrase en une ligne quasi invisible à faible inclinaison (vue proche du
  // côté) — correct pour le relief (qui a un vrai volume pour compenser), mais ça faisait
  // disparaître le robot lui-même tout en laissant le mât/la pompe (mesurés sur un seul coin,
  // donc pas forcément écrasés pareil selon la rotation) à leur taille normale : robot illisible,
  // pompe qui semblait flotter toute seule bien plus grosse que le reste. `tiltSquash` (plancher
  // 0.55, au lieu de sin(tiltRad) qui peut descendre à ~0.09) garde un soupçon de perspective sans
  // jamais faire disparaître le robot. `platformPxHalf` dérive de cs*fitScale (taille d'une case à
  // l'écran), une mesure stable qui ne dépend pas de l'inclinaison — donc mât/pompe restent
  // proportionnés à une plateforme qui, elle, ne disparaît plus.
  const cellPx = cs * fitScale;
  const platformPxHalf = Math.max(4, cellPx * 0.55);
  const tiltSquash = 0.55 + 0.45 * Math.sin(tiltRad);
  function robotOffset(dc, dr) {
    const wx = dc * cs, wy = dr * cs;
    const rx = wx * Math.cos(thetaRad) - wy * Math.sin(thetaRad);
    const ry = wx * Math.sin(thetaRad) + wy * Math.cos(thetaRad);
    return { x: center.x + rx * fitScale, y: center.y + ry * fitScale * tiltSquash };
  }
  const lw = f => Math.max(1, platformPxHalf * f);

  ctx.save();

  // Plateforme modulaire (flotteurs sombres séparés, comme sur la photo du robot réel), pas un
  // simple carré plein.
  ctx.fillStyle = '#334155';
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = lw(0.05);
  for (const corners of DASH_ROBOT_PONTOONS) {
    const pontoon = corners.map(([dc, dr]) => robotOffset(dc, dr));
    ctx.beginPath();
    pontoon.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  // Mât central (boîtier électronique + antenne GPS, comme sur la photo) — trait simple en
  // espace écran plutôt qu'une vraie extrusion 3D : juste un repère schématique, pas une pièce
  // du relief à projeter avec la même précision que le maillage. Le mât reste nettement plus
  // petit que l'empreinte de la plateforme (proportions de la photo), pas l'inverse.
  const mastH = platformPxHalf * 0.9;
  const mastTop = { x: center.x, y: center.y - mastH };
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = lw(0.1);
  ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(mastTop.x, mastTop.y); ctx.stroke();
  // Antenne GPS (fine tige qui dépasse du boîtier).
  ctx.lineWidth = lw(0.05);
  ctx.beginPath(); ctx.moveTo(mastTop.x, mastTop.y); ctx.lineTo(mastTop.x, mastTop.y - mastH * 0.35); ctx.stroke();
  // Boîtier électronique + écran.
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = lw(0.05);
  const boxW = platformPxHalf * 0.5, boxH = platformPxHalf * 0.35;
  ctx.beginPath();
  ctx.roundRect(mastTop.x - boxW / 2, mastTop.y - boxH * 0.3, boxW, boxH, Math.max(1, boxH * 0.2));
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#22c55e';
  ctx.beginPath(); ctx.arc(mastTop.x, mastTop.y - boxH * 0.05, Math.max(1, platformPxHalf * 0.08), 0, Math.PI * 2); ctx.fill();

  const pumpDepth = Number.isFinite(robot.pumpDepth) ? robot.pumpDepth : 0;
  if (pumpDepth > 0.02) {
    // Repère commun avec le maillage (val - totalMin, voir renderBathy3DMeshStacked) : le socle
    // de CETTE case est à "total", la surface de vase à bathyMudTopVal(...,totalMin) — passer 0
    // au lieu de totalMin décalait tout le trajet de la pompe d'un offset fixe (l'écart entre le
    // fond de cette case et la case la moins profonde de tout l'étang), l'empêchant de sembler
    // atteindre le vrai fond. La portion "encore en pleine eau" est elle aussi interpolée vers ce
    // même repère (proportionnellement, pas en mètres bruts) pour rester continue à la jonction.
    const total = waterHere + mudHere;
    const mudTop = bathyMudTopVal(waterHere, mudHere, totalMin);
    let pumpVal;
    if (pumpDepth <= waterHere) {
      pumpVal = waterHere > 0 ? totalMin + (pumpDepth / waterHere) * (mudTop - totalMin) : totalMin;
    } else {
      const intoMudFrac = mudHere > 0 ? Math.min(1, (pumpDepth - waterHere) / mudHere) : 1;
      pumpVal = mudTop + intoMudFrac * (total - mudTop);
    }
    const pPump = screenAt(pumpVal);

    ctx.strokeStyle = 'rgba(125,211,252,0.85)';
    ctx.lineWidth = lw(0.12);
    ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(pPump.x, pPump.y); ctx.stroke();

    // Boîtier du moteur/pompe — nettement plus petit que la plateforme (comme le bloc noir sous
    // le robot réel sur la photo), proportionnel à platformPxHalf comme le reste du robot, pas
    // une taille fixe en pixels (c'est ce qui le faisait paraître plus gros que tout le robot une
    // fois dézoomé).
    const pumping = robot.pumpState === 'pumping';
    const inMud = pumpDepth > waterHere;
    const pumpW = platformPxHalf * 0.5, pumpH = platformPxHalf * 0.65;
    ctx.globalAlpha = inMud ? 0.92 : 1; // à peine estompé une fois dans la vase, juste un indice d'immersion
    ctx.fillStyle   = pumping ? '#10b981' : '#2563eb';
    ctx.strokeStyle = pumping ? '#6ee7b7' : '#93c5fd';
    if (pumping) { ctx.shadowColor = '#34d399'; ctx.shadowBlur = Math.max(2, platformPxHalf * 0.2); }
    ctx.beginPath();
    ctx.roundRect(pPump.x - pumpW / 2, pPump.y - pumpH * 0.5, pumpW, pumpH, Math.max(1, pumpW * 0.25));
    ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// Hit-test au clic sur la vue 3D du tableau de bord — même principe que _bathyHitTest3DMesh,
// mais sur les valeurs LIVE (computeDashLiveRawReadings), pas sur le relevé sélectionné dans
// l'onglet Bathymétrie : on veut voir la donnée qui a servi à ce même rendu.
function _dash3DHitTest(px, py) {
  const L = state.bathy._meshLayout;
  if (!L || !state.pond) return null;
  const raw = computeDashLiveRawReadings();
  if (!raw) return null;
  const thetaRad = state.bathy.rotation3D * Math.PI / 180;
  const tiltRad  = state.bathy.tilt3D     * Math.PI / 180;
  const cs = params.cellSize;
  const valOffset = L.totalMin != null ? L.totalMin : 0;
  let best = null, bestDist = Infinity;
  state.cells.forEach((c, i) => {
    if (!raw[i]) return;
    const total = raw[i].water + raw[i].mud;
    const p = bathyMeshProjectXY(c.col, c.row, total - valOffset, thetaRad, tiltRad, L.heightScale, cs);
    const x = p.x * L.fitScale + L.offX, y = p.y * L.fitScale + L.offY;
    const d = Math.hypot(x - px, y - py);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  const thresh = Math.max(8, cs * L.fitScale * 0.7);
  return bestDist <= thresh ? best : null;
}

function dash3DCellInfoHTML(idx) {
  const cell = state.cells[idx];
  const pond = state.pond;
  if (!cell || !pond) return '';
  const fmt = v => v.toFixed(2) + ' m';
  let html = `<div class="bathy-cell-info-coords">Case (col ${cell.col}, ligne ${cell.row})</div>`;

  const raw = computeDashLiveRawReadings();
  const current = raw ? raw[idx] : null;
  if (current) {
    html += `<div class="bathy-cell-info-row"><span>💧 Eau</span><b>${fmt(current.water)}</b></div>`;
    html += `<div class="bathy-cell-info-row"><span>🟤 Vase</span><b>${fmt(current.mud)}</b></div>`;
    html += `<div class="bathy-cell-info-row"><span>Profondeur totale</span><b>${fmt(current.water + current.mud)}</b></div>`;
  } else {
    html += `<div class="bathy-cell-info-empty">Aucun relevé pour cette case.</div>`;
  }

  const before = latestBathySurvey(pond, 'before');
  const rb = before?.readings[idx];
  if (rb && current) {
    const diffMud = Math.round(rb.mud * 100) / 100 - Math.round(current.mud * 100) / 100;
    if (Math.abs(diffMud) > 0.001) {
      const sign = diffMud >= 0 ? '−' : '+';
      html += `<div class="bathy-cell-info-sep"></div>`;
      html += `<div class="bathy-cell-info-row bathy-cell-info-diff"><span>Vase retirée (ce chantier)</span><b>${sign}${Math.abs(diffMud).toFixed(2)} m</b></div>`;
    }
  }
  if (cell.completed) html += `<div class="bathy-cell-info-row"><span>✅ Case nettoyée</span></div>`;
  return html;
}
function showDashCellInfo(idx) {
  const card = document.getElementById('dashCellInfo');
  const body = document.getElementById('dashCellInfoBody');
  if (!card || !body) return;
  body.innerHTML = dash3DCellInfoHTML(idx);
  card.style.display = 'block';
}
function closeDashCellInfo() {
  const card = document.getElementById('dashCellInfo');
  if (card) card.style.display = 'none';
}

// Point d'entrée commun clic (souris/tactile) sur la vue 3D du tableau de bord — voir
// _handleBathy3DClick, même principe.
function _handleDash3DClick(clientX, clientY, canvas) {
  if (!state.pond) return;
  const rect = canvas.getBoundingClientRect();
  const raw = { x: (clientX - rect.left) * (canvas.width / rect.width), y: (clientY - rect.top) * (canvas.height / rect.height) };
  const local = _bathy3DScreenToLocal(raw.x, raw.y, canvas);
  const idx = _dash3DHitTest(local.x, local.y);
  if (idx != null) showDashCellInfo(idx); else closeDashCellInfo();
}

// Zoom/pan/tap souris + tactile sur la vue 3D du tableau de bord — même mécanique que
// _initBathy3DPanZoomEvents, sur state.bathy.zoom3D/pan3D (partagé avec l'onglet Bathymétrie :
// une seule caméra 3D) mais gérée par state.dash3D.active plutôt que state.bathy.mode. Les rendus
// passent par renderDash3D() (donc restent soumis à son throttle) pour ne pas réintroduire le
// ralentissement déjà corrigé pendant qu'une simulation tourne en parallèle.
let _dash3DDrag = null;
let _dash3DTouch = null;
function _initDash3DPanZoomEvents() {
  const canvas = document.getElementById('dashPondCanvas');
  if (!canvas) return;

  canvas.addEventListener('wheel', e => {
    if (!state.dash3D.active) return;
    e.preventDefault();
    const p = _bathyCanvasPoint(e, canvas);
    _zoomBathy3DAt(p.x, p.y, canvas, e.deltaY < 0 ? 1.12 : 1 / 1.12, renderDash3D);
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    if (!state.dash3D.active || e.button !== 0) return;
    _dash3DDrag = { startX: e.clientX, startY: e.clientY, panX: state.bathy.pan3D.x, panY: state.bathy.pan3D.y };
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!_dash3DDrag) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    state.bathy.pan3D.x = _dash3DDrag.panX + (e.clientX - _dash3DDrag.startX) * sx;
    state.bathy.pan3D.y = _dash3DDrag.panY + (e.clientY - _dash3DDrag.startY) * sy;
    renderDash3D();
  });
  window.addEventListener('mouseup', e => {
    if (_dash3DDrag) {
      const moved = Math.hypot(e.clientX - _dash3DDrag.startX, e.clientY - _dash3DDrag.startY);
      _dash3DDrag = null;
      canvas.style.cursor = state.dash3D.active ? 'grab' : '';
      if (moved < 6 && state.dash3D.active) _handleDash3DClick(e.clientX, e.clientY, canvas);
    }
  });

  canvas.addEventListener('touchstart', e => {
    if (!state.dash3D.active) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      _dash3DTouch = { mode: 'pan', x: t.clientX, y: t.clientY, panX: state.bathy.pan3D.x, panY: state.bathy.pan3D.y };
    } else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      _dash3DTouch = {
        mode: 'pinch',
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        zoom: state.bathy.zoom3D,
        angle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI,
        rotation: state.bathy.rotation3D,
      };
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', e => {
    if (!state.dash3D.active || !_dash3DTouch) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    if (_dash3DTouch.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      state.bathy.pan3D.x = _dash3DTouch.panX + (t.clientX - _dash3DTouch.x) * sx;
      state.bathy.pan3D.y = _dash3DTouch.panY + (t.clientY - _dash3DTouch.y) * sy;
      renderDash3D();
    } else if (_dash3DTouch.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = e.touches;
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      state.bathy.zoom3D = Math.max(BATHY_ZOOM_MIN, Math.min(BATHY_ZOOM_MAX, _dash3DTouch.zoom * (dist / _dash3DTouch.dist)));
      const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI;
      let rotation = (_dash3DTouch.rotation + (angle - _dash3DTouch.angle)) % 360;
      if (rotation < 0) rotation += 360;
      setDash3DRotation(rotation);
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    if (_dash3DTouch && _dash3DTouch.mode === 'pan' && e.changedTouches.length) {
      const t = e.changedTouches[0];
      const moved = Math.hypot(t.clientX - _dash3DTouch.x, t.clientY - _dash3DTouch.y);
      if (moved < 8) _handleDash3DClick(t.clientX, t.clientY, canvas);
    }
    _dash3DTouch = null;
  });
}

// Légende graduée — repères de profondeur alignés sur le dégradé (pas juste min/max aux deux
// bouts) pour qu'on puisse lire directement quelle teinte correspond à quelle profondeur,
// comme sur les cartes bathymétriques classiques.
function _bathyLegendTicksHTML(min, max, unit) {
  const steps = 5;
  const range = max - min;
  let html = '';
  for (let i = 0; i <= steps; i++) {
    const frac  = i / steps;
    const val   = min + range * frac;
    const align = i === 0 ? '0%' : i === steps ? '-100%' : '-50%';
    const label = i === steps ? `${val.toFixed(2)} ${unit}` : val.toFixed(2);
    html += `<span class="bathy-legend-tick" style="left:${(frac * 100).toFixed(2)}%;transform:translateX(${align})">${label}</span>`;
  }
  return html;
}

function updateBathyLegend() {
  const bar = document.getElementById('bathyLegendBar');
  const ticksEl = document.getElementById('bathyLegendTicks');
  const titleEl = document.getElementById('bathyLegendTitle');
  if (!bar) return;
  const metric = state.bathy.metric;
  bar.style.background = bathyLegendGradientCSS(metric);
  if (titleEl) titleEl.textContent = bathyMetricLabel(metric);

  const { _lastMin: min, _lastMax: max } = state.bathy;
  const unit = bathyMetricUnit(metric);
  if (ticksEl) ticksEl.innerHTML = (min == null || max == null) ? '' : _bathyLegendTicksHTML(min, max, unit);

  // En "profondeur totale", la vase et l'eau sont fondues dans une seule valeur combinée —
  // on ajoute donc leurs propres graduations (comme sur les Colonnes/Surface lisse qui montrent
  // les deux couches séparément) pour pouvoir lire directement quelle teinte correspond à
  // quelle profondeur de vase ou d'eau, pas seulement au total.
  const mudWrap = document.getElementById('bathyLegendMudWrap');
  const waterWrap = document.getElementById('bathyLegendWaterWrap');
  if (mudWrap && waterWrap) {
    const raw = metric === 'total' ? computeBathyRawReadings() : null;
    if (raw) {
      const waterVals = [], mudVals = [];
      raw.forEach(r => { if (r) { waterVals.push(r.water); mudVals.push(r.mud); } });
      if (waterVals.length) {
        const mMin = Math.min(...mudVals), mMax = Math.max(...mudVals);
        const wMin = Math.min(...waterVals), wMax = Math.max(...waterVals);
        document.getElementById('bathyLegendMudBar').style.background = bathyLegendGradientCSS('mud');
        document.getElementById('bathyLegendMudTicks').innerHTML = _bathyLegendTicksHTML(mMin, mMax, 'm');
        document.getElementById('bathyLegendWaterBar').style.background = bathyLegendGradientCSS('water');
        document.getElementById('bathyLegendWaterTicks').innerHTML = _bathyLegendTicksHTML(wMin, wMax, 'm');
        mudWrap.style.display = 'block';
        waterWrap.style.display = 'block';
      } else {
        mudWrap.style.display = 'none';
        waterWrap.style.display = 'none';
      }
    } else {
      mudWrap.style.display = 'none';
      waterWrap.style.display = 'none';
    }
  }
}

// ── Vue satellite/plan réelle (Leaflet) — même style de fond que le tableau de bord,
// zoom/pan natifs, cases colorées à l'échelle exacte. ──────────────────────────────────────
let _leafletMapBathy   = null;
let _bathyCellRects    = [];
let _bathyCellRenderer = null;
let _bathyBaseLayer    = null;
let _bathyMarkerLayer  = null;

function initLeafletMapBathy() {
  if (_leafletMapBathy) { setTimeout(() => _leafletMapBathy.invalidateSize(), 50); return; }
  const container = document.getElementById('leaflet-container-bathy');
  if (!container || typeof L === 'undefined') return;

  _leafletMapBathy = L.map('leaflet-container-bathy', { zoomControl: false });
  _leafletMapBathy.setView([0, 0], 2);

  const style = MAP_STYLES[_currentMapStyle];
  L.tileLayer(style.url, { attribution: style.attribution, maxZoom: 23, maxNativeZoom: style.maxNativeZoom }).addTo(_leafletMapBathy);
  if (style.labels) {
    L.tileLayer(style.labels, { attribution: '', maxZoom: 23, maxNativeZoom: style.maxNativeZoom, opacity: 0.65 }).addTo(_leafletMapBathy);
  }
  L.control.zoom({ position: 'bottomright' }).addTo(_leafletMapBathy);

  _rebuildBathyBaseLayer();
  _rebuildBathyCellLayers();
  _addSelectionHandlersBathy();
  _applyModeToLeafletBathy();
}

// Même bascule outil Sélection/Vue que le tableau de bord (state.view.mode, partagé) — en mode
// Vue, le glisser Leaflet natif (pan) reste actif ; en mode Sélection, il est désactivé pour
// laisser place au tracé du rectangle de sélection (voir _addSelectionHandlersBathy).
function _applyModeToLeafletBathy() {
  if (!_leafletMapBathy) return;
  if (state.view.mode === 'select') {
    _leafletMapBathy.dragging.disable();
    _leafletMapBathy.getContainer().style.cursor = 'crosshair';
  } else {
    _leafletMapBathy.dragging.enable();
    _leafletMapBathy.getContainer().style.cursor = 'grab';
  }
}

// Sélection directe sur la carte (glisser = rectangle, clic simple = bascule une case) — mêmes
// gestes que _addSelectionHandlersDash sur le tableau de bord, même état de sélection partagé
// (state.cells[i].selected), donc la sélection faite ici est exactement celle utilisée par
// startBathySurvey() et reste visible/modifiable depuis le tableau de bord aussi.
function _addSelectionHandlersBathy() {
  let _startLL = null, _startPt = null, _selRectLayer = null;

  _leafletMapBathy.on('mousedown', e => {
    if (state.view.mode !== 'select' || e.originalEvent.button !== 0) return;
    _startLL = e.latlng;
    _startPt = e.containerPoint;
    _leafletMapBathy.dragging.disable();
    e.originalEvent.preventDefault();
  });

  _leafletMapBathy.on('mousemove', e => {
    if (!_startLL) return;
    if (_selRectLayer) _leafletMapBathy.removeLayer(_selRectLayer);
    _selRectLayer = L.rectangle([_startLL, e.latlng], {
      color: '#0ea5e9', weight: 1.5, fillColor: '#0ea5e9', fillOpacity: 0.08,
      dashArray: '5,4', interactive: false,
    }).addTo(_leafletMapBathy);
  });

  _leafletMapBathy.on('mouseup', e => {
    if (!_startLL) return;
    if (_selRectLayer) { _leafletMapBathy.removeLayer(_selRectLayer); _selRectLayer = null; }
    if (state.view.mode === 'select') _leafletMapBathy.dragging.disable();
    else _leafletMapBathy.dragging.enable();

    const origin = state.pond?.origin; if (!origin) { _startLL = null; return; }
    const dx = Math.abs(e.containerPoint.x - _startPt.x);
    const dy = Math.abs(e.containerPoint.y - _startPt.y);
    const hcs = params.cellSize / 2;

    if (dx > 8 || dy > 8) {
      const swLL = { lat: Math.min(_startLL.lat, e.latlng.lat), lng: Math.min(_startLL.lng, e.latlng.lng) };
      const neLL = { lat: Math.max(_startLL.lat, e.latlng.lat), lng: Math.max(_startLL.lng, e.latlng.lng) };
      const sw = latLngToMeters(swLL.lat, swLL.lng, origin.lat, origin.lng);
      const ne = latLngToMeters(neLL.lat, neLL.lng, origin.lat, origin.lng);
      let changed = false;
      for (const cell of state.cells) {
        if (cell.cx + hcs > sw.x && cell.cx - hcs < ne.x && cell.cy + hcs > sw.y && cell.cy - hcs < ne.y) {
          cell.selected = true; changed = true;
        }
      }
      if (changed) { _updateBathyCellStyles(); renderAllPondCanvases(); if (_satModeDash && typeof L !== 'undefined') _rebuildCellLayersDash(); debouncedSaveSelection(); }
    } else {
      const local = latLngToMeters(e.latlng.lat, e.latlng.lng, origin.lat, origin.lng);
      const cell = state.cells.find(c => Math.abs(c.cx - local.x) <= hcs && Math.abs(c.cy - local.y) <= hcs);
      if (cell) { cell.selected = !cell.selected; _updateBathyCellStyles(); renderAllPondCanvases(); if (_satModeDash && typeof L !== 'undefined') _rebuildCellLayersDash(); debouncedSaveSelection(); }
    }
    _startLL = null; _startPt = null;
  });

  _leafletMapBathy.getContainer().addEventListener('mouseleave', () => {
    if (_selRectLayer) { _leafletMapBathy.removeLayer(_selRectLayer); _selRectLayer = null; }
    if (_startLL) { if (state.view.mode === 'select') _leafletMapBathy.dragging.disable(); else _leafletMapBathy.dragging.enable(); _startLL = null; }
  });

  // Mode Vue : un clic sur une case affiche sa fiche d'info au lieu de (dé)sélectionner —
  // le glisser natif Leaflet (pan) reste actif, ce handler ne réagit qu'au clic simple.
  _leafletMapBathy.on('click', e => {
    if (state.view.mode !== 'view') return;
    const origin = state.pond?.origin; if (!origin) return;
    const local = latLngToMeters(e.latlng.lat, e.latlng.lng, origin.lat, origin.lng);
    const hcs = params.cellSize / 2;
    const idx = state.cells.findIndex(c => Math.abs(c.cx - local.x) <= hcs && Math.abs(c.cy - local.y) <= hcs);
    if (idx !== -1) showBathyCellInfo(idx); else closeBathyCellInfo();
  });
}

function _rebuildBathyBaseLayer() {
  if (_bathyBaseLayer) { try { _leafletMapBathy.removeLayer(_bathyBaseLayer); } catch {} _bathyBaseLayer = null; }
  if (!state.pond || !isValidOrigin(state.pond.origin)) return;
  const polyLL = state.pond.polygon.map(p => { const ll = metersToLatLng(p.x, p.y); return [ll.lat, ll.lng]; });
  _bathyBaseLayer = L.polygon(polyLL, { color: '#e6edf3', weight: 1.5, fillOpacity: 0, dashArray: '4,4' }).addTo(_leafletMapBathy);
  _leafletMapBathy.fitBounds(_bathyBaseLayer.getBounds(), { padding: [24, 24] });
}

// Rebuild complet (chargement d'étang) : géométrie des cases seulement, la couleur est mise à
// jour séparément et bien plus souvent par _updateBathyCellStyles() (changement de métrique/
// relevé/palette — pas besoin de recréer les rectangles à chaque fois, juste leur style).
function _rebuildBathyCellLayers() {
  for (const l of _bathyCellRects) { if (l) try { _leafletMapBathy.removeLayer(l); } catch {} }
  _bathyCellRects.length = 0;
  if (!state.pond) return;
  if (!_bathyCellRenderer) _bathyCellRenderer = L.canvas({ padding: 0.5 });
  const cs = params.cellSize;
  for (const cell of state.cells) {
    const sw = metersToLatLng(cell.cx - cs / 2, cell.cy - cs / 2);
    const ne = metersToLatLng(cell.cx + cs / 2, cell.cy + cs / 2);
    if (!sw || !ne) { _bathyCellRects.push(null); continue; }
    const rect = L.rectangle([[sw.lat, sw.lng], [ne.lat, ne.lng]], {
      renderer: _bathyCellRenderer, stroke: false, fillOpacity: 0,
    }).addTo(_leafletMapBathy);
    _bathyCellRects.push(rect);
  }
}

// La couleur de remplissage vient du relevé (données) ; le contour indique la sélection
// courante (cases à relever au prochain lancement) — les deux sont indépendants, une case déjà
// relevée reste sélectionnable pour un nouveau passage (contrôle, après travaux...).
function _updateBathyCellStyles() {
  if (!_leafletMapBathy || !_bathyCellRects.length) return;
  const values = computeBathyDisplayValues();
  const min = state.bathy._lastMin, max = state.bathy._lastMax;
  const range = (max - min) || (Math.abs(max) || 1) * 0.05 || 1;
  const metric = state.bathy.metric;
  for (let i = 0; i < _bathyCellRects.length; i++) {
    const rect = _bathyCellRects[i];
    if (!rect) continue;
    const selected = !!state.cells[i]?.selected;
    const style = selected
      ? { stroke: true, color: '#0ea5e9', weight: 1.5, opacity: 0.85 }
      : { stroke: false };
    const v = values ? values[i] : null;
    if (v == null || min == null) style.fillOpacity = 0;
    else {
      const frac = Math.max(0, Math.min(1, (v - min) / range));
      style.fillOpacity = 0.72; style.fillColor = bathyColorForFrac(metric, frac);
    }
    rect.setStyle(style);
  }
}

function _updateBathyScanMarker() {
  if (!_leafletMapBathy) return;
  const cell = state.cells[state.bathy.markerIdx];
  if (!cell) return;
  const ll = metersToLatLng(cell.cx, cell.cy);
  if (!ll) return;
  if (!_bathyMarkerLayer) {
    _bathyMarkerLayer = L.circleMarker([ll.lat, ll.lng], {
      radius: 7, color: '#fff', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 1,
    }).addTo(_leafletMapBathy);
  } else {
    _bathyMarkerLayer.setLatLng([ll.lat, ll.lng]);
  }
}
function _removeBathyScanMarker() {
  if (_bathyMarkerLayer && _leafletMapBathy) { try { _leafletMapBathy.removeLayer(_bathyMarkerLayer); } catch {} }
  _bathyMarkerLayer = null;
}

// ── Stats + historique + peuplement des menus déroulants ───────────────────────────────────
function updateBathySurveyStats() {
  const pond = state.pond;
  const survey = pond?.bathySurveys?.find(s => s.id === state.bathy.selectedSurveyId)
              || pond?.bathySurveys?.[pond?.bathySurveys?.length - 1];
  if (!survey) {
    ['bathySurveyCells', 'bathySurveyWaterVol', 'bathySurveyMudVol', 'bathySurveyAvgWater',
     'bathySurveyAvgMud', 'bathySurveyAvgTotal', 'bathySurveyEnergy', 'bathySurveyDate']
      .forEach(id => setText(id, '—'));
    return;
  }
  const cellArea = params.cellSize * params.cellSize;
  const defined  = survey.readings.filter(Boolean);
  const waterVol = defined.reduce((s, r) => s + r.water * cellArea, 0);
  const mudVol   = defined.reduce((s, r) => s + r.mud   * cellArea, 0);
  const avgWater = defined.length ? defined.reduce((s, r) => s + r.water, 0) / defined.length : 0;
  const avgMud   = defined.length ? defined.reduce((s, r) => s + r.mud,   0) / defined.length : 0;
  const wh       = computeBathySurveyEnergyWh(defined.length);
  setText('bathySurveyCells',    defined.length.toLocaleString('fr-FR'));
  setText('bathySurveyWaterVol', formatVolM3(waterVol));
  setText('bathySurveyMudVol',   formatVolM3(mudVol));
  setText('bathySurveyAvgWater', defined.length ? avgWater.toFixed(2) + ' m' : '—');
  setText('bathySurveyAvgMud',   defined.length ? avgMud.toFixed(2)   + ' m' : '—');
  setText('bathySurveyAvgTotal', defined.length ? (avgWater + avgMud).toFixed(2) + ' m' : '—');
  setText('bathySurveyEnergy',   `${formatEnergyWh(wh)} (≈ ${formatEnergyCost(wh, params.elecTariff)})`);
  setText('bathySurveyDate',     new Date(survey.date).toLocaleString('fr-FR'));
}

function updateBathyCompareStats() {
  const pond = state.pond;
  const before = pond?.bathySurveys?.find(s => s.id === state.bathy.compareBeforeId);
  const after  = pond?.bathySurveys?.find(s => s.id === state.bathy.compareAfterId);
  if (!before || !after) {
    ['bathyCompareBefore', 'bathyCompareAfter', 'bathyCompareRemoved', 'bathyCompareTheoretical', 'bathyCompareCells']
      .forEach(id => setText(id, '—'));
    return;
  }
  const cellArea = params.cellSize * params.cellSize;
  let volBefore = 0, volAfter = 0, removed = 0, n = 0;
  before.readings.forEach((rb, i) => {
    const ra = after.readings[i];
    if (rb) volBefore += rb.mud * cellArea;
    if (ra) volAfter  += ra.mud * cellArea;
    if (rb && ra) { removed += Math.max(0, rb.mud - ra.mud) * cellArea; n++; }
  });
  setText('bathyCompareBefore',      formatVolM3(volBefore));
  setText('bathyCompareAfter',       formatVolM3(volAfter));
  setText('bathyCompareRemoved',     formatVolM3(removed));
  setText('bathyCompareTheoretical', formatVolM3(mudVolumeForCells(n)));
  setText('bathyCompareCells',       n.toLocaleString('fr-FR'));
}

function populateBathySurveySelects() {
  const pond = state.pond, b = state.bathy;
  const surveys = pond?.bathySurveys || [];
  const opts = surveys.map(s => `<option value="${s.id}">${s.label}</option>`).join('');

  const surveySel = document.getElementById('bathySurveySelect');
  if (surveySel) {
    surveySel.innerHTML = opts || '<option value="">—</option>';
    if (!b.selectedSurveyId && surveys.length) b.selectedSurveyId = surveys[surveys.length - 1].id;
    surveySel.value = b.selectedSurveyId || '';
  }
  const beforeSel = document.getElementById('bathyBeforeSelect');
  const afterSel  = document.getElementById('bathyAfterSelect');
  if (beforeSel) {
    beforeSel.innerHTML = opts || '<option value="">—</option>';
    if (!b.compareBeforeId) { const s = latestBathySurvey(pond, 'before'); if (s) b.compareBeforeId = s.id; }
    beforeSel.value = b.compareBeforeId || '';
  }
  if (afterSel) {
    afterSel.innerHTML = opts || '<option value="">—</option>';
    if (!b.compareAfterId) { const s = latestBathySurvey(pond, 'after'); if (s) b.compareAfterId = s.id; }
    afterSel.value = b.compareAfterId || '';
  }
}

function renderBathyHistory() {
  const container = document.getElementById('bathyHistoryList');
  if (!container) return;
  const surveys = state.pond?.bathySurveys || [];
  if (!surveys.length) { container.innerHTML = '<div class="sel-empty">Aucun relevé enregistré</div>'; return; }
  container.innerHTML = surveys.slice().reverse().map(s => {
    const n = s.readings.filter(Boolean).length;
    return `
    <div class="sel-item">
      <span class="sel-item-name" title="${s.label}">${s.label}</span>
      <span class="sel-item-count">${n} cases</span>
      <button class="sel-item-btn" onclick="setBathySurvey('${s.id}'); const sel=document.getElementById('bathySurveySelect'); if(sel) sel.value='${s.id}';" title="Afficher">👁</button>
      <button class="sel-item-btn del" onclick="deleteBathySurvey('${s.id}')" title="Supprimer">✕</button>
    </div>`;
  }).join('');
}

function renderBathyTab() {
  populateBathySurveySelects();
  // La carte Leaflet bathymétrie ne se reconstruit pas toute seule quand on change d'étang —
  // seul renderBathyCanvas() est appelé automatiquement (métrique/relevé/palette). Si la carte
  // existe déjà (onglet déjà ouvert une fois), on doit explicitement la rebrancher sur le
  // nouvel étang ici.
  if (_leafletMapBathy) { _rebuildBathyBaseLayer(); _rebuildBathyCellLayers(); }
  renderBathyCanvas();
  updateBathyLegend();
  updateBathySurveyStats();
  updateBathyCompareStats();
  renderBathyHistory();
}

// ============================================================
// SELECTION HISTORY
// ============================================================
function saveCurrentSelection() {
  if (!state.pond || !state.cells.length) { showToast('Aucun étang chargé', 'error'); return; }
  const name = document.getElementById('selNameInput').value.trim()
    || `Sélection ${(state.pond.selections?.length || 0) + 1}`;
  const count = state.cells.filter(c => c.selected).length;
  if (count === 0) { showToast('Aucune case sélectionnée', 'error'); return; }

  if (!state.pond.selections) state.pond.selections = [];
  state.pond.selections.push({
    id: Date.now().toString(),
    name,
    timestamp: Date.now(),
    cellStates: state.cells.map(c => c.selected),
    count,
  });
  document.getElementById('selNameInput').value = '';
  saveWork();
  renderSelectionHistory();
  showToast(`Sélection "${name}" sauvegardée (${count} cases)`, 'success');
}

function loadSavedSelection(selId) {
  if (!state.pond?.selections) return;
  const sel = state.pond.selections.find(s => s.id === selId);
  if (!sel) return;
  sel.cellStates.forEach((selected, i) => { if (state.cells[i]) state.cells[i].selected = selected; });
  renderAllPondCanvases();
  showToast(`Sélection "${sel.name}" chargée`);
}

function deleteSavedSelection(selId) {
  if (!state.pond?.selections) return;
  state.pond.selections = state.pond.selections.filter(s => s.id !== selId);
  saveWork();
  renderSelectionHistory();
}

function renderSelectionHistory() {
  const container = document.getElementById('selectionHistoryList');
  if (!container) return;
  const sels = state.pond?.selections || [];
  if (!sels.length) {
    container.innerHTML = '<div class="sel-empty">Aucune sélection sauvegardée</div>';
    return;
  }
  container.innerHTML = sels.map(s => `
    <div class="sel-item">
      <span class="sel-item-name" title="${s.name}">${s.name}</span>
      <span class="sel-item-count">${s.count} cases</span>
      <button class="sel-item-btn" onclick="loadSavedSelection('${s.id}')" title="Charger">↩</button>
      <button class="sel-item-btn del" onclick="deleteSavedSelection('${s.id}')" title="Supprimer">✕</button>
    </div>`).join('');
}

// ============================================================
// CELL SELECTION
// ============================================================
function selectAllCells() {
  if (!state.cells.length) return;
  state.cells.forEach(c => { c.selected = true; });
  renderAllPondCanvases();
  if (_satModeDash && typeof L !== 'undefined') _rebuildCellLayersDash();
  renderBathyCanvas();
  debouncedSaveSelection();
  showToast(`${state.cells.length} cases sélectionnées`);
}

function deselectAllCells() {
  state.cells.forEach(c => { c.selected = false; });
  renderAllPondCanvases();
  if (_satModeDash && typeof L !== 'undefined') _rebuildCellLayersDash();
  renderBathyCanvas();
  debouncedSaveSelection();
}

function selectRemainingCells() {
  if (!state.cells.length) return;
  let count = 0;
  state.cells.forEach(c => {
    c.selected = !c.completed;
    if (!c.completed) count++;
  });
  renderAllPondCanvases();
  if (_satModeDash && typeof L !== 'undefined') _rebuildCellLayersDash();
  renderBathyCanvas();
  debouncedSaveSelection();
  showToast(`${count} cases restantes sélectionnées`);
}

function getCellAt(wx, wy) {
  const cs = params.cellSize;
  return state.cells.find(c =>
    Math.abs(c.cx - wx) <= cs/2 && Math.abs(c.cy - wy) <= cs/2
  ) || null;
}

// Le clic/toucher est-il assez proche de la poignée de l'ancre du tuyau pour la saisir ?
function hitTestHoseAnchor(screenX, screenY, radiusPx) {
  if (!state.pond?.hoseAnchor) return false;
  const a = worldToScreen(state.pond.hoseAnchor.x, state.pond.hoseAnchor.y);
  return Math.hypot(screenX - a.x, screenY - a.y) <= radiusPx;
}

// Déplace l'ancre du tuyau vers (wx,wy), toujours reprojetée sur la berge (contour de l'étang)
function dragHoseAnchorTo(wx, wy) {
  if (!state.pond) return;
  state.pond.hoseAnchor = nearestPointOnPolygon(state.pond.polygon, wx, wy);
  renderAllPondCanvases();
}

// ============================================================
// PERSISTENCE
// ============================================================
function savePonds() {
  if (USE_CLOUD) {
    for (const pond of state.ponds) {
      window.db.collection('aquabot_ponds').doc(pond.id)
        .set(pondToFirestore(pond))
        .catch(err => {
          console.warn('Cloud save error:', err.message);
          // "Document ... exceeds the maximum allowed size" (limite Firestore de 1 Mo/document) :
          // survient quand trop de relevés bathymétriques (avec leurs lectures par case)
          // s'accumulent sur un même étang — message générique peu actionnable sinon, alors qu'un
          // geste simple (supprimer d'anciens relevés, bouton ✕ dans l'historique) résout le
          // problème immédiatement, sans attendre un correctif.
          const tooLarge = /exceeds the maximum allowed size/i.test(err.message);
          const msg = tooLarge
            ? `« ${pond.name} » n'a pas pu être enregistré : trop de relevés bathymétriques accumulés pour cet étang. Supprimez d'anciens relevés (✕ dans l'historique, onglet Bathymétrie) pour libérer de la place.`
            : `Échec de l'enregistrement de « ${pond.name} » — ${err.message}`;
          showToast(msg, 'error');
        });
    }
  } else {
    localStorage.setItem('aquabot_ponds', JSON.stringify(state.ponds));
  }
}

let _cloudFirstSnapshot = true;
let _simUnsubscribe       = null;
let _selDebounce          = null;
let _localSelChanging     = false;
let _telemetryUnsubscribe = null;

function loadPonds() {
  if (USE_CLOUD) {
    updateCloudStatus('connecting');
    window.db.collection('aquabot_ponds')
      .orderBy('lastUsed', 'desc')
      .onSnapshot(snapshot => {
        updateCloudStatus('online');
        // Ne redécode QUE les ponds dont le document a réellement changé (docChanges), au lieu de
        // repasser TOUTE la collection par pondFromFirestore à chaque snapshot — décoder
        // l'historique bathymétrique d'un étang (potentiellement plusieurs relevés de plusieurs
        // milliers de cases chacun) coûte plusieurs dizaines de ms, et le refaire pour CHAQUE
        // étang à CHAQUE snapshot (y compris pour un changement sur un seul autre étang, ou nos
        // propres écritures pendant un chantier en cours) causait un ralentissement sensible du
        // navigateur, en particulier avec plusieurs étangs ou beaucoup de relevés accumulés.
        const byId = new Map(state.ponds.map(p => [p.id, p]));
        snapshot.docChanges().forEach(change => {
          if (change.type === 'removed') { byId.delete(change.doc.id); return; }
          // L'étang activement piloté localement n'a pas besoin d'être redécodé pour ses propres
          // écritures (de toute façon ignorées ci-dessous tant que state.sim.running) — regénérer
          // toute sa grille de cases à chaque sauvegarde périodique serait un travail perdu.
          if (state.sim.running && state.pond && change.doc.id === state.pond.id) return;
          byId.set(change.doc.id, pondFromFirestore(change.doc.data()));
        });
        state.ponds = snapshot.docs.map(d => byId.get(d.id)).filter(Boolean);

        // Sync active pond when another user makes changes
        if (state.pond && !state.sim.running) {
          const remote = state.ponds.find(p => p.id === state.pond.id);
          if (remote) {
            remote.cells.forEach((c, i) => { if (state.cells[i]) state.cells[i].completed = c.completed; });
            state.robot.completedCells = remote.work.completedCells?.length || 0;
            state.robot.volumePumped   = remote.work.volumePumped || 0;
            state.robot.energyWh       = remote.work.energyWh     || 0;
            state.robot.elapsedSec     = remote.work.elapsedSec   || 0;
            state.pond.lastResetAt     = remote.lastResetAt || 0;
            state.pond.work            = remote.work;
            state.pond.selections      = remote.selections;
            // Sync live selection from other device (skip if we have pending local changes)
            if (!_localSelChanging && remote.currentSelectedIndices !== undefined) {
              const selSet = decodeSelection(remote.currentSelectedIndices, state.cells.length) || new Set();
              state.cells.forEach((c, i) => { c.selected = selSet.has(i); });
            }
            renderSelectionHistory();
            renderAllPondCanvases();
          }
        }

        // Auto-load most recent pond on first connection
        if (_cloudFirstSnapshot) {
          _cloudFirstSnapshot = false;
          if (state.ponds.length > 0 && !state.pond) loadPond(state.ponds[0]);
        }

        updatePondsList();
        updateUI();
      }, err => {
        updateCloudStatus('error');
        showToast('Erreur Firebase : ' + err.message, 'error');
      });
  } else {
    updateCloudStatus('offline');
    try {
      const d = localStorage.getItem('aquabot_ponds');
      if (d) state.ponds = JSON.parse(d);
    } catch { state.ponds = []; }
  }
}

function saveParameters() {
  const domMap = {
    pSeuilR:'seuilR', pSeuilD:'seuilD', pNbDepas:'nbDepas', pNbTours:'nbTours', pNbToursMax:'nbToursMax',
    pPwmDemR:'pwmDemR', pPwmDemD:'pwmDemD', pPwmMaxR:'pwmMaxR', pPwmMaxD:'pwmMaxD',
    pPasNormR:'pasNormR', pPasNormD:'pasNormD', pPasRapR:'pasRapR', pPasRapD:'pasRapD',
    pPwmManLR:'pwmManLR', pPwmManLD:'pwmManLD', pPwmManRR:'pwmManRR', pPwmManRD:'pwmManRD',
    pMiniCycles:'miniCycles', pToursRedesc:'toursRedesc', pFreqTrait:'freqTrait',
    pWaterDepth:'waterDepth', pMudDepth:'mudDepth', pPumpTime:'pumpTime',
    pPumpDescentSpeed:'pumpDescentSpeed', pPumpAscentSpeed:'pumpAscentSpeed',
    pPumpFlow:'pumpFlow', pRobotSpeed:'robotSpeed', pCurageResidualMud:'curageResidualMud',
  };
  for (const [domId, key] of Object.entries(domMap)) {
    const el = document.getElementById(domId);
    if (el) params[key] = parseFloat(el.value) || 0;
  }
  params.wifiType     = document.getElementById('pWifiType').value;
  params.wifiSSID     = document.getElementById('pWifiSSID').value;
  params.wifiPassword = document.getElementById('pWifiPassword').value;
  params.wifiIP       = document.getElementById('pWifiIP').value;
  // Work mode from radio buttons
  const wmEl = document.querySelector('input[name="workMode"]:checked');
  if (wmEl) params.workMode = wmEl.value;
  const cmEl = document.querySelector('input[name="curageMode"]:checked');
  if (cmEl) params.curageMode = cmEl.value;
  persistParams();
  showToast('Paramètres enregistrés', 'success');
}

// Affichage immédiat (avant même de cliquer "Enregistrer") de la profondeur résiduelle de vase,
// pertinente seulement en mode "curage à profondeur cible".
function updateCurageModeUI() {
  const cmEl = document.querySelector('input[name="curageMode"]:checked');
  const row = document.getElementById('curageResidualRow');
  if (row) row.style.display = (cmEl && cmEl.value === 'partiel') ? 'flex' : 'none';
}

function loadDefaultParameters() {
  params.waterDepth = 2.0; params.mudDepth = 0.3; params.pumpTime = 30;
  params.pumpDescentSpeed = 0.05; params.pumpAscentSpeed = 0.08;
  params.pumpFlow = 500; params.robotSpeed = 0.20;
  syncParamsToDOM();
  showToast('Valeurs par défaut restaurées');
}

function syncParamsToDOM() {
  const m = {
    pSeuilR:'seuilR', pSeuilD:'seuilD', pNbDepas:'nbDepas', pNbTours:'nbTours', pNbToursMax:'nbToursMax',
    pPwmDemR:'pwmDemR', pPwmDemD:'pwmDemD', pPwmMaxR:'pwmMaxR', pPwmMaxD:'pwmMaxD',
    pPasNormR:'pasNormR', pPasNormD:'pasNormD', pPasRapR:'pasRapR', pPasRapD:'pasRapD',
    pPwmManLR:'pwmManLR', pPwmManLD:'pwmManLD', pPwmManRR:'pwmManRR', pPwmManRD:'pwmManRD',
    pMiniCycles:'miniCycles', pToursRedesc:'toursRedesc', pFreqTrait:'freqTrait',
    pWaterDepth:'waterDepth', pMudDepth:'mudDepth', pPumpTime:'pumpTime',
    pPumpDescentSpeed:'pumpDescentSpeed', pPumpAscentSpeed:'pumpAscentSpeed',
    pPumpFlow:'pumpFlow', pRobotSpeed:'robotSpeed', pCurageResidualMud:'curageResidualMud',
  };
  // Ne jamais écraser un champ que l'utilisateur est en train de modifier sur CET appareil —
  // important maintenant que cette fonction peut aussi être déclenchée par un changement
  // distant (voir subscribeParams), pas seulement par une action locale explicite.
  for (const [id, key] of Object.entries(m)) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = params[key];
  }
  const wifiFields = { pWifiType: 'wifiType', pWifiSSID: 'wifiSSID', pWifiPassword: 'wifiPassword', pWifiIP: 'wifiIP' };
  for (const [id, key] of Object.entries(wifiFields)) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = params[key];
  }
  const wmEl = document.querySelector(`input[name="workMode"][value="${params.workMode}"]`);
  if (wmEl) wmEl.checked = true;
  const cmEl = document.querySelector(`input[name="curageMode"][value="${params.curageMode}"]`);
  if (cmEl) cmEl.checked = true;
  const curageResidualRow = document.getElementById('curageResidualRow');
  if (curageResidualRow) curageResidualRow.style.display = params.curageMode === 'partiel' ? 'flex' : 'none';
}

// Diffusion en direct des réglages (Paramètres, tarif, solaire...) à tous les appareils
// connectés — appelée une fois au démarrage. Contrairement à la simulation, pas besoin de
// notion de « pilote » ici : n'importe quel appareil peut modifier les réglages, le dernier à
// écrire l'emporte, exactement comme on s'attendrait à ce que ça marche pour un simple réglage.
let _paramsUnsubscribe = null;
function subscribeParams() {
  if (!USE_CLOUD || _paramsUnsubscribe) return;
  _paramsUnsubscribe = window.db.collection('aquabot_meta').doc('params').onSnapshot(doc => {
    if (!doc.exists) return;
    const remote = doc.data();
    if (!remote) return;
    Object.assign(params, remote);
    localStorage.setItem('aquabot_params', JSON.stringify(params));
    syncParamsToDOM();
    updateEnergyTab();
    updateHoseLengthDisplay();
    renderAllPondCanvases();
  }, e => reportFirestoreError(e, 'subscribeParams'));
}

// ============================================================
// COORDINATE TRANSFORMS
// ============================================================
// y est inversé pour que nord (y+) soit en haut de l'écran, comme sur le satellite
function worldToScreen(wx, wy) {
  const H = state.view.canvasH;
  return {
    x: (wx - state.view.offsetX) * state.view.scale,
    y: H - (wy - state.view.offsetY) * state.view.scale,
  };
}
function screenToWorld(sx, sy) {
  const H = state.view.canvasH;
  return {
    x: sx / state.view.scale + state.view.offsetX,
    y: (H - sy) / state.view.scale + state.view.offsetY,
  };
}

function fitPond() {
  if (!state.pond) return;
  const canvas = document.getElementById('dashPondCanvas');
  if (!canvas || !canvas.width) return;
  const W = canvas.width, H = canvas.height;
  const { minX, maxX, minY, maxY } = getPondBbox(state.pond);
  const pad = 40;
  // La coupe verticale flotte en haut à droite du canvas : on réserve sa largeur pour garder
  // l'étang centré côté gauche, jamais masqué dessous.
  let usableW = W;
  const widget = document.getElementById('sectionWidget');
  if (widget) usableW = Math.max(120, W - widget.offsetWidth - 20);
  state.view.scale   = Math.min((usableW-pad*2)/(maxX-minX), (H-pad*2)/(maxY-minY));
  state.view.offsetX = minX - pad/state.view.scale;
  state.view.offsetY = minY - pad/state.view.scale;
  renderAllPondCanvases();
  updateScaleInfo();
}

function updateScaleInfo() {
  setText('scaleInfo', `1m = ${state.view.scale.toFixed(1)}px`);
}

function zoomIn()  { zoomAt(1.3); }
function zoomOut() { zoomAt(1/1.3); }
function zoomAt(factor) {
  const canvas = document.getElementById('dashPondCanvas');
  if (!canvas) return;
  const cx = canvas.width/2, cy = canvas.height/2;
  const wc = screenToWorld(cx, cy);
  state.view.scale = Math.max(0.5, Math.min(500, state.view.scale * factor));
  state.view.offsetX = wc.x - cx/state.view.scale;
  state.view.offsetY = wc.y - cy/state.view.scale;
  renderAllPondCanvases();
  updateScaleInfo();
}

// ============================================================
// CANVAS RENDERER
// ============================================================
// Redessiner un canvas caché (onglet non actif, ou masqué par le mode satellite via
// visibility:hidden — voir toggleSatelliteViewDash) est un travail pur perdu : pour un grand
// étang (des milliers de cases), ça revient à boucler sur toutes les cases 20×/s (voir
// simulationTick) pour un résultat que personne ne voit jamais. En mode satellite (le mode par
// défaut), c'était systématiquement le cas pour dashPondCanvas — la cause probable du
// ralentissement général du navigateur pendant la simulation sur un gros étang.
function _isCanvasActuallyVisible(c) {
  return c.offsetParent !== null && c.style.visibility !== 'hidden';
}

function renderAllPondCanvases() {
  for (const id of CANVAS_IDS) {
    const c = document.getElementById(id);
    if (c && _isCanvasActuallyVisible(c)) {
      if (state.dash3D.active) renderDash3D(); else renderPondCanvas(c);
    }
  }
}

function renderPondCanvas(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  state.view.canvasH = H;
  ctx.clearRect(0, 0, W, H);
  if (!state.pond) return;

  // Background grid (10m)
  ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 0.5;
  const wStart = screenToWorld(0,0), wEnd = screenToWorld(W,H);
  const gs = 10;
  const xMin = Math.min(wStart.x, wEnd.x), xMax = Math.max(wStart.x, wEnd.x);
  const yMin = Math.min(wStart.y, wEnd.y), yMax = Math.max(wStart.y, wEnd.y);
  for (let gx = Math.floor(xMin/gs)*gs; gx < xMax; gx += gs) {
    const s = worldToScreen(gx,0); ctx.beginPath(); ctx.moveTo(s.x,0); ctx.lineTo(s.x,H); ctx.stroke();
  }
  for (let gy = Math.floor(yMin/gs)*gs; gy < yMax; gy += gs) {
    const s = worldToScreen(0,gy); ctx.beginPath(); ctx.moveTo(0,s.y); ctx.lineTo(W,s.y); ctx.stroke();
  }

  const poly = state.pond.polygon;
  const cs   = params.cellSize;
  const cpx  = state.view.scale * cs;

  // Pond fill
  ctx.beginPath();
  for (let i = 0; i < poly.length; i++) {
    const s = worldToScreen(poly[i].x, poly[i].y);
    i === 0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y);
  }
  ctx.closePath();
  ctx.fillStyle   = 'rgba(14,165,233,0.07)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(14,165,233,0.55)';
  ctx.lineWidth   = 2; ctx.stroke();

  // Grid cells
  if (cpx > 1.2) {
    for (const cell of state.cells) {
      const sx = worldToScreen(cell.cx - cs/2, cell.cy + cs/2);
      if (cell.completed)    ctx.fillStyle = 'rgba(16,185,129,0.72)';
      else if (cell.selected) ctx.fillStyle = cpx > 4 ? 'rgba(14,165,233,0.28)' : 'rgba(14,165,233,0.18)';
      else                    ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(sx.x, sx.y, cpx, cpx);
      if (cpx > 5) {
        ctx.strokeStyle = cell.completed
          ? 'rgba(16,185,129,0.5)'
          : cell.selected ? 'rgba(14,165,233,0.3)' : 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(sx.x, sx.y, cpx, cpx);
      }
    }
  }

  // Planned path
  if (state.plannedPath.length > 1 && cpx > 2) {
    ctx.strokeStyle  = 'rgba(251,191,36,0.55)';
    ctx.lineWidth    = Math.max(1, cpx*0.2);
    ctx.setLineDash([cpx*0.4, cpx*0.4]);
    ctx.beginPath();
    for (let i = 0; i < state.plannedPath.length; i++) {
      const cell = state.cells[state.plannedPath[i]];
      if (!cell) continue;
      const s = worldToScreen(cell.cx, cell.cy);
      i === 0 ? ctx.moveTo(s.x,s.y) : ctx.lineTo(s.x,s.y);
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  // Tuyau d'évacuation flottant — de l'ancre (berge) au robot, en petites courbes
  if (state.pond.hoseAnchor) {
    const hosePts = computeHoseCurvePoints(state.pond.hoseAnchor, state.robot, 24, _hoseRequiredLenCache);
    ctx.beginPath();
    hosePts.forEach((p, i) => {
      const s = worldToScreen(p.x, p.y);
      i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
    });
    // Orange vif — comme les vrais tuyaux d'évacuation flottants (visibilité sur l'eau),
    // et surtout largement visible sur le fond sombre du schéma.
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth   = Math.max(3, 0.16 * state.view.scale);
    ctx.lineCap     = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth   = Math.max(2, 0.12 * state.view.scale);
    ctx.stroke();
    // Petit reflet clair pour l'effet "boyau flottant"
    ctx.strokeStyle = 'rgba(255,237,213,0.6)';
    ctx.lineWidth   = Math.max(1, 0.05 * state.view.scale);
    ctx.stroke();

    // Ancre — poignée à saisir pour la repositionner sur la berge réelle
    const aS = worldToScreen(state.pond.hoseAnchor.x, state.pond.hoseAnchor.y);
    ctx.beginPath(); ctx.arc(aS.x, aS.y, 7, 0, Math.PI*2);
    ctx.fillStyle = '#f97316'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();

    // Zone de dépôt des sédiments + segment de tuyau posé au sol (droit, pas ondulé —
    // contrairement au segment flottant robot→ancre ci-dessus) qui l'y relie.
    if (state.pond.depositZone) {
      const dz = state.pond.depositZone;
      ctx.beginPath();
      dz.polygon.forEach((p, i) => {
        const s = worldToScreen(p.x, p.y);
        i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(146,64,14,0.35)';
      ctx.fill();
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = Math.max(1.5, 0.08 * state.view.scale);
      ctx.stroke();

      const cS = worldToScreen(dz.centroid.x, dz.centroid.y);
      ctx.beginPath(); ctx.moveTo(aS.x, aS.y); ctx.lineTo(cS.x, cS.y);
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = Math.max(2, 0.1 * state.view.scale);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  // Robot
  const rr = worldToScreen(state.robot.x, state.robot.y);
  const hr  = (ROBOT_SIZE/2) * state.view.scale;
  ctx.save();
  ctx.shadowColor = 'rgba(245,158,11,0.9)'; ctx.shadowBlur = Math.max(8, hr*0.8);
  ctx.fillStyle   = 'rgba(245,158,11,0.35)';
  ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.rect(rr.x-hr, rr.y-hr, hr*2, hr*2); ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.arc(rr.x,rr.y,Math.max(3,hr*0.18),0,Math.PI*2); ctx.fill();
  // Pump indicator
  const pr = Math.max(3, (params.cellSize/2)*state.view.scale);
  const pumping = state.robot.pumpState === 'pumping';
  ctx.fillStyle   = pumping ? 'rgba(16,185,129,0.9)' : 'rgba(16,185,129,0.38)';
  ctx.strokeStyle = '#10b981'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(rr.x,rr.y,pr,0,Math.PI*2); ctx.fill(); ctx.stroke();
  // Propulseurs — 4 coins, intensité = poussée courante
  const motors = state.robot.motors || [0,0,0,0];
  const corners = [{dx:-hr,dy:-hr}, {dx:hr,dy:-hr}, {dx:-hr,dy:hr}, {dx:hr,dy:hr}]; // AV-G, AV-D, AR-G, AR-D
  corners.forEach((c, i) => {
    const m = motors[i] || 0;
    const r = Math.max(2, Math.min(6, Math.abs(m) / 100 * 6 + 2));
    ctx.fillStyle   = m >= 0 ? 'rgba(14,165,233,0.9)' : 'rgba(245,158,11,0.9)';
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(rr.x + c.dx, rr.y + c.dy, r, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  });
  // Cap — flèche depuis le centre
  const hRad = (state.robot.heading || 0) * Math.PI / 180;
  const ax = rr.x + Math.sin(hRad) * hr * 1.4, ay = rr.y - Math.cos(hRad) * hr * 1.4;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(rr.x, rr.y); ctx.lineTo(ax, ay); ctx.stroke();
  ctx.beginPath(); ctx.arc(ax, ay, 3, 0, Math.PI*2); ctx.fillStyle = '#fff'; ctx.fill();
  // Label
  if (state.view.scale > 6) {
    ctx.font = `bold ${Math.max(9,hr*0.5)}px sans-serif`;
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.fillText('ROBOT', rr.x, rr.y - hr - 4);
  }

  // Boussole nord
  const bx = W - 20, by = 32;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('N', bx, by - 14);
  ctx.beginPath(); ctx.moveTo(bx - 4, by - 9); ctx.lineTo(bx, by - 16); ctx.lineTo(bx + 4, by - 9); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, by - 8); ctx.lineTo(bx, by + 6); ctx.stroke();
}

// ============================================================
// SECTION CANVAS
// ============================================================
function renderSectionCanvas() {
  const canvas = document.getElementById('sectionCanvas');
  if (!canvas) return;
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Profondeur RÉELLE de la case en cours de travail (dernier relevé bathymétrique — voir
  // getCellBathyBaseline/simulationTick) plutôt que la valeur générique des paramètres, sans quoi
  // la coupe verticale ne reflétait jamais la vase réellement mesurée et pouvait même désaligner
  // visuellement la pompe (sa profondeur cible réelle diffère désormais de ce repère générique).
  const baseline = currentWorkingCellBaseline();
  const wd = baseline.water, md = baseline.mud;
  const tot = wd + md + 0.3, pd = state.robot.pumpDepth;
  const rW  = 40, padL = rW+8, padT = 16, padB = 16;
  const dW  = W - padL - 12, dH = H - padT - padB;
  const sc  = dH / tot;

  ctx.fillStyle = '#0d1424'; ctx.fillRect(0, 0, W, H);

  // Ruler
  ctx.fillStyle = '#1a2235'; ctx.fillRect(0, padT, rW, dH);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
  ctx.strokeRect(0, padT, rW, dH);
  ctx.font = '9px sans-serif'; ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'right';
  const tStep = tot <= 3 ? 0.5 : 1;
  for (let d = 0; d <= tot; d += tStep) {
    const y = padT + d*sc;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.moveTo(rW-5,y); ctx.lineTo(rW,y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.fillText(d.toFixed(1)+'m', rW-6, y+3);
  }

  const dx = padL, dy = padT;
  // Water
  const wH = wd*sc;
  const wg = ctx.createLinearGradient(0, dy, 0, dy+wH);
  wg.addColorStop(0,'rgba(14,165,233,0.55)'); wg.addColorStop(1,'rgba(14,165,233,0.14)');
  ctx.fillStyle = wg; ctx.fillRect(dx, dy, dW, wH);
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(dx,dy); ctx.lineTo(dx+dW,dy); ctx.stroke();
  ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = '#38bdf8'; ctx.textAlign = 'left';
  ctx.fillText('Surface', dx+4, dy+12);

  // Mud
  const mudY = dy+wd*sc, mudH = md*sc;
  const mg = ctx.createLinearGradient(0, mudY, 0, mudY+mudH);
  mg.addColorStop(0,'rgba(120,83,48,0.75)'); mg.addColorStop(1,'rgba(80,50,25,0.92)');
  ctx.fillStyle = mg; ctx.fillRect(dx, mudY, dW, mudH);
  ctx.strokeStyle = '#92400e'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(dx,mudY); ctx.lineTo(dx+dW,mudY); ctx.stroke();
  ctx.fillStyle = '#d97706'; ctx.fillText('Vase', dx+4, mudY+12);

  // Bottom
  const botY = mudY+mudH;
  ctx.fillStyle = 'rgba(60,35,15,0.92)'; ctx.fillRect(dx, botY, dW, dH-(botY-dy));
  ctx.strokeStyle = '#78350f'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(dx,botY); ctx.lineTo(dx+dW,botY); ctx.stroke();

  // ---- PUMP ASSEMBLY ----
  // Always draw the pipe even when depth=0 so user understands the system
  {
    const pd     = state.robot.pumpDepth;
    const pX     = dx + dW / 2;
    const pumpH  = 26; // pump body height px
    const pumpW  = 16;
    const pumpY  = dy + pd * sc; // bottom of pump (intake end)
    const pBodyT = pumpY - pumpH; // top of pump body
    const glow   = state.robot.pumpState === 'pumping';
    const moving = state.robot.pumpState === 'descending' ||
                   state.robot.pumpState === 'partial_ascending' ||
                   state.robot.pumpState === 'ascending';

    // Hose / flexible pipe from surface down to top of pump body
    if (pd > 0.01) {
      ctx.strokeStyle = '#7dd3fc';
      ctx.lineWidth   = 3;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(pX, dy);
      ctx.lineTo(pX, pBodyT);
      ctx.stroke();

      // Cable/guide alongside hose
      ctx.strokeStyle = 'rgba(100,120,150,0.5)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(pX + 6, dy);
      ctx.lineTo(pX + 6, pBodyT);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Pump body (only visible when descended enough)
    if (pd > 0.05) {
      if (glow) { ctx.shadowColor = '#10b981'; ctx.shadowBlur = 14; }

      // Motor section (upper 40% of body, blue)
      const motorH = Math.round(pumpH * 0.42);
      ctx.fillStyle   = '#1e3a5f';
      ctx.strokeStyle = glow ? '#38bdf8' : '#2563eb';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.roundRect(pX - pumpW/2, pBodyT, pumpW, motorH, [3, 3, 0, 0]);
      ctx.fill(); ctx.stroke();
      // Motor label
      ctx.font = `bold 7px sans-serif`;
      ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'center';
      ctx.fillText('M', pX, pBodyT + motorH * 0.65);

      // Pump casing (lower 60%, green)
      const casingY = pBodyT + motorH;
      const casingH = pumpH - motorH;
      ctx.fillStyle   = glow ? '#065f46' : '#064e3b';
      ctx.strokeStyle = glow ? '#34d399' : '#10b981';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.roundRect(pX - pumpW/2, casingY, pumpW, casingH, [0, 0, 2, 2]);
      ctx.fill(); ctx.stroke();

      // Discharge port (side connection to hose)
      ctx.fillStyle   = '#7dd3fc';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth   = 1;
      ctx.fillRect(pX - pumpW/2 - 5, pBodyT + 3, 5, 5);
      ctx.strokeRect(pX - pumpW/2 - 5, pBodyT + 3, 5, 5);

      // Intake strainer (bottom, horizontal slots)
      ctx.strokeStyle = glow ? '#86efac' : '#34d399';
      ctx.lineWidth   = 1;
      for (let i = 0; i < 5; i++) {
        const sy = casingY + casingH * 0.35 + i * 3.5;
        if (sy < pumpY) {
          ctx.beginPath();
          ctx.moveTo(pX - pumpW/2 + 2, sy);
          ctx.lineTo(pX + pumpW/2 - 2, sy);
          ctx.stroke();
        }
      }

      // Suction cup / intake bottom edge
      ctx.fillStyle   = glow ? '#34d399' : '#10b981';
      ctx.strokeStyle = glow ? '#86efac' : '#34d399';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.moveTo(pX - pumpW/2 - 3, pumpY);
      ctx.lineTo(pX + pumpW/2 + 3, pumpY);
      ctx.stroke();

      ctx.shadowBlur = 0;

      // Flow arrows when pumping (upward along hose)
      if (glow && pd > 0.3) {
        ctx.strokeStyle = 'rgba(52,211,153,0.65)';
        ctx.lineWidth   = 1.5;
        ctx.lineCap     = 'round';
        const arrowStep = Math.max(18, (pumpY - dy) / 5);
        for (let ay = pumpY - pumpH - 10; ay > dy + 12; ay -= arrowStep) {
          ctx.beginPath();
          ctx.moveTo(pX - 4, ay + 7);
          ctx.lineTo(pX,     ay);
          ctx.lineTo(pX + 4, ay + 7);
          ctx.stroke();
        }
      }

      // Depth label (right side)
      ctx.font      = 'bold 10px sans-serif';
      ctx.fillStyle = glow ? '#34d399' : '#10b981';
      ctx.textAlign = 'left';
      ctx.fillText(`↓ ${pd.toFixed(2)} m`, pX + pumpW/2 + 8, pumpY - pumpH/2 + 3);

      // Mini-cycle indicator — only during active pump phases (not during ascent)
      const nc = effectiveMiniCycles();
      const activePumpState = ['descending', 'pumping', 'partial_ascending'].includes(state.robot.pumpState);
      if (nc > 1 && activePumpState) {
        ctx.font      = '9px sans-serif';
        ctx.fillStyle = '#fbbf24';
        ctx.textAlign = 'center';
        ctx.fillText(`cycle ${state.robot.miniCyclesDone + 1}/${nc}`, pX, pBodyT - 5);
      }
    }

    // Depth ruler line (horizontal dashed)
    if (pd > 0.01) {
      ctx.strokeStyle = 'rgba(16,185,129,0.2)';
      ctx.lineWidth   = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(dx, dy + pd * sc);
      ctx.lineTo(pX - pumpW/2 - 3, dy + pd * sc);
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

// ============================================================
// PROPULSION — affichage moteurs + cap
// ============================================================
function updateMotorDisplay() {
  const motors = state.robot.motors || [0,0,0,0];
  for (let i = 0; i < 4; i++) {
    const m = motors[i] || 0;
    const pct = Math.round(Math.abs(m));
    for (const suffix of ['', 'map']) {
      const bar = document.getElementById(`motorBar${i}${suffix}`);
      if (bar) {
        bar.style.width = (pct / 2) + '%';
        bar.style.left  = m >= 0 ? '50%' : (50 - pct / 2) + '%';
        bar.classList.toggle('reverse', m < 0);
      }
      setText(`motorVal${i}${suffix}`, `${Math.round(m)}%`);
    }
    setText(`motorVal${i}mini`, `${Math.round(m)}%`);
    const fillMini = document.getElementById(`motorFill${i}mini`);
    if (fillMini) {
      fillMini.style.width = pct + '%';
      fillMini.classList.toggle('reverse', m < 0);
    }
  }
  const heading = Math.round(((state.robot.heading || 0) % 360 + 360) % 360);
  setText('rtHeading', heading);
  setText('headingVal', heading + '°');
  setText('headingValMap', heading + '°');
  setText('headingValMini', heading + '°');
  for (const id of ['headingNeedle', 'headingNeedleMap', 'headingNeedleMini']) {
    const el = document.getElementById(id);
    if (el) el.style.transform = `translate(-50%, -100%) rotate(${heading}deg)`;
  }
}

// Position GPS + case en cours de traitement, affichées dans la coupe verticale
function updateGpsDisplay() {
  const robot  = state.robot;
  const origin = state.pond?.origin || { lat: 0, lng: 0 };
  const lat = origin.lat + robot.y / 110540;
  const lng = origin.lng + robot.x / (Math.cos(origin.lat * Math.PI / 180) * 111320);
  setText('miniGpsLat', lat.toFixed(6) + '°');
  setText('miniGpsLng', lng.toFixed(6) + '°');
  const total = state.plannedPath.length;
  setText('miniGpsCell', total ? `${robot.currentCellIdx + 1}/${total}` : '—');
}

// ============================================================
// SIMULATION
// ============================================================
async function startSimulation() {
  if (!state.pond) { showToast('Sélectionnez un étang d\'abord', 'error'); return; }
  // Ne recalcule le chemin QUE pour un vrai nouveau départ (état "stopped" — que ce soit après un
  // Arrêt explicite ou une fin de chantier naturelle), jamais pour une reprise après pause (état
  // "paused", voir pauseSimulation qui rappelle startSimulation pour "Reprendre"). Se baser sur
  // "plannedPath vide" plutôt que sur cet état laissait passer un cas : finishSimulation() (fin
  // naturelle d'un chantier) ne vide jamais plannedPath contrairement à un Arrêt explicite — donc
  // après un chantier terminé, sélectionner une NOUVELLE zone puis "Démarrer" réutilisait l'ANCIEN
  // chemin (toujours non vide) au lieu de recalculer depuis la nouvelle sélection.
  const isResume = state.robot.state === 'paused';
  if (state.robotMode === 'real') {
    if (!isResume) {
      const path = planPath(state.cells);
      if (!path.length) { showToast('Sélectionnez des cases non terminées', 'error'); return; }
      state.plannedPath = path;
      renderAllPondCanvases();
    }
    sendRobotCommand('start');
    return;
  }
  if (!isResume) {
    const path = planPath(state.cells);
    if (!path.length) { showToast('Sélectionnez des cases non terminées', 'error'); return; }
    state.plannedPath = path;
  }

  // Un seul appareil calcule la simulation à la fois — comme pour le robot réel, il ne peut y
  // avoir qu'un seul « cerveau » actif. Si un autre appareil pilote déjà là, maintenant, on ne
  // démarre pas une seconde boucle locale en parallèle : c'était la cause des désynchronisations
  // entre appareils (chacun calculait sa propre progression). Cet appareil reste simple vue,
  // déjà correctement synchronisée par subscribeSimState().
  if (USE_CLOUD) {
    const owns = await claimSimOwnership(state.pond.id);
    if (!owns) {
      showToast('Simulation déjà en cours sur un autre appareil — cette vue va se synchroniser automatiquement.', 'error');
      return;
    }
  }

  if (state.robot.state === 'stopped') {
    state.robot.currentCellIdx = 0;
    state.sim.sessionElapsedAtStart = state.robot.elapsedSec;
    state.sim.paceDoneCount  = 0;
    state.sim.paceSecPerCell = null;
    autoSaveSelectionOnStart();
    const first = state.cells[state.plannedPath[0]];
    if (first) { state.robot.x = first.cx; state.robot.y = first.cy; }
    startLiveBathySurveyIfEnabled();
  }
  state.robot.state = 'moving';
  state.sim.running = true;
  state.sim.lastSimSave = Date.now();
  setLED('green', 'En travail');
  updateButtonStates();
  updateStatus('En cours...', 'Déplacement');
  document.getElementById('btnPause').textContent = '⏸ Pause';
  if (!state.sim.intervalId) {
    state.sim.lastTick = performance.now();
    state.sim.intervalId = setInterval(simulationTick, SIM_TICK_MS);
  }
  saveSimState();
}

// Exécution locale de la pause — réservée à l'appareil qui pilote réellement (voir
// pauseSimulation ci-dessous pour le cas où on ne l'est pas).
function _pauseLocally() {
  state.sim.running = false;
  state.robot.state = 'paused';
  setLED('yellow', 'En pause');
  updateButtonStates();
  updateStatus('En pause', 'Cliquez Reprendre');
  document.getElementById('btnPause').textContent = '▶ Reprendre';
  saveWork();
  saveSimState();
}

async function pauseSimulation() {
  if (state.robotMode === 'real') {
    const cmd = state.robot.state === 'paused' ? 'resume' : 'pause';
    sendRobotCommand(cmd);
    return;
  }
  if (state.robot.state === 'paused') {
    startSimulation(); return;
  }
  if (!state.sim.running) {
    if (USE_CLOUD && state.pond) {
      // Vérifie s'il y a réellement un pilote actif là, maintenant (même mécanisme que pour
      // démarrer). S'il y en a un, on se contente d'envoyer la demande de pause — c'est lui
      // qui l'appliquera (voir subscribeSimState) et rediffusera l'état exact.
      const owns = await claimSimOwnership(state.pond.id);
      if (!owns) {
        window.db.collection('aquabot_sim').doc(state.pond.id)
          .update({ simRunning: false, lastUpdate: Date.now() })
          .catch(e => reportFirestoreError(e, 'pause (commande distante)'));
        return;
      }
      // Personne ne pilote plus réellement (le vrai pilote a disparu sans s'arrêter proprement
      // — onglet fermé, crash, perte de connexion) alors que l'affichage montrait encore
      // « en marche » partout : on vient de revendiquer le pilotage ci-dessus, on applique donc
      // nous-mêmes la pause complète plutôt que d'envoyer un signal dans le vide que personne
      // n'aurait traité — c'est ce qui laissait le robot bloqué à l'écran sans qu'aucun bouton
      // ne fonctionne pour s'en sortir.
    }
  }
  _pauseLocally();
}

// Exécution locale de l'arrêt — réservée à l'appareil qui pilote réellement (voir
// stopSimulation ci-dessous pour le cas où on ne l'est pas).
function _stopLocally() {
  state.sim.running = false;
  state.robot.state = 'stopped';
  clearInterval(state.sim.intervalId);
  state.sim.intervalId = null;
  state.robot.pumpDepth  = 0;
  state.robot.pumpState  = 'idle';
  state.robot.currentCellIdx = 0;
  state.robot.motors = [0, 0, 0, 0];
  state.plannedPath = [];
  setLED('blue', 'Simulation');
  updateButtonStates();
  updateStatus('Arrêté', 'Prêt à démarrer');
  document.getElementById('btnPause').textContent = '⏸ Pause';
  saveWork();
  saveSimState();
  renderAllPondCanvases();
  renderSectionCanvas();
}

async function stopSimulation() {
  if (state.robotMode === 'real') { sendRobotCommand('stop'); return; }
  if (!state.sim.running) {
    // Même principe que pauseSimulation() : si un pilote est réellement actif, simple demande
    // distante ; sinon (orpheline) on revendique et on applique l'arrêt nous-mêmes.
    if (USE_CLOUD && state.pond) {
      const owns = await claimSimOwnership(state.pond.id);
      if (!owns) {
        window.db.collection('aquabot_sim').doc(state.pond.id)
          .update({ simRunning: false, robotState: 'stopped', lastUpdate: Date.now() })
          .catch(e => reportFirestoreError(e, 'stop (commande distante)'));
        return;
      }
    }
  }
  _stopLocally();
}

function simulationTick() {
  if (!state.sim.running) return;
  const now   = performance.now();
  const rawDt = (now - state.sim.lastTick) / 1000;
  state.sim.lastTick = now;
  const dt = rawDt * state.sim.speed;
  state.robot.elapsedSec += rawDt * state.sim.speed;

  const robot = state.robot;
  const path  = state.plannedPath;
  const nbCycles     = effectiveMiniCycles();

  if (robot.currentCellIdx >= path.length) { finishSimulation(); return; }

  const targetCell = state.cells[path[robot.currentCellIdx]];
  if (!targetCell) { robot.currentCellIdx++; return; }

  // Filet de sécurité : le cache de cible par case (robot._cellFullDepth etc.) n'est normalement
  // posé qu'à la transition idle→descending. Si la session locale reprend en plein cycle sans
  // être passée par cette transition ICI (rechargement de page, reprise après mise en arrière-
  // plan, appareil qui redevient pilote après un relais...), ce cache reste undefined —
  // Math.min/max(undefined, ...) vaut NaN, qui empoisonne alors pumpDepth pour le reste de la
  // session (NaN reste NaN dans tous les calculs suivants). On le (re)calcule donc ici dès qu'il
  // manque, plutôt que de dépendre uniquement de cette seule transition.
  if (robot.pumpState !== 'idle' && robot._cellFullDepth === undefined) {
    robot._cellBaseline     = getCellBathyBaseline(path[robot.currentCellIdx]);
    robot._cellResult       = computeCleaningResult(robot._cellBaseline);
    robot._cellFullDepth    = robot._cellResult.water;
    robot._cellPartialDepth = robot._cellBaseline.water;
  }
  // Filet de sécurité complémentaire : si pumpDepth est déjà NaN (poisoning déjà survenu avant ce
  // correctif, ou toute autre cause), le remettre à une valeur cohérente avec la phase en cours
  // plutôt que de laisser NaN se perpétuer indéfiniment.
  if (!Number.isFinite(robot.pumpDepth)) {
    robot.pumpDepth = robot.pumpState === 'pumping' ? (robot._cellFullDepth ?? 0) : 0;
  }

  // Le robot n'est jamais parfaitement immobile pendant le travail sur une case : courant et
  // agitation de l'eau par la pompe le font dériver légèrement, les moteurs corrigent en continu.
  if (robot.pumpState !== 'idle') {
    const phase  = robot.currentCellIdx * 0.9137;
    const t      = robot.elapsedSec;
    const driftX = Math.sin(t * 0.6  + phase)       * 0.02 + Math.sin(t * 1.7 + phase * 1.4) * 0.012;
    const driftY = Math.cos(t * 0.45 + phase * 1.2) * 0.02 + Math.sin(t * 2.1 + phase * 0.8) * 0.012;
    robot.x = targetCell.cx + driftX;
    robot.y = targetCell.cy + driftY;
    robot.motors = computeThrustAllocation(-driftX * 6, -driftY * 6, robot.heading);
  }

  switch (robot.pumpState) {

    case 'idle': {
      robot.state = 'moving';
      const dx = targetCell.cx - robot.x, dy = targetCell.cy - robot.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.05) {
        robot.x = targetCell.cx;
        robot.y = targetCell.cy;
        robot.pumpState      = 'descending';
        robot.pumpDepth      = 0;
        robot.miniCyclesDone = 0;
        robot.pumpTimer      = 0;
        robot.motors          = [0, 0, 0, 0];
        // Cible de curage propre à cette case — figée pour toute la durée du travail dessus,
        // dérivée du dernier relevé bathymétrique s'il y en a un (voir getCellBathyBaseline),
        // sinon repli sur la profondeur globale uniforme des paramètres.
        robot._cellBaseline    = getCellBathyBaseline(path[robot.currentCellIdx]);
        robot._cellResult      = computeCleaningResult(robot._cellBaseline);
        robot._cellFullDepth   = robot._cellResult.water; // point le plus bas atteint par la pompe
        robot._cellPartialDepth = robot._cellBaseline.water; // remontée entre mini-cycles
      } else {
        const step = params.robotSpeed * dt;
        const ux = dx / d, uy = dy / d;
        robot.x += ux * Math.min(step, d);
        robot.y += uy * Math.min(step, d);
        // Le cap ne tourne que lors des trajets principalement horizontaux (le long d'une rangée) ;
        // les changements de rangée (déplacement surtout vertical) sont gérés en translation latérale
        // pure, sans pivoter — c'est tout l'intérêt des 4 propulseurs holonomes.
        if (Math.abs(dx) >= Math.abs(dy)) robot.heading = Math.atan2(ux, uy) * 180 / Math.PI;
        robot.motors = computeThrustAllocation(ux, uy, robot.heading);
      }
      break;
    }

    case 'descending': {
      const fullDepth = robot._cellFullDepth;
      robot.pumpDepth = Math.min(fullDepth, robot.pumpDepth + params.pumpDescentSpeed * dt);
      if (robot.pumpDepth >= fullDepth - 0.005) {
        robot.pumpDepth = fullDepth;
        robot.pumpState = 'pumping';
        robot.pumpTimer = 0;
      }
      break;
    }

    case 'pumping': {
      robot.pumpTimer    += dt;
      robot.volumePumped += (params.pumpFlow / 60) * rawDt * state.sim.speed;
      if (robot.pumpTimer >= params.pumpTime) {
        robot.miniCyclesDone++;
        if (robot.miniCyclesDone < nbCycles) {
          // More mini-cycles to do → partial ascent back above mud
          robot.pumpState = 'partial_ascending';
        } else {
          // All mini-cycles done → full ascent
          robot.pumpState = 'ascending';
        }
      }
      break;
    }

    case 'partial_ascending': {
      const partialDepth = robot._cellPartialDepth;
      robot.pumpDepth = Math.max(partialDepth, robot.pumpDepth - params.pumpAscentSpeed * dt);
      if (robot.pumpDepth <= partialDepth + 0.005) {
        robot.pumpDepth = partialDepth;
        robot.pumpState = 'descending';
        robot.pumpTimer = 0;
      }
      break;
    }

    case 'ascending': {
      robot.state = 'moving';
      robot.pumpDepth = Math.max(0, robot.pumpDepth - params.pumpAscentSpeed * dt);
      if (robot.pumpDepth <= 0.005) {
        robot.pumpDepth      = 0;
        robot.pumpState      = 'idle';
        robot.miniCyclesDone = 0;
        if (!targetCell.completed) {
          targetCell.completed = true;
          robot.completedCells++;
          if (state.bathy._liveSurveyId) {
            _recordLiveBathyReading(path[robot.currentCellIdx], robot._cellResult);
          }
        }
        robot.currentCellIdx++;
        if (robot.completedCells % 10 === 0) {
          saveWork();
          if (state.bathy._liveSurveyId) persistPondSurveys();
        }
      }
      break;
    }
  }

  // Énergie consommée pendant ce tick — même base de temps que volumePumped/elapsedSec
  // (secondes simulées, donc accélérée par state.sim.speed comme le reste de la simulation).
  robot.energyWh += computeInstantPowerBreakdown(robot).totalW * dt / 3600;

  // Sauvegarde périodique Firestore pour le miroir quasi temps réel sur les autres appareils.
  // Sur le plan payant (Blaze), le quota gratuit journalier n'est plus qu'un seuil de
  // facturation (et non plus un mur bloquant) : on privilégie donc la fluidité entre appareils
  // plutôt que de rester sous le quota gratuit à tout prix. Pour référence, à ce rythme
  // (200ms), un fonctionnement réel de ~20h/jour représente environ 360 000 écritures/jour,
  // soit ~15-18 €/mois au tarif Firestore standard si le robot tourne tous les jours — voir
  // SIM_SAVE_INTERVAL_MS ci-dessus pour ajuster ce compromis fluidité/coût.
  const nowMs = Date.now();
  if (USE_CLOUD && nowMs - state.sim.lastSimSave > SIM_SAVE_INTERVAL_MS) {
    state.sim.lastSimSave = nowMs;
    saveSimState();
  }

  updateUI();
  renderAllPondCanvases();
  renderSectionCanvas();
  if (_satModeDash) updateRobotMarkerDash();
}

function finishSimulation() {
  state.sim.running = false;
  clearInterval(state.sim.intervalId);
  state.sim.intervalId = null;
  state.robot.state     = 'stopped';
  state.robot.pumpDepth = 0;
  state.robot.pumpState = 'idle';
  state.robot.motors    = [0, 0, 0, 0];
  setLED('blue', 'Terminé');
  updateButtonStates();
  updateStatus('Travail terminé !', 'Toutes les cases traitées');
  // Le suivi bathymétrique en direct (voir startLiveBathySurveyIfEnabled/_recordLiveBathyReading)
  // reste la MÊME bathymétrie unique d'un chantier à l'autre — rien à figer/reconvertir ici, elle
  // continue simplement d'être la dernière bathymétrie de l'étang, prête à être mise à jour au
  // prochain chantier. Une bathymétrie "après travaux" figée reste possible à tout moment, mais
  // en tant qu'action manuelle distincte (relevé complet ou génération rapide), pas automatique.
  saveWork();
  updatePondsList();
  showToast('Curage terminé ! Résultats enregistrés.', 'success');
  saveSimState();
  renderAllPondCanvases();
  renderSectionCanvas();
}

// ============================================================
// LED
// ============================================================
function setLED(color, label) {
  ['ledIndicator','heroLed'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = el.className.replace(/led-(?:blue|green|red|yellow)/g, '');
    el.classList.add(`led-${color}`);
  });
  setText('ledLabel', label);
}

// ============================================================
// AUTO-SAVE SELECTION ON START
// ============================================================
function autoSaveSelectionOnStart() {
  if (!state.pond || !state.cells.length) return;
  const count = state.cells.filter(c => c.selected).length;
  if (count === 0) return;
  const inputName = document.getElementById('selNameInput').value.trim();
  const now = new Date();
  const name = inputName ||
    `${now.toLocaleDateString('fr-FR')} ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  const currentStates = state.cells.map(c => c.selected);
  const alreadySaved = state.pond.selections?.some(s =>
    s.cellStates?.length === currentStates.length &&
    s.cellStates.every((v, i) => v === currentStates[i])
  );
  if (alreadySaved) return;
  if (!state.pond.selections) state.pond.selections = [];
  state.pond.selections.push({
    id: Date.now().toString(), name,
    timestamp: Date.now(),
    cellStates: currentStates, count,
  });
  document.getElementById('selNameInput').value = '';
  saveWork();
  renderSelectionHistory();
}

// ============================================================
// UI UPDATER
// ============================================================
function updateUI() {
  // Auto-corrige l'affichage "aucun étang" (nom d'en-tête, état vide du canvas) à chaque
  // rafraîchissement — évite qu'il reste bloqué si state.pond a été peuplé par un chemin
  // qui ne passe pas par loadPond() (reprise cloud, sync multi-appareil, etc.).
  setText('currentPondName', state.pond ? state.pond.name : 'Aucun étang sélectionné');
  const dashEmpty = document.getElementById('dashCanvasEmptyState');
  if (dashEmpty) dashEmpty.style.display = state.pond ? 'none' : 'flex';
  updateEnergyTab();

  const robot = state.robot, path = state.plannedPath;
  const total = path.length;
  // Path-relative progress: count only cells in the current path that are completed
  const done  = path.filter(idx => state.cells[idx]?.completed).length;
  const pct   = total > 0 ? Math.min(100, (done / total) * 100) : 0;

  setText('rtPosX',      robot.x.toFixed(2));
  setText('rtPosY',      robot.y.toFixed(2));
  setText('rtPumpDepth', robot.pumpDepth.toFixed(2));
  const psl = {
    idle: '—', descending: 'Descente ↓',
    pumping: 'Pompage ⚙', partial_ascending: 'Remontée partielle ↑',
    ascending: 'Remontée ↑',
  };
  setText('rtPumpState', psl[robot.pumpState] || '—');

  const el = document.getElementById('dashProgressBar');
  if (el) el.style.width = pct + '%';
  setText('dashProgressPct', pct.toFixed(2) + '%');
  const heroEl = document.getElementById('heroProgressBar');
  if (heroEl) heroEl.style.width = pct + '%';
  setText('heroProgressPct', pct.toFixed(2) + '%');
  setText('dashCellsDone',  done);
  setText('dashCellsTotal', total || '—');

  // Rythme de travail (secondes/case) — recalculé seulement quand une case vient de se
  // terminer, pas à chaque tick. Sinon le numérateur (temps écoulé) grandit en continu
  // pendant qu'on attend la case en cours alors que le dénominateur (cases faites) ne
  // bouge pas : la moyenne dérive sans arrêt, et "Restant"/"Fin estimée" se remettent à
  // reculer puis sautent en avant à chaque case terminée — un temps de fin qui n'arrête
  // pas de bouger. En ne recalculant qu'aux paliers (case terminée), le rythme reste
  // stable entre deux cases et l'estimation ne fait que décompter normalement.
  const sessionElapsed = robot.elapsedSec - (state.sim.sessionElapsedAtStart || 0);
  if (done !== state.sim.paceDoneCount) {
    state.sim.paceDoneCount  = done;
    state.sim.paceSecPerCell = done > 0 ? sessionElapsed / done : null;
  }
  const pace = state.sim.paceSecPerCell;
  const remainingSec = (pace != null && total > done) ? pace * (total - done) : null;
  setText('dashTimeElapsed',   formatTime(robot.elapsedSec));

  // "Restant"/"Fin estimée" doivent répondre à la vitesse de simulation courante, pas juste
  // décompter des secondes "robot" à l'identique quelle que soit la vitesse affichée : remainingSec
  // est en secondes simulées (le rythme réel du travail, indépendant de la vitesse d'affichage —
  // voir le calcul de "pace" ci-dessus). En x200, ce même travail restant défile 200 fois plus
  // vite à l'écran ; sans diviser par la vitesse courante, "Restant" affichait toujours plusieurs
  // jours même en accéléré, alors que l'utilisateur regarde le chantier se terminer en quelques
  // minutes réelles. En mode Robot réel, state.sim.speed reste à 1 — aucun changement là-bas.
  const realRemainingSec = remainingSec != null ? remainingSec / (state.sim.speed || 1) : null;
  setText('dashTimeRemaining', realRemainingSec != null ? formatTime(realRemainingSec) : '—');

  // Fin estimée — date/heure absolue, pas juste une durée (visible dès que "Restant" l'est)
  setText('dashETA', realRemainingSec != null
    ? new Date(Date.now() + realRemainingSec * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—');

  // Selection/path volumes — pompé et total affichés dans la même unité pour rester cohérents
  const selCount = total || state.cells.filter(c => c.selected).length;
  const totalVol = totalVolumeForCells(selCount);
  const mudVol   = mudVolumeForCells(selCount);
  setText('dashVolumePair', formatVolumePair(robot.volumePumped, totalVol));
  setText('dashMudVolume',  mudVol >= 1 ? mudVol.toFixed(2)+' m³' : (mudVol*1000).toFixed(0)+' L');

  // Débit moyen — dérivé du même rythme stable (volume théorique/case ÷ secondes/case),
  // pas d'un ratio volume pompé/temps écoulé brut qui oscille selon la phase en cours
  // (ça pompe activement ou ça descend/remonte/se déplace).
  const ratePerHour = (pace != null && pace > 0) ? (volumePerCell() / pace) * 3600 : 0;
  setText('dashRatePerHour', ratePerHour > 0 ? formatVolume(ratePerHour) + '/h' : '—');
  setText('dashRatePerDay',  ratePerHour > 0 ? formatVolume(ratePerHour * 24) + '/j' : '—');

  // Work mode label
  const wm = WORK_MODES[params.workMode];
  if (wm) setText('dashWorkModeLabel', wm.label);

  // Depths — profondeur RÉELLE de la case en cours de travail si disponible (voir
  // getCellBathyBaseline/simulationTick), repli sur les paramètres génériques sinon.
  const sectionBaseline = currentWorkingCellBaseline();
  setText('depthWater', sectionBaseline.water.toFixed(2));
  setText('depthMud',   sectionBaseline.mud.toFixed(2));
  // En mode Robot réel, pumpDepth vient de la télémétrie ESP32 (subscribeRobotTelemetry) — un
  // champ manquant ou une lecture capteur défaillante peut y transiter en NaN plutôt qu'un
  // simple 0, ce qui affichait littéralement "NaN m" à l'écran.
  setText('depthPump',  Number.isFinite(robot.pumpDepth) ? robot.pumpDepth.toFixed(2) : '—');

  // Bandeau "pompage en cours" — décompte du temps restant sur la mini-cycle en cours, pour
  // se repérer dans le cycle sans avoir à deviner d'après la profondeur de pompe seule.
  const pumpingBanner = document.getElementById('pumpingBanner');
  if (pumpingBanner) {
    if (robot.pumpState === 'pumping') {
      const remaining = Math.max(0, params.pumpTime - (robot.pumpTimer || 0));
      pumpingBanner.style.display = 'flex';
      setText('pumpingBannerTime', Math.ceil(remaining) + 's');
    } else {
      pumpingBanner.style.display = 'none';
    }
  }

  // Bottom bar — cumulative pond totals
  const pondDone  = state.cells.filter(c => c.completed).length;
  const pondTotal = state.cells.length;
  const pondPct   = pondTotal > 0 ? (pondDone / pondTotal) * 100 : 0;
  const allMudVol = mudVolumeForCells(pondTotal);
  const pondTargetVol = totalVolumeForCells(pondTotal);
  setText('pondTotalDone',      pondDone);
  setText('pondTotalCells',     pondTotal || '—');
  setText('pondTotalPct',       pondPct.toFixed(2) + '%');
  setText('pondTotalVolumePair', formatVolumePair(robot.volumePumped, pondTargetVol));
  setText('pondTotalMud',       allMudVol >= 1 ? allMudVol.toFixed(2)+' m³' : (allMudVol*1000).toFixed(0)+' L');
  setText('pondTotalTime',      formatTime(robot.elapsedSec));
  setText('dashPondBottomName', state.pond?.name || '—');
  const pondBarEl = document.getElementById('pondTotalBar');
  if (pondBarEl) pondBarEl.style.width = pondPct + '%';

  updateMotorDisplay();
  updateGpsDisplay();

  // Derive and set status text — works on both active device and observers
  const nc = effectiveMiniCycles();
  const statusMap = {
    idle:              ['Déplacement',        `Case ${robot.currentCellIdx + 1}/${total || '?'}`],
    descending:        ['Descente pompe',     `Cible: ${(robot._cellFullDepth ?? (params.waterDepth + params.mudDepth)).toFixed(2)}m — cycle ${robot.miniCyclesDone + 1}/${nc}`],
    pumping:           ['Pompage actif',      `Cycle ${robot.miniCyclesDone + 1}/${nc} — case ${robot.currentCellIdx + 1}/${total || '?'}`],
    partial_ascending: ['Remontée partielle', `Prochain cycle ${robot.miniCyclesDone + 1}/${nc}`],
    ascending:         ['Remontée pompe',     ''],
  };
  if (robot.state === 'stopped') {
    updateStatus('Arrêté', 'Prêt à démarrer');
  } else if (robot.state === 'paused') {
    updateStatus('En pause', 'Cliquez Reprendre');
  } else {
    const [main, sub] = statusMap[robot.pumpState] || ['En cours', ''];
    updateStatus(main, sub);
  }
}

function updateStatus(main, sub) {
  setText('statusText', main);
  setText('heroStatus', main);
  setText('heroSubStatus', sub);
}

function updateButtonStates() {
  // running = boucle locale active OU le robot est actif sur un autre appareil dont on a
  // reçu un battement de cœur récent. Sans la condition de fraîcheur, un pilote disparu sans
  // s'arrêter proprement (onglet fermé, crash) laissait "Démarrer" durablement désactivé —
  // seul moyen de s'en sortir : deviner qu'il fallait cliquer sur "Pause" pour forcer une
  // reprise. Passé ce délai sans nouvelle écriture, on considère l'affichage "moving/pumping"
  // comme périmé et on redonne la main à l'utilisateur.
  const heartbeatFresh = (Date.now() - _lastKnownSimHeartbeat) < DRIVER_HEARTBEAT_TIMEOUT_MS;
  const running = state.sim.running || (['moving', 'pumping'].includes(state.robot.state) && heartbeatFresh);
  const hasPond = !!state.pond;
  const stopped = state.robot.state === 'stopped';
  document.getElementById('btnStart').disabled  = running || !hasPond;
  document.getElementById('btnPause').disabled  = stopped || !hasPond;
  document.getElementById('btnStop').disabled   = stopped || !hasPond;
}

// ============================================================
// HANDLERS
// ============================================================
// startSimulation()/pauseSimulation()/stopSimulation() sont async (elles attendent
// claimSimOwnership) : sans .catch() ici, une exception dedans (ex. accès réseau Firestore en
// échec) devient une "unhandled promise rejection" invisible — le bouton semble ne rien faire,
// sans aucun message. On la remonte donc explicitement à l'écran.
function handleStart()  { startSimulation().catch(e => { console.error('handleStart:', e); showToast('Erreur au démarrage : ' + e.message, 'error'); }); }
function handlePause()  { pauseSimulation().catch(e => { console.error('handlePause:', e); showToast('Erreur : ' + e.message, 'error'); }); }
function handleStop()   { stopSimulation().catch(e => { console.error('handleStop:', e); showToast('Erreur : ' + e.message, 'error'); }); }
function handleSpeedChange(v) {
  state.sim.speed = parseFloat(v);
  setText('speedValue', v + '×');
  if (state.sim.running) {
    // Cet appareil pilote réellement : sa sauvegarde complète et périodique reflète l'état
    // exact, vitesse incluse — pas besoin d'un envoi séparé.
    saveSimState();
  } else if (USE_CLOUD && state.pond) {
    // Simple vue : n'envoyer QUE le changement de vitesse, jamais un document complet depuis
    // des valeurs suivies (qui écraserait l'état précis de l'appareil qui pilote réellement,
    // et pourrait même usurper sa revendication de pilotage via le champ driverId).
    _sendRemoteSpeedChange(state.sim.speed);
  }
}

// Le pilote réécrit tout le document toutes les ~200ms (voir simulationTick) avec sa propre
// valeur de vitesse en mémoire. Il existe donc une fenêtre de course où sa prochaine écriture
// périodique — partie AVANT d'avoir reçu ce changement distant — écrase cette valeur avec son
// ancienne vitesse locale, avant même que le pilote n'ait eu le temps de traiter le snapshot
// entrant : c'était la cause du "je change la vitesse mais elle revient à l'ancienne valeur".
// On réémet donc la demande à quelques reprises sur une courte fenêtre pour garantir qu'elle
// finit par « tenir » une fois que le pilote l'a effectivement intégrée à son propre état.
// _pendingSpeedRequest (utilisé aussi par subscribeSimState) permet d'ignorer les échos
// périmés du pilote tant que notre demande n'est pas confirmée, plutôt que d'afficher
// brièvement l'ancienne valeur en attendant — et sert de condition d'arrêt fiable pour les
// réémissions (state.sim.speed lui-même est justement instable pendant la course).
let _pendingSpeedRequest = null;
let _speedRetryTimers = [];
function _sendRemoteSpeedChange(speed) {
  _speedRetryTimers.forEach(clearTimeout);
  _speedRetryTimers = [];
  _pendingSpeedRequest = speed;
  const send = () => {
    if (!state.pond) return;
    window.db.collection('aquabot_sim').doc(state.pond.id)
      .update({ speed, lastUpdate: Date.now() })
      .catch(e => reportFirestoreError(e, 'speed (commande distante)'));
  };
  send();
  [250, 600, 1200].forEach(delay => {
    _speedRetryTimers.push(setTimeout(() => {
      // Ne réaffirme que si le pilote n'a pas déjà confirmé cette valeur, et que l'utilisateur
      // n'a pas entre-temps redemandé une autre vitesse.
      if (_pendingSpeedRequest === speed) send();
    }, delay));
  });
}

function triggerKMLImport() { document.getElementById('kmlInput').click(); }

function handleKMLFile(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const kmlData = parseKML(e.target.result);
      const pond = createPondFromKML(kmlData);
      const idx = state.ponds.findIndex(p => p.name === pond.name);
      if (idx !== -1) state.ponds[idx] = pond; else state.ponds.push(pond);
      savePonds();
      loadPond(pond);
      updatePondsList();
      setActiveTab('dashboard');
    } catch (err) { showToast('Erreur KML : ' + err.message, 'error'); }
    input.value = '';
  };
  reader.readAsText(file);
}

function planRoute() {
  if (!state.pond) return;
  const base = planPath(state.cells);
  if (!base.length) { showToast('Sélectionnez des cases non terminées', 'error'); return; }

  // Double-pass modes repeat the full path a second time
  const totalPasses = passes();
  let path = [...base];
  for (let p = 1; p < totalPasses; p++) path = [...path, ...base];

  state.plannedPath = path;
  const wm = WORK_MODES[params.workMode];
  setText('dashCellsTotal', path.length);
  renderAllPondCanvases();
  if (_satModeDash) _rebuildPathLayerDash();
  // Uniquement si cet appareil pilote réellement — sinon startSimulation() se chargera de
  // revendiquer le pilotage et de diffuser le parcours planifié au moment du démarrage. Un
  // envoi ici depuis une simple vue écraserait tout le document (state.robot suivi, pas la
  // vérité) et pourrait usurper la revendication de pilotage d'un autre appareil.
  if (state.sim.running) saveSimState();
  showToast(
    `Parcours planifié : ${base.length} cases × ${totalPasses} passe(s) × ${effectiveMiniCycles()} cycle(s) — Mode : ${wm?.label}`,
    'success'
  );
}

function setMode(mode) {
  state.view.mode = mode;
  ['btnModeSelect','btnModeSelectMap','btnBathyModeSelect'].forEach(id => { const el = document.getElementById(id); if(el) el.classList.toggle('active', mode==='select'); });
  ['btnModeView','btnModeViewMap','btnBathyModeView'].forEach(id => { const el = document.getElementById(id); if(el) el.classList.toggle('active', mode==='view'); });
  const cur = mode === 'select' ? 'crosshair' : 'grab';
  ['dashPondCanvas','pondCanvas'].forEach(id => { const el = document.getElementById(id); if(el) el.style.cursor = cur; });
  if (_satModeDash) _applyModeToLeafletDash();
  _applyModeToLeafletBathy();
}

// ============================================================
// CANVAS EVENTS (shared for both canvases)
// ============================================================
function initCanvasEvents() {
  const canvases = [
    { id: 'dashPondCanvas', wrapId: 'dashCanvasWrap' },
  ];

  for (const { id, wrapId } of canvases) {
    const canvas = document.getElementById(id);
    const wrap   = document.getElementById(wrapId);
    if (!canvas || !wrap) continue;

    // Resize observer — refit on first valid size, re-render on subsequent resizes.
    // Débouncé : sur mobile, la barre d'adresse de Safari qui se cache/montre pendant
    // le scroll déclenche une rafale de micro-resize — sans ce délai, chaque frame
    // relance un reflow du canvas et le scroll se fait "combattre" en boucle.
    //
    // Le conteneur Leaflet partage ce même wrap : sans invalidateSize() ici, Leaflet garde
    // une taille de conteneur périmée dès que le wrap change de taille (barre d'adresse,
    // rotation, tiroir qui s'ouvre...), et ses calculs de position (marqueurs, zoom) dérivent
    // petit à petit — d'où le robot qui semblait se décaler de l'étang sur le tableau de bord
    // (dont la mise en page bouge beaucoup plus que celle de l'onglet Carte, plein écran).
    let resizeDebounce = null;
    new ResizeObserver(() => {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        const prevW = canvas.width;
        canvas.width  = wrap.clientWidth;
        canvas.height = wrap.clientHeight;
        if (prevW === 0 && state.pond) fitPond();
        else renderPondCanvas(canvas);
        if (_leafletMapDash) _leafletMapDash.invalidateSize();
      }, 120);
    }).observe(wrap);

    // Initial size
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;

    // Wheel zoom
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1/1.15);
    }, { passive: false });

    // Mouse events
    let isPanning = false, lastPanX = 0, lastPanY = 0;

    canvas.addEventListener('mousedown', e => {
      if (!state.pond) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const world = screenToWorld(mx, my);

      // Ancre du tuyau : on la saisit en priorité si le clic est dessus
      if (hitTestHoseAnchor(mx, my, 12)) {
        state.hose.dragging = true;
        canvas.style.cursor = 'grabbing';
        return;
      }

      if (state.view.mode === 'view' || e.button === 1) {
        isPanning = true; lastPanX = e.clientX; lastPanY = e.clientY;
        canvas.style.cursor = 'grabbing'; return;
      }

      // Cell selection
      const cell = getCellAt(world.x, world.y);
      if (cell) {
        state.drag.mode = cell.selected ? 'remove' : 'add';
        cell.selected = !cell.selected;
        renderAllPondCanvases();
      }
      state.drag.active = true;
    });

    canvas.addEventListener('mousemove', e => {
      if (!state.pond) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      if (state.hose.dragging) {
        const world = screenToWorld(mx, my);
        dragHoseAnchorTo(world.x, world.y);
        return;
      }
      if (isPanning) {
        state.view.offsetX -= (e.clientX - lastPanX) / state.view.scale;
        state.view.offsetY += (e.clientY - lastPanY) / state.view.scale;
        lastPanX = e.clientX; lastPanY = e.clientY;
        renderAllPondCanvases(); return;
      }
      // Hover feedback near the anchor even when not dragging
      if (!isPanning && !state.drag.active) {
        canvas.style.cursor = hitTestHoseAnchor(mx, my, 12) ? 'grab' : (state.view.mode === 'view' ? 'grab' : 'crosshair');
      }
      // Drag select
      if (e.buttons === 1 && state.drag.active && state.view.mode === 'select') {
        const world = screenToWorld(mx, my);
        const cell  = getCellAt(world.x, world.y);
        if (cell) {
          const newState = state.drag.mode === 'add';
          if (cell.selected !== newState) { cell.selected = newState; renderAllPondCanvases(); }
        }
      }
    });

    canvas.addEventListener('mouseup', () => {
      if (state.hose.dragging) {
        state.hose.dragging = false;
        saveWork();
        updateHoseLengthDisplay();
        canvas.style.cursor = state.view.mode === 'view' ? 'grab' : 'crosshair';
        return;
      }
      if (state.drag.active && state.view.mode === 'select') debouncedSaveSelection();
      isPanning = false; state.drag.active = false;
      canvas.style.cursor = state.view.mode === 'view' ? 'grab' : 'crosshair';
    });

    // Touch events
    let lastTouchDist = 0, touchDragActive = false;
    let lastTouchX = 0, lastTouchY = 0;

    let touchHoseDragActive = false;

    canvas.addEventListener('touchstart', e => {
      if (!state.pond) return;
      if (e.touches.length === 2) {
        lastTouchDist = getTouchDist(e.touches);
        touchDragActive = false;
      } else if (e.touches.length === 1) {
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
        const rect = canvas.getBoundingClientRect();
        const mx = lastTouchX - rect.left, my = lastTouchY - rect.top;
        if (hitTestHoseAnchor(mx, my, 20)) {
          touchHoseDragActive = true;
          state.hose.dragging = true;
          return;
        }
        if (state.view.mode === 'select') {
          const world = screenToWorld(mx, my);
          const cell  = getCellAt(world.x, world.y);
          if (cell) {
            state.drag.mode = cell.selected ? 'remove' : 'add';
            cell.selected = !cell.selected;
            renderAllPondCanvases();
          }
          touchDragActive = true;
        }
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', e => {
      if (!state.pond) return;
      if (touchHoseDragActive && e.touches.length === 1) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const world = screenToWorld(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
        dragHoseAnchorTo(world.x, world.y);
        return;
      }
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = getTouchDist(e.touches);
        if (lastTouchDist > 0) zoomAt(d / lastTouchDist);
        lastTouchDist = d;
      } else if (e.touches.length === 1) {
        e.preventDefault();
        const tx = e.touches[0].clientX, ty = e.touches[0].clientY;
        if (state.view.mode === 'view') {
          // Single-finger pan
          state.view.offsetX -= (tx - lastTouchX) / state.view.scale;
          state.view.offsetY += (ty - lastTouchY) / state.view.scale;
          renderAllPondCanvases();
        } else if (touchDragActive) {
          const rect = canvas.getBoundingClientRect();
          const world = screenToWorld(tx - rect.left, ty - rect.top);
          const cell  = getCellAt(world.x, world.y);
          if (cell) {
            const ns = state.drag.mode === 'add';
            if (cell.selected !== ns) { cell.selected = ns; renderAllPondCanvases(); }
          }
        }
        lastTouchX = tx;
        lastTouchY = ty;
      }
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
      if (touchHoseDragActive) {
        touchHoseDragActive = false;
        state.hose.dragging = false;
        saveWork();
        updateHoseLengthDisplay();
        return;
      }
      if (touchDragActive && state.view.mode === 'select') debouncedSaveSelection();
      touchDragActive = false; lastTouchDist = 0;
    });
  }
}

function getTouchDist(t) {
  return Math.sqrt((t[0].clientX-t[1].clientX)**2 + (t[0].clientY-t[1].clientY)**2);
}

// ============================================================
// PONDS LIST
// ============================================================
function updatePondsList() {
  const container = document.getElementById('pondsList');
  if (!container) return;
  // Reconstruit le HTML complet ET redessine une vignette par étang (boucle sur toutes les
  // cases de CHAQUE étang) — coûteux avec plusieurs étangs et/ou de gros étangs, pour un onglet
  // qui n'est même pas forcément visible. Appelée à chaque snapshot Firestore (ex. pendant un
  // chantier en cours), ce travail perdu et répété causait un ralentissement sensible du
  // navigateur. setActiveTab() rappelle cette fonction en arrivant sur l'onglet Étangs.
  if (state.activeTab !== 'ponds') return;

  if (!state.ponds.length) {
    container.innerHTML = `<div class="pond-empty">
      <svg viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="28" stroke="#475569" stroke-width="2"/><path d="M20 40 Q28 30 32 36 Q36 42 44 28" stroke="#475569" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
      <p>Aucun étang enregistré</p>
      <button class="btn btn-primary" onclick="triggerKMLImport()">Importer un étang KML</button></div>`;
    return;
  }

  container.innerHTML = state.ponds.map(p => {
    const total    = p.cells?.length || 0;
    const done     = p.work?.completedCells?.length || 0;
    const pct      = total > 0 ? Math.round((done/total)*100) : 0;
    const area     = p.area ? (p.area >= 10000 ? (p.area/10000).toFixed(2)+' ha' : p.area.toFixed(0)+' m²') : '—';
    const lastUsed = p.lastUsed ? new Date(p.lastUsed).toLocaleDateString('fr-FR', {day:'2-digit',month:'short',year:'numeric'}) : '—';
    const active   = state.pond?.id === p.id;
    const hasGPS   = isValidOrigin(p.origin);
    const statusClass = done === 0 ? 'pond-status-new' : done >= total ? 'pond-status-done' : 'pond-status-progress';
    const statusLabel = done === 0 ? 'Non commencé' : done >= total ? 'Terminé' : 'En cours';

    // Volumes estimés (méthode/débit courants, mêmes formules que le tableau de bord) et
    // longueur de tuyau nécessaire depuis le point de sortie actuel — pour choisir/
    // comparer un étang sans avoir à le charger d'abord.
    const waterVol   = totalVolumeForCells(total);
    const mudVolM3   = mudVolumeForCells(total);
    const hoseLen    = p.hoseAnchor ? computeRequiredHoseLength(p) : 0;
    const hasDeposit = !!p.depositZone;
    const depositArea = hasDeposit ? polygonArea(p.depositZone.polygon) : 0;

    return `
      <div class="pond-card ${active?'active-pond':''}" onclick="loadPondById('${p.id}')">
        <canvas id="thumb-${p.id}" class="pond-thumb" width="72" height="54"></canvas>
        <div class="pond-info">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
            <div class="pond-name" style="margin:0">${p.name}</div>
            <span class="pond-status-badge ${statusClass}">${statusLabel}</span>
            <span class="pond-gps-badge ${hasGPS?'has-gps':''}">
              ${hasGPS ? '📍 GPS' : '📍 Sans GPS'}
            </span>
            <span class="pond-gps-badge ${hasDeposit?'has-gps':''}">
              ${hasDeposit ? `🎯 Zone de dépôt (${Math.round(depositArea)} m²)` : '🎯 Pas de zone de dépôt'}
            </span>
          </div>
          <div class="pond-meta">
            <span class="pond-meta-item">Surface : <strong>${area}</strong></span>
            <span class="pond-meta-item"><strong>${total}</strong> cases</span>
            <span class="pond-meta-item">Eau à pomper : <strong>${formatVolume(waterVol)}</strong></span>
            <span class="pond-meta-item">Vase : <strong>${mudVolM3 >= 1 ? mudVolM3.toFixed(2)+' m³' : Math.round(mudVolM3*1000)+' L'}</strong></span>
            ${hoseLen > 0 ? `<span class="pond-meta-item">Tuyau nécessaire : <strong>${Math.ceil(hoseLen)} m</strong></span>` : ''}
            <span class="pond-meta-item">Modifié : <strong>${lastUsed}</strong></span>
          </div>
          <div class="pond-progress">
            <div class="progress-bar" style="flex:1"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="pond-progress-pct">${pct}% — ${done}/${total}</span>
          </div>
        </div>
        <div class="pond-actions">
          <button class="btn btn-primary btn-sm"    onclick="event.stopPropagation();loadPondById('${p.id}')">Charger</button>
          <button class="btn btn-secondary btn-sm"  onclick="event.stopPropagation();startDepositZoneForPond('${p.id}')">🎯 Zone de dépôt</button>
          <button class="btn btn-secondary btn-sm"  onclick="event.stopPropagation();resetWork('${p.id}')">↺ RAZ</button>
          <button class="btn btn-danger btn-sm"     onclick="event.stopPropagation();deletePond('${p.id}')">✕</button>
        </div>
      </div>`;
  }).join('');

  requestAnimationFrame(() => { state.ponds.forEach(drawPondThumb); });
}

function drawPondThumb(pond) {
  const canvas = document.getElementById(`thumb-${pond.id}`);
  if (!canvas || !pond.polygon) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1424'; ctx.fillRect(0, 0, W, H);
  const { minX, maxX, minY, maxY } = getPondBbox(pond);
  const sc = Math.min((W-10)/(maxX-minX), (H-10)/(maxY-minY));
  const ox = minX - (W/sc - (maxX-minX))/2;
  const oy = minY - (H/sc - (maxY-minY))/2;
  ctx.beginPath();
  for (let i = 0; i < pond.polygon.length; i++) {
    const sx = (pond.polygon[i].x-ox)*sc, sy = (pond.polygon[i].y-oy)*sc;
    i===0 ? ctx.moveTo(sx,sy) : ctx.lineTo(sx,sy);
  }
  ctx.closePath();
  // Draw completed cells
  const cs = params.cellSize * sc;
  if (pond.cells && cs > 1) {
    const completedSet = new Set(pond.work?.completedCells||[]);
    for (let i = 0; i < pond.cells.length; i++) {
      const c = pond.cells[i];
      const sx = (c.cx - cs/(2*sc) - ox)*sc, sy = (c.cy - cs/(2*sc) - oy)*sc;
      ctx.fillStyle = completedSet.has(i) ? 'rgba(16,185,129,0.7)' : 'rgba(14,165,233,0.18)';
      ctx.fillRect(sx, sy, cs, cs);
    }
  }
  ctx.fillStyle = 'rgba(14,165,233,0.12)'; ctx.fill();
  ctx.strokeStyle = '#0ea5e9'; ctx.lineWidth = 1.5; ctx.stroke();
}

function loadPondById(id) {
  const pond = state.ponds.find(p => p.id === id);
  if (pond) { loadPond(pond); setActiveTab('dashboard'); }
}

function deletePond(id) {
  if (!confirm('Supprimer cet étang et tout son historique ?')) return;
  if (USE_CLOUD) {
    window.db.collection('aquabot_ponds').doc(id).delete()
      .catch(err => reportFirestoreError(err, 'Cloud delete error'));
  }
  state.ponds = state.ponds.filter(p => p.id !== id);
  if (state.pond?.id === id) {
    state.pond = null; state.cells = []; state.plannedPath = [];
    document.getElementById('dashCanvasEmptyState').style.display = 'flex';
    setText('currentPondName', 'Aucun étang sélectionné');
    setText('dashPondBadge', 'Aucun étang');
    renderAllPondCanvases();
    renderSelectionHistory();
    updateHoseLengthDisplay();
  }
  if (!USE_CLOUD) savePonds();
  updatePondsList();
  showToast('Étang supprimé');
}

// ============================================================
// POPOVERS DE LA BARRE D'ACTIONS
// État/contrôles, options de carte, mode/vitesse, et les 3 sections Sélection/
// Propulsion/Progression — tous le même mécanisme (repliés par défaut, un seul
// ouvert à la fois), pas de grand tiroir à part pour les sections.
// ============================================================
const DASH_POPOVERS = [
  ['controlPopover',     'btnControlToggle'],
  ['mapOptionsPopover',  'btnMapOptionsToggle'],
  ['modePopover',        'btnModeToggle'],
  ['selectionPopover',   'btnSectionSelection'],
  ['propulsionPopover',  'btnSectionPropulsion'],
  ['progressionPopover', 'btnSectionProgression'],
];

function toggleDashPopover(popId, force) {
  const pop = document.getElementById(popId);
  if (!pop) return;
  const open = force !== undefined ? force : !pop.classList.contains('open');
  pop.classList.toggle('open', open);
  if (open) {
    for (const [otherId] of DASH_POPOVERS) {
      if (otherId !== popId) document.getElementById(otherId)?.classList.remove('open');
    }
  }
}

function toggleControlPopover(force)     { toggleDashPopover('controlPopover', force); }
function toggleMapOptionsPopover(force)  { toggleDashPopover('mapOptionsPopover', force); }
function toggleModePopover(force)        { toggleDashPopover('modePopover', force); }
function toggleSelectionPopover(force)   { toggleDashPopover('selectionPopover', force); }
function togglePropulsionPopover(force)  { toggleDashPopover('propulsionPopover', force); }
function toggleProgressionPopover(force) { toggleDashPopover('progressionPopover', force); }

document.addEventListener('click', e => {
  for (const [popId, btnId] of DASH_POPOVERS) {
    const pop = document.getElementById(popId);
    if (!pop || !pop.classList.contains('open')) continue;
    if (e.target.closest(`#${popId}`) || e.target.closest(`#${btnId}`)) continue;
    pop.classList.remove('open');
  }
});

// ============================================================
// TAB NAVIGATION
// ============================================================
function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
  if (tab === 'dashboard') {
    // Le tableau de bord est l'onglet par défaut : sa carte Leaflet n'était resynchronisée
    // qu'une fois au tout premier chargement de la page. En revenant d'un autre onglet, sa
    // taille de conteneur avait pu changer entre-temps sans jamais être revérifiée.
    requestAnimationFrame(() => {
      if (_satModeDash) {
        if (!_leafletMapDash) initLeafletMapDash();
        else {
          _leafletMapDash.invalidateSize();
          updateLeafletOverlayDash();
        }
      } else {
        const c = document.getElementById('dashPondCanvas'), w = document.getElementById('dashCanvasWrap');
        if (c && w) { c.width = w.clientWidth; c.height = w.clientHeight; }
        renderPondCanvas(c);
      }
    });
  } else if (tab === 'energy') {
    refreshSolarIrradianceForPond();
    updateEnergyTab();
  } else if (tab === 'bathymetry') {
    // Un étang fraîchement chargé a TOUTES ses cases sélectionnées par défaut (comportement
    // voulu pour le curage — voir generateGrid). Cette sélection est partagée avec le tableau
    // de bord, donc arriver ici avec tout sélectionné noie la carte sous les contours bleus et
    // masque les relevés tant qu'on n'a pas cliqué "Aucune". On ne l'efface QUE si elle
    // correspond encore exactement à ce défaut intouché (jamais une sélection partielle
    // volontaire faite pour un relevé) — l'effet est le même qu'un clic manuel sur "Aucune".
    if (state.cells.length && state.cells.every(c => c.selected)) {
      state.cells.forEach(c => { c.selected = false; });
      renderAllPondCanvases();
      if (_satModeDash && typeof L !== 'undefined') _rebuildCellLayersDash();
      debouncedSaveSelection();
    }
    renderBathyTab();
  } else if (tab === 'ponds') {
    updatePondsList();
  }
}

function resizeSectionCanvas() {
  const wrap = document.querySelector('.dash-section-wrap');
  const canvas = document.getElementById('sectionCanvas');
  if (!wrap || !canvas) return;
  canvas.width  = Math.min(wrap.clientWidth - 4, 500);
  canvas.height = 170;
}

// Mini-widget coupe verticale flottant — visible par défaut, repliable au clic sur l'en-tête
function toggleSectionWidget(force) {
  const widget = document.getElementById('sectionWidget');
  if (!widget) return;
  const collapsed = force !== undefined ? force : !widget.classList.contains('collapsed');
  widget.classList.toggle('collapsed', collapsed);
  const toggleBtn = document.getElementById('sectionWidgetToggle');
  if (toggleBtn) toggleBtn.textContent = collapsed ? '+' : '−';
  if (!collapsed) { resizeSectionCanvas(); renderSectionCanvas(); }
}

// ============================================================
// DEMO POND
// ============================================================
function loadDemoPond() {
  const polygon = [
    {x:0,y:0},{x:30,y:0},{x:33,y:10},{x:31,y:20},{x:2,y:21},{x:0,y:10},{x:0,y:0}
  ];
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for (const p of polygon) {
    minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);
    minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);
  }
  const pond = {
    id:'demo', name:'Étang démo (30×21m)',
    // Un point quelconque en France (pas {lat:0,lng:0} — "null island", en pleine mer,
    // hors de la couverture d'IGN Géoportail : les tuiles y renvoient 404 même une fois
    // le rendu Leaflet correct, ce qui ressemble à tort à un bug). Position générique,
    // sans rapport avec un étang réel.
    origin:{lat:46.8, lng:2.5}, polygon,
    area: polygonArea(polygon),
    cells: generateGrid(polygon),
    work:{completedCells:[],volumePumped:0,elapsedSec:0,energyWh:0},
    selections:[],
    lastUsed:Date.now(),
    bbox:{minX,maxX,minY,maxY},
    hoseAnchor: nearestPointOnPolygon(polygon, minX, (minY + maxY) / 2),
  };
  const idx = state.ponds.findIndex(p => p.id==='demo');
  if (idx !== -1) state.ponds[idx] = pond; else state.ponds.push(pond);
  savePonds();
  loadPond(pond);
}

// ============================================================
// TOAST
// ============================================================
let toastTimeout = null;
function showToast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type?' toast-'+type:''}`;
  el.style.display = 'block';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.style.display='none', 3200);
}

// ============================================================
// COORDINATE CONVERSION — local ↔ GPS
// ============================================================
// {lat:0, lng:0} est une origine valide (voir metersToLatLng) — centralisé ici pour ne
// pas répéter le même test de fausse "origine absente" à chaque site d'appel.
function isValidOrigin(o) {
  return !!o && typeof o.lat === 'number' && typeof o.lng === 'number' && !Number.isNaN(o.lat) && !Number.isNaN(o.lng);
}

function metersToLatLng(x, y) {
  if (!isValidOrigin(state.pond?.origin)) return null;
  const { lat: lat0, lng: lng0 } = state.pond.origin;
  return {
    lat: lat0 + y / 110540,
    lng: lng0 + x / (Math.cos(lat0 * Math.PI / 180) * 111320),
  };
}

// ============================================================
// LEAFLET SATELLITE MAP
// ============================================================

// Fonds de carte disponibles
const MAP_STYLES = {
  esri: {
    label: 'Esri',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri World Imagery',
    maxNativeZoom: 19,
  },
  ign_ortho: {
    label: 'IGN Photo',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image%2Fjpeg',
    labels: null,
    attribution: '© IGN Géoportail',
    // La résolution réelle de la BD ORTHO ne couvre pas le zoom 21 partout
    // (zones rurales) — au-delà, le WMTS renvoie des tuiles vides. On
    // plafonne à 19 (couverture fiable) et on laisse Leaflet suréchantillonner.
    maxNativeZoom: 19,
  },
  ign_plan: {
    label: 'IGN Plan',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image%2Fpng',
    labels: null,
    attribution: '© IGN Géoportail',
    maxNativeZoom: 19,
  },
};

let _currentMapStyle   = 'ign_ortho'; // IGN Ortho — meilleure résolution qu'Esri sur le territoire français
let _baseTileLayerDash = null;   // tableau de bord
let _labelsLayerDash   = null;

function setMapStyle(styleKey) {
  _currentMapStyle = styleKey;
  const style = MAP_STYLES[styleKey];
  if (!style) return;

  // Mettre à jour tous les boutons .map-style-btn
  document.querySelectorAll('.map-style-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.style === styleKey)
  );

  // Fonction utilitaire pour changer le fond sur une map Leaflet
  function applyStyle(lmap, tileRef, labelsRef) {
    if (!lmap) return { tile: tileRef, labels: labelsRef };
    if (tileRef)   { lmap.removeLayer(tileRef);   tileRef   = null; }
    if (labelsRef) { lmap.removeLayer(labelsRef); labelsRef = null; }
    tileRef = L.tileLayer(style.url, {
      attribution: style.attribution, maxZoom: 23, maxNativeZoom: style.maxNativeZoom,
    }).addTo(lmap);
    tileRef.bringToBack();
    if (style.labels) {
      labelsRef = L.tileLayer(style.labels, {
        attribution: '', maxZoom: 23, maxNativeZoom: style.maxNativeZoom, opacity: 0.65,
      }).addTo(lmap);
    }
    return { tile: tileRef, labels: labelsRef };
  }

  if (_leafletMapDash) {
    const r = applyStyle(_leafletMapDash, _baseTileLayerDash, _labelsLayerDash);
    _baseTileLayerDash = r.tile; _labelsLayerDash = r.labels;
  }
}

let _leafletMapDash      = null;
let _isZoomingMapDash    = false; // voir _isZoomingMap ci-dessus
let _baseLayersDash      = [];   // polygone de l'étang + ancre du tuyau
let _dynamicLayersDash   = [];   // robot + tuyau (mis à jour à chaque tick)
let _pathLayerDash       = [];   // parcours planifié
let _cellLayersDash      = [];   // cases (mise à jour rapide)
let _cellRectsDash       = [];   // références aux L.rectangle pour setStyle() rapide
let _cellRendererDash    = null; // canvas renderer partagé
let _robotSquareDash     = null;
let _robotPumpDash       = null;
let _robotArrowDash      = null;
let _gpsLabelMarkerDash  = null;
let _hoseAnchorMarkerDash = null;
let _hosePolylineDash    = null;
let _hoseOutlineDash     = null; // liseré sombre sous le tuyau, pour le contraste
let _depositZoneDash     = null; // zone de dépôt des sédiments
let _depositSegmentDash  = null; // segment de tuyau posé au sol, ancre → zone de dépôt
let _satModeDash         = true; // vue satellite par défaut

// Met à jour la courbe du tuyau sans tout reconstruire (appelé pendant le glisser de l'ancre)
function _refreshHosePolylineDash() {
  if (!_hosePolylineDash || !state.pond?.hoseAnchor) return;
  const pts = _hoseLatLngs(state.pond.hoseAnchor, state.robot);
  _hosePolylineDash.setLatLngs(pts);
  if (_hoseOutlineDash) _hoseOutlineDash.setLatLngs(pts);
  if (_depositSegmentDash && state.pond.depositZone) {
    const anchorLL = metersToLatLng(state.pond.hoseAnchor.x, state.pond.hoseAnchor.y);
    if (anchorLL) _depositSegmentDash.setLatLngs([[anchorLL.lat, anchorLL.lng], _depositSegmentDash.getLatLngs()[1]]);
  }
}

// Points lat/lng de la courbe du tuyau, pour un L.polyline
function _hoseLatLngs(anchor, robot) {
  return computeHoseCurvePoints(anchor, robot, 24, _hoseRequiredLenCache)
    .map(p => { const ll = metersToLatLng(p.x, p.y); return ll ? [ll.lat, ll.lng] : null; })
    .filter(Boolean);
}

// Zone de dépôt des sédiments en coordonnées géographiques — polygone + centroïde, pour
// le rendu Leaflet et le segment de tuyau (posé au sol, donc droit) qui la relie à l'ancre.
function _depositZoneLatLngs(depositZone) {
  const polyLL = depositZone.polygon
    .map(p => { const ll = metersToLatLng(p.x, p.y); return ll ? [ll.lat, ll.lng] : null; })
    .filter(Boolean);
  const centroidLL = metersToLatLng(depositZone.centroid.x, depositZone.centroid.y);
  return { polyLL, centroidLL };
}

// Coins (carré non tourné, comme sur le schéma) de ROBOT_SIZE mètres centré en (cx,cy) —
// en coordonnées géographiques, pour que Leaflet le mette à l'échelle en continu pendant le
// zoom (contrairement à une icône de marqueur en pixels, qui reste figée pendant l'animation
// et ne se corrige qu'au relâchement, donnant l'impression que le robot ne suit pas l'échelle).
function _robotSquareLatLngs(cx, cy) {
  const h = ROBOT_SIZE / 2;
  return [[cx-h,cy-h],[cx+h,cy-h],[cx+h,cy+h],[cx-h,cy+h]]
    .map(([x,y]) => { const ll = metersToLatLng(x,y); return ll ? [ll.lat, ll.lng] : null; })
    .filter(Boolean);
}

// Segment du centre vers la pointe de la flèche de cap, à ROBOT_SIZE*0.7 mètres
function _robotArrowLatLngs(cx, cy, headingDeg) {
  const rad = (headingDeg || 0) * Math.PI / 180;
  const len = ROBOT_SIZE * 0.7;
  const tipX = cx + Math.sin(rad) * len, tipY = cy + Math.cos(rad) * len;
  const a = metersToLatLng(cx, cy), b = metersToLatLng(tipX, tipY);
  return (a && b) ? [[a.lat, a.lng], [b.lat, b.lng]] : null;
}

// ── Dashboard satellite view ─────────────────────────────────────────────────

// Fonction utilitaire : couleur/opacité d'une case
function _cellStyle(cell) {
  if (cell.completed) return { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.65, opacity: 0.4 };
  if (cell.selected)  return { color: '#0ea5e9', fillColor: '#0ea5e9', fillOpacity: 0.25, opacity: 0.15 };
  return { color: '#ffffff', fillColor: '#ffffff', fillOpacity: 0.05, opacity: 0.03 };
}

// Mise à jour légère : change seulement les styles (appelé à chaque tick)
function _updateCellStylesDash() {
  for (let i = 0; i < _cellRectsDash.length; i++) {
    if (state.cells[i]) _cellRectsDash[i].setStyle(_cellStyle(state.cells[i]));
  }
}

// Rebuild complet (chargement d'étang ou changement de sélection)
function _rebuildCellLayersDash() {
  for (const l of _cellLayersDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _cellLayersDash.length = 0;
  _cellRectsDash.length  = 0;
  if (!state.pond) return;
  if (!_cellRendererDash) _cellRendererDash = L.canvas({ padding: 0.5 });
  const cs = params.cellSize;
  for (const cell of state.cells) {
    const sw = metersToLatLng(cell.cx - cs/2, cell.cy - cs/2);
    const ne = metersToLatLng(cell.cx + cs/2, cell.cy + cs/2);
    if (!sw || !ne) continue;
    const rect = L.rectangle([[sw.lat, sw.lng],[ne.lat, ne.lng]], {
      renderer: _cellRendererDash, weight: 0.5, ..._cellStyle(cell),
    }).addTo(_leafletMapDash);
    _cellLayersDash.push(rect);
    _cellRectsDash.push(rect);
  }
}

// Redessine la base (polygone) — appelé lors du chargement de l'étang
function _rebuildBaseLayersDash() {
  for (const l of _baseLayersDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _baseLayersDash.length = 0;
  if (!state.pond) return;
  const origin = state.pond.origin;
  if (!isValidOrigin(origin)) return;

  const polyLL = state.pond.polygon.map(p => { const ll = metersToLatLng(p.x, p.y); return [ll.lat, ll.lng]; });
  const poly = L.polygon(polyLL, { color: '#0ea5e9', weight: 2, fillColor: '#0ea5e9', fillOpacity: 0.07 }).addTo(_leafletMapDash);
  _baseLayersDash.push(poly);

  // Ancre du tuyau d'évacuation — poignée déplaçable à la main, reprojetée sur la berge
  _hoseAnchorMarkerDash = null;
  if (state.pond.hoseAnchor) {
    const aLL = metersToLatLng(state.pond.hoseAnchor.x, state.pond.hoseAnchor.y);
    if (aLL) {
      const anchorIcon = L.divIcon({ html: '<div class="hose-anchor-leaf"></div>', className: '', iconSize: [18,18], iconAnchor: [9,9] });
      _hoseAnchorMarkerDash = L.marker([aLL.lat, aLL.lng], { icon: anchorIcon, draggable: true, zIndexOffset: 950 }).addTo(_leafletMapDash);
      _hoseAnchorMarkerDash.on('drag', e => {
        const local = latLngToMeters(e.target.getLatLng().lat, e.target.getLatLng().lng, origin.lat, origin.lng);
        const snapped = nearestPointOnPolygon(state.pond.polygon, local.x, local.y);
        state.pond.hoseAnchor = snapped;
        const sLL = metersToLatLng(snapped.x, snapped.y);
        if (sLL) e.target.setLatLng([sLL.lat, sLL.lng]);
        _refreshHosePolylineDash();
      });
      _hoseAnchorMarkerDash.on('dragend', () => { saveWork(); updateHoseLengthDisplay(); });
      _baseLayersDash.push(_hoseAnchorMarkerDash);
    }
  }

  // Zone de dépôt des sédiments + segment de tuyau posé au sol (droit, pas ondulé) qui
  // relie l'ancre à son centroïde.
  _depositZoneDash = null; _depositSegmentDash = null;
  if (state.pond.depositZone) {
    const { polyLL: dzLL, centroidLL } = _depositZoneLatLngs(state.pond.depositZone);
    if (dzLL.length > 2) {
      _depositZoneDash = L.polygon(dzLL, { color: '#92400e', weight: 2, fillColor: '#92400e', fillOpacity: 0.3 }).addTo(_leafletMapDash);
      _baseLayersDash.push(_depositZoneDash);
    }
    const anchorLL = metersToLatLng(state.pond.hoseAnchor.x, state.pond.hoseAnchor.y);
    if (anchorLL && centroidLL) {
      _depositSegmentDash = L.polyline([[anchorLL.lat, anchorLL.lng], [centroidLL.lat, centroidLL.lng]], {
        color: '#f97316', weight: 4, opacity: 0.9,
      }).addTo(_leafletMapDash);
      _baseLayersDash.push(_depositSegmentDash);
    }
  }

  // La coupe verticale flotte en haut à droite du canvas : on réserve sa largeur côté droit
  // pour garder l'étang centré côté gauche, jamais masqué dessous.
  const widget   = document.getElementById('sectionWidget');
  const rightPad = 40 + (widget ? widget.offsetWidth + 20 : 0);
  _leafletMapDash.fitBounds(poly.getBounds(), { paddingTopLeft: [40, 40], paddingBottomRight: [rightPad, 40] });
}

// (Re)crée le robot + le tuyau — appelé au chargement de l'étang, changement de style,
// PAS à chaque tick (voir _updateDynamicLayersDashPosition ci-dessous pour ça).
function _rebuildDynamicLayersDash() {
  for (const l of _dynamicLayersDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _dynamicLayersDash.length = 0;
  _robotSquareDash = null; _robotPumpDash = null; _robotArrowDash = null; _gpsLabelMarkerDash = null;
  if (!state.pond) return;
  const origin = state.pond.origin;
  if (!isValidOrigin(origin)) return;

  const robotLL = metersToLatLng(state.robot.x, state.robot.y);
  if (!robotLL) return;

  // Robot — polygone/cercle/ligne géographiques, mis à l'échelle réelle en continu par Leaflet
  // pendant le zoom (une icône en pixels resterait figée pendant l'animation).
  const sq = _robotSquareLatLngs(state.robot.x, state.robot.y);
  if (sq.length > 2) {
    _robotSquareDash = L.polygon(sq, { color: '#fff', weight: 3, fillColor: '#f59e0b', fillOpacity: 0.55 }).addTo(_leafletMapDash);
    _dynamicLayersDash.push(_robotSquareDash);
  }
  _robotPumpDash = L.circle([robotLL.lat, robotLL.lng], {
    radius: ROBOT_SIZE * 0.18, color: '#fff', weight: 1.5,
    fillColor: state.robot.pumpState === 'pumping' ? '#10b981' : 'rgba(16,185,129,0.5)', fillOpacity: 0.9,
  }).addTo(_leafletMapDash);
  _dynamicLayersDash.push(_robotPumpDash);
  const arrow = _robotArrowLatLngs(state.robot.x, state.robot.y, state.robot.heading);
  if (arrow) {
    _robotArrowDash = L.polyline(arrow, { color: '#fff', weight: 3 }).addTo(_leafletMapDash);
    _dynamicLayersDash.push(_robotArrowDash);
  }

  // Position GPS
  const gpsIcon = L.divIcon({
    html: `<div class="gps-pos-leaf">${robotLL.lat.toFixed(6)}, ${robotLL.lng.toFixed(6)}</div>`,
    className: '', iconSize: [160,18], iconAnchor: [80,-18],
  });
  _gpsLabelMarkerDash = L.marker([robotLL.lat, robotLL.lng], { icon: gpsIcon, zIndexOffset: 900 }).addTo(_leafletMapDash);
  _dynamicLayersDash.push(_gpsLabelMarkerDash);

  // Tuyau d'évacuation flottant — courbe de l'ancre (berge, déplaçable) au robot
  _hosePolylineDash = null; _hoseOutlineDash = null;
  if (state.pond.hoseAnchor) {
    const hosePts = _hoseLatLngs(state.pond.hoseAnchor, state.robot);
    if (hosePts.length > 1) {
      _hoseOutlineDash = L.polyline(hosePts, { color: '#000', weight: 7, opacity: 0.4, lineCap: 'round' }).addTo(_leafletMapDash);
      _dynamicLayersDash.push(_hoseOutlineDash);
      _hosePolylineDash = L.polyline(hosePts, { color: '#f97316', weight: 4, opacity: 0.95, lineCap: 'round' }).addTo(_leafletMapDash);
      _dynamicLayersDash.push(_hosePolylineDash);
    }
  }
  _robotSquareDash?.bringToFront(); _robotPumpDash?.bringToFront(); _robotArrowDash?.bringToFront();
}

// Mise à jour légère appelée à chaque tick : repositionne les couches existantes (setLatLngs/
// setStyle) au lieu de les détruire et recréer — bien moins coûteux, et surtout ne crée jamais
// de nouvelle couche Leaflet pendant une transition de zoom en cours.
function _updateDynamicLayersDashPosition() {
  if (!_leafletMapDash || !state.pond || !_robotSquareDash) return;
  const r = state.robot;
  const robotLL = metersToLatLng(r.x, r.y);
  if (!robotLL) return;

  const sq = _robotSquareLatLngs(r.x, r.y);
  if (sq.length > 2) _robotSquareDash.setLatLngs(sq);
  if (_robotPumpDash) {
    _robotPumpDash.setLatLng([robotLL.lat, robotLL.lng]);
    _robotPumpDash.setStyle({ fillColor: r.pumpState === 'pumping' ? '#10b981' : 'rgba(16,185,129,0.5)' });
  }
  const arrow = _robotArrowLatLngs(r.x, r.y, r.heading);
  if (arrow && _robotArrowDash) _robotArrowDash.setLatLngs(arrow);

  if (_gpsLabelMarkerDash) {
    _gpsLabelMarkerDash.setLatLng([robotLL.lat, robotLL.lng]);
    const el = _gpsLabelMarkerDash.getElement()?.querySelector('.gps-pos-leaf');
    if (el) el.textContent = `${robotLL.lat.toFixed(6)}, ${robotLL.lng.toFixed(6)}`;
  }

  if (state.pond.hoseAnchor) {
    const pts = _hoseLatLngs(state.pond.hoseAnchor, state.robot);
    if (_hosePolylineDash) _hosePolylineDash.setLatLngs(pts);
    if (_hoseOutlineDash)  _hoseOutlineDash.setLatLngs(pts);
  }
}

// Redessine le parcours planifié
function _rebuildPathLayerDash() {
  for (const l of _pathLayerDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _pathLayerDash.length = 0;
  if (!state.pond || state.plannedPath.length < 2) return;
  const origin = state.pond.origin;
  if (!isValidOrigin(origin)) return;

  const latlngs = [];
  for (const idx of state.plannedPath) {
    const cell = state.cells[idx]; if (!cell) continue;
    const ll = metersToLatLng(cell.cx, cell.cy); if (!ll) continue;
    latlngs.push([ll.lat, ll.lng]);
  }
  if (latlngs.length > 1) {
    _pathLayerDash.push(L.polyline(latlngs, { color: 'rgba(251,191,36,0.6)', weight: 1.5, dashArray: '4,4' }).addTo(_leafletMapDash));
  }
}

// Handlers de sélection : clic = case unique, drag = rectangle
function _addSelectionHandlersDash() {
  let _startLL = null, _startPt = null, _selRectLayer = null;

  _leafletMapDash.on('mousedown', e => {
    // Le tracé d'étang/zone de dépôt (Leaflet.draw) est actif sur cette même carte — sans
    // cette garde, ce gestionnaire de sélection rectangle (mousedown/mousemove/mouseup, avec
    // son propre disable()/enable() de map.dragging) entre en concurrence avec la gestion
    // interne des sommets de Leaflet.draw et fait clore le polygone prématurément après
    // seulement 2-3 clics au lieu d'attendre la validation explicite de l'utilisateur.
    if (_drawTool && _drawTool._enabled) return;
    if (state.view.mode !== 'select' || e.originalEvent.button !== 0) return;
    _startLL = e.latlng;
    _startPt = e.containerPoint;
    _leafletMapDash.dragging.disable();
    e.originalEvent.preventDefault();
  });

  _leafletMapDash.on('mousemove', e => {
    if (!_startLL) return;
    if (_selRectLayer) _leafletMapDash.removeLayer(_selRectLayer);
    _selRectLayer = L.rectangle([_startLL, e.latlng], {
      color: '#0ea5e9', weight: 1.5, fillColor: '#0ea5e9', fillOpacity: 0.08,
      dashArray: '5,4', interactive: false,
    }).addTo(_leafletMapDash);
  });

  _leafletMapDash.on('mouseup', e => {
    if (!_startLL) return;
    if (_selRectLayer) { _leafletMapDash.removeLayer(_selRectLayer); _selRectLayer = null; }
    _leafletMapDash.dragging.enable();

    const origin = state.pond?.origin; if (!origin) { _startLL = null; return; }
    const dx = Math.abs(e.containerPoint.x - _startPt.x);
    const dy = Math.abs(e.containerPoint.y - _startPt.y);
    const hcs = params.cellSize / 2;

    if (dx > 8 || dy > 8) {
      // Sélection rectangle
      const swLL = { lat: Math.min(_startLL.lat, e.latlng.lat), lng: Math.min(_startLL.lng, e.latlng.lng) };
      const neLL = { lat: Math.max(_startLL.lat, e.latlng.lat), lng: Math.max(_startLL.lng, e.latlng.lng) };
      const sw = latLngToMeters(swLL.lat, swLL.lng, origin.lat, origin.lng);
      const ne = latLngToMeters(neLL.lat, neLL.lng, origin.lat, origin.lng);
      let changed = false;
      for (const cell of state.cells) {
        if (cell.cx + hcs > sw.x && cell.cx - hcs < ne.x && cell.cy + hcs > sw.y && cell.cy - hcs < ne.y) {
          cell.selected = true; changed = true;
        }
      }
      if (changed) { _rebuildCellLayersDash(); renderAllPondCanvases(); debouncedSaveSelection(); }
    } else {
      // Clic simple — bascule une case
      const local = latLngToMeters(e.latlng.lat, e.latlng.lng, origin.lat, origin.lng);
      const cell = state.cells.find(c => Math.abs(c.cx - local.x) <= hcs && Math.abs(c.cy - local.y) <= hcs);
      if (cell) { cell.selected = !cell.selected; _rebuildCellLayersDash(); renderAllPondCanvases(); debouncedSaveSelection(); }
    }
    _startLL = null; _startPt = null;
  });

  // Annule si la souris quitte la carte
  _leafletMapDash.getContainer().addEventListener('mouseleave', () => {
    if (_selRectLayer) { _leafletMapDash.removeLayer(_selRectLayer); _selRectLayer = null; }
    if (_startLL) { _leafletMapDash.dragging.enable(); _startLL = null; }
  });
}

function initLeafletMapDash() {
  if (_leafletMapDash) { setTimeout(() => _leafletMapDash.invalidateSize(), 50); return; }
  const container = document.getElementById('leaflet-container-dash');
  if (!container || typeof L === 'undefined') return;

  _leafletMapDash = L.map('leaflet-container-dash', { zoomControl: false });
  // Leaflet a besoin d'une vue (centre/zoom) déjà établie avant qu'on puisse lui ajouter le
  // moindre calque vectoriel (polygone de l'étang) — sinon il plante en interne,
  // silencieusement — c'était la vraie cause de "la carte n'affiche rien".
  _leafletMapDash.setView([0, 0], 2);

  const styleDash = MAP_STYLES[_currentMapStyle];
  _baseTileLayerDash = L.tileLayer(styleDash.url, { attribution: styleDash.attribution, maxZoom: 23, maxNativeZoom: styleDash.maxNativeZoom }).addTo(_leafletMapDash);
  if (styleDash.labels) {
    _labelsLayerDash = L.tileLayer(styleDash.labels, { attribution: '', maxZoom: 23, maxNativeZoom: styleDash.maxNativeZoom, opacity: 0.65 }).addTo(_leafletMapDash);
  }
  L.control.zoom({ position: 'bottomright' }).addTo(_leafletMapDash);
  _leafletMapDash.on('zoomstart', () => { _isZoomingMapDash = true; });
  _leafletMapDash.on('zoomend', () => {
    _isZoomingMapDash = false;
    if (!_satModeDash) return;
    if (_robotSquareDash) _updateDynamicLayersDashPosition();
    else _rebuildDynamicLayersDash();
  });

  _rebuildLeafletDashLayers();
  _addSelectionHandlersDash();
}

// Un throw dans une étape (ex. polygone/case avec des coordonnées invalides) ne doit pas
// empêcher les suivantes de s'exécuter — sinon une carte satellite "n'affiche rien du tout"
// (ni tuiles, ni polygone, ni robot) et rien dans la console n'indique pourquoi. Chaque étape
// est isolée et son échec journalisé avec une étiquette claire pour un diagnostic rapide.
function _rebuildLeafletDashLayers() {
  for (const [label, fn] of [
    ['base',    _rebuildBaseLayersDash],
    ['cells',   _rebuildCellLayersDash],
    ['path',    _rebuildPathLayerDash],
    ['dynamic', _rebuildDynamicLayersDash],
  ]) {
    try { fn(); } catch (err) { console.error(`[leaflet-dash] échec de la construction "${label}":`, err); }
  }
}

function updateLeafletOverlayDash() {
  if (!_leafletMapDash) return;
  _rebuildLeafletDashLayers();
}

function updateRobotMarkerDash() {
  if (!_satModeDash || !_leafletMapDash || _isZoomingMapDash) return;
  if (_robotSquareDash) _updateDynamicLayersDashPosition();
  else _rebuildDynamicLayersDash();
  _updateCellStylesDash();
}

function toggleSatelliteViewDash(on) {
  _satModeDash = on;
  document.getElementById('btnSatViewDash')?.classList.toggle('active', on);
  document.getElementById('btnSchemaViewDash')?.classList.toggle('active', !on);

  const canvas      = document.getElementById('dashPondCanvas');
  const leafletDiv  = document.getElementById('leaflet-container-dash');
  const schemaZoom  = document.getElementById('dashSchemaZoom');

  const styleGroupDash = document.getElementById('dashMapStyleGroup');

  if (on) {
    if (canvas)          canvas.style.visibility = 'hidden';
    if (leafletDiv)      leafletDiv.style.display = 'block';
    if (schemaZoom)      schemaZoom.style.display = 'none';
    if (styleGroupDash)  styleGroupDash.style.display = '';
    if (_leafletMapDash) _applyModeToLeafletDash();
    if (!_leafletMapDash) initLeafletMapDash();
    else { updateLeafletOverlayDash(); setTimeout(() => _leafletMapDash.invalidateSize(), 100); }
  } else {
    if (leafletDiv)     leafletDiv.style.display = 'none';
    if (canvas)         canvas.style.visibility = '';
    if (schemaZoom)     schemaZoom.style.display = '';
    if (styleGroupDash) styleGroupDash.style.display = 'none';
    // Pendant que ce canvas était masqué (visibility:hidden), renderAllPondCanvases() l'a
    // délibérément ignoré (voir _isCanvasActuallyVisible) — il peut donc afficher un contenu
    // périmé au moment où il redevient visible ; on le redessine explicitement ici.
    if (canvas) renderPondCanvas(canvas);
  }
}

function _applyModeToLeafletDash() {
  if (!_leafletMapDash) return;
  if (state.view.mode === 'select') {
    _leafletMapDash.dragging.disable();
    _leafletMapDash.getContainer().style.cursor = 'crosshair';
  } else {
    _leafletMapDash.dragging.enable();
    _leafletMapDash.getContainer().style.cursor = 'grab';
  }
}

// ============================================================
// TRACÉ D'ÉTANG RÉEL — recherche d'adresse + dessin du contour / zone de dépôt
// Onglet Tableau de bord, vue Satellite uniquement (besoin de voir le terrain pour tracer).
// ============================================================

// ── Recherche d'adresse (API Adresse — data.gouv.fr, gratuite, sans clé) ──
// Port du bloc équivalent de site-vandaele/js/estimation.js (même API, même UX).
let _addrDebounce = null, _addrFocusIndex = -1, _addrResults = [];

function centerCarteMapOn(lat, lng, zoom = 18) {
  if (!_leafletMapDash) return;
  _leafletMapDash.setView([lat, lng], zoom);
  _leafletMapDash.invalidateSize();
}

function _addrRenderDropdown(features) {
  const dropdown = document.getElementById('drawAddressDropdown');
  if (!dropdown) return;
  _addrResults = features;
  _addrFocusIndex = -1;
  if (!features.length) { dropdown.classList.remove('open'); dropdown.innerHTML = ''; return; }
  dropdown.innerHTML = features.map((f, i) => {
    const p = f.properties;
    const icon = p.type === 'municipality' ? '🏘️' : p.type === 'street' ? '🛣️' : '📍';
    return `<li data-idx="${i}"><span class="ac-icon">${icon}</span><span><span class="ac-main">${p.name || p.label}</span><br><span class="ac-sub">${p.postcode || ''} ${p.city || ''}</span></span></li>`;
  }).join('');
  dropdown.classList.add('open');
  dropdown.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', e => { e.preventDefault(); _addrSelect(parseInt(li.dataset.idx)); });
  });
}

function _addrSelect(idx) {
  const f = _addrResults[idx];
  if (!f) return;
  const input = document.getElementById('drawAddressInput');
  const dropdown = document.getElementById('drawAddressDropdown');
  if (input) input.value = f.properties.label;
  if (dropdown) { dropdown.classList.remove('open'); dropdown.innerHTML = ''; }
  _addrResults = [];
  const [lng, lat] = f.geometry.coordinates;
  centerCarteMapOn(lat, lng, 18);
}

function _addrUpdateFocus() {
  const dropdown = document.getElementById('drawAddressDropdown');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('li');
  items.forEach((li, i) => li.classList.toggle('focused', i === _addrFocusIndex));
  if (_addrFocusIndex >= 0 && items[_addrFocusIndex]) items[_addrFocusIndex].scrollIntoView({ block: 'nearest' });
}

function initAddressSearch() {
  const input = document.getElementById('drawAddressInput');
  const dropdown = document.getElementById('drawAddressDropdown');
  if (!input || !dropdown || input.dataset.bound) return;
  input.dataset.bound = '1';

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(_addrDebounce);
    if (q.length < 3) { dropdown.classList.remove('open'); dropdown.innerHTML = ''; return; }
    dropdown.innerHTML = '<li class="autocomplete-loading">Recherche en cours…</li>';
    dropdown.classList.add('open');
    _addrDebounce = setTimeout(async () => {
      try {
        const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6&autocomplete=1`;
        const res = await fetch(url);
        const data = await res.json();
        _addrRenderDropdown(data.features || []);
      } catch { dropdown.classList.remove('open'); dropdown.innerHTML = ''; }
    }, 280);
  });

  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('li');
    if (!dropdown.classList.contains('open') || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); _addrFocusIndex = Math.min(_addrFocusIndex + 1, items.length - 1); _addrUpdateFocus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _addrFocusIndex = Math.max(_addrFocusIndex - 1, 0); _addrUpdateFocus(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (_addrFocusIndex >= 0) _addrSelect(_addrFocusIndex); else if (_addrResults.length) _addrSelect(0); }
    else if (e.key === 'Escape') { dropdown.classList.remove('open'); dropdown.innerHTML = ''; }
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.remove('open');
  });
}

// ── Dessin (Leaflet.draw) ──────────────────────────────────────────────────
let _drawMode = null;             // null | 'contour' | 'deposit'
let _drawTool = null;             // instance L.Draw.Polygon partagée, créée une fois
let _draftLayer = null;           // aperçu de la forme en cours de tracé
let _draftContourLatLngs = null;  // sommets du dernier contour tracé, en attente de validation

function setDrawStatus(msg) { const el = document.getElementById('drawStatusBar'); if (el) el.textContent = msg; }

function _ensureDrawTool() {
  if (!_leafletMapDash || typeof L === 'undefined' || !L.Draw) return null;
  if (_drawTool) return _drawTool;

  _drawTool = new L.Draw.Polygon(_leafletMapDash, {
    allowIntersection: false,
    showArea: true,
    shapeOptions: { color: '#f97316', fillColor: '#f97316', fillOpacity: 0.15, weight: 2 },
    metric: true, feet: false,
  });

  // Fermeture fiable au clic sur le 1er sommet OU via le bouton "Terminer" — même pattern
  // que site-vandaele/js/estimation.js : disable() doit s'exécuter AVANT l'event CREATED,
  // sinon les guides de tracé restent visibles une fois la forme validée.
  _drawTool._finishShape = function() {
    const pts = (this._markers || []).map(m => m.getLatLng());
    if (pts.length < 3) return;
    this.disable();
    const layer = L.polygon([pts], { color: '#f97316', fillColor: '#f97316', fillOpacity: 0.15, weight: 2 });
    _leafletMapDash.fire(L.Draw.Event.CREATED, { layer, layerType: 'polygon' });
  };

  _leafletMapDash.on('draw:drawvertex', () => {
    if (!_drawTool._enabled || !_drawTool._markers || _drawTool._markers.length < 3) return;
    const firstMarker = _drawTool._markers[0];
    firstMarker.off('click').on('click', ev => { L.DomEvent.stop(ev); finishCurrentDrawing(); });
  });

  _leafletMapDash.on(L.Draw.Event.CREATED, _handleDrawCreated);
  return _drawTool;
}

function toggleDrawPondPanel(force) {
  const panel = document.getElementById('drawPondPanel');
  if (!panel) return;
  const open = force !== undefined ? force : panel.style.display === 'none';
  if (!open) { cancelDraw(); return; }

  if (!_satModeDash) toggleSatelliteViewDash(true);
  initAddressSearch();
  _drawMode = null;
  document.getElementById('drawAddressRow').style.display = '';
  document.getElementById('drawNameRow').style.display = 'none';
  document.getElementById('btnStartContour').style.display = '';
  document.getElementById('btnFinishDraw').style.display = 'none';
  setDrawStatus('Cliquez sur « Tracer le contour », puis délimitez l\'étang sur la carte.');
  panel.style.display = 'flex';
  // Tant qu'aucun étang n'est chargé (cas normal : on est justement en train d'en dessiner
  // un), l'état vide reste affiché par-dessus la carte (z-index) et intercepte tous les
  // clics destinés à l'outil de tracé. On le masque explicitement pendant le tracé —
  // updateUI() le réaffichera normalement si jamais le tracé est annulé sans étang créé.
  const emptyState = document.getElementById('dashCanvasEmptyState');
  if (emptyState) emptyState.style.display = 'none';
}

function openDrawPondFromEmptyState() {
  toggleSatelliteViewDash(true);
  toggleDrawPondPanel(true);
}

// Point d'entrée depuis l'onglet Étangs — le tracé se fait directement sur la carte du
// tableau de bord (en vue satellite) plutôt que sur un onglet Carte séparé, pour n'avoir
// jamais qu'une seule carte Leaflet active à la fois. Enveloppé dans un try/catch : mieux
// vaut un message d'erreur visible qu'un clic silencieusement sans effet.
function goToDrawPond() {
  try {
    setActiveTab('dashboard');
    openDrawPondFromEmptyState();
  } catch (err) {
    console.error('[goToDrawPond]', err);
    showToast('Erreur lors de l\'ouverture du tracé — voir la console', 'error');
  }
}

// Point d'entrée depuis une fiche de l'onglet Étangs — charge l'étang si besoin, bascule
// sur le tableau de bord en vue satellite et lance directement le tracé de sa zone de dépôt.
function startDepositZoneForPond(id) {
  try {
    const pond = state.ponds.find(p => p.id === id);
    if (!pond) { showToast('Étang introuvable', 'error'); return; }
    if (state.pond?.id !== id) loadPond(pond);
    setActiveTab('dashboard');
    toggleSatelliteViewDash(true);
    startDepositZoneDraw();
  } catch (err) {
    console.error('[startDepositZoneForPond]', err);
    showToast('Erreur lors de l\'ouverture du tracé — voir la console', 'error');
  }
}

function startContourDraw() {
  const tool = _ensureDrawTool();
  if (!tool) { showToast('Passez en vue Satellite pour dessiner', 'error'); return; }
  _drawMode = 'contour';
  _draftContourLatLngs = null;
  if (_draftLayer) { _leafletMapDash.removeLayer(_draftLayer); _draftLayer = null; }
  document.getElementById('drawNameRow').style.display = 'none';
  document.getElementById('btnStartContour').style.display = 'none';
  document.getElementById('btnFinishDraw').style.display = '';
  setDrawStatus('📐 Cliquez pour placer les sommets du contour. Cliquez sur le 1er point ou sur « Terminer » pour fermer.');
  tool.enable();
}

// Actif dès qu'un étang est chargé (dessiné ou importé en KML) — retrace la zone de dépôt
// existante si besoin, pas de drag-and-drop d'une forme entière après coup (hors scope).
function startDepositZoneDraw() {
  if (!state.pond) { showToast('Chargez ou dessinez un étang d\'abord', 'error'); return; }
  const tool = _ensureDrawTool();
  if (!tool) { showToast('Passez en vue Satellite pour dessiner', 'error'); return; }
  if (!_satModeDash) toggleSatelliteViewDash(true);
  _drawMode = 'deposit';
  const panel = document.getElementById('drawPondPanel');
  if (panel) panel.style.display = 'flex';
  document.getElementById('drawAddressRow').style.display = 'none';
  document.getElementById('drawNameRow').style.display = 'none';
  document.getElementById('btnStartContour').style.display = 'none';
  document.getElementById('btnFinishDraw').style.display = '';
  setDrawStatus('🎯 Délimitez la zone de dépôt des sédiments (là où ira le tuyau). Cliquez sur le 1er point ou sur « Terminer » pour fermer.');
  tool.enable();
}

function finishCurrentDrawing() {
  if (_drawTool && _drawTool._enabled) {
    if ((_drawTool._markers || []).length < 3) { setDrawStatus('⚠️ Tracez au moins 3 points.'); return; }
    _drawTool._finishShape();
  }
}

function cancelDraw() {
  if (_drawTool) _drawTool.disable();
  if (_draftLayer && _leafletMapDash) { _leafletMapDash.removeLayer(_draftLayer); _draftLayer = null; }
  _drawMode = null;
  _draftContourLatLngs = null;
  const panel = document.getElementById('drawPondPanel');
  if (panel) panel.style.display = 'none';
  // Restaure l'état vide (masqué pendant le tracé, voir toggleDrawPondPanel) si le tracé est
  // annulé sans qu'un étang n'ait été créé entre-temps.
  const emptyState = document.getElementById('dashCanvasEmptyState');
  if (emptyState) emptyState.style.display = state.pond ? 'none' : 'flex';
}

function _handleDrawCreated(e) {
  if (_draftLayer && _leafletMapDash) _leafletMapDash.removeLayer(_draftLayer);
  _draftLayer = e.layer.addTo(_leafletMapDash);

  const raw = e.layer.getLatLngs();
  const lls = Array.isArray(raw[0]) ? raw[0] : raw;

  if (_drawMode === 'contour') {
    const areaM2 = Math.round(L.GeometryUtil.geodesicArea(lls));
    // Garde-fou : generateGrid() construit une grille cols×rows à partir de la surface —
    // un tracé démesuré (carte pas recentrée, clic malheureux) produirait une grille de
    // plusieurs milliards de cases et fait planter l'onglet. 20 ha est déjà très généreux
    // pour un étang réel.
    if (areaM2 > 200000) {
      _leafletMapDash.removeLayer(_draftLayer);
      _draftLayer = null;
      document.getElementById('btnStartContour').style.display = '';
      document.getElementById('btnFinishDraw').style.display = 'none';
      setDrawStatus(`⚠️ Surface bien trop grande (${areaM2.toLocaleString('fr-FR')} m²) — vérifiez que la carte est bien centrée sur l'étang, puis retracez.`);
      return;
    }
    _draftContourLatLngs = lls.map(ll => ({ lat: ll.lat, lng: ll.lng }));
    document.getElementById('drawNameRow').style.display = '';
    document.getElementById('btnFinishDraw').style.display = 'none';
    setDrawStatus(`✅ Surface tracée : ${areaM2.toLocaleString('fr-FR')} m². Donnez un nom à l'étang puis validez.`);
  } else if (_drawMode === 'deposit') {
    const origin = state.pond.origin;
    const polygon = lls.map(ll => latLngToMeters(ll.lat, ll.lng, origin.lat, origin.lng));
    const cx = polygon.reduce((s,p) => s+p.x, 0) / polygon.length;
    const cy = polygon.reduce((s,p) => s+p.y, 0) / polygon.length;
    state.pond.depositZone = { polygon, centroid: { x: cx, y: cy } };
    state.pond.hoseAnchor  = nearestPointOnPolygon(state.pond.polygon, cx, cy);
    saveWork();
    updateHoseLengthDisplay();
    updateLeafletOverlayDash();
    renderAllPondCanvases();
    updatePondsList();
    cancelDraw();
    showToast('Zone de dépôt enregistrée — tuyau mis à jour', 'success');
  }
}

function confirmNewPond() {
  if (!_draftContourLatLngs || _draftContourLatLngs.length < 3) return;
  const nameInput = document.getElementById('drawPondNameInput');
  const name = (nameInput?.value || '').trim() || `Étang ${new Date().toLocaleDateString('fr-FR')}`;
  const origin = _draftContourLatLngs[0];
  const polygon = _draftContourLatLngs.map(ll => latLngToMeters(ll.lat, ll.lng, origin.lat, origin.lng));
  const first = polygon[0], last = polygon[polygon.length - 1];
  if (dist(first.x, first.y, last.x, last.y) > 0.1) polygon.push({ ...first });

  const pond = createPondFromKML({ name, polygon, origin });
  const idx = state.ponds.findIndex(p => p.name === pond.name);
  if (idx !== -1) state.ponds[idx] = pond; else state.ponds.push(pond);
  savePonds();

  if (_draftLayer && _leafletMapDash) { _leafletMapDash.removeLayer(_draftLayer); _draftLayer = null; }
  loadPond(pond);
  updatePondsList();
  cancelDraw();
  showToast(`Étang « ${pond.name} » créé (${pond.cells.length} cases)`, 'success');
}

// ============================================================
// INIT
// ============================================================
function init() {
  applyThemeIcon();
  toggleSatelliteViewDash(true);
  loadPonds();
  try { const sp = localStorage.getItem('aquabot_params'); if (sp) Object.assign(params, JSON.parse(sp)); } catch {}

  syncParamsToDOM();
  subscribeParams();

  document.querySelectorAll('.nav-tab').forEach(btn => btn.addEventListener('click', () => setActiveTab(btn.dataset.tab)));

  initCanvasEvents();
  _initBathyCanvasSelectionEvents();
  _initBathy3DPanZoomEvents();
  _initDash3DPanZoomEvents();
  initBathyPaletteButtons();

  updatePondsList();
  updateUI();
  updateButtonStates();

  // Load last pond — only in local mode (cloud mode auto-loads via onSnapshot)
  if (!USE_CLOUD && state.ponds.length > 0) {
    const last = [...state.ponds].sort((a,b) => (b.lastUsed||0)-(a.lastUsed||0))[0];
    if (last) loadPond(last);
  }

  resizeSectionCanvas();
  renderSectionCanvas();

  // Save on unload
  window.addEventListener('beforeunload', saveWork);
  window.addEventListener('resize', () => {
    resizeSectionCanvas(); renderSectionCanvas();
    if (_leafletMapBathy) _leafletMapBathy.invalidateSize();
    renderBathyCanvas();
  });

  // Réaffiche périodiquement l'état des boutons (léger, aucun accès réseau) pour que
  // "Démarrer" se réactive tout seul dès que le battement de cœur d'un pilote disparu devient
  // périmé (voir updateButtonStates) — sans ça, ça ne se rafraîchissait qu'au prochain
  // événement (snapshot ou clic), ce qui pouvait laisser le bouton bloqué en apparence.
  setInterval(() => { if (!state.sim.running) updateButtonStates(); }, 1000);

  document.addEventListener('visibilitychange', handleVisibilityChange);
}

// Un onglet mis en arrière-plan (écran éteint, changement d'appli sur mobile) continue de
// détenir le pilotage tant que ses écritures Firestore régulières (saveSimState(), toutes les
// ~200ms tant que state.sim.running est vrai) réaffirment son driverId — mais un onglet
// suffisamment longtemps en arrière-plan peut voir son intervalle ralenti au lieu d'arrêté, ou
// même sa connexion Firestore se couper puis se reconnecter par intermittence. Dans ce cas il
// peut resurgir de temps à autre et réaffirmer son driverId sans jamais avoir "vu" qu'un autre
// appareil avait légitimement repris la main pendant son absence — ce qui redonnait l'illusion
// que Démarrer, ailleurs, se grisait un instant avant de se redébloquer tout seul, sans jamais
// que le robot ne travaille vraiment. On arrête donc nous-mêmes explicitement la boucle locale
// dès la mise en arrière-plan (sans annoncer d'arrêt : les autres appareils reprendront après
// l'expiration normale du battement de cœur), puis on ne la relance qu'après avoir revérifié le
// pilotage au retour au premier plan.
async function handleVisibilityChange() {
  if (document.hidden) {
    if (state.sim.running && state.sim.intervalId) {
      clearInterval(state.sim.intervalId);
      state.sim.intervalId = null;
      state.sim.backgroundPaused = true;
    }
    return;
  }
  if (!state.sim.backgroundPaused) return;
  state.sim.backgroundPaused = false;
  if (!state.sim.running || !state.pond) return;
  const owns = !USE_CLOUD || await claimSimOwnership(state.pond.id);
  if (!owns) {
    // Un autre appareil a légitimement repris la main pendant notre absence — on redevient
    // simple suiveur, subscribeSimState() reflète déjà son état exact.
    state.sim.running = false;
    updateButtonStates();
    return;
  }
  state.sim.lastTick = performance.now();
  state.sim.intervalId = setInterval(simulationTick, SIM_TICK_MS);
}

window.addEventListener('DOMContentLoaded', init);
