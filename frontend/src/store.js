import { create } from 'zustand'

export const KPI_DEFS = [
  {
    id: 'cap_rate', label: 'Cap rate δ', color: '#10B981', weight: 0.15,
    explanation: 'Value pressure × transit × appreciation. 0.5 is market-neutral; above 0.5 means cap rate compressed (premium pricing); below 0.5 means cap rate wide (discount).'
  },
  {
    id: 'transit', label: 'Transit centrality', color: '#3B82F6', weight: 0.10,
    explanation: 'Max and mean betweenness of nearby intersections from the OSM graph, log-normalized against Atlanta p50/p95 cuts. Higher scores = stronger throughput to jobs and commerce.'
  },
  {
    id: 'noi_growth', label: 'NOI growth', color: '#F59E0B', weight: 0.10,
    explanation: 'AssessedValue vs last_sale_price delta proxies demand trajectory. Transit weights the throughput; tract income caps what the local market can bear.'
  },
  {
    id: 'income_mig', label: 'Income migration', color: '#8B5CF6', weight: 0.10,
    explanation: 'Classic gentrification pull: high-earner tract × parcel priced above tract average × connectivity to jobs. Anchored in Census ACS tract median income.'
  },
  {
    id: 'displacement', label: 'Displacement risk', color: '#EF4444', weight: 0.12,
    explanation: 'Composite of income migration and value pressure, amplified by transit (migrants reach the parcel), damped by lot size (larger lots slow flips).'
  },
  {
    id: 'lihtc', label: 'LIHTC eligibility', color: '#06B6D4', weight: 0.05,
    explanation: 'QCT-style proxy: tracts below the city income median score higher. Parcels priced below their tract average add a rent-affordable basis signal. Pending direct HUD QCT overlay.'
  },
  {
    id: 'retail', label: 'Retail gravity', color: '#EC4899', weight: 0.05,
    explanation: 'Placeholder in current synthesis. Future build: weighted distance to top-N retail anchors × commercial parcel density within 0.5 mile ring.'
  },
  {
    id: 'street', label: 'Street entropy', color: '#14B8A6', weight: 0.05,
    explanation: 'Coefficient of variation of nearby intersection betweenness + intersection density. Separates cul-de-sac subdivisions (low) from chaotic mixed-use corridors (high).'
  },
  {
    id: 'lien', label: 'Lien density', color: '#F97316', weight: 0.08,
    explanation: 'Stress triad: housing-stock age × inverse value pressure × inverse tract income. Capped at 0.70 because no direct lien data is wired yet; we don\'t want to over-flag title risk.'
  },
  {
    id: 'school', label: 'School gradient', color: '#FCD34D', weight: 0.08,
    explanation: 'Tract median income carries the signal (US property-tax-funded schools) with small premiums for mature housing stock and dense, established tracts.'
  },
  {
    id: 'crime', label: 'Crime density', color: '#EF4444', weight: 0.05,
    explanation: 'Roadmap KPI. Future ingest: APD incident data geocoded to parcels, kernel density smoothed over 12-month rolling window.'
  },
  {
    id: 'flood', label: 'Flood risk', color: '#3B82F6', weight: 0.05,
    explanation: 'Roadmap KPI. Future ingest: FEMA NFHL flood zone overlay + elevation delta to nearest hydrographic feature.'
  },
  {
    id: 'substation', label: 'Substation prox.', color: '#EAB308', weight: 0.05,
    appliesTo: ['multifamily', 'data_center'],
    explanation: 'Roadmap KPI for data-center thesis. Future: Euclidean distance to nearest Georgia Power substation × available transmission capacity (when GP publishes).'
  },
  {
    id: 'dark_fiber', label: 'Dark fiber lat.', color: '#0EA5E9', weight: 0.05,
    appliesTo: ['multifamily', 'data_center'],
    explanation: 'Roadmap KPI for data-center thesis. Future: latency to nearest internet exchange point + fiber route redundancy count.'
  },
  {
    id: 'water_stress', label: 'Water stress idx', color: '#06B6D4', weight: 0.08,
    appliesTo: ['multifamily', 'data_center'],
    explanation: 'Roadmap KPI. Future: WRI Aqueduct baseline water stress × tract-level household water demand projection.'
  },
  {
    id: 'nimby_risk', label: 'Acoustic / NIMBY', color: '#F43F5E', weight: 0.10,
    appliesTo: ['multifamily', 'data_center'],
    explanation: 'Roadmap KPI. Future: HOA density × historic district overlay × past rezone-opposition signatures from city council records.'
  },
  {
    id: 'health_grav', label: 'Healthcare Grav.', color: '#F43F5E', weight: 0.15,
    explanation: 'Roadmap KPI. Future: weighted distance to top-tier hospital systems × MOB density within 1 mile ring.'
  },
  {
    id: 'demo_aging', label: 'Demographic Aging', color: '#8B5CF6', weight: 0.10,
    explanation: 'Roadmap KPI. Future: ACS B01001 age-bracket distribution × tract-level median age trend over 5-year window.'
  },
  {
    id: 'supply_sat', label: 'Supply Saturation', color: '#EAB308', weight: 0.10,
    explanation: 'Roadmap KPI. Future: multifamily deliveries + pipeline / tract household count, normalized against MSA absorption rate.'
  },
  {
    id: 'rlv_yield', label: 'RLV vs. REIT Yield', color: '#10B981', weight: 0.15,
    explanation: 'Roadmap KPI. Future: residual land value / cost of capital, compared against REIT sector yield curves for the relevant asset class.'
  },
  {
    id: 'permit_vel', label: 'Permit velocity', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — city permit issuance velocity, 90-day moving average, with type breakdown.'
  },
  {
    id: 'assemblage', label: 'Assemblage prob.', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — probability that an adjacent-parcel set can be assembled into a developable block, based on ownership graph and zoning.'
  },
  {
    id: 'shadow_inv', label: 'Shadow inventory', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — units held off-market (institutional vacant + distressed title), tract-weighted.'
  },
  {
    id: 'absorption', label: 'Absorption rate', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — net units absorbed per month at submarket level, by asset class.'
  },
  {
    id: 'irr_conf', label: 'IRR confidence', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — posterior variance of IRR given Monte Carlo over rent, cap rate, and exit timing.'
  },
  {
    id: 'zoning_elas', label: 'Zoning elasticity', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — probability of successful rezone given historical council decisions and active variance applications.'
  },
  {
    id: 'ownership', label: 'Ownership conc.', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — HHI of beneficial owners within submarket, traced through LLC-signatory chains.'
  },
  {
    id: 'tax_traj', label: 'Tax trajectory', color: '#888888', weight: 0.0, locked: true,
    explanation: 'Enterprise tier — 5-year projected millage rate trajectory + tract-level reassessment momentum.'
  },

// ── DC-specific KPIs (V1 demo) ──────────────────────────────
{
  id: 'dc_suitability', label: 'DC Suitability', color: '#14B8A6', weight: 0.20,
  appliesTo: ['data_center'],
  explanation: 'Calibrated 0–1 probability that this parcel matches the institutional data-center signature. Output of the Velasight DC GNN, validated cross-market on Amsterdam at AUC 0.988 ± 0.013 across 5 spatial folds (whole-buurt holdout). The lead score for DC discovery and feasibility.'
},
{
  id: 'parcel_fitness', label: 'Parcel Fitness', color: '#A78BFA', weight: 0.15,
  appliesTo: ['data_center'],
  explanation: 'Composite of building footprint, parcel area, and assemblage potential — the structural signature DCs share (~76–79× the metro median). Reads BAG building footprint, Kadaster parcel area, and ownership-graph adjacency for aggregation feasibility.'
},
{
  id: 'appreciation', label: 'Appreciation Traj.', color: '#34D399', weight: 0.12,
  appliesTo: ['data_center'],
  explanation: 'Reframed value-trajectory head. Where neighborhood value and rent are heading — calibrated against ACS inflow signals (income, education, permits, investment). Replaces displacement as the headline trajectory metric for institutional underwriting; displacement remains as a risk overlay.'
},
{
  id: 'calibration', label: 'Calibration', color: '#FBBF24', weight: 0.10,
  appliesTo: ['data_center'],
  explanation: 'In-report model confidence: predicted suitability paired with historical hit-rate of comparable predictions ("our 90% intervals contained the actual X% of the time on N comparable parcels"). Brier score + ECE displayed; the artifact that lets a CIO weight the number correctly.'
}
]

