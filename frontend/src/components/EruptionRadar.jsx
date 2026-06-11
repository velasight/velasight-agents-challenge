import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';

// ---------- Themes ----------
const THEMES = {
  VOID: {
    name: 'VOID', bg: '#0A0A0F', bgLift: '#11111A', edge: '#1F1F2E',
    primary: '#00F0FF', risk: '#FF006E', healthy: '#06FFA5', watch: '#FFB800',
    text: 'rgba(255,255,255,0.92)', dim: 'rgba(255,255,255,0.45)', faint: 'rgba(255,255,255,0.18)',
    bgHex: 0x0A0A0F, primaryHex: 0x00F0FF, riskHex: 0xFF006E,
    healthyHex: 0x06FFA5, watchHex: 0xFFB800, gridA: 0x1F1F2E, gridB: 0x14141C,
    crossEdgeHex: 0x6B7BB8,
  },
  TERMINAL: {
    name: 'TERMINAL', bg: '#0F0E0B', bgLift: '#1A1612', edge: '#2D261E',
    primary: '#FFB627', risk: '#E63946', healthy: '#A7C957', watch: '#F4A261',
    text: 'rgba(255,243,222,0.94)', dim: 'rgba(255,243,222,0.5)', faint: 'rgba(255,243,222,0.18)',
    bgHex: 0x0F0E0B, primaryHex: 0xFFB627, riskHex: 0xE63946,
    healthyHex: 0xA7C957, watchHex: 0xF4A261, gridA: 0x2D261E, gridB: 0x1A1612,
    crossEdgeHex: 0x8B7355,
  },
};

// ---------- Mode definitions ----------
// Each mode is a STYLED PRESENTATION of the same underlying scene
const MODES = {
  RADAR: {
    name: 'RADAR',
    icon: '◉',
    description: 'Active sweep — find properties matching scenarios',
    showScan: true,
    showLocalEdges: true,
    showCrossEdges: true,
    crossEdgeOpacity: 0.35,
    localEdgeOpacity: 0.5,
    nodeOpacity: 0.95,
    haloOpacity: 0.18,
    palette: 'risk', // healthy/watch/risk
  },
  XRAY: {
    name: 'X-RAY',
    icon: '◇',
    description: 'Network structure — see the GNN relationships',
    showScan: false,
    showLocalEdges: true,
    showCrossEdges: true,
    crossEdgeOpacity: 0.85,    // foregrounded
    localEdgeOpacity: 0.35,    // softened
    nodeOpacity: 0.5,           // recede
    haloOpacity: 0.05,
    palette: 'risk',
  },
  THERMAL: {
    name: 'THERMAL',
    icon: '◈',
    description: 'Heat map  site readiness gradient and infrastructure stress',
    showScan: false,
    showLocalEdges: false,      // hidden — heat is the focus
    showCrossEdges: false,
    crossEdgeOpacity: 0,
    localEdgeOpacity: 0,
    nodeOpacity: 0.95,
    haloOpacity: 0.55,         // big aura is the heat signature
    palette: 'thermal',         // dedicated heat palette
  },
};

// Thermal palette — continuous heat gradient based on displacement risk
function thermalColor(risk) {
  // 0 = deep blue (cold), 0.5 = green/amber (warming), 1 = magenta (hot)
  if (risk < 0.25) {
    // Deep blue → cyan
    const t = risk / 0.25;
    return new THREE.Color().lerpColors(
      new THREE.Color(0x0A2540), new THREE.Color(0x00B8FF), t
    );
  } else if (risk < 0.5) {
    const t = (risk - 0.25) / 0.25;
    return new THREE.Color().lerpColors(
      new THREE.Color(0x00B8FF), new THREE.Color(0x06FFA5), t
    );
  } else if (risk < 0.75) {
    const t = (risk - 0.5) / 0.25;
    return new THREE.Color().lerpColors(
      new THREE.Color(0x06FFA5), new THREE.Color(0xFFB800), t
    );
  } else {
    const t = (risk - 0.75) / 0.25;
    return new THREE.Color().lerpColors(
      new THREE.Color(0xFFB800), new THREE.Color(0xFF006E), t
    );
  }
}

// ---------- Mock data ----------
function mulberry32(seed) {
  let t = seed;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function streetName(rng) {
  const names = ['CASCADE RD', 'RALPH MCGILL', 'PEACHTREE ST', 'EDGEWOOD AVE', 'PIEDMONT AVE',
    'METROPOLITAN PKY', 'MEMORIAL DR', 'DEKALB AVE', 'MORELAND AVE', 'PONCE DE LEON'];
  return names[Math.floor(rng() * names.length)];
}
function generateProperties() {
  const rng = mulberry32(7);
  const props = [];
  const clusters = [
    { x: -8, y: 0, z: -4, base: [0.7, 0.6, 0.7, 0.8, 0.7, 0.4, 0.6, 0.7, 0.5, 0.78], name: 'WEST_END' },
    { x: 6, y: 0, z: -2, base: [0.6, 0.5, 0.5, 0.6, 0.5, 0.5, 0.4, 0.5, 0.6, 0.55], name: 'EDGEWOOD' },
    { x: 4, y: 0, z: 8, base: [0.4, 0.3, 0.2, 0.3, 0.2, 0.8, 0.2, 0.3, 0.7, 0.18], name: 'BUCKHEAD' },
    { x: -2, y: 0, z: 6, base: [0.55, 0.5, 0.45, 0.7, 0.65, 0.45, 0.5, 0.6, 0.55, 0.62], name: 'EAST_ATL' },
  ];
  let id = 1000;
  clusters.forEach((c, ci) => {
    const count = 28 + Math.floor(rng() * 8);
    for (let i = 0; i < count; i++) {
      const r = rng() * 4;
      const a = rng() * Math.PI * 2;
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      const y = (rng() - 0.5) * 1.5;
      const kpis = c.base.map(b => Math.max(0, Math.min(1, b + (rng() - 0.5) * 0.35)));
      // Add a "velocity" — rate of change in displacement risk over last 90 days
      const velocity = (rng() - 0.5) * 0.3 + (kpis[9] > 0.6 ? 0.1 : -0.05);
      props.push({ id: `ATL-${id++}`, cluster: c.name, clusterIdx: ci, x, y, z, kpis, velocity,
        addr: streetName(rng) + ' ' + (Math.floor(rng() * 4900) + 100),
        // mock data has no real source pand record
        source: null });
    }
  });
  return props;
}

// ---------- Live Amsterdam pand → property adapter ----------
// Converts the API response shape (PandRecord) into the property records
// the THREE.js scene consumes. Lat/lng → x/z via equirectangular projection
// centered on the supplied center point (default: Hoofddorp De Landman).
// Output coordinates are in scene units, scaled so the Amsterdam metro fits
// inside roughly the same bounds.cityRadius the mock data used.
const HOOFDDORP_CENTER = { lat: 52.286, lng: 4.692 };
const SCENE_SCALE_M_PER_UNIT = 250;  // 1 scene unit = 250 m → ~5km radius fits in 20 units

function pandToProperty(pand, center = HOOFDDORP_CENTER, idx = 0) {
  // Equirectangular at this latitude — accurate to <1% over Amsterdam metro
  const cosLat = Math.cos(center.lat * Math.PI / 180);
  const dLng = pand.longitude - center.lng;
  const dLat = pand.latitude - center.lat;
  const eastingM = dLng * cosLat * 111320;
  const northingM = dLat * 111320;
  // Scene convention: x = east, z = north (so a north-up map looks correct)
  const x = eastingM / SCENE_SCALE_M_PER_UNIT;
  const z = northingM / SCENE_SCALE_M_PER_UNIT;
  // y carries a small jitter based on building footprint so larger buildings sit higher
  const y = Math.log10(Math.max(pand.pand_opp_max, 100)) - 3.2;  // ~ -0.2 to 1.5 for 100-30000 m²

  // Synthesize a 10-element KPI vector from the available pand features.
  // Slot mapping aligns roughly with KPI_LABELS:
  //   [0] BETWEENNESS         — proxy: address density (urbanization)
  //   [1] STREET ENTROPY      — proxy: address density / population density ratio
  //   [2] LIEN DENSITY        — unknown for DC, set to inverse population proxy
  //   [3] PERMIT VELOCITY     — proxy: build-year recency (newer = more permitting activity)
  //   [4] ZONING FLUX         — inverse cluster size (more cluster mates = stable zoning)
  //   [5] INCOME GRADIENT     — inverse population density (industrial parks = low population)
  //   [6] TENURE CHURN        — proxy: derived from rank (higher rank = more recent discovery)
  //   [7] RENT BURDEN         — set to inverse score (high score = low DC-deployment burden)
  //   [8] TRANSIT REACH       — proxy: address density (high urbanization = better transit)
  //   [9] DISPLACEMENT RISK   — for DC: NIMBY/population displacement risk, proxy: pop density
  const normFootprint = Math.min(1, Math.max(0, Math.log10(Math.max(pand.pand_opp_max, 1)) / 5));
  const normUrban = pand.omgevingsadressendichtheid != null
    ? Math.min(1, pand.omgevingsadressendichtheid / 5000) : 0.3;
  const normPop = pand.bevolkingsdichtheid_inwoners_per_km2 != null
    ? Math.min(1, pand.bevolkingsdichtheid_inwoners_per_km2 / 10000) : 0.2;
  const normRecency = Math.min(1, Math.max(0, (pand.pand_bouwjaar - 1960) / 65));
  const normScore = pand.score;
  const normClusterSize = Math.min(1, pand.cluster_size / 20);
  const kpis = [
    normScore,                                       // 0 BETWEENNESS
    Math.min(1, normFootprint * 1.8),                // 1 FIBER LATENCY
    Math.min(1, (1 - normPop) * 1.4),               // 2 POWER CAPACITY
    normRecency,                                     // 3 PERMIT VELOCITY
    Math.min(1, normClusterSize * 2.5),              // 4 ZONING FLUX
    Math.min(1, Math.abs(normUrban - normPop) * 3),  // 5 INCOME GRADIENT
    Math.min(1, pand.rank / 100),                    // 6 WATER STRESS
    Math.min(1, normScore * 1.5),                    // 7 RENT BURDEN
    Math.min(1, normUrban * 1.6),                    // 8 TRANSIT REACH
    Math.min(1, normPop * 2.0),                      // 9 NIMBY RISK
  ];

  // Velocity: how recently the building was constructed signals momentum
  const velocity = (normRecency - 0.5) * 0.4;

  return {
    id: pand.pand_id,
    cluster: pand.buurtnaam || pand.buurtcode,
    clusterIdx: 0,  // computed in propertiesFromPanden so cluster index is stable
    x, y, z,
    kpis,
    velocity,
    addr: pand.buurtnaam ? `${pand.buurtnaam}, ${pand.gemeentenaam}` : pand.buurtcode,
    // Keep the full source record for the detail panel
    source: pand,
  };
}

// ---------- Geographic helpers (cluster composition panel) ----------

/** Great-circle distance in meters between two lat/lng pairs. */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compass bearing from point 1 to point 2, returned as 8-point label (N/NE/E/SE/S/SW/W/NW). */
function compassBearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  let brng = (toDeg(Math.atan2(y, x)) + 360) % 360;
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(brng / 45) % 8];
}

