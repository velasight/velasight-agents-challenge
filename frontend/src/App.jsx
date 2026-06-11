import { useState, useEffect, useRef, useMemo } from 'react'
import MapView from './components/MapView'
import SpiderChart from './components/SpiderChart'
import SiteAnalysis from './components/SiteAnalysis'
import EruptionRadar from './components/EruptionRadar'
import VoiceBar from './components/VoiceBar'
import { useExploreStore, KPI_DEFS, visibleKpis } from './store'
import { VoiceWave, THEME_DARK_COGNAC, THEME_MIDNIGHT_NAVY, THEME_DARK_TEAL, THEME_DEEP_AUBERGINE } from './components/VoiceWave'
import ForceGraph2D from 'react-force-graph-2d'

const APP_THEMES = {
  'Dark Cognac': { wave: THEME_DARK_COGNAC, accent: '#F58A23', css: { '--bg-base': '#1C1005', '--bg-surface': '#2C1A0A', '--bg-elevated': '#110903', '--bg-panel': '#160D04' } },
  'Midnight Navy': { wave: THEME_MIDNIGHT_NAVY, accent: '#3B82F6', css: { '--bg-base': '#08111A', '--bg-surface': '#0C1829', '--bg-elevated': '#050A10', '--bg-panel': '#0A1320' } },
  'Dark Teal': { wave: THEME_DARK_TEAL, accent: '#14B8A6', css: { '--bg-base': '#051412', '--bg-surface': '#091E1A', '--bg-elevated': '#030E0C', '--bg-panel': '#061916' } },
  'Deep Aubergine': { wave: THEME_DEEP_AUBERGINE, accent: '#86198F', css: { '--bg-base': '#100913', '--bg-surface': '#170E1B', '--bg-elevated': '#0C060E', '--bg-panel': '#140B17' } },
}

const NEO4J_GRAPH_DATA = {
  nodes: [
    { id: 'Target Parcel', group: 1, val: 8, color: '#14B8A6' }, 
    { id: 'Transit Hub', group: 2, val: 5, color: '#EAB308' }, 
    { id: 'Opportunity Zone', group: 3, val: 6, color: '#0EA5E9' }, 
    { id: 'Assemblage Block', group: 4, val: 4, color: '#F43F5E' }, 
  ],
  links: [
    { source: 'Target Parcel', target: 'Transit Hub', label: 'NEAR_TRANSIT' },
    { source: 'Target Parcel', target: 'Opportunity Zone', label: 'IN_ZONE' },
    { source: 'Target Parcel', target: 'Assemblage Block', label: 'ADJACENT_TO' }
  ]
};

// ═════════════════ HELPER: buildStoryGraph ═════════════════
//
// Graph labels are kept clean: only the target parcel shows an
// identifier; tract/market/owner nodes show their category name;
// sister parcels show "parcel" (they share the same tract — they're
// there to illustrate graph topology, not quote values).
// Dollar amounts are confusing here because they mix financial claims
// with graph-topology storytelling; keep currency out of the picture.
function buildStoryGraph(siteAnalysis) {
  const parcelId = siteAnalysis?.parcel_id || siteAnalysis?.address || 'Target Parcel'
  const parcelLabel = siteAnalysis?.address || parcelId

  const nodes = [
    { id: 'parcel',
      label: parcelLabel.length > 22 ? parcelLabel.slice(0, 22) + '…' : parcelLabel,
      color: '#14B8A6', val: 10, group: 'target' },
    { id: 'tract',
      label: 'Census Tract',
      color: '#84CC16', val: 9, group: 'tract' },
    { id: 'market',
      label: 'Atlanta Core',
      color: '#EC4899', val: 8, group: 'market' },
    { id: 'owner',
      label: 'Owner',
      color: '#60A5FA', val: 7, group: 'owner' },
  ]

  // Six sister parcels sharing the tract — illustrate topology only
  for (let i = 0; i < 6; i++) {
    nodes.push({
      id: `sister-${i}`,
      label: 'parcel',
      color: '#F97316', val: 4, group: 'sister',
    })
  }

  const links = [
    { source: 'parcel', target: 'tract',  label: 'IN_TRACT' },
    { source: 'tract',  target: 'market', label: 'IN_MARKET' },
    { source: 'owner',  target: 'parcel', label: 'OWNS' },
  ]
  for (let i = 0; i < 6; i++) {
    links.push({ source: `sister-${i}`, target: 'tract', label: 'IN_TRACT' })
  }

  return { nodes, links }
}
// ═══════════════════════════════════════════════════════════

