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

// Convert a local pond object → Firestore document (no cells, compact selections)
function pondToFirestore(pond) {
  return {
    id:       pond.id,
    name:     pond.name,
    origin:   pond.origin   || null,
    polygon:  pond.polygon,
    anchors:  pond.anchors,
    area:     pond.area     || 0,
    bbox:     pond.bbox,
    lastUsed: pond.lastUsed || Date.now(),
    work: {
      completedCells: pond.work?.completedCells || [],
      volumePumped:   pond.work?.volumePumped   || 0,
      elapsedSec:     pond.work?.elapsedSec     || 0,
    },
    // Live selection state (so other devices see which cells are highlighted)
    currentSelectedIndices: (pond.cells || [])
      .map((c,i) => c.selected ? i : -1)
      .filter(i => i !== -1),
    // Store selections as sparse index arrays (far smaller than boolean arrays)
    selections: (pond.selections || []).map(s => ({
      id:        s.id,
      name:      s.name,
      timestamp: s.timestamp,
      count:     s.count,
      selectedIndices: s.cellStates
        ? s.cellStates.reduce((acc, v, i) => { if (v) acc.push(i); return acc; }, [])
        : (s.selectedIndices || []),
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
    const indices = state.cells.map((c,i) => c.selected ? i : -1).filter(i => i !== -1);
    window.db.collection('aquabot_ponds').doc(state.pond.id)
      .update({ currentSelectedIndices: indices, lastUsed: Date.now() })
      .catch(e => console.warn('selSync:', e.message));
    // Keep flag for 2s to absorb our own echo from onSnapshot
    setTimeout(() => { _localSelChanging = false; }, 2000);
  }, 500);
}

// Listen to real-time robot state for the active pond
function subscribeSimState(pondId) {
  if (_simUnsubscribe) { _simUnsubscribe(); _simUnsubscribe = null; }
  if (!USE_CLOUD) return;
  _simUnsubscribe = window.db.collection('aquabot_sim').doc(pondId)
    .onSnapshot(doc => {
      if (!doc.exists || state.sim.running) return;
      const sim = doc.data();
      if (!sim) return;

      const offlineMs  = Date.now() - (sim.lastUpdate || Date.now());
      const offlineSec = (offlineMs / 1000) * (sim.speed || 1);

      // Build completed set, extending with ghost cells if app was closed mid-sim
      const completedSet = new Set(sim.completedCells || []);
      if (sim.simRunning && offlineMs > 3000) {
        const doneBefore = sim.completedCells?.length || 0;
        if (doneBefore > 0 && sim.elapsedSec > 0) {
          const secPerCell = sim.elapsedSec / doneBefore;
          const ghostCells = Math.floor(offlineSec / secPerCell);
          const path = sim.plannedPath || [];
          for (let i = doneBefore; i < Math.min(doneBefore + ghostCells, path.length); i++) {
            if (path[i] !== undefined) completedSet.add(path[i]);
          }
        }
        const added = completedSet.size - (sim.completedCells?.length || 0);
        if (added > 0) showToast(`Reprise : ~${added} cases traitées hors ligne`, 'success');
      }

      // Apply full robot state to local
      state.cells.forEach((c, i) => { c.completed = completedSet.has(i); });
      state.robot.state          = sim.robotState  || 'stopped';
      state.robot.completedCells = completedSet.size;
      state.robot.elapsedSec     = sim.elapsedSec + (sim.simRunning ? offlineSec : 0);
      state.robot.volumePumped   = sim.volumePumped || 0;
      state.robot.x              = sim.x ?? state.robot.x;
      state.robot.y              = sim.y ?? state.robot.y;
      state.robot.pumpDepth      = sim.pumpDepth  ?? 0;
      state.robot.pumpState      = sim.simRunning ? (sim.pumpState || 'idle') : 'idle';
      state.robot.miniCyclesDone = sim.miniCyclesDone || 0;
      state.robot.currentCellIdx = sim.currentCellIdx  || 0;

      // Always sync planned path and speed
      if (sim.plannedPath?.length) state.plannedPath = sim.plannedPath;
      if (sim.speed && sim.speed !== state.sim.speed) {
        state.sim.speed = sim.speed;
        const speedEl = document.getElementById('speedSlider');
        if (speedEl) { speedEl.value = sim.speed; setText('speedValue', sim.speed + '×'); }
      }

      // Sync work mode params so effectiveMiniCycles() returns the right value
      if (sim.workMode) params.workMode  = sim.workMode;
      if (sim.miniCycles) params.miniCycles = sim.miniCycles;

      // LED + boutons + texte pause
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

      // Save ghost progress
      if (sim.simRunning && offlineMs > 3000) saveWork();

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
    doc.anchors = state.pond.anchors.map(a => ({ x: a.x, y: a.y }));
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

      // Longueurs câbles réelles
      for (let i = 0; i < 4; i++) {
        const v = t[`cable${i}`];
        if (v !== undefined) {
          const s = v.toFixed(1);
          setText(`rtCable${i}`,   s);
          setText(`cableLen${i}`,  s);
          setText(`cableLen${i}map`, s);
        }
      }

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
  const selectedSet = new Set(data.currentSelectedIndices || []);
  if (selectedSet.size > 0) cells.forEach((c, i) => { c.selected = selectedSet.has(i); });
  return {
    ...data,
    cells,
    work: data.work || { completedCells: [], volumePumped: 0, elapsedSec: 0 },
    selections: (data.selections || []).map(s => {
      const set = new Set(s.selectedIndices || []);
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
  },
  sim: { running: false, speed: 1, intervalId: null, lastTick: 0, sessionElapsedAtStart: 0, lastSimSave: 0 },
  view: { offsetX: 0, offsetY: 0, scale: 10, canvasH: 600 },
  drag: { active: false, mode: 'add' }, // for drag-select
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

function formatTime(sec) {
  const s = Math.floor(Math.abs(sec));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

function formatVolume(l) {
  return l >= 1000 ? `${(l/1000).toFixed(2)} m³` : `${Math.round(l)} L`;
}

function setText(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }

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
// PATH PLANNER — boustrophedon
// ============================================================
function planPath(cells) {
  const selected = cells.filter(c => c.selected && !c.completed);
  if (!selected.length) return [];
  const byRow = {};
  for (const c of selected) {
    if (!byRow[c.row]) byRow[c.row] = [];
    byRow[c.row].push(c);
  }
  const path = [];
  let ltr = true;
  for (const rowIdx of Object.keys(byRow).map(Number).sort((a,b) => a-b)) {
    const row = byRow[rowIdx].sort((a,b) => ltr ? a.col-b.col : b.col-a.col);
    path.push(...row.map(c => cells.indexOf(c)));
    ltr = !ltr;
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
  const anchors = [
    { x: minX, y: maxY, label: 'AV-G' },
    { x: maxX, y: maxY, label: 'AV-D' },
    { x: minX, y: minY, label: 'AR-G' },
    { x: maxX, y: minY, label: 'AR-D' },
  ];
  const cells = generateGrid(polygon);
  return {
    id: Date.now().toString(), name, origin, polygon, anchors, area, cells,
    work: { completedCells: [], volumePumped: 0, elapsedSec: 0 },
    selections: [],
    lastUsed: Date.now(),
    bbox: { minX, maxX, minY, maxY },
  };
}

function loadPond(pond) {
  state.pond = pond;
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
  document.getElementById('cablePanel').style.display     = 'block';
  document.getElementById('cablePanelMap').style.display  = 'block';
  document.getElementById('modeToggle').style.display     = 'flex';
  document.getElementById('dashCanvasEmptyState').style.display = 'none';
  document.getElementById('canvasEmptyState').style.display    = 'none';
  ['btnSelectAll','btnSelectRemaining','btnDeselectAll','btnPlanRoute'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = false;
  });

  setMode('select');
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
  pond.work = { completedCells: [], volumePumped: 0, elapsedSec: 0 };
  pond.cells?.forEach(c => { c.completed = false; });
  pond.lastUsed = Date.now();

  if (state.pond?.id === pondId) {
    state.cells.forEach(c => { c.completed = false; });
    state.robot.completedCells = 0;
    state.robot.volumePumped   = 0;
    state.robot.elapsedSec     = 0;
    state.plannedPath = [];
    renderAllPondCanvases();
    updateUI();
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

// ============================================================
// PERSISTENCE
// ============================================================
function savePonds() {
  if (USE_CLOUD) {
    for (const pond of state.ponds) {
      window.db.collection('aquabot_ponds').doc(pond.id)
        .set(pondToFirestore(pond))
        .catch(err => console.warn('Cloud save error:', err.message));
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
            state.pond.selections      = remote.selections;
            // Sync live selection from other device (skip if we have pending local changes)
            if (!_localSelChanging && remote.currentSelectedIndices !== undefined) {
              const selSet = new Set(remote.currentSelectedIndices);
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
  if (!canvas || !canvas.width) canvas = document.getElementById('pondCanvas');
  if (!canvas || !canvas.width) return;
  const W = canvas.width, H = canvas.height;
  const { minX, maxX, minY, maxY } = state.pond.bbox;
  const pad = 40;
  state.view.scale   = Math.min((W-pad*2)/(maxX-minX), (H-pad*2)/(maxY-minY));
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

  // Cables
  const cables = getCableLengths();
  for (let i = 0; i < 4; i++) {
    const a = state.pond.anchors[i]; if (!a) continue;
    const as = worldToScreen(a.x, a.y);
    const rs = worldToScreen(state.robot.x, state.robot.y);
    ctx.strokeStyle = 'rgba(251,191,36,0.65)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(rs.x,rs.y); ctx.lineTo(as.x,as.y); ctx.stroke();
    ctx.setLineDash([]);
    // Anchor
    ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.arc(as.x,as.y,6,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    // Length label
    if (state.view.scale > 3) {
      const mx = (rs.x+as.x)/2, my = (rs.y+as.y)/2;
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(mx-16,my-8,32,13);
      ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'center';
      ctx.fillText(cables[i].toFixed(1)+'m', mx, my+3);
    }
  }

  // Robot
  const rr = worldToScreen(state.robot.x, state.robot.y);
  const hr  = (ROBOT_SIZE/2) * state.view.scale;
  ctx.fillStyle   = 'rgba(14,165,233,0.18)';
  ctx.strokeStyle = '#0ea5e9'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.rect(rr.x-hr, rr.y-hr, hr*2, hr*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#0ea5e9'; ctx.beginPath(); ctx.arc(rr.x,rr.y,Math.max(3,hr*0.18),0,Math.PI*2); ctx.fill();
  // Pump indicator
  const pr = Math.max(3, (params.cellSize/2)*state.view.scale);
  const pumping = state.robot.pumpState === 'pumping';
  ctx.fillStyle   = pumping ? 'rgba(16,185,129,0.9)' : 'rgba(16,185,129,0.38)';
  ctx.strokeStyle = '#10b981'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(rr.x,rr.y,pr,0,Math.PI*2); ctx.fill(); ctx.stroke();
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
// CABLES
// ============================================================
function getCableLengths() {
  if (!state.pond) return [0,0,0,0];
  return state.pond.anchors.map(a => parseFloat(dist(state.robot.x, state.robot.y, a.x, a.y).toFixed(2)));
}

function updateCableDisplay() {
  const cables = getCableLengths();
  for (let i = 0; i < 4; i++) {
    const v = cables[i].toFixed(1);
    setText(`rtCable${i}`, v);
    setText(`cableLen${i}`, v);
    setText(`cableLen${i}map`, v);
  }
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

function simulationTick() {
  if (!state.sim.running) return;
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
      } else {
        const step = params.robotSpeed * dt;
        robot.x += (dx / d) * Math.min(step, d);
        robot.y += (dy / d) * Math.min(step, d);
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
  ['ledIndicator','dashLed'].forEach(id => {
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
  const robot = state.robot, path = state.plannedPath;
  const total = path.length;
  // Path-relative progress: count only cells in the current path that are completed
  const done  = path.filter(idx => state.cells[idx]?.completed).length;
  const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

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
  setText('dashProgressPct', pct + '%');
  setText('dashCellsDone',  done);
  setText('dashCellsTotal', total || '—');

  // Remaining time uses rate from current session only
  const sessionElapsed = robot.elapsedSec - (state.sim.sessionElapsedAtStart || 0);
  const remaining = (done > 0 && total > done)
    ? formatTime((sessionElapsed / done) * (total - done))
    : '—';
  setText('dashTimeElapsed',   formatTime(robot.elapsedSec));
  setText('dashTimeRemaining', remaining);

  // Selection/path volumes
  const selCount = total || state.cells.filter(c => c.selected).length;
  const totalVol = totalVolumeForCells(selCount);
  const mudVol   = mudVolumeForCells(selCount);
  setText('dashVolumePumped', formatVolume(robot.volumePumped));
  setText('dashVolumeTotal',  formatVolume(totalVol));
  setText('dashMudVolume',    mudVol >= 1 ? mudVol.toFixed(2)+' m³' : (mudVol*1000).toFixed(0)+' L');

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
  const pondPct   = pondTotal > 0 ? Math.round((pondDone / pondTotal) * 100) : 0;
  const allMudVol = mudVolumeForCells(pondTotal);
  setText('pondTotalDone',      pondDone);
  setText('pondTotalCells',     pondTotal || '—');
  setText('pondTotalPct',       pondPct + '%');
  setText('pondTotalVolume',    formatVolume(robot.volumePumped));
  setText('pondTotalMud',       allMudVol >= 1 ? allMudVol.toFixed(2)+' m³' : (allMudVol*1000).toFixed(0)+' L');
  setText('pondTotalTime',      formatTime(robot.elapsedSec));
  setText('dashPondBottomName', state.pond?.name || '—');
  const pondBarEl = document.getElementById('pondTotalBar');
  if (pondBarEl) pondBarEl.style.width = pondPct + '%';

  updateCableDisplay();

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
  setText('dashStatus', main);
  setText('dashSubStatus', sub);
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

    // Resize observer — refit on first valid size, re-render on subsequent resizes
    new ResizeObserver(() => {
      const prevW = canvas.width;
      canvas.width  = wrap.clientWidth;
      canvas.height = wrap.clientHeight;
      if (prevW === 0 && state.pond) fitPond();
      else renderPondCanvas(canvas);
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
    let isPanning = false, lastPanX = 0, lastPanY = 0, anchorDragging = -1;

    canvas.addEventListener('mousedown', e => {
      if (!state.pond) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const world = screenToWorld(mx, my);

      // Check anchor drag
      anchorDragging = -1;
      for (let i = 0; i < state.pond.anchors.length; i++) {
        const a  = state.pond.anchors[i];
        const as = worldToScreen(a.x, a.y);
        if (dist(mx, my, as.x, as.y) < 12) { anchorDragging = i; break; }
      }
      if (anchorDragging >= 0) return;

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

      if (anchorDragging >= 0) {
        const w = screenToWorld(mx, my);
        state.pond.anchors[anchorDragging].x = w.x;
        state.pond.anchors[anchorDragging].y = w.y;
        updateCableDisplay(); renderAllPondCanvases(); return;
      }
      if (isPanning) {
        state.view.offsetX -= (e.clientX - lastPanX) / state.view.scale;
        state.view.offsetY += (e.clientY - lastPanY) / state.view.scale;
        lastPanX = e.clientX; lastPanY = e.clientY;
        renderAllPondCanvases(); return;
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
      if (state.drag.active && state.view.mode === 'select') debouncedSaveSelection();
      isPanning = false; anchorDragging = -1; state.drag.active = false;
      canvas.style.cursor = state.view.mode === 'view' ? 'grab' : 'crosshair';
    });

    // Touch events
    let lastTouchDist = 0, touchDragActive = false;
    let lastTouchX = 0, lastTouchY = 0;

    canvas.addEventListener('touchstart', e => {
      if (!state.pond) return;
      if (e.touches.length === 2) {
        lastTouchDist = getTouchDist(e.touches);
        touchDragActive = false;
      } else if (e.touches.length === 1) {
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
        if (state.view.mode === 'select') {
          const rect = canvas.getBoundingClientRect();
          const world = screenToWorld(e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top);
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
    const hasGPS   = !!(p.origin?.lat || p.origin?.lng);
    const statusClass = done === 0 ? 'pond-status-new' : done >= total ? 'pond-status-done' : 'pond-status-progress';
    const statusLabel = done === 0 ? 'Non commencé' : done >= total ? 'Terminé' : 'En cours';
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
          </div>
          <div class="pond-meta">
            <span class="pond-meta-item">Surface : <strong>${area}</strong></span>
            <span class="pond-meta-item"><strong>${total}</strong> cases</span>
            <span class="pond-meta-item">Modifié : <strong>${lastUsed}</strong></span>
          </div>
          <div class="pond-progress">
            <div class="progress-bar" style="flex:1"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="pond-progress-pct">${pct}% — ${done}/${total}</span>
          </div>
        </div>
        <div class="pond-actions">
          <button class="btn btn-primary btn-sm"    onclick="event.stopPropagation();loadPondById('${p.id}')">Charger</button>
          ${hasGPS ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();loadPondById('${p.id}');setActiveTab('map');toggleSatelliteView(true);startCalibration()">⚓ Calibrer</button>` : ''}
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
  const { minX, maxX, minY, maxY } = pond.bbox;
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
    document.getElementById('cablePanel').style.display    = 'none';
    document.getElementById('cablePanelMap').style.display = 'none';
    document.getElementById('modeToggle').style.display    = 'none';
    setText('currentPondName', 'Aucun étang sélectionné');
    setText('dashPondBadge', 'Aucun étang');
    renderAllPondCanvases();
    renderSelectionHistory();
  }
  if (!USE_CLOUD) savePonds();
  updatePondsList();
  showToast('Étang supprimé');
}

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
        else { updateLeafletOverlay(); setTimeout(() => _leafletMap.invalidateSize(), 100); }
      } else {
        const c = document.getElementById('pondCanvas'), w = document.getElementById('canvasWrap');
        if (c && w) { c.width = w.clientWidth; c.height = w.clientHeight; }
        renderPondCanvas(document.getElementById('pondCanvas'));
        if (state.pond) { document.getElementById('modeToggle').style.display = 'flex'; }
      }
    });
  }
}

function resizeSectionCanvas() {
  const wrap = document.querySelector('.dash-section-wrap');
  const canvas = document.getElementById('sectionCanvas');
  if (!wrap || !canvas) return;
  canvas.width  = Math.min(wrap.clientWidth - 20, 500);
  canvas.height = 200;
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
    origin:{lat:0,lng:0}, polygon,
    anchors:[{x:minX,y:maxY,label:'AV-G'},{x:maxX,y:maxY,label:'AV-D'},{x:minX,y:minY,label:'AR-G'},{x:maxX,y:minY,label:'AR-D'}],
    area: polygonArea(polygon),
    cells: generateGrid(polygon),
    work:{completedCells:[],volumePumped:0,elapsedSec:0},
    selections:[],
    lastUsed:Date.now(),
    bbox:{minX,maxX,minY,maxY},
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
function metersToLatLng(x, y) {
  if (!state.pond?.origin) return null;
  const { lat: lat0, lng: lng0 } = state.pond.origin;
  if (!lat0 && !lng0) return null;
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
    maxNativeZoom: 21,
  },
  ign_plan: {
    label: 'IGN Plan',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image%2Fpng',
    labels: null,
    attribution: '© IGN Géoportail',
    maxNativeZoom: 19,
  },
};

let _currentMapStyle   = 'esri';
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
      attribution: style.attribution, maxZoom: 21, maxNativeZoom: style.maxNativeZoom,
    }).addTo(lmap);
    tileRef.bringToBack();
    if (style.labels) {
      labelsRef = L.tileLayer(style.labels, {
        attribution: '', maxZoom: 21, maxNativeZoom: style.maxNativeZoom, opacity: 0.65,
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

let _leafletMap      = null;
let _leafletLayers   = [];
let _robotMarkerLeaf = null;
let _satMode         = false;

let _leafletMapDash      = null;
let _baseLayersDash      = [];   // polygone, ancres
let _dynamicLayersDash   = [];   // robot + câbles (mis à jour à chaque tick)
let _pathLayerDash       = [];   // parcours planifié
let _cellLayersDash      = [];   // cases (mise à jour rapide)
let _robotMarkerDash     = null;
let _satModeDash         = false;

function initLeafletMap() {
  if (_leafletMap) { setTimeout(() => _leafletMap.invalidateSize(), 50); return; }
  const container = document.getElementById('leaflet-container');
  if (!container || typeof L === 'undefined') return;

  _leafletMap = L.map('leaflet-container', { zoomControl: false });

  const style = MAP_STYLES[_currentMapStyle];
  _baseTileLayer = L.tileLayer(style.url, { attribution: style.attribution, maxZoom: 21, maxNativeZoom: style.maxNativeZoom }).addTo(_leafletMap);
  if (style.labels) {
    _labelsLayer = L.tileLayer(style.labels, { attribution: '', maxZoom: 21, maxNativeZoom: style.maxNativeZoom, opacity: 0.65 }).addTo(_leafletMap);
  }

  L.control.zoom({ position: 'bottomright' }).addTo(_leafletMap);
  updateLeafletOverlay();
}

function updateLeafletOverlay() {
  if (!_leafletMap) return;
  _robotMarkerLeaf = _buildLeafletOverlay(_leafletMap, _leafletLayers);
}

function updateRobotMarker() {
  if (!_robotMarkerLeaf || !_satMode) return;
  const ll = metersToLatLng(state.robot.x, state.robot.y);
  if (ll) _robotMarkerLeaf.setLatLng([ll.lat, ll.lng]);
}

// ── Shared overlay builder (évite duplication) ──────────────────────────────
function _buildLeafletOverlay(lmap, layersArr) {
  for (const l of layersArr) { try { lmap.removeLayer(l); } catch {} }
  layersArr.length = 0;

  if (!state.pond) return null;
  const origin = state.pond.origin;
  if (!origin || (!origin.lat && !origin.lng)) return null;

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

  const anchorLabels = ['AV-G','AV-D','AR-G','AR-D'];
  const robotLL = metersToLatLng(state.robot.x, state.robot.y);

  // Câbles ancre → robot
  if (robotLL) {
    state.pond.anchors.forEach((anchor) => {
      const ll = metersToLatLng(anchor.x, anchor.y); if (!ll) return;
      layersArr.push(L.polyline([[robotLL.lat, robotLL.lng],[ll.lat, ll.lng]], {
        color: 'rgba(251,191,36,0.65)', weight: 1.5, dashArray: '5,4'
      }).addTo(lmap));
    });
  }

  state.pond.anchors.forEach((anchor, i) => {
    const ll = metersToLatLng(anchor.x, anchor.y); if (!ll) return;
    const icon = L.divIcon({ html: `<div class="anchor-marker">${anchorLabels[i]}</div>`, className: '', iconSize: [48,24], iconAnchor: [24,12] });
    const marker = L.marker([ll.lat, ll.lng], { icon, draggable: true }).addTo(lmap);
    marker.on('dragend', e => {
      const pos = e.target.getLatLng();
      const local = latLngToMeters(pos.lat, pos.lng, origin.lat, origin.lng);
      state.pond.anchors[i] = { ...state.pond.anchors[i], x: local.x, y: local.y };
      const idx = state.ponds.findIndex(p => p.id === state.pond.id);
      if (idx !== -1) state.ponds[idx] = state.pond;
      savePonds(); renderAllPondCanvases();
      showToast(`Ancre ${anchorLabels[i]} repositionnée`, 'success');
    });
    layersArr.push(marker);
  });

  let robotMarker = null;
  if (robotLL) {
    const icon = L.divIcon({ html: '<div class="robot-marker-leaf"></div>', className: '', iconSize: [16,16], iconAnchor: [8,8] });
    robotMarker = L.marker([robotLL.lat, robotLL.lng], { icon, zIndexOffset: 1000 }).addTo(lmap);
    layersArr.push(robotMarker);
  }

  lmap.fitBounds(poly.getBounds(), { padding: [40,40] });
  return robotMarker;
}

// ── Dashboard satellite view ─────────────────────────────────────────────────

// Redessine uniquement les cases (rapide après chaque clic de sélection)
function _rebuildCellLayersDash() {
  for (const l of _cellLayersDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _cellLayersDash.length = 0;
  if (!state.pond) return;
  const renderer = L.canvas({ padding: 0.5 });
  const cs = params.cellSize;
  for (const cell of state.cells) {
    const sw = metersToLatLng(cell.cx - cs/2, cell.cy - cs/2);
    const ne = metersToLatLng(cell.cx + cs/2, cell.cy + cs/2);
    if (!sw || !ne) continue;
    const color   = cell.completed ? '#10b981' : cell.selected ? '#0ea5e9' : '#ffffff';
    const opacity = cell.completed ? 0.55 : cell.selected ? 0.2 : 0.04;
    _cellLayersDash.push(L.rectangle([[sw.lat, sw.lng],[ne.lat, ne.lng]], {
      renderer, color, weight: 0.5, fillColor: color, fillOpacity: opacity, opacity: opacity * 0.5,
    }).addTo(_leafletMapDash));
  }
}

// Redessine la base (polygone, ancres) — appelé lors du chargement de l'étang
function _rebuildBaseLayersDash() {
  for (const l of _baseLayersDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _baseLayersDash.length = 0;
  if (!state.pond) return;
  const origin = state.pond.origin;
  if (!origin || (!origin.lat && !origin.lng)) return;

  const polyLL = state.pond.polygon.map(p => { const ll = metersToLatLng(p.x, p.y); return [ll.lat, ll.lng]; });
  const poly = L.polygon(polyLL, { color: '#0ea5e9', weight: 2, fillColor: '#0ea5e9', fillOpacity: 0.07 }).addTo(_leafletMapDash);
  _baseLayersDash.push(poly);

  const anchorLabels = ['AV-G','AV-D','AR-G','AR-D'];
  state.pond.anchors.forEach((anchor, i) => {
    const ll = metersToLatLng(anchor.x, anchor.y); if (!ll) return;
    const icon = L.divIcon({ html: `<div class="anchor-marker">${anchorLabels[i]}</div>`, className: '', iconSize: [48,24], iconAnchor: [24,12] });
    const marker = L.marker([ll.lat, ll.lng], { icon, draggable: true }).addTo(_leafletMapDash);
    marker.on('dragend', e => {
      const pos = e.target.getLatLng();
      const local = latLngToMeters(pos.lat, pos.lng, origin.lat, origin.lng);
      state.pond.anchors[i] = { ...state.pond.anchors[i], x: local.x, y: local.y };
      const idx = state.ponds.findIndex(p => p.id === state.pond.id);
      if (idx !== -1) state.ponds[idx] = state.pond;
      savePonds(); renderAllPondCanvases();
      if (_satModeDash) _rebuildDynamicLayersDash();
      showToast(`Ancre ${anchorLabels[i]} repositionnée`, 'success');
    });
    _baseLayersDash.push(marker);
  });

  _leafletMapDash.fitBounds(poly.getBounds(), { padding: [40,40] });
}

// Redessine robot + câbles (mis à jour à chaque tick de simulation)
function _rebuildDynamicLayersDash() {
  for (const l of _dynamicLayersDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _dynamicLayersDash.length = 0;
  _robotMarkerDash = null;
  if (!state.pond) return;
  const origin = state.pond.origin;
  if (!origin || (!origin.lat && !origin.lng)) return;

  const robotLL = metersToLatLng(state.robot.x, state.robot.y);
  if (!robotLL) return;

  // Câbles ancre → robot
  state.pond.anchors.forEach(anchor => {
    const ll = metersToLatLng(anchor.x, anchor.y); if (!ll) return;
    _dynamicLayersDash.push(L.polyline([[robotLL.lat, robotLL.lng],[ll.lat, ll.lng]], {
      color: 'rgba(251,191,36,0.65)', weight: 1.5, dashArray: '5,4'
    }).addTo(_leafletMapDash));
  });

  const icon = L.divIcon({ html: '<div class="robot-marker-leaf"></div>', className: '', iconSize: [16,16], iconAnchor: [8,8] });
  _robotMarkerDash = L.marker([robotLL.lat, robotLL.lng], { icon, zIndexOffset: 1000 }).addTo(_leafletMapDash);
  _dynamicLayersDash.push(_robotMarkerDash);
}

// Redessine le parcours planifié
function _rebuildPathLayerDash() {
  for (const l of _pathLayerDash) { try { _leafletMapDash.removeLayer(l); } catch {} }
  _pathLayerDash.length = 0;
  if (!state.pond || state.plannedPath.length < 2) return;
  const origin = state.pond.origin;
  if (!origin || (!origin.lat && !origin.lng)) return;

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

  const styleDash = MAP_STYLES[_currentMapStyle];
  _baseTileLayerDash = L.tileLayer(styleDash.url, { attribution: styleDash.attribution, maxZoom: 21, maxNativeZoom: styleDash.maxNativeZoom }).addTo(_leafletMapDash);
  if (styleDash.labels) {
    _labelsLayerDash = L.tileLayer(styleDash.labels, { attribution: '', maxZoom: 21, maxNativeZoom: styleDash.maxNativeZoom, opacity: 0.65 }).addTo(_leafletMapDash);
  }
  L.control.zoom({ position: 'bottomright' }).addTo(_leafletMapDash);

  _rebuildBaseLayersDash();
  _rebuildCellLayersDash();
  _rebuildPathLayerDash();
  _rebuildDynamicLayersDash();
  _addSelectionHandlersDash();
}

function updateLeafletOverlayDash() {
  if (!_leafletMapDash) return;
  _rebuildBaseLayersDash();
  _rebuildCellLayersDash();
  _rebuildPathLayerDash();
  _rebuildDynamicLayersDash();
}

function updateRobotMarkerDash() {
  if (!_satModeDash || !_leafletMapDash) return;
  _rebuildDynamicLayersDash();
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
  const calibBtn      = document.getElementById('btnCalibrate');
  const scaleInfo     = document.getElementById('scaleInfoMap');
  const styleGroup    = document.getElementById('mapMapStyleGroup');

  if (on) {
    if (canvasWrap)    canvasWrap.style.display = 'none';
    if (zoomControls)  zoomControls.style.display = 'none';
    if (modeToggleMap) modeToggleMap.style.display = 'none';
    if (scaleInfo)     scaleInfo.style.display = 'none';
    if (leafletDiv)    leafletDiv.style.display = 'block';
    if (styleGroup)    styleGroup.style.display = '';
    if (calibBtn)      calibBtn.style.display = (state.pond && state.pond.origin?.lat) ? 'inline-flex' : 'none';
    if (!_leafletMap) initLeafletMap();
    else { updateLeafletOverlay(); setTimeout(() => _leafletMap.invalidateSize(), 100); }
  } else {
    if (leafletDiv)    leafletDiv.style.display = 'none';
    if (canvasWrap)    canvasWrap.style.display = '';
    if (zoomControls)  zoomControls.style.display = '';
    if (modeToggleMap && state.pond) modeToggleMap.style.display = 'flex';
    if (scaleInfo)     scaleInfo.style.display = '';
    if (styleGroup)    styleGroup.style.display = 'none';
    if (calibBtn)      calibBtn.style.display = 'none';
    requestAnimationFrame(() => {
      const c = document.getElementById('pondCanvas'), w = document.getElementById('canvasWrap');
      if (c && w) { c.width = w.clientWidth; c.height = w.clientHeight; }
      renderPondCanvas(document.getElementById('pondCanvas'));
    });
  }
}

// ============================================================
// CALIBRATION WIZARD
// ============================================================
let _calibIdx = 0;
let _calibClickHandler = null;
const _calibLabels = ['AV-G (avant gauche)', 'AV-D (avant droite)', 'AR-G (arrière gauche)', 'AR-D (arrière droite)'];

function startCalibration() {
  if (!state.pond) { showToast('Chargez un étang d\'abord', 'error'); return; }
  if (!state.pond.origin?.lat && !state.pond.origin?.lng) {
    showToast('Cet étang n\'a pas de coordonnées GPS (étang démo)', 'error'); return;
  }
  _calibIdx = 0;
  updateCalibUI();
  document.getElementById('calibModal').style.display = 'flex';
  if (!_leafletMap) initLeafletMap();
  if (_calibClickHandler) _leafletMap.off('click', _calibClickHandler);
  _calibClickHandler = e => captureAnchorByClick(e.latlng);
  setTimeout(() => _leafletMap?.on('click', _calibClickHandler), 200);
}

function updateCalibUI() {
  setText('calibAnchorName', _calibLabels[_calibIdx] || '');
  setText('calibStep', `${_calibIdx + 1} / 4`);
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById(`calibDot${i}`);
    if (dot) dot.className = 'calib-dot' + (i < _calibIdx ? ' done' : i === _calibIdx ? ' active' : '');
  }
}

function captureAnchorByClick(latlng) {
  if (!state.pond) return;
  const { lat: lat0, lng: lng0 } = state.pond.origin;
  const local = latLngToMeters(latlng.lat, latlng.lng, lat0, lng0);
  state.pond.anchors[_calibIdx] = { ...state.pond.anchors[_calibIdx], x: local.x, y: local.y };
  showToast(`Ancre ${['AV-G','AV-D','AR-G','AR-D'][_calibIdx]} placée sur la carte`, 'success');
  advanceCalib();
}

function captureAnchorByGPS() {
  if (!navigator.geolocation) { showToast('GPS non disponible sur cet appareil', ''); return; }
  showToast('Lecture GPS en cours…', '');
  navigator.geolocation.getCurrentPosition(pos => {
    const { lat: lat0, lng: lng0 } = state.pond.origin;
    const local = latLngToMeters(pos.coords.latitude, pos.coords.longitude, lat0, lng0);
    state.pond.anchors[_calibIdx] = { ...state.pond.anchors[_calibIdx], x: local.x, y: local.y };
    showToast(`Ancre ${['AV-G','AV-D','AR-G','AR-D'][_calibIdx]} capturée (±${Math.round(pos.coords.accuracy)}m)`, 'success');
    advanceCalib();
  }, err => { showToast('Erreur GPS : ' + err.message, 'error'); },
  { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
}

function skipCalibAnchor() { advanceCalib(); }

function advanceCalib() {
  updateLeafletOverlay();
  renderAllPondCanvases();
  _calibIdx++;
  if (_calibIdx >= 4) finishCalibration();
  else updateCalibUI();
}

function finishCalibration() {
  if (_calibClickHandler) { _leafletMap?.off('click', _calibClickHandler); _calibClickHandler = null; }
  document.getElementById('calibModal').style.display = 'none';
  const idx = state.ponds.findIndex(p => p.id === state.pond.id);
  if (idx !== -1) state.ponds[idx] = state.pond;
  savePonds();
  renderAllPondCanvases();
  showToast('Calibration des ancres enregistrée !', 'success');
}

function closeCalibration() {
  if (_calibClickHandler) { _leafletMap?.off('click', _calibClickHandler); _calibClickHandler = null; }
  document.getElementById('calibModal').style.display = 'none';
}

// ============================================================
// INIT
// ============================================================
function init() {
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
