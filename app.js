// ── Route cache ─────────────────────────────────────────────────
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
// Continuous grade factor: each % of slope adds/removes time proportionally
function gradeAdjustment(grade) {
  if (grade > 0) return 1 + 0.03 * Math.min(grade, 15);   // +3% per 1% slope uphill
  return 1 - 0.015 * Math.min(Math.abs(grade), 8);         // -1.5% per 1% slope downhill
}

function calculateStrategy(route, targetSecs) {
  const paceBase = targetSecs / route.total_km;

  const raw = route.segments.map(seg => {
    let factor = gradeAdjustment(seg.grade_pct);
    if (seg.km === 1) factor = Math.max(factor, 1.03); // conservative start
    factor = Math.max(0.80, Math.min(1.50, factor));   // hard limits
    return { ...seg, factor, rawPace: paceBase * factor };
  });

  // Normalize: sum must equal targetSecs exactly
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
  if (grade > 2)    return { icon: '↑', label: 'Subida',    color: '#F97316', cls: 'border-l-orange-500' };
  if (grade > 0.5)  return { icon: '↗', label: 'Leve ↗',   color: '#FCA853', cls: 'border-l-orange-400' };
  if (grade < -2)   return { icon: '↓', label: 'Bajada',   color: '#9AFF5F', cls: 'border-l-neurogreen' };
  if (grade < -0.5) return { icon: '↘', label: 'Leve ↘',   color: '#7DEBA3', cls: 'border-l-green-400' };
  return              { icon: '→', label: 'Plano',           color: '#A1A1AA', cls: 'border-l-white10' };
}

// ── UI state ─────────────────────────────────────────────────────
let selectedDistance = '5k';

function selectDistance(d) {
  selectedDistance = d;
  ['5k', '10k'].forEach(id => {
    const el = document.getElementById('btn-' + id);
    if (id === d) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function loadRoute(distance) {
  if (ROUTE_DATA[distance]) return ROUTE_DATA[distance];
  const res = await fetch(`data/route-${distance}.json`);
  if (!res.ok) throw new Error('No se pudo cargar el recorrido.');
  ROUTE_DATA[distance] = await res.json();
  return ROUTE_DATA[distance];
}

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
    renderResults(segments, targetSecs, selectedDistance, route);
    document.getElementById('screen-form').classList.add('hidden');
    document.getElementById('screen-results').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (e) {
    showError(e.message);
  } finally {
    btn.textContent = 'CALCULAR ESTRATEGIA';
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

  // Mini elevation profile
  renderElevationProfile(route);

  const table = document.getElementById('results-table');
  table.innerHTML = '';

  segments.forEach(seg => {
    const terrain = getTerrainInfo(seg.grade_pct);
    const deviation = ((seg.pace - paceBase) / paceBase) * 100;
    const paceColor = Math.abs(deviation) < 2 ? '#FFFFFF'
                    : deviation > 0 ? '#FCA853' : '#9AFF5F';

    const gradeTxt = seg.grade_pct === 0 ? '0%'
                   : seg.grade_pct > 0 ? `+${seg.grade_pct}%` : `${seg.grade_pct}%`;

    const borderStyle = `border-left: 3px solid ${terrain.color};`;

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
      ${borderStyle}
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

  // Tip
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
  route.segments.forEach((seg, i) => {
    const h1 = ((seg.ele_start - minE) / range) * 32 + 4;
    const h2 = ((seg.ele_end - minE) / range) * 32 + 4;
    const avgH = (h1 + h2) / 2;
    const terrain = getTerrainInfo(seg.grade_pct);

    const bar = document.createElement('div');
    bar.style.cssText = `
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      gap: 2px;
    `;
    bar.innerHTML = `
      <div style="width:100%;border-radius:4px 4px 0 0;background:${terrain.color};opacity:0.7;height:${avgH}px;min-height:4px"></div>
      <div style="font-size:9px;color:#A1A1AA;font-family:'Orbitron',sans-serif">${seg.km}</div>
    `;
    container.appendChild(bar);
  });
}

function renderTip(segments, distance) {
  const uphills = segments.filter(s => s.grade_pct > 0.5).length;
  const downhills = segments.filter(s => s.grade_pct < -0.5).length;
  const numKm = parseInt(distance);

  let tip;
  if (uphills === 0 && downhills === 0) {
    tip = 'Recorrido muy parejo. Mantené el ritmo constante desde el km 2 y arrancá tranquilo. La ventaja la hacés en la segunda mitad.';
  } else if (downhills > uphills) {
    tip = `Los primeros kilómetros son favorables (bajada leve). No te dejes llevar por la velocidad: ahorrá energía para la segunda mitad.`;
  } else if (uphills > downhills) {
    tip = 'El tramo más exigente está en los kilómetros con subida. Controlá el ritmo allí y no te pases.';
  } else {
    tip = 'Recorrido mixto. Seguí los ritmos sugeridos y ajustá por sensación en los últimos kilómetros.';
  }

  document.getElementById('tip-text').textContent = `💡 ${tip}`;
}

function showForm() {
  document.getElementById('screen-results').classList.add('hidden');
  document.getElementById('screen-form').classList.remove('hidden');
  window.scrollTo(0, 0);
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  selectDistance('5k');

  document.getElementById('time-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') calculate();
  });

  // Auto-format time input: insert colons
  document.getElementById('time-input').addEventListener('input', function () {
    let v = this.value.replace(/[^0-9]/g, '');
    if (v.length > 6) v = v.slice(0, 6);
    if (v.length >= 5) v = v.slice(0, 2) + ':' + v.slice(2, 4) + ':' + v.slice(4);
    else if (v.length >= 3) v = v.slice(0, v.length - 2) + ':' + v.slice(v.length - 2);
    this.value = v;
  });
});