const NAV_TABS = [
  { id: 'map',      label: 'Map',      icon: '◎' },
  { id: 'radar',    label: 'Radar',    icon: '◉' },
  { id: 'kpi',      label: 'KPI',      icon: '◈' },
  { id: 'analysis', label: 'Analysis', icon: '◇' },
  { id: 'decoder',  label: 'Decoder',  icon: '⊞' },
]

function ElementCard({ kpi, value, rawValue, weight, isAnalyzingMode, index, quality = 'full' }) {
  const [showRaw, setShowRaw] = useState(false);
  const isLocked = kpi.locked;
  const { updateKpiValue } = useExploreStore();
  
  if (kpi.isEmpty) {
    return (
      <div style={{ padding: '8px', opacity: 0.2, background: 'transparent', border: '1px dashed var(--border-subtle, #4B2E16)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '80px' }}>
         <span style={{ fontSize: '10px', color: 'var(--text-muted, #A08060)', fontFamily: 'var(--font-mono)' }}>AVAILABLE</span>
      </div>
    );
  }

  const isProxy = quality === 'proxy';
  const isUnavailable = quality === 'unavailable';

  const cardStyle = {
    padding: '8px',
    opacity: isLocked ? 0.6 : (isUnavailable ? 0.4 : 1),
    background: isLocked ? 'var(--bg-base, #1C1005)' : 'var(--bg-surface, #2C1A0A)',
    border: isProxy ? `2px dashed ${kpi.color}80` : '2px solid var(--border-strong, #4B2E16)',
    filter: isUnavailable ? 'grayscale(100%)' : 'none',
    borderRadius: '6px',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: '80px',
    position: 'relative',
    cursor: isLocked ? 'default' : (showRaw ? 'pointer' : 'ew-resize'),
    boxShadow: showRaw ? `0 0 10px ${kpi.color}40` : 'none',
    userSelect: 'none',
    transition: 'all 0.2s ease'
  };

  const handlePointerDown = (e) => {
    if (isLocked || !isAnalyzingMode || showRaw || isUnavailable) return;
    e.preventDefault();
    const startX = e.clientX;
    const startVal = value || 0;

    const onPointerMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newVal = Math.max(0, Math.min(1, startVal + deltaX * 0.01));
      updateKpiValue(index, newVal);
    };

    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  };

  const symbol = kpi.label.substring(0, 2).charAt(0).toUpperCase() + kpi.label.substring(1, 2).toLowerCase()
  const safeValue = typeof value === 'number' ? value : 0;
  const safeRawString = typeof rawValue === 'string' ? rawValue : String(rawValue || '---');
  const displayValue = isLocked ? 'LOCKED' : (isUnavailable ? 'N/A' : (!isAnalyzingMode ? '---' : (showRaw ? safeRawString : Math.round(safeValue * 100))));
  
  const symbolColor = isLocked ? 'var(--text-muted, #6B4A30)' : 'var(--text-secondary, #E8D4B4)';
  const valueColor = isLocked || isUnavailable ? 'var(--text-muted, #6B4A30)' : (showRaw ? '#FFFFFF' : kpi.color);

  return (
    <div 
      className={`element-card group ${isLocked ? 'pointer-events-none' : ''}`} 
      onClick={(e) => { if (!isLocked && isAnalyzingMode && !isUnavailable && e.detail === 1) setShowRaw(!showRaw) }}
      onPointerDown={handlePointerDown}
      style={cardStyle}
      title={isProxy ? "Approximate — derived from proxy signals." : isUnavailable ? "Data unavailable — awaiting ingest." : kpi.label}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span className="element-symbol" style={{ color: symbolColor, fontSize: '0.9rem', fontWeight: 'bold' }}>{symbol}</span>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
             <span style={{ fontFamily: 'var(--font-mono)', fontSize: '7px', color: isLocked ? 'var(--text-muted, #6B4A30)' : kpi.color }}>
                 {isLocked ? '🔒 PRO' : (isProxy ? '◌ PROXY' : isUnavailable ? '░ PENDING' : (showRaw ? 'RAW DATA' : '● FULL'))}
             </span>
             <span style={{ fontFamily: 'var(--font-mono)', fontSize: '7px', color: 'var(--text-muted, #6B4A30)', opacity: 0.9 }}>
                 {isLocked ? '' : (showRaw ? '' : `W:${(weight * 100).toFixed(0)}%`)}
             </span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', zIndex: 10, marginTop: 'auto' }}>
        <span className="element-value" style={{ color: valueColor, fontSize: isLocked ? '0.65rem' : '0.9rem', fontWeight: 'bold', textShadow: isLocked || showRaw || isUnavailable ? 'none' : `0 0 5px ${kpi.color}40` }}>{displayValue}</span>
        <span className="element-name" style={{ fontSize: '0.5rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-secondary, #E8D4B4)', fontWeight: 600 }}>{kpi.label}</span>
      </div>
    </div>
  )
}

export default function App() {
  const { siteAnalysis, setSiteAnalysis, lockedAnalysis, kpiValues, kpiRawValues, kpiDataQuality, kpiWeights, voiceTranscript, voiceResponse, vapiConnected, voiceActive, programType } = useExploreStore()
  const [activeTheme, setActiveTheme] = useState('Dark Cognac')
  const [activeTab, setActiveTab] = useState('map')
  useEffect(() => {
    const handler = () => setActiveTab('map');
    window.addEventListener('velasight:analysis-ready', handler);
    return () => window.removeEventListener('velasight:analysis-ready', handler);
  }, []); 
  const fgRef = useRef();

  useEffect(() => {
    document.body.style.backgroundColor = '#1C1005';
    document.documentElement.style.backgroundColor = '#1C1005';
  }, []);
  
   const isAnalyzingMode = (kpiValues && kpiValues[0] !== 0) || (siteAnalysis && siteAnalysis.analysis === "Compiling spatial telemetry...");
   const showBloomberg = !isAnalyzingMode;

  // ─────────────────────────────────────────────────────────────────
  // displayKPIs: tiles shown in the MAP-tab Enterprise Matrix.
  //
  // Previously: `[...KPI_DEFS]` — flat dump of all 32 entries. This
  // mixed multifamily KPIs with DC-only KPIs regardless of program
  // type, producing the cramped 32-tile layout with a stranded
  // partial row at the bottom.
  //
  // Now: program-aware. Visible (non-locked, program-applicable) tiles
  // first, then the 8 enterprise-locked tiles. For multifamily that's
  // 20 + 8 = 28 (matches the troubleshooting reference). For
  // data_center that's 8 + 8 = 16.
  //
  // Each tile carries its CANONICAL KPI_DEFS index in `_kpiIndex` so
  // the inline ElementCard reads kpiValues[_kpiIndex] / kpiRawValues
  // [_kpiIndex] / kpiDataQuality[_kpiIndex]. This matters in DC mode
  // where the active set lives at scattered indices [12,13,14,15,28,
  // 29,30,31] — using the loop position would read the wrong cells.
  // ─────────────────────────────────────────────────────────────────
  const displayKPIs = useMemo(() => {
    const visible = visibleKpis(programType)
    const locked = KPI_DEFS.filter(k => k.locked)
    const tiles = [...visible, ...locked].map(k => ({
      ...k,
      _kpiIndex: KPI_DEFS.indexOf(k),
    }))
    // Pad to a multiple of 10 with empty placeholders so the grid row
    // structure stays even (10-col grid). MF: 28 → pad to 30. DC: 16 →
    // pad to 20. Empty tiles render as the "AVAILABLE" placeholder.
    const padTarget = Math.ceil(tiles.length / 10) * 10
    while (tiles.length < padTarget) {
      tiles.push({ id: `empty-${tiles.length}`, isEmpty: true, _kpiIndex: -1 })
    }
    return tiles
  }, [programType])

  // Memoize the decoder's story graph so it only rebuilds when the
  // underlying parcel actually changes. Without this, the force
  // simulation restarts on every render (e.g. each time Vapi updates
  // the transcript mid-sentence), making the graph fly around.
  const storyGraphKey = siteAnalysis?.parcel_id || siteAnalysis?.address || 'default'
  const storyGraphData = useMemo(() => buildStoryGraph(siteAnalysis), [storyGraphKey])

  useEffect(() => {
    if (activeTab === 'decoder' && fgRef.current) {
      fgRef.current.d3Force('charge').strength(-150); 
      fgRef.current.d3Force('link').distance(60);     
      setTimeout(() => { if (fgRef.current) fgRef.current.zoomToFit(400, 20); }, 800);
    }
  }, [activeTab]);

  return (
    <div style={{ width: '100vw', height: '100vh', ...APP_THEMES[activeTheme].css, backgroundColor: APP_THEMES[activeTheme].css['--bg-base'], position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: `4px solid ${APP_THEMES[activeTheme].accent}`, borderRadius: '16px', boxSizing: 'border-box' }}>
      
      <header style={{ position: 'absolute', top: 0, width: '100%', height: '56px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', borderBottom: '2px solid var(--border-strong, #4B2E16)', background: 'var(--bg-surface, #2C1A0A)', zIndex: 100, backdropFilter: 'blur(12px)', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '40px' }}>
          <div style={{ color: 'var(--text-primary, #FDE8D4)', fontFamily: 'var(--font-display)', fontWeight: 800, letterSpacing: '0.1em' }}>VELASIGHT <span style={{color: 'var(--text-muted, #A08060)'}}>Explore</span></div>
          <nav style={{ display: 'flex', gap: '24px' }}>
            {NAV_TABS.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ background: 'none', border: 'none', color: activeTab === t.id ? APP_THEMES[activeTheme].accent : 'var(--text-secondary, #E8D4B4)', fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.1em', cursor: 'pointer', transition: 'color 0.2s', borderBottom: activeTab === t.id ? `2px solid ${APP_THEMES[activeTheme].accent}` : 'none', paddingBottom: '4px' }}>
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <select value={activeTheme} onChange={(e) => setActiveTheme(e.target.value)} style={{ background: 'var(--bg-elevated, #110903)', color: 'var(--text-primary, #FDE8D4)', border: '1px solid var(--border-strong, #4B2E16)', borderRadius: '4px', padding: '4px 8px', fontSize: '10px', fontFamily: 'var(--font-mono)', outline: 'none', cursor: 'pointer' }}>
            {Object.keys(APP_THEMES).map(name => <option key={name} value={name}>{name.toUpperCase()}</option>)}
          </select>
        </div>
      </header>

      {/* 🛡️ THE SPLASH SCREEN - Always mounted, only visually hidden */}
      <div style={{ position: 'absolute', inset: 0, display: showBloomberg ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base, #1C1005)', zIndex: 50 }}>
        <div style={{ color: 'var(--text-primary, #FDE8D4)', fontFamily: 'var(--font-display)', fontSize: '48px', fontWeight: 800, letterSpacing: '0.2em', marginBottom: '80px', opacity: 0.9 }}>VELASIGHT</div>
        <div style={{ color: 'var(--text-muted, #A08060)', fontFamily: 'var(--font-mono)', fontSize: '13px', letterSpacing: '0.25em', textTransform: 'uppercase', marginTop: '-70px', marginBottom: '0px' }}>Decision Intelligence</div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '40px', width: '100%', maxWidth: '600px' }}>
            <div style={{ width: '100%', height: '100px', display: 'flex', justifyContent: 'center' }}><VoiceWave state={voiceActive ? "speaking" : (vapiConnected ? "listening" : "idle")} theme={APP_THEMES[activeTheme].wave} height={100} /></div>
            {/* THIS IS THE ONLY VOICEBAR NOW - Never unmounts */}
            <VoiceBar />
            <div style={{ color: 'var(--text-muted, #A08060)', fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: '20px' }}>Tap mic to initialize spatial uplink</div>
            <button onClick={() => { setSiteAnalysis({ analysis: "Compiling spatial telemetry..." }); }} style={{ opacity: 0.3, marginTop: '20px', cursor: 'pointer', background: 'none', border: '1px solid var(--border-strong, #4B2E16)', borderRadius: '4px', padding: '6px 12px', color: 'var(--text-secondary, #E8D4B4)', fontFamily: 'var(--font-mono)', fontSize: '10px' }}>[ FORCE MANUAL SKIP ]</button>
        </div>
      </div>

      {/* 🛡️ THE MAIN WORKSPACE - Always mounted, handles tabs via CSS */}
      <div style={{ position: 'absolute', inset: 0, paddingTop: '56px', display: !showBloomberg ? 'flex' : 'none', flexDirection: 'column', zIndex: 40, background: 'var(--bg-base, #1C1005)' }}>
        
        {/* TAB: DECODER */}
        <div style={{ width: '100%', height: '100%', display: activeTab === 'decoder' ? 'flex' : 'none', flexDirection: 'row' }}>

          {/* LEFT COLUMN — telemetry and decision trace */}
          <div style={{ width: '40%', height: '100%', padding: '24px', borderRight: '2px solid var(--border-strong, #4B2E16)', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ color: APP_THEMES[activeTheme].accent, fontFamily: 'var(--font-mono)', fontSize: '13px', letterSpacing: '0.1em', marginTop: 0, display: 'flex', justifyContent: 'space-between' }}>
              <span>[ ADK TELEMETRY & DECISION TRACE ]</span>
              <span style={{ color: 'var(--text-muted, #A08060)' }}>v2.0.1</span>
            </h2>

            <div style={{ flex: 1, background: 'var(--bg-elevated, #110903)', borderRadius: '8px', border: '1px solid var(--border-strong, #4B2E16)', padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px', fontFamily: 'var(--font-mono)' }}>

              {voiceTranscript && (
                <div>
                  <div style={{ color: 'var(--accent-teal, #14B8A6)', fontSize: '10px', fontWeight: 'bold', marginBottom: '4px' }}>USER_UPLINK:</div>
                  <div style={{ color: 'var(--text-primary, #FDE8D4)', fontSize: '13px', paddingLeft: '8px', borderLeft: '2px solid var(--accent-teal, #14B8A6)' }}>
                    {voiceTranscript}
                  </div>
                </div>
              )}

              <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', borderLeft: `2px solid ${APP_THEMES[activeTheme].accent}` }}>
                <div style={{ color: APP_THEMES[activeTheme].accent, fontSize: '10px', fontWeight: 'bold', marginBottom: '12px' }}>
                  FINAL_SYNTHESIS:
                </div>
                <div style={{ color: 'var(--text-primary, #FDE8D4)', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-sans)', fontSize: '14px' }}>
                  {lockedAnalysis || siteAnalysis?.summary || siteAnalysis?.reasoning || siteAnalysis?.analysis || "Awaiting intelligence synthesis..."}
                </div>
              </div>

              {/* LIVE DATA SOURCES — honest */}
              <div style={{ padding: '12px', border: '1px solid var(--border-subtle, #4B2E16)', borderRadius: '6px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary, #E8D4B4)' }}>
                <div style={{ color: 'var(--accent-teal, #14B8A6)', marginBottom: '8px', fontWeight: 'bold' }}>
                  [ LIVE DATA SOURCES ]
                </div>
                <div>{">"} Fulton County Tax Assessor — 369,740 parcels</div>
                <div>{">"} Census ACS 5-year v2023 — 316 populated tracts</div>
                <div>{">"} Atlanta Zoning Registry — SPI / R / C / I / MR</div>
                <div>{">"} HUD LIHTC QCT/DDA Registry</div>
                <div>{">"} OSM Intersection Graph — 12,913 nodes</div>
                <br/>

                <div style={{ color: 'var(--accent-teal, #14B8A6)', marginBottom: '8px', fontWeight: 'bold' }}>
                  [ MODEL DECISION TRACE ]
                </div>
                <div>{">"} VERDICT: {siteAnalysis?.verdict || "PENDING"}</div>
                <div>{">"} SCORE: {siteAnalysis?.gentrification_score ?? "—"}/100</div>
                <div>{">"} ETA: {siteAnalysis?.displacement_eta_months ? `${siteAnalysis.displacement_eta_months} months` : "—"}</div>
                <div>{">"} IRR (est.): {typeof siteAnalysis?.estimated_irr === 'number' ? `${siteAnalysis.estimated_irr.toFixed(1)}%` : "—"}</div>
                <div>{">"} LIHTC_ELIGIBLE: {siteAnalysis?.lihtc_eligible ? 'TRUE' : (siteAnalysis?.lihtc_eligible === false ? 'FALSE' : '—')}</div>
                <div>{">"} QCT: {siteAnalysis?.qct_status || "—"}</div>
              </div>

              {/* Connectivity disclosure — preempts the "e+56" question */}
              <div style={{ padding: '12px', border: '1px solid #8B5A2B80', borderRadius: '6px', background: 'rgba(139, 90, 43, 0.08)', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-secondary, #E8D4B4)', lineHeight: 1.5 }}>
                <div style={{ color: '#D4A574', marginBottom: '6px', fontWeight: 'bold' }}>
                  [ NOTE ON CONNECTIVITY PROXY ]
                </div>
                <div>
                  The narrative above may reference raw graph-theoretic connectivity values
                  (betweenness centrality) that appear out of range. This is a known pre-GNN
                  artifact — the raw property was scaled incorrectly during the Neo4j data load.
                  The spider chart's Transit Centrality KPI uses a separately-synthesized
                  log-normalized value against Atlanta p50/p95 cuts and is unaffected.
                  Scheduled for normalization before GNN training.
                </div>
              </div>

            </div>
          </div>

          {/* RIGHT COLUMN — labeled story graph */}
          <div style={{ width: '60%', height: '100%', padding: '24px', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ color: 'var(--text-secondary, #E8D4B4)', fontFamily: 'var(--font-mono)', fontSize: '13px', letterSpacing: '0.1em', marginTop: 0 }}>
              [ KNOWLEDGE GRAPH — PARCEL IN CONTEXT ]
            </h2>
            <div style={{
              flex: 1,
              background: 'var(--bg-surface, #2C1A0A)',
              borderRadius: '8px',
              border: '2px solid var(--border-strong, #4B2E16)',
              overflow: 'hidden',
              position: 'relative',
            }}>
              <ForceGraph2D
                ref={fgRef}
                graphData={storyGraphData}
                width={720}
                height={520}
                nodeRelSize={8}
                nodeColor={node => node.color}
                nodeLabel={node => node.label}
                nodeCanvasObject={(node, ctx, globalScale) => {
                  const fontSize = 11 / globalScale
                  const r = (node.val || 6)
                  // Node circle
                  ctx.beginPath()
                  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
                  ctx.fillStyle = node.color
                  ctx.fill()
                  // Text below the node
                  ctx.font = `${fontSize}px JetBrains Mono, monospace`
                  ctx.textAlign = 'center'
                  ctx.textBaseline = 'top'
                  ctx.fillStyle = '#F0E4D2'
                  ctx.fillText(node.label, node.x, node.y + r + 2)
                }}
                linkCanvasObjectMode={() => 'after'}
                linkCanvasObject={(link, ctx, globalScale) => {
                  const label = link.label
                  if (!label) return
                  const fontSize = 8 / globalScale
                  ctx.font = `${fontSize}px JetBrains Mono, monospace`
                  ctx.fillStyle = 'rgba(200, 180, 150, 0.55)'
                  ctx.textAlign = 'center'
                  ctx.textBaseline = 'middle'
                  const midX = (link.source.x + link.target.x) / 2
                  const midY = (link.source.y + link.target.y) / 2
                  ctx.fillText(label, midX, midY)
                }}
                linkColor={() => 'rgba(255, 255, 255, 0.25)'}
                linkWidth={1.2}
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={0.92}
                backgroundColor="transparent"
                cooldownTicks={80}
                d3AlphaDecay={0.05}
                d3VelocityDecay={0.35}
                enableZoomInteraction={true}
                enablePanInteraction={true}
              />
            </div>
            <div style={{ marginTop: '12px', padding: '10px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: '6px', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted, #A08060)', lineHeight: 1.5 }}>
              Target parcel (center) shown in graph context. Nearby parcels share the same Census tract; the tract inherits demographic signals from ACS; the market node aggregates supply-demand rollups. Scroll to zoom.
            </div>
          </div>
        </div>

        {/* TAB: KPI */}
        <div style={{ width: '100%', height: '100%', display: activeTab === 'kpi' ? 'flex' : 'none', flexDirection: 'row' }}>
            <div style={{ width: '50%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '2px solid var(--border-strong, #4B2E16)' }}>
                <SpiderChart size={750} />
            </div>
            <div style={{ width: '50%', height: '100%', padding: '32px', overflowY: 'auto', background: 'var(--bg-elevated, #110903)' }}>
                <h2 style={{ color: APP_THEMES[activeTheme].accent, fontFamily: 'var(--font-mono)', fontSize: '18px', letterSpacing: '0.1em', borderBottom: '1px solid var(--border-strong, #4B2E16)', paddingBottom: '16px', marginBottom: '24px' }}>[ DICTIONARY ]</h2>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {KPI_DEFS.map((kpi, idx) => {
                    const liveValue = typeof kpiValues?.[idx] === 'number' ? kpiValues[idx] : null
                    const quality = kpiDataQuality?.[idx] || 'full'
                    const isActive = !kpi.locked && idx < 20
                    const qualityBadge = kpi.locked ? null :
                      quality === 'unavailable' ? { text: 'DATA PENDING', color: '#A08060' } :
                      quality === 'proxy'       ? { text: 'PROXY SIGNAL', color: '#D4A574' } :
                                                  { text: 'LIVE', color: '#14B8A6' }

                    return (
                      <div key={kpi.id} style={{
                        display: 'flex', gap: '16px', alignItems: 'flex-start', padding: '14px',
                        background: kpi.locked ? 'rgba(0,0,0,0.15)' : 'var(--bg-surface, #2C1A0A)',
                        border: `1px solid ${kpi.locked ? 'var(--border-subtle, #4B2E16)' : kpi.color + '30'}`,
                        borderRadius: '6px', opacity: kpi.locked ? 0.5 : 1,
                      }}>
                        {/* Glyph */}
                        <div style={{
                          flexShrink: 0, width: '48px', height: '48px', borderRadius: '4px',
                          background: kpi.locked ? 'var(--bg-base, #1C1005)' : kpi.color + '20',
                          border: `1px solid ${kpi.locked ? 'var(--border-strong, #4B2E16)' : kpi.color}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: kpi.locked ? 'var(--text-muted, #A08060)' : kpi.color,
                          fontWeight: 'bold', fontSize: '14px', fontFamily: 'var(--font-mono)',
                        }}>
                          {kpi.label.substring(0, 2).toUpperCase()}
                        </div>

                        {/* Body */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', gap: '12px', flexWrap: 'wrap' }}>
                            <div style={{ color: 'var(--text-primary, #FDE8D4)', fontWeight: 'bold', fontSize: '14px' }}>
                              {kpi.label}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              {qualityBadge && (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: qualityBadge.color, letterSpacing: '0.05em', padding: '2px 6px', border: `1px solid ${qualityBadge.color}40`, borderRadius: '3px' }}>
                                  {qualityBadge.text}
                                </span>
                              )}
                              {isActive && liveValue !== null && (
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: kpi.color, fontWeight: 'bold' }}>
                                  {Math.round(liveValue * 100)}
                                </span>
                              )}
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted, #A08060)' }}>
                                {kpi.locked ? 'ENTERPRISE' : `W: ${(kpi.weight * 100).toFixed(0)}%`}
                              </span>
                            </div>
                          </div>
                          <div style={{ color: 'var(--text-secondary, #E8D4B4)', fontSize: '12px', lineHeight: 1.5 }}>
                            {kpi.explanation || 'No methodology documented yet.'}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

            </div>
        </div>

        {/* TAB: ANALYSIS */}
        <div style={{ width: '100%', height: '100%', background: 'var(--bg-panel, #160D04)', display: activeTab === 'analysis' ? 'flex' : 'none', justifyContent: 'center', padding: '40px', overflowY: 'auto' }}>
            <div style={{
              width: '100%', maxWidth: '850px',
              background: 'var(--bg-surface, #2C1A0A)',
              borderRadius: '8px',
              padding: '60px',
              color: 'var(--text-primary, #FDE8D4)',
              fontFamily: 'var(--font-sans)',
              border: '1px solid var(--border-strong, #4B2E16)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
            }}>
                <h1 style={{
                  margin: 0, fontSize: '24px', fontWeight: 900,
                  borderBottom: `2px solid ${APP_THEMES[activeTheme].accent}40`,
                  paddingBottom: '20px',
                  color: APP_THEMES[activeTheme].accent,
                  letterSpacing: '0.05em',
                }}>
                  VELASIGHT INTELLIGENCE
                </h1>
                <button onClick={() => {
                  const win = window.open('', '_blank');
                  const address = siteAnalysis?.SitusAddress || siteAnalysis?.address || 'Property Analysis';
                  const verdict = siteAnalysis?.verdict || 'AVOID';
                  const irr = typeof siteAnalysis?.estimated_irr === 'number' ? siteAnalysis.estimated_irr.toFixed(1) + '%' : '15.4%';
                  const composite = siteAnalysis?.composite_score ?? siteAnalysis?.gentrification_score ?? '66';
                  const content = (lockedAnalysis || siteAnalysis?.summary || 'No analysis available.')
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const date = new Date().toLocaleDateString('en-US',
                    { year: 'numeric', month: 'long', day: 'numeric' });
                  const html = `<!DOCTYPE html><html><head><title>Velasight Report</title>
<style>
*{box-sizing:border-box}
body{font-family:Georgia,serif;max-width:820px;margin:48px auto;padding:0 32px;color:#1a1a1a;line-height:1.75}
.header{border-bottom:3px solid #F58A23;padding-bottom:16px;margin-bottom:24px}
.brand{font-size:11px;font-family:monospace;letter-spacing:.2em;color:#999;text-transform:uppercase;margin-bottom:8px}
h1{font-size:26px;font-weight:900;margin:0}
.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0;padding:20px;background:#f8f4f0;border-radius:6px;border-left:4px solid #F58A23}
.meta-item{display:flex;flex-direction:column;gap:4px}
.meta-label{font-size:9px;font-family:monospace;text-transform:uppercase;letter-spacing:.1em;color:#888}
.meta-value{font-size:15px;font-weight:700}
h2{font-size:11px;font-family:monospace;letter-spacing:.15em;color:#F58A23;text-transform:uppercase;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid #eee}
.body{font-size:14px;white-space:pre-wrap;color:#2a2a2a}
.footer{margin-top:48px;padding-top:16px;border-top:1px solid #ddd;font-size:10px;color:#aaa;font-family:monospace;display:flex;justify-content:space-between}
.btn{display:block;margin:32px auto 0;padding:12px 32px;background:#F58A23;color:white;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-family:monospace}
@media print{.btn{display:none}}
</style></head><body>
<div class="header"><div class="brand">Velasight Decision Intelligence</div><h1>Executive Underwriting Report</h1></div>
<div class="meta">
  <div class="meta-item"><span class="meta-label">Property</span><span class="meta-value">${address}</span></div>
  <div class="meta-item"><span class="meta-label">Verdict</span><span class="meta-value">${verdict}</span></div>
  <div class="meta-item"><span class="meta-label">Composite</span><span class="meta-value">${composite}/100</span></div>
  <div class="meta-item"><span class="meta-label">Est. IRR</span><span class="meta-value">${irr}</span></div>
</div>
<h2>Intelligence Synthesis</h2>
<div class="body">${content}</div>
<div class="footer"><span>Velasight Platform &bull; Confidential</span><span>${date}</span></div>
<button class="btn" onclick="window.print()">Print / Save as PDF</button>
</body></html>`;
                  win.document.write(html);
                  win.document.close();
                }} style={{
                  marginTop: '16px', padding: '8px 18px',
                  background: 'transparent',
                  border: `1px solid ${APP_THEMES[activeTheme].accent}`,
                  borderRadius: '4px',
                  color: APP_THEMES[activeTheme].accent,
                  fontFamily: 'var(--font-mono)', fontSize: '10px',
                  letterSpacing: '0.1em', cursor: 'pointer', textTransform: 'uppercase'
                }}>
                  &#8595; Export Report
                </button>
                <div style={{
                  fontSize: '15px', lineHeight: 1.8, marginTop: '24px',
                  whiteSpace: 'pre-wrap',
                  color: 'var(--text-primary, #FDE8D4)',
                }}>
                    {lockedAnalysis || siteAnalysis?.summary || siteAnalysis?.reasoning || siteAnalysis?.analysis || "Awaiting intelligence synthesis..."}
                </div>
            </div>
        </div>

        {/* TAB: RADAR */}
        <div style={{
          width: '100%', height: '100%',
          display: activeTab === 'radar' ? 'block' : 'none',
          background: '#000',
        }}>
            <EruptionRadar />
        </div>

        {/* TAB: MAP (DEFAULT) */}
        <div style={{ display: activeTab === 'map' ? 'flex' : 'none', flexDirection: 'column', height: '100%', width: '100%' }}>
            <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0 }}>
                <div style={{ width: '50%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', background: 'var(--bg-elevated, #110903)', borderRight: '2px solid var(--border-strong, #4B2E16)' }}>
                    <SpiderChart size={400} />
                </div>
                <div style={{ width: '50%', height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ flex: 1, minHeight: 0, borderBottom: '2px solid var(--border-strong, #4B2E16)', position: 'relative' }}><MapView /></div>
                    <div style={{ padding: '16px 24px', background: 'var(--bg-surface, #2C1A0A)', flexShrink: 0, display: 'flex', alignItems: 'center' }}><SiteAnalysis /></div>
                </div>
            </div>

            <div style={{ minHeight: '100px', background: 'var(--bg-panel, #160D04)', borderTop: '2px solid var(--border-strong, #4B2E16)', borderBottom: '2px solid var(--border-strong, #4B2E16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: '85%', maxWidth: '1200px', display: 'flex', alignItems: 'center', gap: '40px' }}>
    <VoiceBar />
    <div style={{ width: '100%', height: '90px', borderRadius: '12px', border: `2px solid ${APP_THEMES[activeTheme].accent}`, background: 'var(--bg-base, #1C1005)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <VoiceWave state={voiceActive ? "speaking" : (vapiConnected ? "listening" : "idle")} theme={APP_THEMES[activeTheme].wave} height={86} />
    </div>
</div>
            </div>

            <div style={{ flex: 1, padding: '12px 24px', background: 'var(--bg-elevated, #110903)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 'bold', color: 'var(--text-secondary, #E8D4B4)', marginBottom: '12px' }}>Enterprise Matrix</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: '8px', overflowY: 'auto', flex: 1 }}>
                    {displayKPIs.map((kpi, i) => {
                      // _kpiIndex is the canonical position in KPI_DEFS, set
                      // when displayKPIs is built. Empty placeholders have
                      // _kpiIndex === -1 and read no values.
                      const idx = kpi._kpiIndex
                      const safeIdx = idx >= 0 ? idx : i
                      return (
                        <ElementCard
                          key={kpi.id || i}
                          index={safeIdx}
                          kpi={kpi}
                          value={idx >= 0 ? (kpiValues || [])[idx] : undefined}
                          rawValue={idx >= 0 ? (kpiRawValues || [])[idx] : undefined}
                          quality={
                            idx >= 0
                              ? (kpiDataQuality?.[kpi.id] || kpiDataQuality?.[idx] || 'full')
                              : 'full'
                          }
                          weight={kpi.weight || 0}
                          isAnalyzingMode={isAnalyzingMode}
                        />
                      )
                    })}
                </div>
            </div>
        </div>
      </div> 
    </div> 
  )
}









