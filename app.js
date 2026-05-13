// ── Route cache ──────────────────────────────────────────────────
const ROUTE_DATA = {};

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
  if (grade > 2)    return { icon: '↑', label: 'Subida',   color: '#F97316' };
  if (grade > 0.5)  return { icon: '↗', label: 'Leve ↗',  color: '#FCA853' };
  if (grade < -2)   return { icon: '↓', label: 'Bajada',   color: '#9AFF5F' };
  if (grade < -0.5) return { icon: '↘', label: 'Leve ↘',  color: '#7DEBA3' };
  return              { icon: '→', label: 'Plano',          color: '#A1A1AA' };
}

// ── Screen navigation ────────────────────────────────────────────
const SCREENS = ['landing', 'guiarme', 'form', 'results'];

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
  ['5k', '10k'].forEach(id => {
    const el = document.getElementById('btn-' + id);
    el.classList.toggle('selected', id === d);
  });
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
  if (guiarmeStep > 1) {
    showGuiarmeStep(guiarmeStep - 1);
  } else {
    showScreen('landing');
  }
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
  const distLabel = distance === '5k' ? '5K' : '10K';
  const paceBase = targetSecs / parseInt(distance);

  document.getElementById('result-title').textContent = `${distLabel} · ${formatTime(targetSecs)}`;
  document.getElementById('pace-base').textContent = formatPace(paceBase);
  document.getElementById('time-total').textContent = formatTime(targetSecs);

  renderElevationProfile(route);

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

function renderElevationProfile(route) {
  const container = document.getElementById('elev-profile');
  if (!container) return;

  const elevs = route.segments.map(s => s.ele_start);
  elevs.push(route.segments[route.segments.length - 1].ele_end);

  const minE = Math.min(...elevs);
  const maxE = Math.max(...elevs);
  const range = maxE - minE || 1;

  container.innerHTML = '';
  route.segments.forEach(seg => {
    const h1 = ((seg.ele_start - minE) / range) * 32 + 4;
    const h2 = ((seg.ele_end - minE) / range) * 32 + 4;
    const avgH = (h1 + h2) / 2;
    const terrain = getTerrainInfo(seg.grade_pct);

    const bar = document.createElement('div');
    bar.style.cssText = `flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px`;
    bar.innerHTML = `
      <div style="width:100%;border-radius:4px 4px 0 0;background:${terrain.color};opacity:0.7;height:${avgH}px;min-height:4px"></div>
      <div style="font-size:9px;color:#A1A1AA;font-family:'Orbitron',sans-serif">${seg.km}</div>
    `;
    container.appendChild(bar);
  });
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

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  selectDistance('5k');

  const timeInput = document.getElementById('time-input');

  timeInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') calculate();
  });

  timeInput.addEventListener('input', function () {
    let v = this.value.replace(/[^0-9]/g, '');
    if (v.length > 6) v = v.slice(0, 6);
    if (v.length >= 5) v = v.slice(0, 2) + ':' + v.slice(2, 4) + ':' + v.slice(4);
    else if (v.length >= 3) v = v.slice(0, v.length - 2) + ':' + v.slice(v.length - 2);
    this.value = v;
  });
});
