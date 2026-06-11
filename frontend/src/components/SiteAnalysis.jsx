import { useEffect, useState } from 'react'
import { useExploreStore } from '../store'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

const VERDICT_CONFIG = {
  DEVELOP: { color: '#14B8A6', bg: 'rgba(20,184,166,0.1)', label: 'DEVELOP', icon: '▲' },
  CAUTION: { color: '#F59E0B', bg: 'rgba(245,158,11,0.1)', label: 'CAUTION', icon: '◆' },
  HOLD:    { color: '#38BDF8', bg: 'rgba(56,189,248,0.1)', label: 'HOLD',    icon: '■' },
  AVOID:   { color: '#F87171', bg: 'rgba(248,113,113,0.1)', label: 'AVOID',  icon: '▼' },
}

function displacementBand(risk) {
  if (risk == null) return { label: '—', color: '#A08060' }
  if (risk < 0.02) return { label: 'LOW',       color: '#14B8A6' }
  if (risk < 0.04) return { label: 'MODERATE',  color: '#F59E0B' }
  if (risk < 0.07) return { label: 'ELEVATED',  color: '#F97316' }
  return { label: 'HIGH', color: '#F87171' }
}

function formatRentPct(v) {
  if (v == null) return '—'
  const pct = (v * 100).toFixed(1)
  return v >= 0 ? `+${pct}%` : `${pct}%`
}

function rentColor(v) {
  if (v == null) return '#A08060'
  if (v > 0.03) return '#14B8A6'
  if (v > 0)    return '#38BDF8'
  return '#F59E0B'
}

export default function SiteAnalysis() {
  const { siteAnalysis, gentrificationScore, kpiValues } = useExploreStore()
  console.log('🔵 SiteAnalysis render', { siteAnalysis, tractGeoid: siteAnalysis?.tract_geoid })
  const [gnnPred, setGnnPred] = useState(null)
  const [gnnLoading, setGnnLoading] = useState(false)

  // Fetch GNN prediction when tract_geoid changes
  const tractGeoid = siteAnalysis?.tract_geoid
  useEffect(() => {
    if (!tractGeoid) {
      setGnnPred(null)
      return
    }
    setGnnLoading(true)
    fetch(`${API_BASE}/api/v1/predict/tract/${tractGeoid}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setGnnPred)
      .catch(() => setGnnPred(null))
      .finally(() => setGnnLoading(false))
  }, [tractGeoid])

  // Existing verdict logic — augment with GNN displacement if available
  const rawVerdict = siteAnalysis?.analysis || siteAnalysis?.verdict || 'CAUTION'
  const safeVerdictString = typeof rawVerdict === 'string' ? rawVerdict : 'CAUTION'
  let verdict = safeVerdictString.toUpperCase().includes('DEVELOP') ? 'DEVELOP'
              : safeVerdictString.toUpperCase().includes('HOLD')    ? 'HOLD'
              : safeVerdictString.toUpperCase().includes('AVOID')   ? 'AVOID'
              : 'CAUTION'

  // GNN override: if predicted displacement risk is HIGH and current verdict is DEVELOP, downgrade to CAUTION
  if (gnnPred?.displacement_risk != null && gnnPred.displacement_risk >= 0.07 && verdict === 'DEVELOP') {
    verdict = 'CAUTION'
  }

  const safeKpi = Array.isArray(kpiValues) ? kpiValues : new Array(28).fill(0)
  const dynamicIRR = (12.0 + ((safeKpi[2] || 0) * 8.0) - ((safeKpi[5] || 0) * 3.0)).toFixed(1)
  const baseScore = gentrificationScore !== '--' ? parseInt(gentrificationScore) : 50
  const dynamicScore = Math.min(100, Math.max(0, Math.round(baseScore + ((safeKpi[0] || 0) * 15) + ((safeKpi[3] || 0) * 15))))

  const dispBand = displacementBand(gnnPred?.displacement_risk)
  const fwdRent2br = gnnPred?.rent_growth_yoy_2025_2026?.bedroom_2br

  return (
    <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
      <VerdictBadge verdict={verdict} gnnBacked={gnnPred != null} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Chip label="Composite" value={`${dynamicScore}/100`} />
        <Chip label="Est. IRR" value={`${dynamicIRR}%`} />
        {gnnPred && (
          <>
            <Chip
              label="Displacement"
              value={`${(gnnPred.displacement_risk * 100).toFixed(1)}%`}
              accent={dispBand.color}
              badge={dispBand.label}
            />
            <Chip
              label="2BR Rent Δ FY26"
              value={formatRentPct(fwdRent2br)}
              accent={rentColor(fwdRent2br)}
            />
          </>
        )}
        {gnnLoading && (
          <div style={{ fontSize: 10, color: '#A08060', alignSelf: 'center', fontStyle: 'italic' }}>
            GNN…
          </div>
        )}
      </div>
    </div>
  )
}

function Chip({ label, value, accent, badge }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'rgba(255,255,255,0.03)',
      padding: '10px 16px', borderRadius: 6,
      border: `1px solid ${accent ? accent + '40' : 'var(--border-subtle, #4B2E16)'}`,
    }}>
      <div style={{
        fontSize: 10, color: 'var(--text-muted, #A08060)',
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>{label}:</div>
      <div style={{
        fontSize: 14, fontFamily: 'var(--font-mono)',
        color: accent || '#FFF', fontWeight: 'bold',
      }}>{value}</div>
      {badge && (
        <span style={{
          fontSize: 9, padding: '2px 6px',
          border: `1px solid ${accent}`, borderRadius: 3, color: accent,
          letterSpacing: '0.08em',
        }}>{badge}</span>
      )}
    </div>
  )
}

function VerdictBadge({ verdict, gnnBacked }) {
  const cfg = VERDICT_CONFIG[verdict] || VERDICT_CONFIG.CAUTION
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      background: cfg.bg, border: `1px solid ${cfg.color}40`,
      borderRadius: 6, padding: '10px 16px',
    }}>
      <span style={{ color: cfg.color, fontSize: 14 }}>{cfg.icon}</span>
      <span style={{
        fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700,
        letterSpacing: '0.05em', color: cfg.color,
      }}>{cfg.label}</span>
      {gnnBacked && (
        <span style={{
          fontSize: 9, color: cfg.color, opacity: 0.7,
          letterSpacing: '0.08em', marginLeft: 4,
        }}>GNN</span>
      )}
    </div>
  )
}