'use strict';

// ============================================================
// CLOUD — Firebase Firestore
// ============================================================
const USE_CLOUD = typeof window !== 'undefined' && !!window.db;

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
    lastUsed:   pond.lastUsed   || Date.now(),
    lastResetAt: pond.lastResetAt || 0,
    work: {
      completedCells: pond.work?.completedCells || [],
      volumePumped:   pond.work?.volumePumped   || 0,
      elapsedSec:     pond.work?.elapsedSec     || 0,
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
    miniCyclesDone: state.robot.miniCyclesDone,
    heading:        state.robot.heading,
    motors:         state.robot.motors,
    elapsedSec:     state.robot.elapsedSec,
    volumePumped:   state.robot.volumePumped,
    plannedPath:    state.plannedPath,
    completedCells: completedIdxs,
    speed:          state.sim.speed,
    workMode:       params.workMode,
    miniCycles:     params.miniCycles,
    lastUpdate:     Date.now(),
  }).catch(e => console.warn('simState save:', e.message));
}

// Debounced save of current cell selection (called after user changes selection)
function debouncedSaveSelection() {
  if (!USE_CLOUD || !state.pond) return;
  _localSelChanging = true;
  clearTimeout(_selDebounce);
  _selDebounce = setTimeout(() => {
    window.db.collection('aquabot_ponds').doc(state.pond.id)
      .update({ currentSelectedIndices: encodeSelection(state.cells), lastUsed: Date.now() })
      .catch(e => console.warn('selSync:', e.message));
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
      if (!doc.exists || state.sim.running) return;
      const sim = doc.data();
      if (!sim) return;

      // Ignorer les données antérieures au dernier RAZ
      const pondResetAt = state.pond?.lastResetAt || 0;
      if (pondResetAt > 0 && (sim.lastUpdate || 0) < pondResetAt) return;

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
      if (sim.speed && sim.speed !== state.sim.speed) {
        state.sim.speed = sim.speed;
        const speedEl = document.getElementById('speedSlider');
        if (speedEl) { speedEl.value = sim.speed; setText('speedValue', sim.speed + '×'); }
      }
      if (sim.workMode)   params.workMode   = sim.workMode;
      if (sim.miniCycles) params.miniCycles = sim.miniCycles;

      state.robot.state          = sim.robotState  || 'stopped';
      state.robot.elapsedSec     = sim.elapsedSec + (sim.simRunning ? offlineSec : 0);
      state.robot.volumePumped   = sim.volumePumped || 0;
      state.robot.x              = sim.x ?? state.robot.x;
      state.robot.y              = sim.y ?? state.robot.y;
      state.robot.pumpDepth      = sim.pumpDepth  ?? 0;
      state.robot.pumpState      = sim.simRunning ? (sim.pumpState || 'idle') : 'idle';
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
        _rebuildCellLayersDash();
        _rebuildPathLayerDash();
        _rebuildDynamicLayersDash();
      }
    }, e => console.warn('simState listener:', e.message));
}

// Lecture unique au chargement : reprend la simulation si elle était en cours.
// Séparé de subscribeSimState pour éviter tout risque de re-entrance.
function checkAndResumeSim(pondId) {
  if (!USE_CLOUD || !state.pond || state.robotMode === 'real') return;
  console.log('[checkAndResumeSim] Lecture aquabot_sim pour', pondId);
  window.db.collection('aquabot_sim').doc(pondId).get().then(doc => {
    console.log('[checkAndResumeSim] doc.exists=', doc.exists, 'sim.running=', state.sim.running);
    if (!doc.exists || state.sim.running) return;
    const sim = doc.data();
    console.log('[checkAndResumeSim] simRunning=', sim?.simRunning, 'lastUpdate=', sim?.lastUpdate, 'plannedPath.length=', sim?.plannedPath?.length, 'completedCells.length=', sim?.completedCells?.length);
    if (!sim || !sim.simRunning) return;

    const pondResetAt = state.pond?.lastResetAt || 0;
    const offlineMs = Date.now() - (sim.lastUpdate || 0);
    console.log('[checkAndResumeSim] pondResetAt=', pondResetAt, 'offlineMs=', offlineMs);
    if (pondResetAt > 0 && (sim.lastUpdate || 0) < pondResetAt) { console.log('[checkAndResumeSim] SKIP: antérieur au RAZ'); return; }
    if (offlineMs > 7200000) { console.log('[checkAndResumeSim] SKIP: trop ancien (>2h)'); return; }

    _resumeSimFromCloud(sim);
  }).catch(e => console.warn('checkAndResumeSim:', e.message));
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
  }
  window.db.collection('aquabot_commands').doc(state.pond.id)
    .set(doc)
    .catch(e => console.warn('Robot command error:', e));
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
    }, e => console.warn('Telemetry listener:', e));
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
    work: data.work || { completedCells: [], volumePumped: 0, elapsedSec: 0 },
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
const CANVAS_IDS  = ['dashPondCanvas', 'pondCanvas'];

// 4 propulseurs en configuration X (avant-gauche, avant-droit, arrière-gauche, arrière-droit)
const MOTOR_LABELS = ['AV-G', 'AV-D', 'AR-G', 'AR-D'];

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
  },
  view: { offsetX: 0, offsetY: 0, scale: 10, canvasH: 600 },
  drag: { active: false, mode: 'add' }, // for drag-select
  hose: { dragging: false }, // déplacement à la main de l'ancrage du tuyau d'évacuation
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
  wifiType: 'ap', wifiSSID: 'WETAP-ESP8266',
  wifiPassword: '507317123456789', wifiIP: '192.168.42.1',
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

