import { useExploreStore, KPI_DEFS, ZONE_PRESETS } from '../store'

// Score gauge SVG
function ScoreGauge({ score }) {
  const circumference = 2 * Math.PI * 40
  const pct = score / 100
  const offset = circumference * (1 - pct * 0.75) // 270° arc
  const color = score > 75 ? '#F87171' : score > 50 ? '#F59E0B' : '#14B8A6'
  const label = score > 75 ? 'HIGH RISK' : score > 50 ? 'MODERATE' : 'LOW RISK'

  return (
    <div style={{ position: 'relative', width: 100, height: 100, flexShrink: 0 }}>
      <svg width="100" height="100" viewBox="0 0 100 100">
        {/* Track */}
        <circle cx="50" cy="50" r="40" fill="none"
          stroke="rgba(255,255,255,0.06)" strokeWidth="7"
          strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
          strokeDashoffset={circumference * 0.125}
          strokeLinecap="round"
          transform="rotate(135 50 50)"
        />
        {/* Progress */}
        <circle cx="50" cy="50" r="40" fill="none"
          stroke={color} strokeWidth="7"
          strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
          strokeDashoffset={offset + circumference * 0.125}
          strokeLinecap="round"
          transform="rotate(135 50 50)"
          style={{ transition: 'stroke-dashoffset 0.8s ease-out, stroke 0.4s' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center'
      }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 700, color: '#F0F4FF' }}>
          {score}
        </span>
        <span style={{ fontSize: 9, color, fontWeight: 600, letterSpacing: '0.05em' }}>
          {label}
        </span>
      </div>
    </div>
  )
}

function ZonePresetBtn({ zone, label }) {
  const { activeZone, setActiveZone } = useExploreStore()
  const isActive = activeZone === zone
  return (
    <button
      onClick={() => setActiveZone(zone)}
      style={{
        flex: 1, padding: '6px 0',
        background: isActive ? 'var(--bg-hover)' : 'transparent',
        border: `1px solid ${isActive ? 'var(--border-strong)' : 'var(--border-subtle)'}`,
        borderRadius: 4, cursor: 'pointer',
        color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
        fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase',
        transition: 'all 0.2s'
      }}
    >
      {label}
    </button>
  )
}

// The new Glassmorphic Element Card
function ElementCard({ kpi, value, weight, onChange }) {
  // Generate a 2-3 letter symbol from the label (e.g. "Transit centrality" -> "Tr")
  const symbol = kpi.label.substring(0, 2).charAt(0).toUpperCase() + kpi.label.substring(1, 2).toLowerCase()
  
  return (
    <div className="element-card group">
      {/* Top: Symbol and Weight */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span className="element-symbol">{symbol}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: kpi.color, opacity: 0.8 }}>
          W:{(weight * 100).toFixed(0)}%
        </span>
      </div>

      {/* Bottom: Name and Value */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', zIndex: 10 }}>
        <span className="element-value" style={{ color: kpi.color }}>
          {Math.round(value * 100)}
        </span>
        <span className="element-name" title={kpi.label}>
          {kpi.label.length > 14 ? kpi.label.substring(0, 12) + '...' : kpi.label}
        </span>
      </div>

      {/* The Invisible Slider overlay */}
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: 'ew-resize',
          zIndex: 20
        }}
        title={`Drag to adjust ${kpi.label}`}
      />
    </div>
  )
}

export default function KPIPanel() {
  const {
    kpiValues, updateKpiValue, kpiWeights, gentrificationScore
  } = useExploreStore()

  return (
    <div style={{
      width: '100%', height: '100%', overflowY: 'auto',
      padding: 20, background: 'var(--bg-surface)'
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 400, margin: '0 auto' }}>
        
        {/* Header Section */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <ScoreGauge score={gentrificationScore} />
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8
            }}>
              Monte Carlo Scenarios
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <ZonePresetBtn zone="opportunity" label="Base" />
              <ZonePresetBtn zone="displacement" label="Peak" />
              <ZonePresetBtn zone="stable" label="Stable" />
            </div>
          </div>
        </div>

        <div className="divider" />

        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--text-muted)'
        }}>
          Live Metric Matrix — Drag cards to model
        </div>

        {/* The New Periodic Table Grid */}
        <div className="periodic-grid">
          {KPI_DEFS.map((kpi, i) => (
            <ElementCard
              key={kpi.id}
              kpi={kpi}
              value={kpiValues[i]}
              weight={kpiWeights ? kpiWeights[i] : kpi.weight}
              onChange={(val) => updateKpiValue(i, val)}
            />
          ))}
        </div>

      </div>
    </div>
  )
}