/** Format meters as "280m" or "3.0km" depending on scale. */
function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

function propertiesFromPanden(panden, center = HOOFDDORP_CENTER) {
  // Stable cluster index per buurtcode (for cross-cluster edge logic)
  const buurtIdx = new Map();
  panden.forEach(p => {
    if (!buurtIdx.has(p.buurtcode)) buurtIdx.set(p.buurtcode, buurtIdx.size);
  });
  return panden.map((p, i) => {
    const prop = pandToProperty(p, center, i);
    prop.clusterIdx = buurtIdx.get(p.buurtcode);
    return prop;
  });
}

function buildEdges(props) {
  const localEdges = [];
  for (let i = 0; i < props.length; i++) {
    const dists = [];
    for (let j = 0; j < props.length; j++) {
      if (i === j) continue;
      const dx = props[i].x - props[j].x, dz = props[i].z - props[j].z, dy = props[i].y - props[j].y;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d < 4.5) dists.push({ j, d });
    }
    dists.sort((a, b) => a.d - b.d);
    dists.slice(0, 4).forEach(({ j }) => { if (i < j) localEdges.push([i, j, 'local']); });
  }
  const rng = mulberry32(42);
  const crossEdges = [];
  const seen = new Set();
  const sigDims = [3, 5, 8, 9];
  function similarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (const d of sigDims) { dot += a[d] * b[d]; na += a[d] * a[d]; nb += b[d] * b[d]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
  }
  for (let i = 0; i < props.length; i++) {
    const candidates = [];
    for (let j = 0; j < props.length; j++) {
      if (i === j || props[i].clusterIdx === props[j].clusterIdx) continue;
      const sim = similarity(props[i].kpis, props[j].kpis);
      if (sim > 0.92) candidates.push({ j, sim });
    }
    candidates.sort((a, b) => b.sim - a.sim);
    if (rng() < 0.3) {
      const take = Math.min(2, candidates.length);
      for (let k = 0; k < take; k++) {
        const j = candidates[k].j;
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) { seen.add(key); crossEdges.push([Math.min(i, j), Math.max(i, j), 'cross']); }
      }
    }
  }
  return { localEdges, crossEdges, all: [...localEdges, ...crossEdges] };
}
const KPI_LABELS = ['BETWEENNESS','FIBER LAT.','PWR CAP.','PERMIT VEL.','ZONING FLUX',
  'INCOME GRAD.','WATER STR.','BRDN','TRNST','NIMBY RISK'];

const SCENARIOS = {
  DEVELOPMENT: {
    name: 'DEV. POTENTIAL', description: 'Properties suitable for new development',
    weights: [0, 0.1, 0, 0.3, 0.25, 0.15, 0, 0, 0.2, 0],
    inverted: [false, false, true, false, false, false, false, false, false, false],
  },
  ACQUISITION: {
    name: 'ACQUISITION', description: 'Undervalued properties in transitional zones',
    weights: [0.15, 0.1, 0, 0.1, 0.2, 0, 0.15, 0.1, 0.2, 0],
    inverted: [false, false, false, false, false, true, false, false, false, false],
  },
  AT_RISK: {
    name: 'AT-RISK SITES', description: 'Active infrastructure stress zones',
    weights: [0, 0, 0.15, 0, 0, 0, 0.15, 0.2, 0, 0.5],
    inverted: [false, false, false, false, false, false, false, false, false, false],
  },
  STABLE: {
    name: 'STABLE INVEST.', description: 'Low risk, established neighborhoods',
    weights: [0.1, 0, 0, 0.1, 0, 0.3, 0, 0, 0.2, 0.3],
    inverted: [false, false, false, false, false, false, false, false, false, true],
  },
};

function scoreProperty(kpis, scenario) {
  let total = 0;
  for (let i = 0; i < kpis.length; i++) {
    if (scenario.weights[i] === 0) continue;
    const v = scenario.inverted[i] ? (1 - kpis[i]) : kpis[i];
    total += v * scenario.weights[i];
  }
  return total;
}

function buildContributions(kpis, scenario) {
  const rows = [];
  for (let i = 0; i < kpis.length; i++) {
    if (scenario.weights[i] === 0) continue;
    const adjusted = scenario.inverted[i] ? (1 - kpis[i]) : kpis[i];
    rows.push({
      idx: i, label: KPI_LABELS[i], weight: scenario.weights[i],
      value: kpis[i], adjustedValue: adjusted,
      contribution: adjusted * scenario.weights[i], inverted: scenario.inverted[i],
    });
  }
  rows.sort((a, b) => b.contribution - a.contribution);
  return rows;
}

function computeTiers(allScores) {
  const sorted = [...allScores].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(sorted.length * p)] || 0;
  return { weak: q(0), moderate: q(0.25), strong: q(0.5), exceptional: q(0.75) };
}
const TIER_LABELS = ['WEAK', 'MODERATE', 'STRONG', 'EXCEPTIONAL'];
function tierForScore(score, tiers) {
  if (score >= tiers.exceptional) return 3;
  if (score >= tiers.strong) return 2;
  if (score >= tiers.moderate) return 1;
  return 0;
}

// ---------- Spider ----------
function SpiderChart({ kpis, color, theme, scenario }) {
  const size = 300, cx = (size/2) + 8, cy = size/2, radius = 110, n = kpis.length;
  const points = kpis.map((v, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [cx + Math.cos(a) * radius * v, cy + Math.sin(a) * radius * v];
  });
  const path = points.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ') + ' Z';
  const rings = [0.25, 0.5, 0.75, 1].map((r, i) => {
    const ringPts = Array.from({ length: n }, (_, k) => {
      const a = (k / n) * Math.PI * 2 - Math.PI / 2;
      return `${cx + Math.cos(a) * radius * r},${cy + Math.sin(a) * radius * r}`;
    }).join(' ');
    return <polygon key={i} points={ringPts} fill="none" stroke={theme.faint} strokeWidth="0.5" />;
  });
  const spokes = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return <line key={i} x1={cx} y1={cy} x2={cx + Math.cos(a) * radius} y2={cy + Math.sin(a) * radius}
                 stroke={theme.faint} strokeWidth="0.5" />;
  });
  const labels = KPI_LABELS.map((label, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const lx = cx + Math.cos(a) * (radius + 28);
    const ly = cy + Math.sin(a) * (radius + 28);
    const isWeighted = scenario && scenario.weights[i] > 0;
    return <text key={i} x={lx} y={ly}
                 fill={isWeighted ? theme.primary : theme.dim}
                 fontSize="7" fontFamily="IBM Plex Mono, monospace"
                 textAnchor={Math.cos(a) < -0.3 ? "end" : Math.cos(a) > 0.3 ? "start" : "middle"} dominantBaseline="middle" letterSpacing="1">{label}</text>;
  });
  const dots = points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2.5" fill={color} />);
  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      <defs>
        <radialGradient id={`spider-fill-${theme.name}`}>
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.05" />
        </radialGradient>
      </defs>
      {rings}{spokes}
      <path d={path} fill={`url(#spider-fill-${theme.name})`} stroke={color} strokeWidth="1.2"
            style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
      {dots}{labels}
    </svg>
  );
}