// ─────────────────────────────────────────────────────────────────────
// Helper: return KPI_DEFS filtered by program type.
// - Locked (enterprise-tier) entries are always excluded.
// - Entries with `appliesTo` show only when the type matches.
// - Entries without `appliesTo` default to non-DC types (preserves
//   existing multifamily/MOB/affordable behavior — DC requires opt-in).
// ─────────────────────────────────────────────────────────────────────

export function visibleKpis(programType = 'multifamily') {
  return KPI_DEFS.filter(k => {
    if (k.locked) return false
    if (k.appliesTo) return k.appliesTo.includes(programType)
    return programType !== 'data_center'
  })
}

// ─────────────────────────────────────────────────────────────────────
// Backend KPI order
// ─────────────────────────────────────────────────────────────────────
//
// Maps FastAPI's KPIVector fields to their index in our kpiValues array.
// The backend's SiteAnalysis.kpi object looks like:
//   { transit_centrality, school_gradient, noi_growth, income_migration,
//     lien_density, cap_rate_delta, street_entropy, displacement_risk,
//     lihtc_eligibility, irr_horizon }
//
// We map each of these into the correct KPI_DEFS slot.
// The array below is the SAME order as the first 10 entries in KPI_DEFS.

const BACKEND_KPI_ORDER = [
  'cap_rate_delta',           // [0]  cap_rate
  'transit_centrality',       // [1]  transit
  'noi_growth',               // [2]  noi_growth
  'income_migration',         // [3]  income_mig
  'displacement_risk',        // [4]  displacement
  'lihtc_eligibility',        // [5]  lihtc
  null,                       // [6]  retail — not in backend yet
  'street_entropy',           // [7]  street
  'lien_density',             // [8]  lien
  'school_gradient',          // [9]  school
  null, null,                 // [10-11] crime, flood — roadmap
  'substation_proximity',     // [12] substation — NEW backend mapping
  'fiber_latency',            // [13] dark_fiber — NEW backend mapping
  null,                       // [14] water_stress — roadmap
  null,                       // [15] nimby_risk — roadmap
  null, null, null, null,     // [16-19] roadmap multifamily KPIs
  null, null, null, null,     // [20-23] enterprise-locked
  null, null, null, null,     // [24-27] enterprise-locked
  'dc_suitability_score',     // [28] dc_suitability — NEW
  null,                       // [29] parcel_fitness — derived elsewhere, not in KPIVector
  'appreciation_trajectory',  // [30] appreciation — NEW backend mapping
  null,                       // [31] calibration — derived from model card, not in KPIVector
]

