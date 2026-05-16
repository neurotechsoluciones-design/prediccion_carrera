// ── Route cache ──────────────────────────────────────────────────
const ROUTE_DATA = {};
const REFS_CACHE = {};

// ── Last results (shared by PDF, Garmin, Map) ────────────────────
let lastSegments = null;
let lastDistance = null;
let lastTargetSecs = null;

// ── Map state ────────────────────────────────────────────────────
let leafletMap = null;
let mapRouteLayer = null;
let mapMarkerLayers = [];
let currentMapDistance = null;

// ── Time utilities ───────────────────────────────────────────────
function parseTime(str) {
  str = str.trim().replace(/[^0-9:]/g, '');
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN) || parts.some(p => p < 0)) return null;
  if (parts.length === 2) {
    const [m, s] = parts;
    if (s >= 60) return null;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

function formatPace(secs) {
  secs = Math.round(secs);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(secs) {
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Pace calculation ─────────────────────────────────────────────
// km1 always runs faster in races: adrenaline + positioning.
// Grade is ignored on km1. Normalization distributes compensation across remaining kms.
const KM1_RACE_FACTOR = 0.95; // ~5% faster than base pace

function gradeAdjustment(grade) {
  if (grade > 0) return 1 + 0.03 * Math.min(grade, 15);
  return 1 - 0.015 * Math.min(Math.abs(grade), 8);
}

function calculateStrategy(route, targetSecs) {
  const paceBase = targetSecs / route.total_km;

  const raw = route.segments.map(seg => {
    let factor;
    if (seg.km === 1) {
      factor = KM1_RACE_FACTOR;
    } else {
      factor = gradeAdjustment(seg.grade_pct);
      factor = Math.max(0.80, Math.min(1.50, factor));
    }
    return { ...seg, factor, rawPace: paceBase * factor };
  });

  const totalRaw = raw.reduce((acc, s) => acc + s.rawPace, 0);
  const ratio = targetSecs / totalRaw;

  let cumulative = 0;
  return raw.map(seg => {
    const pace = Math.round(seg.rawPace * ratio);
    cumulative += pace;
    return { ...seg, pace, cumulative };
  });
}

// ── Terrain classification ───────────────────────────────────────
function getTerrainInfo(grade) {
  if (grade > 2)    return { icon: '↑', label: 'Subida',        pdfLabel: 'Subida',        color: '#F97316' };
  if (grade > 0.5)  return { icon: '↗', label: 'Leve subida',   pdfLabel: 'Leve subida',   color: '#FCA853' };
  if (grade < -2)   return { icon: '↓', label: 'Bajada',        pdfLabel: 'Bajada',        color: '#9AFF5F' };
  if (grade < -0.5) return { icon: '↘', label: 'Leve bajada',   pdfLabel: 'Leve bajada',   color: '#7DEBA3' };
  return              { icon: '→', label: 'Plano',               pdfLabel: 'Plano',         color: '#A1A1AA' };
}

// ── Screen navigation ────────────────────────────────────────────
const SCREENS = ['landing', 'guiarme', 'form', 'results', 'map'];

function showScreen(name) {
  SCREENS.forEach(s => {
    document.getElementById('screen-' + s).classList.toggle('hidden', s !== name);
  });
  window.scrollTo(0, 0);
}

// ── UI state ─────────────────────────────────────────────────────
let selectedDistance = '5k';
let currentMode = 'ritmo'; // 'guiarme' | 'ritmo'
let guiarmeStep = 1;
let guiarmeAnswers = {};

function selectDistance(d) {
  selectedDistance = d;
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Route loading ─────────────────────────────────────────────────
async function loadRoute(distance) {
  if (ROUTE_DATA[distance]) return ROUTE_DATA[distance];
  const res = await fetch(`data/route-${distance}.json`);
  if (!res.ok) throw new Error('No se pudo cargar el recorrido.');
  ROUTE_DATA[distance] = await res.json();
  return ROUTE_DATA[distance];
}

// ── GUIARME mode ─────────────────────────────────────────────────
function startGuiarme() {
  currentMode = 'guiarme';
  guiarmeAnswers = {};
  showGuiarmeStep(1);
  showScreen('guiarme');
}

function startRitmo() {
  currentMode = 'ritmo';
  showScreen('form');
}

function showGuiarmeStep(step) {
  guiarmeStep = step;

  document.querySelectorAll('.g-step').forEach(el => {
    el.classList.toggle('hidden', parseInt(el.dataset.step) !== step);
  });

  const prog = step <= 4 ? (step / 4) * 100 : 100;
  document.getElementById('g-progress').style.width = prog + '%';
  document.getElementById('g-step-label').textContent = step <= 4 ? `${step} / 4` : 'Listo';

  if (step === 3) updateFamiliarityStep();
}

function updateFamiliarityStep() {
  const is10k = guiarmeAnswers.distance === '10k';
  const labels = is10k
    ? ['Más de 10K', 'Entre 5 y 10K', 'Menos de 5K']
    : ['Más de 5K', 'Entre 2 y 5K', 'Menos de 2K'];

  document.querySelectorAll('.g-fam-opt').forEach((btn, i) => {
    btn.querySelector('.g-opt-main').textContent = labels[i];
  });
}

function guiarmeAnswer(key, value, nextStep) {
  guiarmeAnswers[key] = value;
  if (nextStep === 0) {
    calculateGuiarme();
  } else {
    showGuiarmeStep(nextStep);
  }
}

function estimateGuidedPace(distance, frequency, familiarity, goal) {
  const base = distance === '5k' ? 390 : 420;
  const freqMap  = { high: -30, moderate: 0, low: 65 };
  const famMap   = { above: -15, same: 0, below: 35 };
  const goalMap  = { noWalk: 0, finish: 25, walk: 45 };

  const pace = base + (freqMap[frequency] || 0) + (famMap[familiarity] || 0) + (goalMap[goal] || 0);
  return Math.max(270, Math.min(600, pace));
}

function calculateGuiarme() {
  const { distance, frequency, familiarity, goal } = guiarmeAnswers;
  const pace = estimateGuidedPace(distance, frequency, familiarity, goal);
  const totalSecs = pace * parseInt(distance);
  renderGuiarmeResult(pace, totalSecs, distance, goal);
  showGuiarmeStep(5);
}

function renderGuiarmeResult(pace, totalSecs, distance, goal) {
  document.getElementById('g-pace-value').textContent = formatPace(pace);
  document.getElementById('g-dist-value').textContent = distance.toUpperCase();
  document.getElementById('g-total-value').textContent = formatTime(totalSecs);

  const { frequency } = guiarmeAnswers;
  let msg;
  if (goal === 'walk') {
    msg = 'Llegar al final es lo que importa. Caminá lo que necesites, sin culpa. Este ritmo te va a llevar hasta la meta.';
  } else if (goal === 'finish' && frequency === 'low') {
    msg = 'La clave es no salir demasiado rápido. Guardá energía en los primeros km y el final se va a dar solo.';
  } else if (goal === 'noWalk' && frequency === 'high') {
    msg = 'Tenés el entrenamiento. Arrancá firme, no te pases en el km 1, y vas a cruzar la meta en forma.';
  } else {
    msg = 'Seguí este ritmo de cerca los primeros kilómetros. El cuerpo se acomoda y el final se corre casi solo.';
  }

  document.getElementById('g-message').textContent = msg;
}

async function goToGuiarmeStrategy() {
  const { distance, frequency, familiarity, goal } = guiarmeAnswers;
  const pace = estimateGuidedPace(distance, frequency, familiarity, goal);
  const totalSecs = pace * parseInt(distance);

  try {
    const route = await loadRoute(distance);
    const segments = calculateStrategy(route, totalSecs);
    document.getElementById('results-mode').textContent = 'Guiarme';
    renderResults(segments, totalSecs, distance, route);
    showScreen('results');
  } catch (e) {
    showScreen('guiarme');
    showGuiarmeStep(5);
    alert(e.message);
  }
}

function guiarmeBack() {
  showScreen('landing');
}

function resultsBack() {
  if (currentMode === 'guiarme') {
    showScreen('guiarme');
    showGuiarmeStep(5);
  } else {
    showScreen('form');
  }
}

// ── Ritmo Objetivo: calculate ────────────────────────────────────
async function calculate() {
  const timeStr = document.getElementById('time-input').value;
  const targetSecs = parseTime(timeStr);

  if (!targetSecs || targetSecs < 60) {
    showError('Ingresá el tiempo en formato MM:SS o H:MM:SS');
    return;
  }

  const numKm = parseInt(selectedDistance);
  const pacePerKm = targetSecs / numKm;
  if (pacePerKm < 140 || pacePerKm > 1200) {
    showError('Tiempo fuera de rango realista (2:20–20:00 por km)');
    return;
  }

  const btn = document.getElementById('btn-calc');
  btn.textContent = 'Calculando…';
  btn.disabled = true;

  try {
    const route = await loadRoute(selectedDistance);
    const segments = calculateStrategy(route, targetSecs);
    document.getElementById('results-mode').textContent = 'Ritmo Objetivo';
    renderResults(segments, targetSecs, selectedDistance, route);
    showScreen('results');
  } catch (e) {
    showError(e.message);
  } finally {
    btn.textContent = 'Calcular estrategia';
    btn.disabled = false;
  }
}

// ── Render ───────────────────────────────────────────────────────
function renderResults(segments, targetSecs, distance, route) {
  lastSegments = segments;
  lastDistance = distance;
  lastTargetSecs = targetSecs;

  document.getElementById('garmin-accordion').classList.add('hidden');

  const distLabel = distance === '5k' ? '5K' : '10K';
  const paceBase = targetSecs / parseInt(distance);

  document.getElementById('result-title').textContent = `${distLabel} · ${formatTime(targetSecs)}`;
  document.getElementById('pace-base').textContent = formatPace(paceBase);
  document.getElementById('time-total').textContent = formatTime(targetSecs);

  renderElevationSVG(route, 'elev-profile');

  const table = document.getElementById('results-table');
  table.innerHTML = '';

  segments.forEach(seg => {
    const isRaceStart = seg.km === 1;
    const terrain = isRaceStart
      ? { icon: '⚡', label: 'Salida rápida', color: '#9AFF5F' }
      : getTerrainInfo(seg.grade_pct);

    const deviation = ((seg.pace - paceBase) / paceBase) * 100;
    const paceColor = isRaceStart ? '#9AFF5F'
                    : Math.abs(deviation) < 2 ? '#FFFFFF'
                    : deviation > 0 ? '#FCA853' : '#9AFF5F';

    const gradeTxt = isRaceStart ? 'emoción'
                   : seg.grade_pct === 0 ? '0%'
                   : seg.grade_pct > 0 ? `+${seg.grade_pct}%` : `${seg.grade_pct}%`;

    const row = document.createElement('div');
    row.className = 'result-row';
    row.style.cssText = `
      display: grid;
      grid-template-columns: 36px 1fr 90px 64px;
      gap: 4px;
      background: #0A1A2F;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 0 12px 12px 0;
      padding: 14px 12px;
      align-items: center;
      border-left: 3px solid ${terrain.color};
    `;
    row.innerHTML = `
      <div style="font-family:'Orbitron',sans-serif;font-weight:900;font-size:1.25rem;color:#fff">${seg.km}</div>
      <div>
        <div style="font-size:0.75rem;font-weight:600;color:${terrain.color};line-height:1.2">${terrain.icon} ${terrain.label}</div>
        <div style="font-size:0.65rem;color:#A1A1AA;margin-top:2px">${gradeTxt}</div>
      </div>
      <div>
        <span style="font-family:'Orbitron',sans-serif;font-weight:700;font-size:1rem;color:${paceColor}">${formatPace(seg.pace)}</span>
        <span style="font-size:0.6rem;color:#A1A1AA">/km</span>
      </div>
      <div style="text-align:right;font-size:0.8rem;color:#A1A1AA;font-family:'Inter',sans-serif">${formatTime(seg.cumulative)}</div>
    `;
    table.appendChild(row);
  });

  renderTip(segments, distance);
}

function renderElevationSVG(route, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const W = Math.max(container.clientWidth, 280);
  const H = 80;
  const pad = { left: 30, right: 8, top: 8, bottom: 20 };

  const elevs = route.segments.map(s => s.ele_start);
  elevs.push(route.segments[route.segments.length - 1].ele_end);
  const minE = Math.min(...elevs);
  const maxE = Math.max(...elevs);
  const range = maxE - minE || 1;

  const n = elevs.length;
  const xStep = (W - pad.left - pad.right) / (n - 1);
  const pts = elevs.map((e, i) => [
    pad.left + i * xStep,
    pad.top + (1 - (e - minE) / range) * (H - pad.top - pad.bottom)
  ]);

  const polyline = pts.map(p => p[0] + ',' + p[1]).join(' ');
  const area = 'M' + pts[0][0] + ',' + (H - pad.bottom) +
    ' L' + pts.map(p => p[0] + ',' + p[1]).join(' L') +
    ' L' + pts[pts.length - 1][0] + ',' + (H - pad.bottom) + ' Z';

  const kmLabels = route.segments.map((seg, i) =>
    `<text x="${pts[i][0]}" y="${H - 4}" fill="#6F7D94" font-size="8" font-family="Orbitron,sans-serif" text-anchor="middle">${seg.km}</text>`
  ).join('');

  const topLabel = `<text x="${pad.left - 4}" y="${pad.top + 6}" fill="#6F7D94" font-size="7" font-family="Inter,sans-serif" text-anchor="end">${Math.round(maxE)}m</text>`;
  const botLabel = `<text x="${pad.left - 4}" y="${H - pad.bottom}" fill="#6F7D94" font-size="7" font-family="Inter,sans-serif" text-anchor="end">${Math.round(minE)}m</text>`;

  const gridLines = [0.25, 0.5, 0.75].map(f => {
    const y = pad.top + f * (H - pad.top - pad.bottom);
    return `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`;
  }).join('');

  container.innerHTML = `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2100E5" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#2100E5" stop-opacity="0.02"/>
      </linearGradient>
      <filter id="glowLine">
        <feGaussianBlur stdDeviation="1.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${H - pad.bottom}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
    <line x1="${pad.left}" y1="${H - pad.bottom}" x2="${W - pad.right}" y2="${H - pad.bottom}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
    ${gridLines}
    <path d="${area}" fill="url(#elevGrad)"/>
    <polyline points="${polyline}" fill="none" stroke="#9AFF5F" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glowLine)"/>
    ${kmLabels}${topLabel}${botLabel}
  </svg>`;
}

function renderTip(segments, distance) {
  const uphills   = segments.slice(1).filter(s => s.grade_pct > 0.5).length;
  const downhills = segments.slice(1).filter(s => s.grade_pct < -0.5).length;

  let terrainTip;
  if (uphills === 0 && downhills === 0) {
    terrainTip = 'El recorrido es parejo: mantené el ritmo estable del km 2 en adelante.';
  } else if (downhills > uphills) {
    terrainTip = 'Hay bajadas leves: aprovechalas sin destruir las piernas, y guardá para el final.';
  } else if (uphills > downhills) {
    terrainTip = 'Hay subidas: no te pases en esos kilómetros, la tabla ya los tiene compensados.';
  } else {
    terrainTip = 'Recorrido mixto: seguí los ritmos sugeridos y ajustá por sensación.';
  }

  const tip = `El km 1 refleja la salida real de carrera: más rápido por posicionamiento y adrenalina. A partir del km 2, seguí el ritmo de la tabla. ${terrainTip}`;
  document.getElementById('tip-text').textContent = tip;
}

// ── PDF download ─────────────────────────────────────────────────
function downloadPDF() {
  if (!lastSegments) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const distLabel = lastDistance === '5k' ? '5K' : '10K';
  const paceBase = lastTargetSecs / parseInt(lastDistance);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(10, 26, 47);
  doc.text('Carrera Heroes de Malvinas', 105, 18, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  doc.text(
    distLabel + '  ·  Objetivo: ' + formatTime(lastTargetSecs) + '  ·  Ritmo base: ' + formatPace(paceBase) + ' /km',
    105, 26, { align: 'center' }
  );

  const rows = lastSegments.map(seg => {
    const tramo = seg.km === 1 ? 'Salida rapida' : getTerrainInfo(seg.grade_pct).pdfLabel;
    return [String(seg.km), tramo, formatPace(seg.pace) + ' /km', formatTime(seg.cumulative)];
  });

  doc.autoTable({
    startY: 34,
    head: [['KM', 'Tramo', 'Ritmo sugerido', 'Tiempo acum.']],
    body: rows,
    headStyles: { fillColor: [10, 26, 47], textColor: [154, 255, 95], fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 10 },
    alternateRowStyles: { fillColor: [245, 248, 252] },
    columnStyles: {
      0: { cellWidth: 14, halign: 'center' },
      1: { cellWidth: 68 },
      2: { cellWidth: 50, halign: 'center' },
      3: { cellWidth: 38, halign: 'center' }
    },
    margin: { left: 20, right: 20 }
  });

  const finalY = doc.lastAutoTable.finalY + 8;
  doc.setFontSize(7.5);
  doc.setTextColor(150);
  doc.text(
    'NeuroTech · Herramienta orientativa · No reemplaza evaluacion profesional',
    105, finalY, { align: 'center' }
  );

  const filename = 'plan-' + distLabel + '-' + formatTime(lastTargetSecs).replace(/:/g, '-') + '.pdf';
  doc.save(filename);
}

// ── Garmin accordion ─────────────────────────────────────────────
function toggleGarmin() {
  const el = document.getElementById('garmin-accordion');
  if (!el.classList.contains('hidden')) {
    el.classList.add('hidden');
    return;
  }
  document.getElementById('garmin-steps-count').textContent = lastDistance === '10k' ? '10' : '5';
  renderGarminPaces(lastSegments);
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderGarminPaces(segments) {
  const tbody = document.getElementById('garmin-pace-table');
  tbody.innerHTML = '';
  segments.forEach(seg => {
    const lo = formatPace(Math.max(60, seg.pace - 5));
    const hi = formatPace(seg.pace + 5);
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>Km ' + seg.km + '</td>' +
      '<td>' + formatPace(seg.pace) + ' /km</td>' +
      '<td>' + lo + ' → ' + hi + '</td>';
    tbody.appendChild(tr);
  });
}

// ── Map screen ───────────────────────────────────────────────────
function showMapScreen() {
  if (!lastSegments) return;
  document.getElementById('map-screen-title').textContent = 'Recorrido · ' + (lastDistance === '5k' ? '5K' : '10K');
  showScreen('map');

  if (!leafletMap) {
    setTimeout(initLeafletMap, 50);
  } else if (currentMapDistance !== lastDistance) {
    updateMapForDistance();
  } else {
    rebuildKmMarkers();
  }
  renderMapKmList();
}

async function initLeafletMap() {
  leafletMap = L.map('leaflet-map', {
    zoomControl: true,
    attributionControl: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(leafletMap);

  L.control.attribution({ prefix: '© OpenStreetMap · © CARTO' }).addTo(leafletMap);

  await updateMapForDistance();
}

async function updateMapForDistance() {
  currentMapDistance = lastDistance;

  mapMarkerLayers.forEach(m => leafletMap.removeLayer(m));
  mapMarkerLayers = [];
  if (mapRouteLayer) { leafletMap.removeLayer(mapRouteLayer); mapRouteLayer = null; }

  const cacheKey = 'geo_' + lastDistance;
  if (!REFS_CACHE[cacheKey]) {
    try {
      const res = await fetch('data/recorrido-' + lastDistance + '.geojson');
      if (!res.ok) throw new Error('No se pudo cargar el recorrido GeoJSON.');
      REFS_CACHE[cacheKey] = await res.json();
    } catch (e) {
      alert(e.message);
      return;
    }
  }

  const geojson = REFS_CACHE[cacheKey];
  const bounds = [];

  geojson.features.forEach(f => {
    const t = f.properties.type;
    const coords = f.geometry.coordinates;

    if (t === 'route') {
      const latLngs = coords.map(c => [c[1], c[0]]);
      mapRouteLayer = L.polyline(latLngs, {
        color: '#9AFF5F', weight: 4, opacity: 0.9
      }).addTo(leafletMap);
      bounds.push(...latLngs);

    } else if (t === 'start_finish') {
      const m = L.marker([coords[1], coords[0]], { icon: createStartFinishIcon() })
        .bindTooltip('Largada / Meta', { className: 'map-tooltip', direction: 'top' })
        .addTo(leafletMap);
      mapMarkerLayers.push(m);

    } else if (t === 'km') {
      const seg = lastSegments.find(s => s.km === f.properties.km);
      const m = L.marker([coords[1], coords[0]], { icon: createKmIcon(f.properties.km, seg) })
        .addTo(leafletMap);
      mapMarkerLayers.push(m);
    }
  });

  if (bounds.length) leafletMap.fitBounds(bounds, { padding: [24, 24] });

  const route = ROUTE_DATA[lastDistance];
  if (route) renderElevationSVG(route, 'map-elev-profile');
}

function rebuildKmMarkers() {
  updateMapForDistance();
}

function createStartFinishIcon() {
  return L.divIcon({
    html: '<div class="map-marker-start"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9AFF5F" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></div>',
    className: '',
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

function createKmIcon(km, seg) {
  const pace = seg ? formatPace(seg.pace) : '—';
  const cumul = seg ? formatTime(seg.cumulative) : '—';
  return L.divIcon({
    html: '<div class="map-marker-km">' +
      '<div class="map-km-bubble">' +
      '<span class="map-km-num">' + km + '</span>' +
      '<span class="map-km-pace-lbl">' + pace + '</span>' +
      '<span class="map-km-cumul-lbl">' + cumul + '</span>' +
      '</div>' +
      '<div class="map-km-dot"></div>' +
      '</div>',
    className: '',
    iconSize: [60, 52],
    iconAnchor: [30, 52]
  });
}

async function renderMapKmList() {
  const listEl = document.getElementById('map-km-list');

  if (!REFS_CACHE[lastDistance]) {
    listEl.innerHTML = '<div style="color:var(--muted);padding:16px;font-size:0.8rem">Cargando referencias...</div>';
    try {
      const res = await fetch('data/route-' + lastDistance + '-refs.json');
      if (!res.ok) throw new Error();
      REFS_CACHE[lastDistance] = await res.json();
    } catch {
      listEl.innerHTML = '<div style="color:var(--muted);padding:16px;font-size:0.8rem">No se pudieron cargar las referencias.</div>';
      return;
    }
  }

  const refs = REFS_CACHE[lastDistance];
  listEl.innerHTML = '';
  refs.forEach(ref => {
    const seg = lastSegments ? lastSegments.find(s => s.km === ref.km) : null;
    const terrain = seg
      ? (seg.km === 1 ? { color: '#9AFF5F' } : getTerrainInfo(seg.grade_pct))
      : { color: '#6F7D94' };
    const ritmo = seg ? formatPace(seg.pace) + ' /km' : '—';

    const row = document.createElement('div');
    row.className = 'map-km-row';
    row.style.borderLeftColor = terrain.color;
    row.innerHTML =
      '<div class="map-km-row-num">' + ref.km + '</div>' +
      '<div><div class="map-km-row-calles">' + ref.desde + ' → ' + ref.hasta + '</div>' +
      '<div class="map-km-row-consejo">' + ref.consejo + '</div></div>' +
      '<div class="map-km-row-pace">' + ritmo + '</div>';
    listEl.appendChild(row);
  });
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  selectDistance('5k');

  const timeInput = document.getElementById('time-input');

  timeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') calculate();
  });

  timeInput.addEventListener('input', function () {
    let v = this.value;
    if (v.includes(':')) {
      this.value = v.replace(/[^0-9:]/g, '');
      return;
    }
    v = v.replace(/[^0-9]/g, '');
    if (v.length > 6) v = v.slice(0, 6);
    if (v.length === 6)      v = v.slice(0, 2) + ':' + v.slice(2, 4) + ':' + v.slice(4);
    else if (v.length === 5) v = v.slice(0, 1) + ':' + v.slice(1, 3) + ':' + v.slice(3);
    else if (v.length >= 3)  v = v.slice(0, v.length - 2) + ':' + v.slice(v.length - 2);
    this.value = v;
  });
});