function ContributionChart({ contributions, totalScore, color, theme, scenarioName }) {
  if (!contributions.length) return (
    <div style={{ padding: 20, textAlign: 'center', color: theme.dim, fontSize: 10 }}>
      No weighted KPIs in this scenario
    </div>
  );
  const maxContribution = Math.max(...contributions.map(c => c.contribution));
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ fontSize: 9, color: theme.dim, letterSpacing: 1.5, marginBottom: 12,
                    display: 'flex', justifyContent: 'space-between' }}>
        <span>CONTRIBUTION TO {scenarioName}</span>
        <span style={{ color: theme.primary }}>SUM: {totalScore.toFixed(3)}</span>
      </div>
      {contributions.map((c, i) => {
        const barWidthPct = (c.contribution / maxContribution) * 100;
        return (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3,
                          fontSize: 9, letterSpacing: 1 }}>
              <span style={{ color: theme.text }}>
                {c.label}
                {c.inverted && <span style={{ color: theme.dim, marginLeft: 4 }}>(inv)</span>}
              </span>
              <span style={{ color: color, fontWeight: 500 }}>{c.contribution.toFixed(3)}</span>
            </div>
            <div style={{ position: 'relative', height: 14, background: theme.edge, overflow: 'hidden' }}>
              <div style={{
                position: 'absolute', top: 0, left: 0, height: '100%',
                width: `${barWidthPct}%`,
                background: `linear-gradient(90deg, ${color}cc, ${color}66)`,
                boxShadow: `0 0 4px ${color}80`,
              }} />
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 3, fontSize: 8,
                          color: theme.dim, letterSpacing: 1 }}>
              <span>VAL <span style={{ color: theme.text }}>{c.value.toFixed(2)}</span>
                {c.inverted && <span style={{ color: theme.watch, marginLeft: 4 }}>→ {c.adjustedValue.toFixed(2)}</span>}
              </span>
              <span>×</span>
              <span>WGT <span style={{ color: theme.text }}>{c.weight.toFixed(2)}</span></span>
              <span style={{ marginLeft: 'auto', color: theme.faint }}>
                {(c.contribution / totalScore * 100).toFixed(0)}% of total
              </span>
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${theme.edge}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4,
                      fontSize: 9, letterSpacing: 1 }}>
          <span style={{ color: theme.dim }}>FINAL SCORE</span>
          <span style={{ color: theme.primary, textShadow: `0 0 4px ${theme.primary}` }}>
            {totalScore.toFixed(3)}
          </span>
        </div>
        <div style={{ height: 6, background: theme.edge, position: 'relative' }}>
          <div style={{
            position: 'absolute', inset: 0, width: `${totalScore * 100}%`,
            background: theme.primary, boxShadow: `0 0 6px ${theme.primary}`,
          }} />
        </div>
      </div>
    </div>
  );
}