// Same ordering for the quality tag lookup.
const BACKEND_QUALITY_KEY = BACKEND_KPI_ORDER

// Map backend quality dict to UI quality array.
function mapQualityDict(qualityDict) {
  if (!qualityDict) return null
  const arr = new Array(32).fill('full')
  BACKEND_QUALITY_KEY.forEach((backendKey, i) => {
    if (backendKey && qualityDict[backendKey]) {
      arr[i] = qualityDict[backendKey]
    }
  })
  return arr
}

// Map backend kpi dict to the UI's flat kpiValues array.
function mapKpiDict(kpiDict, prevValues) {
  if (!kpiDict) return prevValues
  const arr = [...prevValues]
  BACKEND_KPI_ORDER.forEach((backendKey, i) => {
    if (backendKey && typeof kpiDict[backendKey] === 'number') {
      arr[i] = kpiDict[backendKey]
    }
  })
  return arr
}

// Raw-value strings for hover-reveal on the KPI cards.
function mapRawValues(kpiDict, prevRaw) {
  if (!kpiDict) return prevRaw
  const arr = [...prevRaw]
  BACKEND_KPI_ORDER.forEach((backendKey, i) => {
    if (backendKey && typeof kpiDict[backendKey] === 'number') {
      arr[i] = kpiDict[backendKey].toFixed(3)
    }
  })
  return arr
}


// ─────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────

// Default map presets per program type. Switching programType also
// recenters the map so the user lands in the relevant submarket.
export const MAP_PRESETS = {
  multifamily:  { center: [-84.3880, 33.7490], zoom: 13 },  // Atlanta downtown
  mob:          { center: [-84.3880, 33.7490], zoom: 13 },  // Atlanta downtown
  data_center:  { center: [ 4.6920, 52.2860], zoom: 15 },  // Hoofddorp De Landman cluster
}