// Points d'une courbe légèrement sinueuse entre l'ancre (berge) et le robot — un tuyau qui
// flotte ne file jamais droit, il ondule doucement ; l'amplitude retombe à zéro aux deux
// bouts (sin(πt)) pour que la courbe reste toujours accrochée exactement à l'ancre et au robot.
function computeHoseCurvePoints(anchor, robot, segments = 24) {
  const dx = robot.x - anchor.x, dy = robot.y - anchor.y;
  const L  = Math.hypot(dx, dy) || 0.001;
  const ux = dx / L, uy = dy / L;   // direction
  const nx = -uy, ny = ux;          // perpendiculaire
  const amp = Math.min(L * 0.12, 1.5);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const win  = Math.sin(Math.PI * t);
    const wave = win * (Math.sin(t * 5.3 + L * 0.7) * amp + Math.sin(t * 2.1 + L * 0.3) * amp * 0.4);
    pts.push({ x: anchor.x + dx * t + nx * wave, y: anchor.y + dy * t + ny * wave });
  }
  return pts;
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
    if (dashBadge) dashBadge.textContent = '—';
    if (dashStat)  dashStat.textContent  = '—';
    return;
  }
  const lenM = computeRequiredHoseLength(state.pond);
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
    work: { completedCells: [], volumePumped: 0, elapsedSec: 0 },
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
  state.robot.elapsedSec     = pond.work.elapsedSec    || 0;
  state.plannedPath = [];

  subscribeSimState(pond.id);
  checkAndResumeSim(pond.id);
  if (state.robotMode === 'real') subscribeRobotTelemetry(pond.id);
  if (_satMode     && _leafletMap)     updateLeafletOverlay();
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
  document.getElementById('propulsionPanelMap').style.display = 'flex';
  if (!_satMode) document.getElementById('modeToggle').style.display = 'flex';
  document.getElementById('dashCanvasEmptyState').style.display = 'none';
  document.getElementById('canvasEmptyState').style.display    = 'none';
  ['btnSelectAll','btnSelectRemaining','btnDeselectAll','btnPlanRoute'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = false;
  });

  setMode('select');
  updateHoseLengthDisplay();
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

  pond.work = { completedCells: [], volumePumped: 0, elapsedSec: 0 };
  pond.cells?.forEach(c => { c.completed = false; });
  pond.lastResetAt = Date.now();
  pond.lastUsed    = Date.now();

  if (state.pond?.id === pondId) {
    state.pond.lastResetAt = pond.lastResetAt;
    state.pond.work        = pond.work;
    state.cells.forEach(c => { c.completed = false; });
    state.robot.completedCells = 0;
    state.robot.volumePumped   = 0;
    state.robot.elapsedSec     = 0;
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
      elapsedSec:     0,
      pumpDepth:      0,
      pumpState:      'idle',
      miniCyclesDone: 0,
      currentCellIdx: 0,
      plannedPath:    [],
      lastUpdate:     Date.now(),
    }).catch(e => console.warn('resetWork sim:', e.message));
  }

  if (_satModeDash && _leafletMapDash) { _rebuildPathLayerDash(); _rebuildDynamicLayersDash(); _rebuildCellLayersDash(); }
  if (_satMode     && _leafletMap)     updateLeafletOverlay();
  updatePondsList();
  showToast('Progression remise à zéro', 'success');
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
  if (_satModeDash) _rebuildCellLayersDash();
  debouncedSaveSelection();
  showToast(`${state.cells.length} cases sélectionnées`);
}