// ---------- Main ----------
export default function EruptionRadar() {
  const mountRef = useRef(null);
  const [themeName, setThemeName] = useState('VOID');
  const theme = THEMES[themeName];
  const themeRef = useRef(theme);
  useEffect(() => { themeRef.current = theme; }, [theme]);

  const [mode, setMode] = useState('RADAR');
  const modeRef = useRef('RADAR');
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const [selected, setSelected] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [autoFly, setAutoFly] = useState(true);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [scanType, setScanType] = useState('rotate');
  const [chartView, setChartView] = useState('SPIDER');
  const [showInfo, setShowInfo] = useState(false);

  const [scenarioKey, setScenarioKey] = useState('DEVELOPMENT');
  const [tierIdx, setTierIdx] = useState(2);
  const [scanProgress, setScanProgress] = useState(0);

  const scenarioRef = useRef(SCENARIOS.DEVELOPMENT);
  const thresholdRef = useRef(0);
  const scanTypeRef = useRef('rotate');
  useEffect(() => { scenarioRef.current = SCENARIOS[scenarioKey]; }, [scenarioKey]);
  useEffect(() => { scanTypeRef.current = scanType; }, [scanType]);

  // ----- Live data ingest -----
  // Fetch Amsterdam DC discovery candidates on mount. If the fetch fails
  // (offline dev, backend not running), fall back to the synthetic Atlanta
  // cluster mock so the scene still renders something demonstrable.
  const [livePanden, setLivePanden] = useState(null);
  const [dataMode, setDataMode] = useState('loading');  // 'loading' | 'live' | 'mock'
  const [dataMeta, setDataMeta] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const API_BASE = 'http://localhost:8000';
    fetch(`${API_BASE}/api/v1/predict/pand/discovery?limit=200`, {
      headers: {
        'Authorization': 'Bearer velasight_demo_key_2026',
        'Content-Type': 'application/json',
      },
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(json => {
        if (cancelled) return;
        if (json && Array.isArray(json.panden) && json.panden.length > 0) {
          setLivePanden(json.panden);
          setDataMode('live');
          setDataMeta({
            total: json.total,
            clusters: json.unique_clusters,
            modelVersion: json.model_version,
            vintage: json.data_vintage,
          });
        } else {
          setDataMode('mock');
        }
      })
      .catch(err => {
        console.warn('Eruption Radar: live data fetch failed, using mock', err);
        if (!cancelled) setDataMode('mock');
      });
    return () => { cancelled = true; };
  }, []);

  // ----- Cluster composition (anchor + supporting panden) -----
  // When a live pand is selected, fetch its full buurt cluster so the
  // SELECTED panel can render anchor / supporting roles, distances, and
  // aggregate footprint. Mock data has no source.buurtcode so the fetch
  // is skipped cleanly.
  const [clusterMembers, setClusterMembers] = useState(null);
  const [clusterLoading, setClusterLoading] = useState(false);

  useEffect(() => {
    const buurtcode = selected?.source?.buurtcode;
    if (!buurtcode) {
      setClusterMembers(null);
      return;
    }
    let cancelled = false;
    setClusterLoading(true);
    const API_BASE = 'http://localhost:8000';
    fetch(`${API_BASE}/api/v1/predict/pand/cluster/${buurtcode}`, {
      headers: {
        'Authorization': 'Bearer velasight_demo_key_2026',
        'Content-Type': 'application/json',
      },
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(json => {
        if (cancelled) return;
        if (Array.isArray(json) && json.length > 0) {
          setClusterMembers(json);
        } else {
          setClusterMembers(null);
        }
      })
      .catch(err => {
        console.warn('Cluster fetch failed', err);
        if (!cancelled) setClusterMembers(null);
      })
      .finally(() => { if (!cancelled) setClusterLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  // Properties: live Amsterdam panden if loaded; otherwise mock cluster data.
  // Recomputed only when the data source changes (not per-render).
  const properties = useMemo(() => {
    if (livePanden && livePanden.length > 0) {
      return propertiesFromPanden(livePanden);
    }
    return generateProperties();
  }, [livePanden]);

  // Edge data: kNN local edges + cross-cluster similarity edges.
  // Expensive (O(n²)) — only recomputed when properties array reference changes.
  const edgeData = useMemo(() => buildEdges(properties), [properties]);

  // Scene bounds derived from current properties — used by the scan-line sweep
  // range and the camera framing.
  const bounds = useMemo(() => {
    const xs = properties.map(p => p.x);
    const zs = properties.map(p => p.z);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const zMin = Math.min(...zs) - 1, zMax = Math.max(...zs) + 1;
    const cityRadius = Math.max(Math.abs(xMin), Math.abs(xMax), Math.abs(zMin), Math.abs(zMax)) + 2;
    return { xMin, xMax, zMin, zMax, cityRadius };
  }, [properties]);

  const propScores = useMemo(
    () => properties.map(p => scoreProperty(p.kpis, SCENARIOS[scenarioKey])),
    [properties, scenarioKey]
  );
  const tiers = useMemo(() => computeTiers(propScores), [propScores]);
  const threshold = useMemo(() => {
    const keys = ['weak', 'moderate', 'strong', 'exceptional'];
    return tiers[keys[tierIdx]];
  }, [tiers, tierIdx]);
  useEffect(() => { thresholdRef.current = threshold; }, [threshold]);
  const matchCount = useMemo(
    () => propScores.filter(s => s >= threshold).length,
    [propScores, threshold]
  );

  // ----- Three.js -----
  const sceneObjRef = useRef(null);
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(theme.bgHex, 0.022);
    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 200);
    camera.position.set(0, 8, 22);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(theme.bgHex, 1);
    mount.appendChild(renderer.domElement);

    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(800 * 3);
    for (let i = 0; i < 800; i++) {
      starPos[i*3] = (Math.random() - 0.5) * 200;
      starPos[i*3+1] = (Math.random() - 0.5) * 100;
      starPos[i*3+2] = (Math.random() - 0.5) * 200;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.04, transparent: true, opacity: 0.5,
    }));
    scene.add(stars);

    const grid = new THREE.GridHelper(60, 30, theme.gridA, theme.gridB);
    grid.position.y = -2;
    scene.add(grid);

    // Scan group (only visible in RADAR mode)
    const SCAN_HALF_WIDTH = bounds.cityRadius * 1.4;
    const SCAN_HEIGHT = 6;
    const SCAN_Y_BASE = 1;
    const SCAN_Y_BOTTOM = SCAN_Y_BASE - SCAN_HEIGHT / 2;
    const SCAN_Y_TOP = SCAN_Y_BASE + SCAN_HEIGHT / 2;
    const scanGroup = new THREE.Group();
    const planeGeo = new THREE.PlaneGeometry(SCAN_HALF_WIDTH * 2, SCAN_HEIGHT);
    const planeMat = new THREE.MeshBasicMaterial({
      color: theme.primaryHex, transparent: true, opacity: 0.08,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const planeMesh = new THREE.Mesh(planeGeo, planeMat);
    planeMesh.position.set(0, SCAN_Y_BASE, 0);
    planeMesh.rotation.y = Math.PI / 2;
    scanGroup.add(planeMesh);
    const lineGeo = new THREE.BufferGeometry();
    const lineVerts = new Float32Array([
      0, SCAN_Y_BOTTOM, -SCAN_HALF_WIDTH,  0, SCAN_Y_BOTTOM,  SCAN_HALF_WIDTH,
      0, SCAN_Y_TOP,     SCAN_HALF_WIDTH,  0, SCAN_Y_TOP,    -SCAN_HALF_WIDTH,
      0, SCAN_Y_BOTTOM, -SCAN_HALF_WIDTH,
    ]);
    lineGeo.setAttribute('position', new THREE.BufferAttribute(lineVerts, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: theme.primaryHex, transparent: true, opacity: 0.85,
    });
    const lineMesh = new THREE.Line(lineGeo, lineMat);
    scanGroup.add(lineMesh);
    const innerGeo = new THREE.BufferGeometry();
    const innerVerts = new Float32Array([
      0, SCAN_Y_BOTTOM + 0.15, -SCAN_HALF_WIDTH + 0.3,  0, SCAN_Y_BOTTOM + 0.15,  SCAN_HALF_WIDTH - 0.3,
      0, SCAN_Y_TOP - 0.15,     SCAN_HALF_WIDTH - 0.3,  0, SCAN_Y_TOP - 0.15,    -SCAN_HALF_WIDTH + 0.3,
      0, SCAN_Y_BOTTOM + 0.15, -SCAN_HALF_WIDTH + 0.3,
    ]);
    innerGeo.setAttribute('position', new THREE.BufferAttribute(innerVerts, 3));
    const innerMat = new THREE.LineBasicMaterial({
      color: theme.primaryHex, transparent: true, opacity: 0.4,
    });
    const innerLine = new THREE.Line(innerGeo, innerMat);
    scanGroup.add(innerLine);
    scene.add(scanGroup);

    const nodes = [], halos = [];
    const nodeGroup = new THREE.Group();
    properties.forEach((p, i) => {
      const risk = p.kpis[9];
      const colorHex = risk > 0.65 ? theme.riskHex : risk > 0.45 ? theme.watchHex : theme.healthyHex;
      const baseSize = 0.13 + risk * 0.18;
      const geo = new THREE.SphereGeometry(baseSize, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, p.y, p.z);
      mesh.userData = { idx: i, colorHex, baseSize, baseColor: new THREE.Color(colorHex) };
      nodeGroup.add(mesh);
      nodes.push(mesh);
      const haloGeo = new THREE.SphereGeometry(baseSize * 2.6, 12, 12);
      const haloMat = new THREE.MeshBasicMaterial({
        color: colorHex, transparent: true, opacity: 0.18, side: THREE.BackSide,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.copy(mesh.position);
      halo.userData = { baseOpacity: 0.18, baseColor: new THREE.Color(colorHex) };
      nodeGroup.add(halo);
      halos.push(halo);
    });
    scene.add(nodeGroup);

    const localEdgePositions = new Float32Array(edgeData.localEdges.length * 6);
    const localEdgeColors = new Float32Array(edgeData.localEdges.length * 6);
    edgeData.localEdges.forEach(([a, b], i) => {
      const pa = properties[a], pb = properties[b];
      localEdgePositions[i*6+0] = pa.x; localEdgePositions[i*6+1] = pa.y; localEdgePositions[i*6+2] = pa.z;
      localEdgePositions[i*6+3] = pb.x; localEdgePositions[i*6+4] = pb.y; localEdgePositions[i*6+5] = pb.z;
      const avgRisk = (pa.kpis[9] + pb.kpis[9]) / 2;
      let edgeHex;
      if (avgRisk > 0.65) edgeHex = theme.riskHex;
      else if (avgRisk > 0.45) edgeHex = theme.watchHex;
      else edgeHex = theme.healthyHex;
      const c = new THREE.Color(edgeHex);
      localEdgeColors[i*6+0] = c.r; localEdgeColors[i*6+1] = c.g; localEdgeColors[i*6+2] = c.b;
      localEdgeColors[i*6+3] = c.r; localEdgeColors[i*6+4] = c.g; localEdgeColors[i*6+5] = c.b;
    });
    const localEdgeGeo = new THREE.BufferGeometry();
    localEdgeGeo.setAttribute('position', new THREE.BufferAttribute(localEdgePositions, 3));
    localEdgeGeo.setAttribute('color', new THREE.BufferAttribute(localEdgeColors, 3));
    const localEdgeMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5,
    });
    const localEdgeLines = new THREE.LineSegments(localEdgeGeo, localEdgeMat);
    scene.add(localEdgeLines);

    const crossPositions = [];
    edgeData.crossEdges.forEach(([a, b]) => {
      const pa = properties[a], pb = properties[b];
      const segments = 12;
      const midY = 2 + Math.random() * 1.5;
      for (let s = 0; s < segments; s++) {
        const t1 = s / segments, t2 = (s + 1) / segments;
        const arc = (t) => {
          const x = pa.x + (pb.x - pa.x) * t;
          const z = pa.z + (pb.z - pa.z) * t;
          const y = pa.y + (pb.y - pa.y) * t + Math.sin(t * Math.PI) * midY;
          return [x, y, z];
        };
        const p1 = arc(t1), p2 = arc(t2);
        crossPositions.push(...p1, ...p2);
      }
    });
    const crossEdgeGeo = new THREE.BufferGeometry();
    crossEdgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(crossPositions, 3));
    const crossEdgeMat = new THREE.LineBasicMaterial({
      color: theme.crossEdgeHex, transparent: true, opacity: 0.35,
    });
    const crossEdgeLines = new THREE.LineSegments(crossEdgeGeo, crossEdgeMat);
    scene.add(crossEdgeLines);

    const ringGeo = new THREE.RingGeometry(0.5, 0.6, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: theme.primaryHex, transparent: true, opacity: 0, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered = null;

    const onPointerMove = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    const onPointerDown = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(nodes);
      if (hits.length > 0) {
        const idx = hits[0].object.userData.idx;
        const p = properties[idx];
        setSelected(p);
        setAutoFly(false);
        ringMat.opacity = 1;
        ringMat.color.setHex(themeRef.current.primaryHex);
        ring.position.set(p.x, p.y - 0.15, p.z);
      }
    };
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    let dragging = false, lastX = 0, lastY = 0;
    let yaw = 0, pitch = 0.3, camDist = 24;
    let autoFlyLocal = true;
    const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.005;
      pitch = Math.max(0.05, Math.min(1.2, pitch + (e.clientY - lastY) * 0.005));
      lastX = e.clientX; lastY = e.clientY;
      autoFlyLocal = false;
      setAutoFly(false);
    };
    const onWheel = (e) => { camDist = Math.max(8, Math.min(50, camDist + e.deltaY * 0.02)); };
    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });

    sceneObjRef.current = { scene, renderer, nodes, halos,
      localEdgeGeo, localEdgeMat, localEdgeLines, crossEdgeLines, crossEdgeMat,
      grid, ring, ringMat, stars, scanGroup, planeMat, lineMat, innerMat,
      getAuto: () => autoFlyLocal, setAuto: (v) => { autoFlyLocal = v; } };

    let frame = 0, raf;

    const animate = () => {
      frame++;
      if (autoFlyLocal) yaw += 0.0015;
      camera.position.x = Math.sin(yaw) * Math.cos(pitch) * camDist;
      camera.position.z = Math.cos(yaw) * Math.cos(pitch) * camDist;
      camera.position.y = Math.sin(pitch) * camDist;
      camera.lookAt(0, 0, 0);

      const currentMode = MODES[modeRef.current];
      const isRadar = modeRef.current === 'RADAR';
      const isXray = modeRef.current === 'XRAY';
      const isThermal = modeRef.current === 'THERMAL';

      // Scan visibility + animation
      scanGroup.visible = currentMode.showScan;
      if (currentMode.showScan) {
        const sweepPeriod = 1200;
        const t = (frame % sweepPeriod) / sweepPeriod;
        if (scanTypeRef.current === 'rotate') {
          scanGroup.position.set(0, 0, 0);
          scanGroup.rotation.y = t * Math.PI * 2;
        } else {
          scanGroup.rotation.y = 0;
          const sweepRange = (bounds.xMax - bounds.xMin) + 6;
          scanGroup.position.x = bounds.xMin - 3 + t * sweepRange;
        }
        const pulse = (Math.sin(frame * 0.04) + 1) / 2;
        planeMat.opacity = 0.06 + pulse * 0.05;
        lineMat.opacity = 0.7 + pulse * 0.2;
        innerMat.opacity = 0.25 + pulse * 0.2;
        if (frame % 6 === 0) setScanProgress(t);
      }

      // Edges
      localEdgeLines.visible = currentMode.showLocalEdges;
      crossEdgeLines.visible = currentMode.showCrossEdges;
      localEdgeMat.opacity = currentMode.localEdgeOpacity * (0.85 + Math.sin(frame * 0.015) * 0.15);

      if (isXray) {
        // X-ray: cross edges pulse strongly to emphasize message passing
        crossEdgeMat.opacity = currentMode.crossEdgeOpacity * (0.7 + Math.sin(frame * 0.04) * 0.3);
      } else {
        crossEdgeMat.opacity = currentMode.crossEdgeOpacity * (0.7 + Math.sin(frame * 0.025) * 0.3);
      }

      // ===== Per-node update — palette and detection =====
      const detectionWidth = 1.2;
      const theta = scanGroup.rotation.y;
      const nx = Math.cos(theta);
      const nz = -Math.sin(theta);

      nodes.forEach((node, i) => {
        const p = properties[i];
        const halo = halos[i];

        // Determine base color by mode palette
        let baseHex;
        if (currentMode.palette === 'thermal') {
          // Thermal: heat gradient by displacement risk + velocity
          const heatVal = Math.max(0, Math.min(1, p.kpis[9] + p.velocity * 0.5));
          const tColor = thermalColor(heatVal);
          baseHex = tColor.getHex();
        } else {
          const risk = p.kpis[9];
          baseHex = risk > 0.65 ? themeRef.current.riskHex
                  : risk > 0.45 ? themeRef.current.watchHex
                  : themeRef.current.healthyHex;
        }
        const baseColor = new THREE.Color(baseHex);
        node.userData.baseColor = baseColor;
        halo.userData.baseColor = baseColor;

        // Apply mode opacity defaults
        node.material.opacity = currentMode.nodeOpacity;
        halo.material.opacity = currentMode.haloOpacity;

        // Detection (only in RADAR mode)
        if (isRadar) {
          const score = scoreProperty(p.kpis, scenarioRef.current);
          const isMatch = score >= thresholdRef.current;
          const dist = scanTypeRef.current === 'rotate'
            ? Math.abs(p.x * nx + p.z * nz)
            : Math.abs(p.x - scanGroup.position.x);
          if (isMatch && dist < detectionWidth) {
            const proximity = 1 - (dist / detectionWidth);
            const pulse2 = 1 + proximity * 1.5;
            node.scale.setScalar(pulse2);
            const hotColor = new THREE.Color(themeRef.current.primaryHex);
            halo.material.color.lerpColors(baseColor, hotColor, proximity);
            halo.material.opacity = currentMode.haloOpacity + proximity * 0.55;
            halo.scale.setScalar(1 + proximity * 0.8);
            node.material.color.lerpColors(baseColor, hotColor, proximity * 0.7);
          } else {
            const idle = 1 + Math.sin(frame * 0.04 + i * 0.3) * 0.05;
            node.scale.setScalar(idle);
            node.material.color.copy(baseColor);
            halo.material.color.copy(baseColor);
          }
        } else if (isThermal) {
          // Thermal: nodes pulse based on velocity
          const pulseAmount = Math.abs(p.velocity) * 1.5;
          const pulseSpeed = 0.04 + Math.abs(p.velocity) * 0.1;
          const pulse = 1 + pulseAmount * Math.sin(frame * pulseSpeed + i * 0.3);
          node.scale.setScalar(pulse);
          // Halo also pulses brightly
          halo.scale.setScalar(1 + pulseAmount * 0.5);
          node.material.color.copy(baseColor);
          halo.material.color.copy(baseColor);
        } else if (isXray) {
          // X-ray: nodes are dim recede, but those with cross-links glow slightly
          // (For demo purposes, all nodes get a subtle pulse)
          const idle = 1 + Math.sin(frame * 0.02 + i * 0.4) * 0.03;
          node.scale.setScalar(idle);
          node.material.color.copy(baseColor);
          halo.material.color.copy(baseColor);
        }
      });

      if (ringMat.opacity > 0) ring.scale.setScalar(1 + Math.sin(frame * 0.08) * 0.15);

      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(nodes);
      const newHover = hits.length > 0 ? hits[0].object.userData.idx : null;
      if (newHover !== hovered) {
        hovered = newHover;
        setHoverIdx(newHover);
        renderer.domElement.style.cursor = newHover != null ? 'pointer' : 'grab';
      }
      stars.rotation.y += 0.0001;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;  // wait until laid out
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    // ResizeObserver fires when the mount element itself resizes — including
    // its initial layout, which window.resize won't catch. This is what fixes
    // the "open DevTools to make the scene appear" bug: the canvas was sized
    // before the tab container had laid out, so it rendered at 0x0 until a
    // window event (like F12) triggered a re-layout.
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(mount);
    }
    window.addEventListener('resize', onResize);
    // Defer one frame so the parent flex/grid layout has a chance to
    // compute width/height before we read them.
    requestAnimationFrame(() => requestAnimationFrame(onResize));

    return () => {
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('mousedown', onDown);
      renderer.domElement.removeEventListener('wheel', onWheel);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  // Scene rebuilds when properties / edges / bounds change (live data load).
  // theme.bgHex is intentionally excluded — runtime theme swaps update the
  // existing scene via themeRef rather than rebuilding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties, edgeData, bounds]);

  useEffect(() => {
    if (sceneObjRef.current) sceneObjRef.current.setAuto(autoFly);
  }, [autoFly]);

  useEffect(() => {
    const so = sceneObjRef.current;
    if (!so) return;
    so.scene.fog.color.setHex(theme.bgHex);
    so.renderer.setClearColor(theme.bgHex, 1);
    so.grid.material.color.setHex(theme.gridA);
    so.planeMat.color.setHex(theme.primaryHex);
    so.lineMat.color.setHex(theme.primaryHex);
    so.innerMat.color.setHex(theme.primaryHex);
    so.crossEdgeMat.color.setHex(theme.crossEdgeHex);
    so.ringMat.color.setHex(theme.primaryHex);
  }, [theme]);

  const selectedColor = selected
    ? (selected.kpis[9] > 0.65 ? theme.risk : selected.kpis[9] > 0.45 ? theme.watch : theme.healthy)
    : theme.primary;
  const hovered = hoverIdx != null ? properties[hoverIdx] : null;
  const selectedScore = selected ? scoreProperty(selected.kpis, SCENARIOS[scenarioKey]) : 0;
  const selectedTierIdx = selected ? tierForScore(selectedScore, tiers) : 0;
  const selectedContributions = selected ? buildContributions(selected.kpis, SCENARIOS[scenarioKey]) : [];
  const currentMode = MODES[mode];

  return (
    <div style={{
      width: '100%', height: '100vh', minHeight: 600,
      background: theme.bg, color: theme.text,
      fontFamily: '"IBM Plex Mono", "JetBrains Mono", "Courier New", monospace',
      position: 'relative', overflow: 'hidden',
      transition: 'background 0.4s ease, color 0.4s ease',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&display=swap');
        @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        .blink { animation: blink 1.2s steps(2) infinite; }
      `}</style>

      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

      {/* ============================================================
          TOP BAR — Two rows for mobile readability
          Row 1: Brand · spacer · Theme toggle · Info button
          Row 2: Mode selector (full width, equal segments)
          ============================================================ */}

      {/* Row 1 — Header */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        height: 44, padding: '0 14px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: `linear-gradient(180deg, ${theme.bg}f0, ${theme.bg}cc)`,
        borderBottom: `1px solid ${theme.edge}`,
        zIndex: 11, fontSize: 11, letterSpacing: 2,
      }}>
        {/* Brand block — compact, no version number */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', background: theme.primary,
            boxShadow: `0 0 8px ${theme.primary}`, flexShrink: 0,
          }} />
          <span style={{ color: theme.text, fontWeight: 500, letterSpacing: 2 }}>VELASIGHT</span>
          <span style={{ color: theme.dim, fontSize: 9, letterSpacing: 2,
                         whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            ATLANTA
          </span>
        </div>

        {/* Right-side controls — theme + info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* Theme toggle — single button cycles, more compact than two buttons */}
          <button onClick={() => setThemeName(themeName === 'VOID' ? 'TERMINAL' : 'VOID')}
                  title={`Theme: ${themeName}`}
                  style={{
            background: 'transparent', border: `1px solid ${theme.edge}`,
            color: theme.dim, padding: '5px 10px', fontSize: 9, letterSpacing: 2,
            cursor: 'pointer', fontFamily: 'inherit', minWidth: 64,
          }}>
            <span style={{ color: theme.primary, marginRight: 4 }}>◐</span>
            {themeName}
          </button>

          {/* Info button — opens stats popover */}
          <button onClick={() => setShowInfo(!showInfo)}
                  title="Session info"
                  style={{
            background: showInfo ? `${theme.primary}22` : 'transparent',
            border: `1px solid ${showInfo ? theme.primary : theme.edge}`,
            color: showInfo ? theme.primary : theme.dim,
            width: 28, height: 28, fontSize: 12,
            cursor: 'pointer', fontFamily: 'inherit', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            ⓘ
          </button>
        </div>
      </div>

      {/* Row 2 — Mode selector (anchor of navigation, full width, equal thirds) */}
      <div style={{
        position: 'absolute', top: 44, left: 0, right: 0,
        height: 46, padding: '0 14px',
        display: 'flex', alignItems: 'center', gap: 6,
        background: `linear-gradient(180deg, ${theme.bg}cc, ${theme.bg}80)`,
        borderBottom: `1px solid ${theme.edge}`,
        zIndex: 11,
      }}>
        {Object.entries(MODES).map(([key, m]) => (
          <button key={key} onClick={() => setMode(key)} style={{
            flex: 1,
            background: key === mode ? `${theme.primary}1f` : 'transparent',
            color: key === mode ? theme.primary : theme.dim,
            border: `1px solid ${key === mode ? theme.primary : theme.edge}`,
            padding: '8px 6px', fontSize: 11, letterSpacing: 2,
            cursor: 'pointer', fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            transition: 'all 0.15s',
            boxShadow: key === mode ? `0 0 12px ${theme.primary}30` : 'none',
            textShadow: key === mode ? `0 0 4px ${theme.primary}` : 'none',
            fontWeight: key === mode ? 500 : 400,
          }}>
            <span style={{ fontSize: 13 }}>{m.icon}</span>
            <span>{m.name}</span>
          </button>
        ))}
      </div>

      {/* Info popover — stats + mode description, only when toggled */}
      {showInfo && (
        <div style={{
          position: 'absolute', top: 96, right: 14, zIndex: 12,
          width: 240,
          background: `${theme.bgLift}f0`, backdropFilter: 'blur(12px)',
          border: `1px solid ${theme.edge}`, padding: 14,
          fontSize: 10, letterSpacing: 1.5,
          boxShadow: `0 4px 20px ${theme.bg}cc`,
        }}>
          <div style={{ color: theme.primary, fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>
            {currentMode.icon} {currentMode.name} MODE
          </div>
          <div style={{ fontSize: 9, color: theme.dim, lineHeight: 1.5, marginBottom: 12 }}>
            {currentMode.description}
          </div>

          <div style={{ borderTop: `1px solid ${theme.edge}`, paddingTop: 10 }}>
            <div style={{ fontSize: 8, color: theme.dim, letterSpacing: 2, marginBottom: 6 }}>
              SESSION
            </div>
            <SigRow theme={theme} label="MARKET" value="ATLANTA" color={theme.text} />
            <SigRow theme={theme} label="NODES" value={properties.length} color={theme.text} />
            <SigRow theme={theme} label="LOCAL EDGES" value={edgeData.localEdges.length} color={theme.text} />
            <SigRow theme={theme} label="CROSS EDGES" value={edgeData.crossEdges.length} color={theme.text} />
            <SigRow theme={theme} label="GRAPH" value="● LIVE" color={theme.healthy} />
            <SigRow theme={theme} label="VERSION" value="v1.1.0" color={theme.dim} />
          </div>

          <button onClick={() => setShowInfo(false)} style={{
            width: '100%', marginTop: 10,
            background: 'transparent', border: `1px solid ${theme.edge}`,
            color: theme.dim, padding: '6px', fontSize: 9, letterSpacing: 2,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>CLOSE</button>
        </div>
      )}

      {/* LEFT PANEL — context-sensitive based on mode */}
      <div style={{
        position: 'absolute', top: 90, left: 20, zIndex: 10,
        width: panelCollapsed ? 44 : 260,
        background: `${theme.bgLift}cc`, backdropFilter: 'blur(8px)',
        border: `1px solid ${theme.edge}`,
        transition: 'width 0.25s ease',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: panelCollapsed ? '12px 0' : '12px 14px 8px 14px',
          borderBottom: panelCollapsed ? 'none' : `1px solid ${theme.edge}`,
        }}>
          {!panelCollapsed && (
            <div style={{ color: theme.primary, fontSize: 11, letterSpacing: 1.5,
                          textShadow: `0 0 4px ${theme.primary}` }}>
              {currentMode.icon} {currentMode.name}
            </div>
          )}
          <button onClick={() => setPanelCollapsed(!panelCollapsed)} style={{
            background: 'transparent', border: `1px solid ${theme.edge}`,
            color: theme.dim, width: 20, height: 20, fontSize: 11,
            cursor: 'pointer', fontFamily: 'inherit', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: panelCollapsed ? '0 auto' : '0',
          }}>{panelCollapsed ? '▶' : '◀'}</button>
        </div>

        {!panelCollapsed && (
          <div style={{ padding: '10px 14px 14px 14px', fontSize: 10, letterSpacing: 1.5 }}>
            {/* RADAR MODE PANEL */}
            {mode === 'RADAR' && (
              <>
                <div style={{ color: theme.dim, marginBottom: 6, fontSize: 9 }}>SCAN TYPE</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 12 }}>
                  {[['rotate', 'ROTATE'], ['sweep', 'SWEEP']].map(([key, label]) => (
                    <button key={key} onClick={() => setScanType(key)} style={{
                      background: key === scanType ? `${theme.primary}22` : 'transparent',
                      color: key === scanType ? theme.primary : theme.text,
                      border: `1px solid ${key === scanType ? theme.primary : theme.edge}`,
                      padding: '6px 4px', fontSize: 9, letterSpacing: 1, cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}>{label}</button>
                  ))}
                </div>

                <div style={{ color: theme.dim, marginBottom: 6, fontSize: 9 }}>SCENARIO</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 12 }}>
                  {Object.entries(SCENARIOS).map(([key, sc]) => (
                    <button key={key} onClick={() => setScenarioKey(key)} style={{
                      background: key === scenarioKey ? `${theme.primary}22` : 'transparent',
                      color: key === scenarioKey ? theme.primary : theme.text,
                      border: `1px solid ${key === scenarioKey ? theme.primary : theme.edge}`,
                      padding: '6px 4px', fontSize: 8, letterSpacing: 1, cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}>{sc.name}</button>
                  ))}
                </div>
                <div style={{ fontSize: 8, color: theme.dim, marginBottom: 12, lineHeight: 1.5 }}>
                  {SCENARIOS[scenarioKey].description}
                </div>

                <div style={{ color: theme.dim, marginBottom: 6, fontSize: 9 }}>
                  MATCH AT TIER OR ABOVE
                </div>
                <div style={{ display: 'flex', gap: 2, marginBottom: 8 }}>
                  {TIER_LABELS.map((label, i) => (
                    <button key={i} onClick={() => setTierIdx(i)} style={{
                      flex: 1,
                      background: i === tierIdx ? `${theme.primary}22` : 'transparent',
                      color: i === tierIdx ? theme.primary : theme.dim,
                      border: `1px solid ${i === tierIdx ? theme.primary : theme.edge}`,
                      padding: '5px 2px', fontSize: 7, letterSpacing: 0.5, cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}>{label}</button>
                  ))}
                </div>
                <div style={{ fontSize: 8, color: theme.faint, marginBottom: 12, lineHeight: 1.5 }}>
                  {TIER_LABELS[tierIdx]}: score ≥ {threshold.toFixed(3)}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 6 }}>
                  <span style={{ color: theme.dim }}>SCAN CYCLE</span>
                  <span style={{ color: theme.primary }}>{Math.round(scanProgress * 100)}%</span>
                </div>
                <div style={{ height: 4, background: theme.edge, position: 'relative', marginBottom: 12 }}>
                  <div style={{
                    position: 'absolute', inset: 0, width: `${scanProgress * 100}%`,
                    background: theme.primary, boxShadow: `0 0 6px ${theme.primary}`,
                  }} />
                </div>

                <div style={{ borderTop: `1px solid ${theme.edge}`, paddingTop: 10,
                              fontSize: 9, color: theme.dim }}>
                  MATCHES: <span style={{ color: theme.primary, fontSize: 11,
                                           textShadow: `0 0 4px ${theme.primary}` }}>
                    {matchCount}
                  </span> / {properties.length}
                </div>
              </>
            )}

            {/* X-RAY MODE PANEL */}
            {mode === 'XRAY' && (
              <>
                <div style={{ fontSize: 9, color: theme.dim, lineHeight: 1.6, marginBottom: 12 }}>
                  Foregrounds the GraphSAGE network topology. Cross-cluster arcs show properties
                  connected by shared embedding signals — owner networks, transit corridors,
                  comparable zoning history.
                </div>

                <div style={{ borderTop: `1px solid ${theme.edge}`, paddingTop: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: theme.dim, marginBottom: 6 }}>NETWORK STATS</div>
                  <SigRow theme={theme} label="LOCAL EDGES" value={edgeData.localEdges.length} color={theme.text} />
                  <SigRow theme={theme} label="CROSS EDGES" value={edgeData.crossEdges.length} color={theme.text} />
                  <SigRow theme={theme} label="MEAN DEGREE"
                          value={((edgeData.all.length * 2) / properties.length).toFixed(1)} color={theme.text} />
                  <SigRow theme={theme} label="SIM THRESHOLD" value="0.92" color={theme.primary} />
                </div>

                <div style={{ borderTop: `1px solid ${theme.edge}`, paddingTop: 10 }}>
                  <div style={{ fontSize: 9, color: theme.dim, marginBottom: 6 }}>EDGE TYPES</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 9 }}>
                    <div style={{ width: 18, height: 2, background: theme.healthy }} />
                    <span style={{ color: theme.text }}>LOCAL · k-NN spatial</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 9 }}>
                    <div style={{ width: 18, height: 2, background: theme.crossEdgeHex }} />
                    <span style={{ color: theme.text }}>CROSS · GNN signal</span>
                  </div>
                </div>

                <div style={{ borderTop: `1px solid ${theme.edge}`, marginTop: 10, paddingTop: 10,
                              fontSize: 8, color: theme.faint, lineHeight: 1.4 }}>
                  Tap a node to see its first-degree neighbors highlighted.
                </div>
              </>
            )}

            {/* THERMAL MODE PANEL */}
            {mode === 'THERMAL' && (
              <>
                <div style={{ fontSize: 9, color: theme.dim, lineHeight: 1.6, marginBottom: 12 }}>
                  Heat map of site readiness and infrastructure stress. Pulsing intensity reflects
                  rate of change — fast pulse means rapid market movement.
                </div>

                <div style={{ borderTop: `1px solid ${theme.edge}`, paddingTop: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: theme.dim, marginBottom: 8 }}>HEAT GRADIENT</div>
                  <div style={{
                    height: 16,
                    background: 'linear-gradient(90deg, #0A2540, #00B8FF, #06FFA5, #FFB800, #FF006E)',
                    border: `1px solid ${theme.edge}`,
                    marginBottom: 4,
                  }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between',
                                fontSize: 8, color: theme.dim, letterSpacing: 1 }}>
                    <span>COLD</span>
                    <span>NEUTRAL</span>
                    <span>HOT</span>
                  </div>
                </div>

                <div style={{ borderTop: `1px solid ${theme.edge}`, paddingTop: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: theme.dim, marginBottom: 6 }}>VELOCITY DIST.</div>
                  <SigRow theme={theme} label="ACCELERATING" value={
                    properties.filter(p => p.velocity > 0.05).length
                  } color={theme.risk} />
                  <SigRow theme={theme} label="STABLE" value={
                    properties.filter(p => Math.abs(p.velocity) <= 0.05).length
                  } color={theme.watch} />
                  <SigRow theme={theme} label="DECELERATING" value={
                    properties.filter(p => p.velocity < -0.05).length
                  } color={theme.healthy} />
                </div>

                <div style={{ borderTop: `1px solid ${theme.edge}`, marginTop: 10, paddingTop: 10,
                              fontSize: 8, color: theme.faint, lineHeight: 1.4 }}>
                  Pulse rate ∝ |velocity|. Fast-pulsing nodes are properties where
                  site readiness has shifted most over the last 90 days.
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* CONTROLS */}
      <div style={{
        position: 'absolute', bottom: 20, left: 20, zIndex: 10, display: 'flex', gap: 8,
      }}>
        <ControlButton theme={theme} active={autoFly} onClick={() => setAutoFly(!autoFly)}>
          {autoFly ? '◉ AUTO ORBIT' : '○ MANUAL'}
        </ControlButton>
        <ControlButton theme={theme} onClick={() => { setSelected(null); }}>
          ✕ DESELECT
        </ControlButton>
      </div>

      {/* HOVER */}
      {hovered && !selected && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          zIndex: 10, fontSize: 10, color: theme.dim, letterSpacing: 1.5,
        }}>
          <span style={{ color: theme.text }}>{hovered.id}</span>
          <span style={{ margin: '0 10px' }}>·</span>
          <span>{hovered.cluster.replace('_', ' ')}</span>
          {mode === 'RADAR' && (
            <>
              <span style={{ margin: '0 10px' }}>·</span>
              <span style={{ color: theme.primary }}>
                {TIER_LABELS[tierForScore(scoreProperty(hovered.kpis, SCENARIOS[scenarioKey]), tiers)]}
              </span>
            </>
          )}
          {mode === 'THERMAL' && (
            <>
              <span style={{ margin: '0 10px' }}>·</span>
              <span style={{ color: hovered.velocity > 0.05 ? theme.risk
                                   : hovered.velocity < -0.05 ? theme.healthy : theme.watch }}>
                Δ {(hovered.velocity * 100).toFixed(1)}%/90d
              </span>
            </>
          )}
          <span style={{ margin: '0 10px' }}>·</span>
          <span style={{ color: theme.watch }}>TAP TO INSPECT</span>
        </div>
      )}

      {/* SELECTED */}
      {selected && (
        <div style={{
          position: 'absolute', top: 90, right: 20, zIndex: 10,
          width: 360, maxHeight: 'calc(100vh - 110px)', overflowY: 'auto',
          background: `${theme.bgLift}eb`, backdropFilter: 'blur(12px)',
          border: `1px solid ${theme.edge}`, padding: 18,
        }}>
          {/* Close button — prominent, top-right of panel, sticky so it's always visible */}
          <button onClick={() => setSelected(null)} style={{
            position: 'sticky', top: -18, marginTop: -18, marginRight: -18, marginLeft: 'auto',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, float: 'right',
            background: `${theme.bgLift}f5`,
            border: `1px solid ${theme.edge}`,
            color: theme.text, fontSize: 16, lineHeight: 1,
            cursor: 'pointer', fontFamily: 'inherit', padding: 0,
            zIndex: 2, transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = theme.risk;
            e.currentTarget.style.color = theme.risk;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = theme.edge;
            e.currentTarget.style.color = theme.text;
          }}>
            ✕
          </button>

          <div style={{ fontSize: 9, color: theme.dim, letterSpacing: 2, marginBottom: 4 }}>
            PROPERTY ID
          </div>
          <div style={{ fontSize: 18, color: selectedColor, letterSpacing: 1, marginBottom: 2,
                        textShadow: `0 0 8px ${selectedColor}80` }}>
            {selected.id}
          </div>
          <div style={{ fontSize: 11, color: theme.text, marginBottom: 10 }}>
            {selected.addr}
            <span style={{ color: theme.dim, marginLeft: 8 }}>· {selected.cluster.replace('_', ' ')}</span>
          </div>

          {mode === 'RADAR' && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px', marginBottom: 14,
              border: `1px solid ${theme.primary}66`, background: `${theme.primary}10`,
            }}>
              <div>
                <div style={{ fontSize: 8, color: theme.dim, letterSpacing: 2 }}>
                  {SCENARIOS[scenarioKey].name}
                </div>
                <div style={{ fontSize: 13, color: theme.primary, letterSpacing: 2,
                              textShadow: `0 0 4px ${theme.primary}` }}>
                  {TIER_LABELS[selectedTierIdx]}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 8, color: theme.dim, letterSpacing: 1 }}>SCORE</div>
                <div style={{ fontSize: 14, color: theme.text, letterSpacing: 1 }}>
                  {selectedScore.toFixed(3)}
                </div>
              </div>
            </div>
          )}

          {mode === 'THERMAL' && (
            <div style={{
              padding: '8px 12px', marginBottom: 14,
              border: `1px solid ${theme.primary}66`, background: `${theme.primary}10`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 8, color: theme.dim, letterSpacing: 2 }}>SITE READINESS INDEX</span>
                <span style={{ fontSize: 13, color: selected.velocity > 0 ? theme.risk : theme.healthy,
                                letterSpacing: 1 }}>
                  {selected.velocity > 0 ? '+' : ''}{(selected.velocity * 100).toFixed(1)}% / 90d
                </span>
              </div>
              <div style={{ fontSize: 8, color: theme.faint, lineHeight: 1.4, marginTop: 6 }}>
                {selected.velocity > 0.1 ? 'Rapid acceleration — broker action recommended within 30 days'
                 : selected.velocity > 0.05 ? 'Mild acceleration — monitor monthly'
                 : selected.velocity > -0.05 ? 'Stable — standard 90-day review'
                 : 'Cooling — reduced urgency'}
              </div>
            </div>
          )}

          {mode === 'XRAY' && (
            <div style={{
              padding: '8px 12px', marginBottom: 14,
              border: `1px solid ${theme.primary}66`, background: `${theme.primary}10`,
            }}>
              <div style={{ fontSize: 8, color: theme.dim, letterSpacing: 2, marginBottom: 4 }}>
                NETWORK POSITION
              </div>
              <SigRow theme={theme} label="LOCAL DEGREE"
                      value={edgeData.localEdges.filter(e => e[0] === properties.indexOf(selected) || e[1] === properties.indexOf(selected)).length}
                      color={theme.text} />
              <SigRow theme={theme} label="CROSS DEGREE"
                      value={edgeData.crossEdges.filter(e => e[0] === properties.indexOf(selected) || e[1] === properties.indexOf(selected)).length}
                      color={theme.primary} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {['SPIDER', 'CONTRIBUTION'].map(view => (
              <button key={view} onClick={() => setChartView(view)} style={{
                flex: 1,
                background: view === chartView ? `${theme.primary}22` : 'transparent',
                color: view === chartView ? theme.primary : theme.text,
                border: `1px solid ${view === chartView ? theme.primary : theme.edge}`,
                padding: '6px 4px', fontSize: 9, letterSpacing: 1.5, cursor: 'pointer',
                fontFamily: 'inherit',
              }}>{view}</button>
            ))}
          </div>

          <div style={{ minHeight: 400, width: '100%', overflow: 'visible' }}>
            {chartView === 'SPIDER' ? (
              <SpiderChart kpis={selected.kpis} color={selectedColor} theme={theme} scenario={SCENARIOS[scenarioKey]} />
            ) : (
              <ContributionChart contributions={selectedContributions} totalScore={selectedScore}
                                 color={selectedColor} theme={theme} scenarioName={SCENARIOS[scenarioKey].name} />
            )}
          </div>

          {/* ─── CLUSTER COMPOSITION (live data only) ─── */}
          {selected.source && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${theme.edge}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <div style={{ fontSize: 9, color: theme.dim, letterSpacing: 2 }}>
                  CLUSTER COMPOSITION
                </div>
                {clusterLoading && (
                  <div style={{ fontSize: 8, color: theme.dim, fontStyle: 'italic' }}>loading…</div>
                )}
              </div>

              {clusterMembers && clusterMembers.length > 0 ? (() => {
                const anchor = clusterMembers.find(m => m.is_cluster_anchor) || clusterMembers[0];
                const supporting = clusterMembers.filter(m => !m.is_cluster_anchor);
                const totalFootprint = clusterMembers.reduce((s, m) => s + (m.pand_opp_max || 0), 0);
                const totalAcres = totalFootprint / 4046.86;

                return (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 4 }}>
                      <span style={{ color: theme.dim, letterSpacing: 1 }}>BUURT</span>
                      <span style={{ color: theme.text, letterSpacing: 1 }}>
                        {anchor.buurtnaam || anchor.buurtcode}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 4 }}>
                      <span style={{ color: theme.dim, letterSpacing: 1 }}>GEMEENTE</span>
                      <span style={{ color: theme.text, letterSpacing: 1 }}>
                        {anchor.gemeentenaam || '—'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 10 }}>
                      <span style={{ color: theme.dim, letterSpacing: 1 }}>CANDIDATES</span>
                      <span style={{ color: theme.primary, letterSpacing: 1 }}>
                        {clusterMembers.length}
                      </span>
                    </div>

                    {/* Anchor */}
                    <div style={{
                      padding: '6px 8px', marginBottom: 6,
                      background: `${theme.primary}14`,
                      border: `1px solid ${theme.primary}40`,
                    }}>
                      <div style={{ fontSize: 8, color: theme.primary, letterSpacing: 2, marginBottom: 2 }}>
                        ★ ANCHOR
                        {anchor.pand_id === selected.source.pand_id ? '  (SELECTED)' : ''}
                      </div>
                      <div style={{ fontSize: 10, color: theme.text, letterSpacing: 1, marginBottom: 2 }}>
                        {anchor.pand_id}
                      </div>
                      <div style={{ fontSize: 9, color: theme.dim, letterSpacing: 1 }}>
                        {Math.round(anchor.pand_opp_max).toLocaleString()} m² · built {anchor.pand_bouwjaar} · score {anchor.score.toFixed(6)}
                      </div>
                    </div>

                    {/* Supporting panden */}
                    {supporting.length > 0 && (
                      <>
                        <div style={{ fontSize: 8, color: theme.dim, letterSpacing: 2, marginTop: 8, marginBottom: 4 }}>
                          ◇ SUPPORTING ({supporting.length})
                        </div>
                        {supporting.map((m) => {
                          const dist = haversineMeters(
                            anchor.latitude, anchor.longitude,
                            m.latitude, m.longitude
                          );
                          const bearing = compassBearing(
                            anchor.latitude, anchor.longitude,
                            m.latitude, m.longitude
                          );
                          const isSelected = m.pand_id === selected.source.pand_id;
                          return (
                            <div key={m.pand_id} style={{
                              padding: '5px 8px', marginBottom: 4,
                              background: isSelected ? `${theme.primary}10` : 'transparent',
                              border: `1px solid ${isSelected ? `${theme.primary}30` : theme.edge}`,
                            }}>
                              <div style={{ fontSize: 9, color: isSelected ? theme.text : theme.dim, letterSpacing: 1, marginBottom: 1 }}>
                                {m.pand_id}{isSelected ? '  (SELECTED)' : ''}
                              </div>
                              <div style={{ fontSize: 8, color: theme.dim, letterSpacing: 1 }}>
                                {Math.round(m.pand_opp_max).toLocaleString()} m² · {m.pand_bouwjaar} · {formatDistance(dist)} {bearing}
                              </div>
                            </div>
                          );
                        })}
                      </>
                    )}

                    {/* Aggregate footprint — the underwriting punchline */}
                    <div style={{
                      marginTop: 10, paddingTop: 8,
                      borderTop: `1px solid ${theme.edge}`,
                      display: 'flex', justifyContent: 'space-between', fontSize: 9,
                    }}>
                      <span style={{ color: theme.dim, letterSpacing: 1 }}>TOTAL FOOTPRINT</span>
                      <span style={{ color: theme.text, letterSpacing: 1 }}>
                        {Math.round(totalFootprint).toLocaleString()} m²
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginTop: 2 }}>
                      <span style={{ color: theme.dim, letterSpacing: 1 }}>CAMPUS SCALE</span>
                      <span style={{ color: theme.primary, letterSpacing: 1 }}>
                        ~{totalAcres.toFixed(1)} acres
                      </span>
                    </div>
                  </>
                );
              })() : (
                !clusterLoading && (
                  <div style={{ fontSize: 9, color: theme.dim, fontStyle: 'italic' }}>
                    No cluster data — single-candidate site
                  </div>
                )
              )}
            </div>
          )}

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${theme.edge}` }}>
            <div style={{ fontSize: 9, color: theme.dim, letterSpacing: 2, marginBottom: 8 }}>
              KPI BREAKDOWN
            </div>
            {KPI_LABELS.map((label, i) => {
              const isWeighted = SCENARIOS[scenarioKey].weights[i] > 0;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <div style={{ fontSize: 9, color: isWeighted && mode === 'RADAR' ? theme.primary : theme.dim,
                                width: 110, letterSpacing: 1 }}>{label}</div>
                  <div style={{ flex: 1, height: 3, background: theme.edge, position: 'relative' }}>
                    <div style={{
                      position: 'absolute', inset: 0, width: `${selected.kpis[i] * 100}%`,
                      background: selectedColor, boxShadow: `0 0 4px ${selectedColor}`,
                    }} />
                  </div>
                  <div style={{ fontSize: 9, color: theme.text, width: 32, textAlign: 'right' }}>
                    {selected.kpis[i].toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{
        position: 'absolute', bottom: 20, right: 20, zIndex: 10,
        fontSize: 9, color: theme.dim, letterSpacing: 2, textAlign: 'right',
      }}>
        <div>GRAPHSAGE · 800K NODES · 55M EDGES</div>
        <div style={{ marginTop: 3, color: theme.faint }}>NEO4J · VERTEX AI · H3 r9</div>
      </div>
    </div>
  );
}

function SigRow({ theme, label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 10, gap: 12 }}>
      <span style={{ color: theme.dim, letterSpacing: 1, flexShrink: 0 }}>{label}</span>
      <span style={{ color, letterSpacing: 1, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ControlButton({ theme, children, onClick, active }) {
  return (
    <button onClick={onClick} style={{
      background: active ? `${theme.primary}1f` : `${theme.bgLift}b3`,
      backdropFilter: 'blur(8px)',
      border: `1px solid ${active ? theme.primary : theme.edge}`,
      color: active ? theme.primary : theme.text,
      padding: '8px 14px', fontSize: 10, letterSpacing: 2,
      fontFamily: 'inherit', cursor: 'pointer', transition: 'all 0.15s',
      boxShadow: active ? `0 0 12px ${theme.primary}40` : 'none',
    }}>
      {children}
    </button>
  );
}