export const useExploreStore = create((set, get) => ({
  // Active program type — drives visibleKpis filtering, spider chart
  // selection, map preset, and which prediction endpoint SiteAnalysis hits.
  programType: 'multifamily',

  mapCenter: MAP_PRESETS.multifamily.center,
  mapZoom: MAP_PRESETS.multifamily.zoom,
  selectedParcel: null,

  kpiValues: new Array(32).fill(0),
  kpiRawValues: new Array(32).fill('---'),
  kpiWeights: KPI_DEFS.map(k => k.weight),
  kpiDataQuality: null,        // array of 'full'|'proxy'|'unavailable' per KPI
  gentrificationScore: '--',

  siteAnalysis: null,
  voiceActive: false,
  voiceTranscript: '',
  voiceResponse: '',
  lockedAnalysis: '',
  lastAnalyzedAddress: '',
  vapiConnected: false,

  // setSiteAnalysis is the single entry point for any new analysis result,
  // whether it comes from Vapi (camelCase) or FastAPI (snake_case).
  //
  // We accept three possible shapes:
  //   1. Vapi tool-call result: { kpiValues: [...], kpiRawValues: [...] }
  //   2. FastAPI SiteAnalysis:  { kpi: {transit_centrality: 0.6, ...},
  //                               kpi_data_quality: {...},
  //                               gentrification_score: 68, verdict: '...' }
  //   3. Ad-hoc:                { analysis: 'free-form text' }
  //
  // We handle all three without clobbering state we already have.
  setSiteAnalysis: (data) => set((state) => {
    if (!data) return {}
    const incomingSummary = data.summary || data.ai_analysis_report || data.reasoning || data.analysis || ''
    if (incomingSummary) useExploreStore.setState({ lockedAnalysis: incomingSummary })

    // Shape 1 — Vapi flat arrays
    const vapiKpi = data.kpiValues || data.kpi_values
    const vapiRaw = data.kpiRawValues || data.kpi_raw_values

    // Shape 2 — FastAPI structured response
    const backendKpi = data.kpi
    const backendQuality = data.kpi_data_quality

    let newKpiValues = state.kpiValues
    let newRawValues = state.kpiRawValues
    let newQuality = state.kpiDataQuality

    if (Array.isArray(vapiKpi)) {
      newKpiValues = vapiKpi
    } else if (backendKpi && typeof backendKpi === 'object') {
      newKpiValues = mapKpiDict(backendKpi, state.kpiValues)
    }

    if (Array.isArray(vapiRaw)) {
      newRawValues = vapiRaw
    } else if (backendKpi && typeof backendKpi === 'object') {
      newRawValues = mapRawValues(backendKpi, state.kpiRawValues)
    }

    if (backendQuality && typeof backendQuality === 'object') {
      newQuality = mapQualityDict(backendQuality)
    }

    const newScore = typeof data.gentrification_score === 'number'
      ? data.gentrification_score
      : state.gentrificationScore

    return {
      siteAnalysis: data,
      kpiValues: newKpiValues,
      kpiRawValues: newRawValues,
      kpiDataQuality: newQuality,
      gentrificationScore: newScore,
    }
  }),

  setMapCenter: (center) => set({ mapCenter: center }),
  setMapZoom: (zoom) => set({ mapZoom: zoom }),

  // Switching program type triggers a map recenter to the preset for
  // that program. Components that watch programType (SpiderChart,
  // KPIPanel, SiteAnalysis) re-render against the new visibleKpis set
  // and the correct prediction endpoint.
  setProgramType: (pt) => set((state) => {
    const preset = MAP_PRESETS[pt] || MAP_PRESETS.multifamily
    return {
      programType: pt,
      mapCenter: preset.center,
      mapZoom: preset.zoom,
      // Clear stale analysis when switching programs — the old verdict
      // is for a different market and would mislead.
      siteAnalysis: null,
      kpiValues: new Array(32).fill(0),
      kpiRawValues: new Array(32).fill('---'),
      kpiDataQuality: null,
      gentrificationScore: '--',
    }
  }),
  updateKpiValue: (index, value) => {
    const values = [...get().kpiValues]
    values[index] = value
    set({ kpiValues: values })
  },
  setVoiceActive: (v) => set({ voiceActive: v }),
  setVoiceTranscript: (t) => set({ voiceTranscript: t }),
  setVoiceResponse: (r) => set({ voiceResponse: r }),
  setVapiConnected: (v) => set({ vapiConnected: v }),
}))