function deselectAllCells() {
  state.cells.forEach(c => { c.selected = false; });
  renderAllPondCanvases();
  if (_satModeDash) _rebuildCellLayersDash();
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
  if (_satModeDash) _rebuildCellLayersDash();
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
          showToast(`Échec de l'enregistrement de « ${pond.name} » — ${err.message}`, 'error');
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
        state.ponds = snapshot.docs.map(doc => pondFromFirestore(doc.data()));

        // Sync active pond when another user makes changes
        if (state.pond && !state.sim.running) {
          const remote = state.ponds.find(p => p.id === state.pond.id);
          if (remote) {
            remote.cells.forEach((c, i) => { if (state.cells[i]) state.cells[i].completed = c.completed; });
            state.robot.completedCells = remote.work.completedCells?.length || 0;
            state.robot.volumePumped   = remote.work.volumePumped || 0;
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
    pPumpFlow:'pumpFlow', pRobotSpeed:'robotSpeed',
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
  localStorage.setItem('aquabot_params', JSON.stringify(params));
  showToast('Paramètres enregistrés', 'success');
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
    pPumpFlow:'pumpFlow', pRobotSpeed:'robotSpeed',
  };
  for (const [id, key] of Object.entries(m)) { const el = document.getElementById(id); if (el) el.value = params[key]; }
  document.getElementById('pWifiType').value     = params.wifiType;
  document.getElementById('pWifiSSID').value     = params.wifiSSID;
  document.getElementById('pWifiPassword').value = params.wifiPassword;
  document.getElementById('pWifiIP').value       = params.wifiIP;
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
  // Use dash canvas if visible, otherwise map canvas
  let canvas = document.getElementById('dashPondCanvas');
  const isDash = !!(canvas && canvas.width);
  if (!isDash) canvas = document.getElementById('pondCanvas');
  if (!canvas || !canvas.width) return;
  const W = canvas.width, H = canvas.height;
  const { minX, maxX, minY, maxY } = getPondBbox(state.pond);
  const pad = 40;
  // Sur le tableau de bord, la coupe verticale flotte en haut à droite du canvas :
  // on réserve sa largeur pour garder l'étang centré côté gauche, jamais masqué dessous.
  let usableW = W;
  if (isDash) {
    const widget = document.getElementById('sectionWidget');
    if (widget) usableW = Math.max(120, W - widget.offsetWidth - 20);
  }
  state.view.scale   = Math.min((usableW-pad*2)/(maxX-minX), (H-pad*2)/(maxY-minY));
  state.view.offsetX = minX - pad/state.view.scale;
  state.view.offsetY = minY - pad/state.view.scale;
  renderAllPondCanvases();
  updateScaleInfo();
}

function updateScaleInfo() {
  const txt = `1m = ${state.view.scale.toFixed(1)}px`;
  setText('scaleInfo', txt);
  setText('scaleInfoMap', txt);
}

function zoomIn()  { zoomAt(1.3); }
function zoomOut() { zoomAt(1/1.3); }
function zoomAt(factor) {
  const canvas = document.getElementById(state.activeTab === 'dashboard' ? 'dashPondCanvas' : 'pondCanvas');
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
function renderAllPondCanvases() {
  for (const id of CANVAS_IDS) {
    const c = document.getElementById(id);
    if (c) renderPondCanvas(c);
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
    const hosePts = computeHoseCurvePoints(state.pond.hoseAnchor, state.robot);
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

  const wd  = params.waterDepth, md = params.mudDepth;
  const tot = wd + 0.5, pd = state.robot.pumpDepth;
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
function startSimulation() {
  if (!state.pond) { showToast('Sélectionnez un étang d\'abord', 'error'); return; }
  if (state.robotMode === 'real') {
    if (!state.plannedPath.length) {
      const path = planPath(state.cells);
      if (!path.length) { showToast('Sélectionnez des cases non terminées', 'error'); return; }
      state.plannedPath = path;
      renderAllPondCanvases();
    }
    sendRobotCommand('start');
    return;
  }
  if (state.plannedPath.length === 0) {
    const path = planPath(state.cells);
    if (!path.length) { showToast('Sélectionnez des cases non terminées', 'error'); return; }
    state.plannedPath = path;
  }
  if (state.robot.state === 'stopped') {
    state.robot.currentCellIdx = 0;
    state.sim.sessionElapsedAtStart = state.robot.elapsedSec;
    state.sim.paceDoneCount  = 0;
    state.sim.paceSecPerCell = null;
    autoSaveSelectionOnStart();
    const first = state.cells[state.plannedPath[0]];
    if (first) { state.robot.x = first.cx; state.robot.y = first.cy; }
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

function pauseSimulation() {
  if (state.robotMode === 'real') {
    const cmd = state.robot.state === 'paused' ? 'resume' : 'pause';
    sendRobotCommand(cmd);
    return;
  }
  if (state.robot.state === 'paused') {
    startSimulation(); return;
  }
  state.sim.running = false;
  state.robot.state = 'paused';
  setLED('yellow', 'En pause');
  updateButtonStates();
  updateStatus('En pause', 'Cliquez Reprendre');
  document.getElementById('btnPause').textContent = '▶ Reprendre';
  saveWork();
  saveSimState();
}

function stopSimulation() {
  if (state.robotMode === 'real') { sendRobotCommand('stop'); return; }
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

let _tickLogCount = 0;
function simulationTick() {
  if (!state.sim.running) return;
  if (_tickLogCount < 5) { console.log('[tick]', ++_tickLogCount, 'cellIdx=', state.robot.currentCellIdx, '/', state.plannedPath.length, 'pumpState=', state.robot.pumpState); }
  const now   = performance.now();
  const rawDt = (now - state.sim.lastTick) / 1000;
  state.sim.lastTick = now;
  const dt = rawDt * state.sim.speed;
  state.robot.elapsedSec += rawDt * state.sim.speed;

  const robot = state.robot;
  const path  = state.plannedPath;
  // Full target depth = water + mud (pump goes into the vase)
  const fullDepth    = params.waterDepth + params.mudDepth;
  // Between mini-cycles: rise back to just above the mud surface
  const partialDepth = params.waterDepth;
  const nbCycles     = effectiveMiniCycles();

  if (robot.currentCellIdx >= path.length) { finishSimulation(); return; }

  const targetCell = state.cells[path[robot.currentCellIdx]];
  if (!targetCell) { robot.currentCellIdx++; return; }

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
        }
        robot.currentCellIdx++;
        if (robot.completedCells % 10 === 0) saveWork();
      }
      break;
    }
  }

  // Periodic Firestore save (every 200ms) for near-real-time mirror on other devices
  const nowMs = Date.now();
  if (USE_CLOUD && nowMs - state.sim.lastSimSave > 200) {
    state.sim.lastSimSave = nowMs;
    saveSimState();
  }

  updateUI();
  renderAllPondCanvases();
  renderSectionCanvas();
  if (_satMode)     updateRobotMarker();
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
  const mapEmpty = document.getElementById('canvasEmptyState');
  if (mapEmpty) mapEmpty.style.display = state.pond ? 'none' : 'flex';

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
  setText('dashTimeRemaining', remainingSec != null ? formatTime(remainingSec) : '—');

  // Fin estimée — date/heure absolue, pas juste une durée (visible dès que "Restant" l'est)
  setText('dashETA', remainingSec != null
    ? new Date(Date.now() + remainingSec * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
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

  // Depths
  setText('depthWater', params.waterDepth.toFixed(1));
  setText('depthMud',   params.mudDepth.toFixed(2));
  setText('depthPump',  robot.pumpDepth.toFixed(2));

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
    descending:        ['Descente pompe',     `Cible: ${(params.waterDepth + params.mudDepth).toFixed(2)}m — cycle ${robot.miniCyclesDone + 1}/${nc}`],
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
  // running = local sim loop OR robot is active on another device
  const running = state.sim.running || ['moving', 'pumping'].includes(state.robot.state);
  const hasPond = !!state.pond;
  const stopped = state.robot.state === 'stopped';
  document.getElementById('btnStart').disabled  = running || !hasPond;
  document.getElementById('btnPause').disabled  = stopped || !hasPond;
  document.getElementById('btnStop').disabled   = stopped || !hasPond;
}

// ============================================================
// HANDLERS
// ============================================================
function handleStart()  { startSimulation(); }
function handlePause()  { pauseSimulation(); }
function handleStop()   { stopSimulation(); }
function handleSpeedChange(v) {
  state.sim.speed = parseFloat(v);
  setText('speedValue', v + '×');
  saveSimState();
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
  if (_satMode)     updateLeafletOverlay();
  if (_satModeDash) _rebuildPathLayerDash();
  saveSimState();
  showToast(
    `Parcours planifié : ${base.length} cases × ${totalPasses} passe(s) × ${effectiveMiniCycles()} cycle(s) — Mode : ${wm?.label}`,
    'success'
  );
}

function setMode(mode) {
  state.view.mode = mode;
  ['btnModeSelect','btnModeSelectMap'].forEach(id => { const el = document.getElementById(id); if(el) el.classList.toggle('active', mode==='select'); });
  ['btnModeView','btnModeViewMap'].forEach(id => { const el = document.getElementById(id); if(el) el.classList.toggle('active', mode==='view'); });
  const cur = mode === 'select' ? 'crosshair' : 'grab';
  ['dashPondCanvas','pondCanvas'].forEach(id => { const el = document.getElementById(id); if(el) el.style.cursor = cur; });
  if (_satModeDash) _applyModeToLeafletDash();
}

// ============================================================
// CANVAS EVENTS (shared for both canvases)
// ============================================================
function initCanvasEvents() {
  const canvases = [
    { id: 'dashPondCanvas', wrapId: 'dashCanvasWrap' },
    { id: 'pondCanvas',     wrapId: 'canvasWrap' },
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
        const lmap = wrapId === 'dashCanvasWrap' ? _leafletMapDash : _leafletMap;
        if (lmap) lmap.invalidateSize();
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
      .catch(err => console.warn('Cloud delete error:', err.message));
  }
  state.ponds = state.ponds.filter(p => p.id !== id);
  if (state.pond?.id === id) {
    state.pond = null; state.cells = []; state.plannedPath = [];
    document.getElementById('dashCanvasEmptyState').style.display = 'flex';
    document.getElementById('canvasEmptyState').style.display     = 'flex';
    document.getElementById('propulsionPanelMap').style.display = 'none';
    document.getElementById('modeToggle').style.display    = 'none';
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
  if (tab === 'map') {
    requestAnimationFrame(() => {
      if (_satMode) {
        if (!_leafletMap) initLeafletMap();
        else {
          // invalidateSize() D'ABORD : sinon fitBounds() (dans updateLeafletOverlay) se
          // calcule sur l'ancienne taille de conteneur, encore fausse pendant que l'onglet
          // était masqué, et la carte peut se retrouver sur une vue incohérente ("n'affiche
          // rien"). Une fois la taille corrigée, le recadrage peut se faire correctement.
          _leafletMap.invalidateSize();
          updateLeafletOverlay();
        }
      } else {
        const c = document.getElementById('pondCanvas'), w = document.getElementById('canvasWrap');
        if (c && w) { c.width = w.clientWidth; c.height = w.clientHeight; }
        renderPondCanvas(document.getElementById('pondCanvas'));
        if (state.pond) { document.getElementById('modeToggle').style.display = 'flex'; }
      }
    });
  } else if (tab === 'dashboard') {
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
    work:{completedCells:[],volumePumped:0,elapsedSec:0},
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
let _baseTileLayer     = null;   // onglet Carte
let _labelsLayer       = null;
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

  if (_leafletMap) {
    const r = applyStyle(_leafletMap, _baseTileLayer, _labelsLayer);
    _baseTileLayer = r.tile; _labelsLayer = r.labels;
  }
  if (_leafletMapDash) {
    const r = applyStyle(_leafletMapDash, _baseTileLayerDash, _labelsLayerDash);
    _baseTileLayerDash = r.tile; _labelsLayerDash = r.labels;
  }
}

let _leafletMap          = null;
let _leafletLayers       = [];
let _robotSquareLeaf     = null;
let _robotPumpLeaf       = null;
let _robotArrowLeaf      = null;
let _hosePolylineLeaf    = null;
let _hoseOutlineLeaf     = null; // liseré sombre sous le tuyau, pour le contraste
let _hoseAnchorMarkerLeaf = null;
let _depositZoneLeaf     = null; // zone de dépôt des sédiments
let _depositSegmentLeaf  = null; // segment de tuyau posé au sol, ancre → zone de dépôt
let _satMode             = true; // vue satellite par défaut

let _leafletMapDash      = null;
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
  return computeHoseCurvePoints(anchor, robot)
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

function initLeafletMap() {
  if (_leafletMap) { setTimeout(() => _leafletMap.invalidateSize(), 50); return; }
  const container = document.getElementById('leaflet-container');
  if (!container || typeof L === 'undefined') return;

  _leafletMap = L.map('leaflet-container', { zoomControl: false });
  // Leaflet a besoin d'une vue (centre/zoom) déjà établie avant qu'on puisse lui ajouter
  // le moindre calque vectoriel (polygone/ligne) — sinon ses calculs de bornes internes
  // (_pxBounds) sont undefined et ça plante ("Cannot read properties of undefined
  // (reading 'min')") dès le premier polygone ajouté, avant même le fitBounds() qui
  // suit plus loin. Vue provisoire ici, recadrée par fitBounds() dès que l'étang est connu.
  _leafletMap.setView([0, 0], 2);

  const style = MAP_STYLES[_currentMapStyle];
  _baseTileLayer = L.tileLayer(style.url, { attribution: style.attribution, maxZoom: 23, maxNativeZoom: style.maxNativeZoom }).addTo(_leafletMap);
  if (style.labels) {
    _labelsLayer = L.tileLayer(style.labels, { attribution: '', maxZoom: 23, maxNativeZoom: style.maxNativeZoom, opacity: 0.65 }).addTo(_leafletMap);
  }

  L.control.zoom({ position: 'bottomright' }).addTo(_leafletMap);
  updateLeafletOverlay();
}

function updateLeafletOverlay() {
  if (!_leafletMap) return;
  _buildLeafletOverlay(_leafletMap, _leafletLayers);
}

// Repositionne le robot à chaque tick — polygone/cercle/ligne géographiques : Leaflet les
// remet à l'échelle tout seul en continu pendant le zoom, pas besoin de recalculer une taille.
function updateRobotMarker() {
  if (!_robotSquareLeaf || !_satMode) return;
  const r = state.robot;
  const sq = _robotSquareLatLngs(r.x, r.y);
  if (sq.length > 2) _robotSquareLeaf.setLatLngs(sq);
  const centerLL = metersToLatLng(r.x, r.y);
  if (centerLL && _robotPumpLeaf) {
    _robotPumpLeaf.setLatLng([centerLL.lat, centerLL.lng]);
    _robotPumpLeaf.setStyle({ fillColor: r.pumpState === 'pumping' ? '#10b981' : 'rgba(16,185,129,0.5)' });
  }
  const arrow = _robotArrowLatLngs(r.x, r.y, r.heading);
  if (arrow && _robotArrowLeaf) _robotArrowLeaf.setLatLngs(arrow);

  if (_hosePolylineLeaf && state.pond?.hoseAnchor) {
    const pts = _hoseLatLngs(state.pond.hoseAnchor, state.robot);
    _hosePolylineLeaf.setLatLngs(pts);
    if (_hoseOutlineLeaf) _hoseOutlineLeaf.setLatLngs(pts);
  }
}

// ── Shared overlay builder (évite duplication) ──────────────────────────────
function _buildLeafletOverlay(lmap, layersArr) {
  for (const l of layersArr) { try { lmap.removeLayer(l); } catch {} }
  layersArr.length = 0;

  if (!state.pond) return null;
  const origin = state.pond.origin;
  if (!isValidOrigin(origin)) return null;

  // Un throw ici (ex. coordonnées invalides) plantait tout l'overlay en silence — plus de
  // polygone, plus de cases, plus de robot, sans rien dans la console pour comprendre
  // pourquoi. On isole et on journalise pour un diagnostic rapide si ça se reproduit.
  try {
    _buildLeafletOverlayInner(lmap, layersArr, origin);
  } catch (err) {
    console.error('[leaflet-map] échec de la construction de l\'overlay:', err);
  }
  return null;
}

function _buildLeafletOverlayInner(lmap, layersArr, origin) {
  const renderer = L.canvas({ padding: 0.5 });

  const polyLL = state.pond.polygon.map(p => { const ll = metersToLatLng(p.x, p.y); return [ll.lat, ll.lng]; });
  const poly = L.polygon(polyLL, { color: '#0ea5e9', weight: 2, fillColor: '#0ea5e9', fillOpacity: 0.07 }).addTo(lmap);
  layersArr.push(poly);

  const cs = params.cellSize;
  for (const cell of state.cells) {
    const sw = metersToLatLng(cell.cx - cs/2, cell.cy - cs/2);
    const ne = metersToLatLng(cell.cx + cs/2, cell.cy + cs/2);
    if (!sw || !ne) continue;
    const color   = cell.completed ? '#10b981' : cell.selected ? '#0ea5e9' : '#ffffff';
    const opacity = cell.completed ? 0.55 : cell.selected ? 0.2 : 0.04;
    layersArr.push(L.rectangle([[sw.lat, sw.lng],[ne.lat, ne.lng]], {
      renderer, color, weight: 0.5, fillColor: color, fillOpacity: opacity, opacity: opacity * 0.5,
    }).addTo(lmap));
  }

  // Parcours planifié
  if (state.plannedPath.length > 1) {
    const pathLL = [];
    for (const idx of state.plannedPath) {
      const cell = state.cells[idx]; if (!cell) continue;
      const ll = metersToLatLng(cell.cx, cell.cy); if (!ll) continue;
      pathLL.push([ll.lat, ll.lng]);
    }
    if (pathLL.length > 1) {
      layersArr.push(L.polyline(pathLL, { color: 'rgba(251,191,36,0.6)', weight: 1.5, dashArray: '4,4' }).addTo(lmap));
    }
  }

  const robotLL = metersToLatLng(state.robot.x, state.robot.y);

  // Robot — carré/cercle/flèche en coordonnées géographiques (pas une icône en pixels) pour
  // qu'il reste correctement à l'échelle réelle pendant tout le geste de zoom, pas seulement
  // une fois relâché.
  _robotSquareLeaf = null; _robotPumpLeaf = null; _robotArrowLeaf = null;
  if (robotLL) {
    const sq = _robotSquareLatLngs(state.robot.x, state.robot.y);
    if (sq.length > 2) {
      _robotSquareLeaf = L.polygon(sq, { color: '#fff', weight: 3, fillColor: '#f59e0b', fillOpacity: 0.55 }).addTo(lmap);
      layersArr.push(_robotSquareLeaf);
    }
    _robotPumpLeaf = L.circle([robotLL.lat, robotLL.lng], {
      radius: ROBOT_SIZE * 0.18, color: '#fff', weight: 1.5,
      fillColor: state.robot.pumpState === 'pumping' ? '#10b981' : 'rgba(16,185,129,0.5)', fillOpacity: 0.9,
    }).addTo(lmap);
    layersArr.push(_robotPumpLeaf);
    const arrow = _robotArrowLatLngs(state.robot.x, state.robot.y, state.robot.heading);
    if (arrow) {
      _robotArrowLeaf = L.polyline(arrow, { color: '#fff', weight: 3 }).addTo(lmap);
      layersArr.push(_robotArrowLeaf);
    }
    _robotSquareLeaf?.bringToFront(); _robotPumpLeaf?.bringToFront(); _robotArrowLeaf?.bringToFront();
    // GPS position
    const gpsIcon = L.divIcon({
      html: `<div class="gps-pos-leaf">${robotLL.lat.toFixed(6)}, ${robotLL.lng.toFixed(6)}</div>`,
      className: '', iconSize: [160,18], iconAnchor: [80,-18],
    });
    layersArr.push(L.marker([robotLL.lat, robotLL.lng], { icon: gpsIcon, zIndexOffset: 900 }).addTo(lmap));
  }

  // Tuyau d'évacuation flottant — courbe de l'ancre (berge, déplaçable) au robot.
  // Orange vif (comme les vrais tuyaux flottants) + liseré sombre pour rester visible
  // quel que soit le fond (satellite clair, eau, terrain sombre...).
  _hosePolylineLeaf = null; _hoseOutlineLeaf = null; _hoseAnchorMarkerLeaf = null;
  if (state.pond.hoseAnchor) {
    const hosePts = _hoseLatLngs(state.pond.hoseAnchor, state.robot);
    if (hosePts.length > 1) {
      _hoseOutlineLeaf = L.polyline(hosePts, { color: '#000', weight: 7, opacity: 0.4, lineCap: 'round' }).addTo(lmap);
      layersArr.push(_hoseOutlineLeaf);
      _hosePolylineLeaf = L.polyline(hosePts, { color: '#f97316', weight: 4, opacity: 0.95, lineCap: 'round' }).addTo(lmap);
      layersArr.push(_hosePolylineLeaf);
    }
    const aLL = metersToLatLng(state.pond.hoseAnchor.x, state.pond.hoseAnchor.y);
    if (aLL) {
      const anchorIcon = L.divIcon({ html: '<div class="hose-anchor-leaf"></div>', className: '', iconSize: [18,18], iconAnchor: [9,9] });
      _hoseAnchorMarkerLeaf = L.marker([aLL.lat, aLL.lng], { icon: anchorIcon, draggable: true, zIndexOffset: 950 }).addTo(lmap);
      _hoseAnchorMarkerLeaf.on('drag', e => {
        const local = latLngToMeters(e.target.getLatLng().lat, e.target.getLatLng().lng, origin.lat, origin.lng);
        const snapped = nearestPointOnPolygon(state.pond.polygon, local.x, local.y);
        state.pond.hoseAnchor = snapped;
        const sLL = metersToLatLng(snapped.x, snapped.y);
        if (sLL) e.target.setLatLng([sLL.lat, sLL.lng]);
        const newPts = _hoseLatLngs(snapped, state.robot);
        if (_hosePolylineLeaf) _hosePolylineLeaf.setLatLngs(newPts);
        if (_hoseOutlineLeaf)  _hoseOutlineLeaf.setLatLngs(newPts);
        if (_depositSegmentLeaf) _depositSegmentLeaf.setLatLngs([[sLL.lat, sLL.lng], _depositSegmentLeaf.getLatLngs()[1]]);
      });
      _hoseAnchorMarkerLeaf.on('dragend', () => { saveWork(); updateHoseLengthDisplay(); });
      layersArr.push(_hoseAnchorMarkerLeaf);
    }
  }

  // Zone de dépôt des sédiments + segment de tuyau posé au sol (droit, pas ondulé) qui
  // relie l'ancre à son centroïde.
  _depositZoneLeaf = null; _depositSegmentLeaf = null;
  if (state.pond.depositZone) {
    const { polyLL, centroidLL } = _depositZoneLatLngs(state.pond.depositZone);
    if (polyLL.length > 2) {
      _depositZoneLeaf = L.polygon(polyLL, { color: '#92400e', weight: 2, fillColor: '#92400e', fillOpacity: 0.3 }).addTo(lmap);
      layersArr.push(_depositZoneLeaf);
    }
    const anchorLL = metersToLatLng(state.pond.hoseAnchor.x, state.pond.hoseAnchor.y);
    if (anchorLL && centroidLL) {
      _depositSegmentLeaf = L.polyline([[anchorLL.lat, anchorLL.lng], [centroidLL.lat, centroidLL.lng]], {
        color: '#f97316', weight: 4, opacity: 0.9,
      }).addTo(lmap);
      layersArr.push(_depositSegmentLeaf);
    }
  }

  lmap.fitBounds(poly.getBounds(), { padding: [40,40] });
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
  // Voir le commentaire équivalent dans initLeafletMap() : sans vue initiale, le premier
  // calque vectoriel (polygone de l'étang) ajouté à la carte fait planter Leaflet en
  // interne, silencieusement — c'était la vraie cause de "la carte n'affiche rien".
  _leafletMapDash.setView([0, 0], 2);

  const styleDash = MAP_STYLES[_currentMapStyle];
  _baseTileLayerDash = L.tileLayer(styleDash.url, { attribution: styleDash.attribution, maxZoom: 23, maxNativeZoom: styleDash.maxNativeZoom }).addTo(_leafletMapDash);
  if (styleDash.labels) {
    _labelsLayerDash = L.tileLayer(styleDash.labels, { attribution: '', maxZoom: 23, maxNativeZoom: styleDash.maxNativeZoom, opacity: 0.65 }).addTo(_leafletMapDash);
  }
  L.control.zoom({ position: 'bottomright' }).addTo(_leafletMapDash);
  _leafletMapDash.on('zoomend', () => {
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
  if (!_satModeDash || !_leafletMapDash) return;
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

function toggleSatelliteView(on) {
  _satMode = on;
  document.getElementById('btnSatView')?.classList.toggle('active', on);
  document.getElementById('btnSchemaView')?.classList.toggle('active', !on);
  document.getElementById('btnFitMap').style.display = on ? 'none' : '';

  const canvasWrap    = document.getElementById('canvasWrap');
  const leafletDiv    = document.getElementById('leaflet-container');
  const zoomControls  = document.querySelector('#panel-map .zoom-controls');
  const modeToggleMap = document.getElementById('modeToggle');
  const scaleInfo     = document.getElementById('scaleInfoMap');
  const styleGroup    = document.getElementById('mapMapStyleGroup');

  if (on) {
    if (canvasWrap)    canvasWrap.style.display = 'none';
    if (zoomControls)  zoomControls.style.display = 'none';
    if (modeToggleMap) modeToggleMap.style.display = 'none';
    if (scaleInfo)     scaleInfo.style.display = 'none';
    if (leafletDiv)    leafletDiv.style.display = 'block';
    if (styleGroup)    styleGroup.style.display = '';
    if (!_leafletMap) {
      // Un conteneur masqué (display:none, onglet Carte pas encore visité) a une taille
      // nulle : Leaflet construit dessus reste cassé même après un invalidateSize() bien
      // plus tard. On diffère la construction — setActiveTab('map') la fera au moment où
      // l'onglet devient réellement visible pour la première fois.
      if (document.getElementById('panel-map')?.classList.contains('active')) initLeafletMap();
    }
    else { updateLeafletOverlay(); setTimeout(() => _leafletMap.invalidateSize(), 100); }
  } else {
    if (leafletDiv)    leafletDiv.style.display = 'none';
    if (canvasWrap)    canvasWrap.style.display = '';
    if (zoomControls)  zoomControls.style.display = '';
    if (modeToggleMap && state.pond) modeToggleMap.style.display = 'flex';
    if (scaleInfo)     scaleInfo.style.display = '';
    if (styleGroup)    styleGroup.style.display = 'none';
    if (typeof cancelDraw === 'function') cancelDraw();
    requestAnimationFrame(() => {
      const c = document.getElementById('pondCanvas'), w = document.getElementById('canvasWrap');
      if (c && w) { c.width = w.clientWidth; c.height = w.clientHeight; }
      renderPondCanvas(document.getElementById('pondCanvas'));
    });
  }
}

// ============================================================
// TRACÉ D'ÉTANG RÉEL — recherche d'adresse + dessin du contour / zone de dépôt
// Onglet Carte, Satellite uniquement (besoin de voir le terrain pour tracer).
// ============================================================

// ── Recherche d'adresse (API Adresse — data.gouv.fr, gratuite, sans clé) ──
// Port du bloc équivalent de site-vandaele/js/estimation.js (même API, même UX).
let _addrDebounce = null, _addrFocusIndex = -1, _addrResults = [];

function centerCarteMapOn(lat, lng, zoom = 18) {
  if (!_leafletMap) return;
  _leafletMap.setView([lat, lng], zoom);
  _leafletMap.invalidateSize();
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
  if (!_leafletMap || typeof L === 'undefined' || !L.Draw) return null;
  if (_drawTool) return _drawTool;

  _drawTool = new L.Draw.Polygon(_leafletMap, {
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
    _leafletMap.fire(L.Draw.Event.CREATED, { layer, layerType: 'polygon' });
  };

  _leafletMap.on('draw:drawvertex', () => {
    if (!_drawTool._enabled || !_drawTool._markers || _drawTool._markers.length < 3) return;
    const firstMarker = _drawTool._markers[0];
    firstMarker.off('click').on('click', ev => { L.DomEvent.stop(ev); finishCurrentDrawing(); });
  });

  _leafletMap.on(L.Draw.Event.CREATED, _handleDrawCreated);
  return _drawTool;
}

function toggleDrawPondPanel(force) {
  const panel = document.getElementById('drawPondPanel');
  if (!panel) return;
  const open = force !== undefined ? force : panel.style.display === 'none';
  if (!open) { cancelDraw(); return; }

  if (!_satMode) toggleSatelliteView(true);
  initAddressSearch();
  _drawMode = null;
  document.getElementById('drawAddressRow').style.display = '';
  document.getElementById('drawNameRow').style.display = 'none';
  document.getElementById('btnStartContour').style.display = '';
  document.getElementById('btnFinishDraw').style.display = 'none';
  setDrawStatus('Cliquez sur « Tracer le contour », puis délimitez l\'étang sur la carte.');
  panel.style.display = 'flex';
}

function openDrawPondFromEmptyState() {
  toggleSatelliteView(true);
  toggleDrawPondPanel(true);
}

// Point d'entrée depuis l'onglet Étangs — le tracé lui-même a besoin d'une vraie carte
// Leaflet, qui n'existe que sur l'onglet Carte ; on y bascule d'abord. Enveloppé dans un
// try/catch : mieux vaut un message d'erreur visible qu'un clic silencieusement sans effet.
function goToDrawPond() {
  try {
    setActiveTab('map');
    openDrawPondFromEmptyState();
  } catch (err) {
    console.error('[goToDrawPond]', err);
    showToast('Erreur lors de l\'ouverture du tracé — voir la console', 'error');
  }
}

// Point d'entrée depuis une fiche de l'onglet Étangs — charge l'étang si besoin, bascule
// sur la carte satellite et lance directement le tracé de sa zone de dépôt.
function startDepositZoneForPond(id) {
  try {
    const pond = state.ponds.find(p => p.id === id);
    if (!pond) { showToast('Étang introuvable', 'error'); return; }
    if (state.pond?.id !== id) loadPond(pond);
    setActiveTab('map');
    toggleSatelliteView(true);
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
  if (_draftLayer) { _leafletMap.removeLayer(_draftLayer); _draftLayer = null; }
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
  if (!_satMode) toggleSatelliteView(true);
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
  if (_draftLayer && _leafletMap) { _leafletMap.removeLayer(_draftLayer); _draftLayer = null; }
  _drawMode = null;
  _draftContourLatLngs = null;
  const panel = document.getElementById('drawPondPanel');
  if (panel) panel.style.display = 'none';
}

function _handleDrawCreated(e) {
  if (_draftLayer && _leafletMap) _leafletMap.removeLayer(_draftLayer);
  _draftLayer = e.layer.addTo(_leafletMap);

  const raw = e.layer.getLatLngs();
  const lls = Array.isArray(raw[0]) ? raw[0] : raw;

  if (_drawMode === 'contour') {
    const areaM2 = Math.round(L.GeometryUtil.geodesicArea(lls));
    // Garde-fou : generateGrid() construit une grille cols×rows à partir de la surface —
    // un tracé démesuré (carte pas recentrée, clic malheureux) produirait une grille de
    // plusieurs milliards de cases et fait planter l'onglet. 20 ha est déjà très généreux
    // pour un étang réel.
    if (areaM2 > 200000) {
      _leafletMap.removeLayer(_draftLayer);
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
    if (_satMode)     updateLeafletOverlay();
    if (_satModeDash) updateLeafletOverlayDash();
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

  if (_draftLayer && _leafletMap) { _leafletMap.removeLayer(_draftLayer); _draftLayer = null; }
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
  toggleSatelliteView(true);
  loadPonds();
  try { const sp = localStorage.getItem('aquabot_params'); if (sp) Object.assign(params, JSON.parse(sp)); } catch {}

  syncParamsToDOM();

  document.querySelectorAll('.nav-tab').forEach(btn => btn.addEventListener('click', () => setActiveTab(btn.dataset.tab)));

  initCanvasEvents();

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
  window.addEventListener('resize', () => { resizeSectionCanvas(); renderSectionCanvas(); });
}

window.addEventListener('DOMContentLoaded', init);
