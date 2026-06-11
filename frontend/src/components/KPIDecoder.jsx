import { useState } from 'react'
import { KPI_DEFS } from '../store'

// Full 10 KPI × 3 zone interpretation matrix
// Each entry: what does THIS value mean in THIS zone context
const INTERPRETATIONS = {
  transit_centrality: {
    opportunity: {
      val: 82,
      text: 'Transit is the precondition. High betweenness centrality predicts income migration 18–24 months ahead of price adjustment. This is the earliest detectable signal — the appreciation front has not yet arrived but the infrastructure that carries it is already in place.'
    },
    displacement: {
      val: 45,
      text: 'Wave arrived via other mechanisms — proximity to job centers, amenity anchors. Transit present but not the dominant driver. The displacement pressure is coming from a different origin point than transit access.'
    },
    stable: {
      val: 70,
      text: 'Established transit, fully priced in. Strong neighborhood stability marker. No pending displacement wave — the transit premium has been capitalized into values over time, and the neighborhood has equilibrated around it.'
    }
  },
  school_gradient: {
    opportunity: {
      val: 65,
      text: 'Schools lag neighborhood change by 3–7 years. This medium score is the BEFORE state — quality improvement will follow demographics, not lead it. The incoming high-income cohort has not yet translated into school board pressure or enrollment shifts.'
    },
    displacement: {
      val: 30,
      text: 'Schools still poor despite income influx. Incoming high-income residents use private alternatives or accept existing quality. This lag confirms the displacement wave is in early-to-mid phase — school quality has not yet responded to composition change.'
    },
    stable: {
      val: 80,
      text: 'Strong schools are the definitive lagging indicator — they reflect past stability and sustained community investment over decades. High school gradient here means this neighborhood has been stable long enough for institutional quality to compound.'
    }
  },
  noi_growth: {
    opportunity: {
      val: 71,
      text: 'Rents growing but not peaked. Early-to-mid appreciation cycle. The development opportunity window is still open — NOI upside is achievable through value-add or new construction without paying peak basis.'
    },
    displacement: {
      val: 55,
      text: 'Growth rate elevated but moderating. Rents have already partially adjusted. Late-cycle positioning with compressed upside — you are buying into a trend that is maturing, not initiating.'
    },
    stable: {
      val: 50,
      text: 'Moderate stable growth, no spike. This neighborhood is not in an active wave trajectory. Consistent NOI growth with low variance — the cashflow story is predictable, which is exactly what long-duration institutional capital wants.'
    }
  },
  income_migration: {
    opportunity: {
      val: 88,
      text: 'Leading signal. High-income in-movers arriving rapidly. The wave is incoming and the acquisition window is open — prices have not yet fully reflected the composition change that is already measurable in migration data.'
    },
    displacement: {
      val: 92,
      text: 'Peak inflow — maximum income replacement underway. The wave has arrived and is at full force. Entry now means paying peak pricing. The window for affordable development is effectively closed; market-rate infill is the only viable program.'
    },
    stable: {
      val: 30,
      text: 'Established residents staying. Low churn indicates stable community composition. No displacement wave incoming — this is the absence of the signal, which is itself informative for long-horizon hold strategies.'
    }
  },
  lien_density: {
    opportunity: {
      val: 42,
      text: 'Moderate distress creates acquisition opportunity without market collapse. Some motivated sellers, manageable title complexity. This is the sweet spot — enough stress to create pricing dislocation without the title gridlock that makes assembly impossible.'
    },
    displacement: {
      val: 85,
      text: 'Tax lien accumulation is the involuntary displacement mechanism. Forced selling is concentrated at wave peak. High lien density at this stage signals that incumbent owners are being pushed out through financial stress, not voluntary exit. Significant title risk.'
    },
    stable: {
      val: 20,
      text: 'Healthy ownership structure. No forced selling pressure. Clean title, stable equity distribution across the parcel graph. This is the baseline condition of a neighborhood where owners have been able to build and maintain equity over time.'
    }
  },
  cap_rate_delta: {
    opportunity: {
      val: 60,
      text: 'Compressing but not yet compressed. A pricing gap between observed cap rate and intrinsic value still exists — the spread is closeable. Institutional capital has not fully arrived to price in the displacement wave, so early movers can still capture the compression trade.'
    },
    displacement: {
      val: 30,
      text: 'Already compressed. Institutional capital has arrived and priced in the signal. The value arbitrage window for early movers is closed. Buying here means paying the institutional premium — your exit multiple depends entirely on further compression, which is unlikely.'
    },
    stable: {
      val: 75,
      text: 'Stable, appropriately priced for long-duration hold. No pending compression event. Reliable DSCR story for debt underwriting — lenders will model this as a known quantity. Best profile for core institutional capital seeking predictable, unlevered returns.'
    }
  },
  street_entropy: {
    opportunity: {
      val: 55,
      text: 'Mixed grid/organic street pattern. Partial legibility to institutional capital. Displacement propagation velocity moderate — the topology provides some friction against wave diffusion, buying additional time in the intervention window.'
    },
    displacement: {
      val: 75,
      text: 'Grid-dominant street network. Easy unit substitution at any node — this accelerates displacement wave propagation significantly. In a grid, the wave can move in all directions simultaneously with no topological barriers to slow it down.'
    },
    stable: {
      val: 40,
      text: 'More organic/irregular pattern creates friction to wave propagation. The topology itself provides some protection to existing residents — irregular networks make substitution harder and slow the rate at which high-income demand can fan out from origin nodes.'
    }
  },
  displacement_risk: {
    opportunity: {
      val: 78,
      text: 'Elevated displacement risk signals the opportunity window is open — the early phase of incumbent exit, before prices fully adjust. This is where the pricing gap between observed value and trajectory-implied value is widest. The intervention window for affordable development is still viable but narrowing.'
    },
    displacement: {
      val: 95,
      text: 'Near-complete displacement. Late stage — incumbent population largely replaced. Entry price now fully reflects the risk premium. For affordable developers, QCT/DDA eligibility is likely already lost or will be lost at the next census update.'
    },
    stable: {
      val: 25,
      text: 'No significant pricing-out underway. Stable incumbent population. Low risk of politically-driven regulatory intervention. Long runway for community benefit agreements and LIHTC structuring without displacement pressure creating urgency.'
    }
  },
  lihtc_eligibility: {
    opportunity: {
      val: 35,
      text: 'QCT/DDA window is narrowing fast. Critical urgency for LIHTC developers — the rising income trajectory will erode eligibility at the next census determination. Act now or permanently lose the basis boost stacking opportunity for this submarket.'
    },
    displacement: {
      val: 20,
      text: 'Affordability window nearly closed. QCT/DDA status likely lost at next census — income levels have risen above the eligibility thresholds. Too late for LIHTC basis stacking strategy in this submarket. Redirect to adjacent opportunity zones.'
    },
    stable: {
      val: 60,
      text: 'Healthy affordable stock maintained. Eligibility preserved with no displacement pressure threatening it. Long runway for LIHTC structuring, community benefit agreements, and phased development without census-driven urgency.'
    }
  },
  irr_horizon: {
    opportunity: {
      val: 68,
      text: 'Good projected IRR. Still in the appreciation upswing phase. Optimal timing for development underwriting or value-add acquisition — you are buying into a trajectory where the carry is building, not peaking. Holding period sensitivity is moderate.'
    },
    displacement: {
      val: 40,
      text: 'IRR shrinking. Buy-in price has captured most of the appreciation. Risk-adjusted returns are thin for new entrants at this stage. The IRR horizon compresses because you are paying for upside that has already been realized by earlier entrants.'
    },
    stable: {
      val: 80,
      text: 'Long-horizon stable returns with lower volatility. Best profile for patient institutional capital — pension funds, core open-end funds — seeking predictable cash flow over a 10+ year hold rather than appreciation-driven exit multiples.'
    }
  }
}

const ZONES = ['opportunity', 'displacement', 'stable']
const ZONE_COLORS = {
  opportunity: '#14B8A6',
  displacement: '#F87171',
  stable: '#38BDF8'
}
const ZONE_LABELS = {
  opportunity: 'Opportunity',
  displacement: 'Displacement',
  stable: 'Stable'
}

function barColor(val) {
  if (val >= 70) return '#14B8A6'
  if (val >= 40) return '#F59E0B'
  return '#F87171'
}

export default function KPIDecoder() {
  const [selected, setSelected] = useState(null) // { kpiId, zone }
  const [hoveredCell, setHoveredCell] = useState(null)

  const activeInterpretation = selected
    ? INTERPRETATIONS[selected.kpiId]?.[selected.zone]
    : null

  const activeKPI = selected
    ? KPI_DEFS.find(k => k.id === selected.kpiId)
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--text-muted)'
          }}>
            KPI Interpretation Matrix
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 9,
            color: 'var(--text-muted)'
          }}>
            tap any cell
          </span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>

        {/* Zone column headers */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '130px repeat(3, 1fr)',
          gap: 4,
          marginBottom: 6
        }}>
          <div /> {/* empty corner */}
          {ZONES.map(z => (
            <div key={z} style={{
              fontFamily: 'var(--font-mono)', fontSize: 9,
              fontWeight: 600, letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: ZONE_COLORS[z],
              textAlign: 'center',
              padding: '4px 0'
            }}>
              {ZONE_LABELS[z]}
            </div>
          ))}
        </div>

        {/* KPI rows */}
        {KPI_DEFS.map((kpi, ki) => (
          <div key={kpi.id} style={{
            display: 'grid',
            gridTemplateColumns: '130px repeat(3, 1fr)',
            gap: 4,
            marginBottom: 4
          }}>
            {/* KPI label */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 4px'
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: kpi.color, flexShrink: 0,
                boxShadow: `0 0 4px ${kpi.color}80`
              }} />
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 10,
                color: 'var(--text-secondary)', lineHeight: 1.3
              }}>
                {kpi.label}
              </span>
            </div>

            {/* Zone cells */}
            {ZONES.map(zone => {
              const interp = INTERPRETATIONS[kpi.id]?.[zone]
              const val = interp?.val ?? 50
              const isSelected = selected?.kpiId === kpi.id && selected?.zone === zone
              const isHovered = hoveredCell?.kpiId === kpi.id && hoveredCell?.zone === zone
              const zoneColor = ZONE_COLORS[zone]

              return (
                <button
                  key={zone}
                  onClick={() => setSelected(
                    isSelected ? null : { kpiId: kpi.id, zone }
                  )}
                  onMouseEnter={() => setHoveredCell({ kpiId: kpi.id, zone })}
                  onMouseLeave={() => setHoveredCell(null)}
                  style={{
                    background: isSelected
                      ? `${zoneColor}18`
                      : isHovered
                      ? 'rgba(255,255,255,0.04)'
                      : 'rgba(255,255,255,0.02)',
                    border: isSelected
                      ? `1px solid ${zoneColor}50`
                      : '1px solid var(--border-subtle)',
                    borderRadius: 6,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    transition: 'all 0.12s ease',
                    textAlign: 'left'
                  }}
                >
                  {/* Value + bar */}
                  <div style={{
                    display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', marginBottom: 4
                  }}>
                    <div style={{ flex: 1, height: 3, borderRadius: 2,
                      background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginRight: 6 }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        width: `${val}%`,
                        background: barColor(val)
                      }} />
                    </div>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10,
                      fontWeight: 600, color: barColor(val),
                      minWidth: 20, textAlign: 'right'
                    }}>
                      {val}
                    </span>
                  </div>
                  {/* Preview text */}
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: 8,
                    color: isSelected ? 'var(--text-secondary)' : 'var(--text-muted)',
                    lineHeight: 1.4, overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical'
                  }}>
                    {interp?.text.slice(0, 60)}…
                  </div>
                </button>
              )
            })}
          </div>
        ))}

        {/* Interpretation panel */}
        <div style={{
          marginTop: 12,
          padding: 14,
          borderRadius: 10,
          background: activeInterpretation
            ? `${ZONE_COLORS[selected.zone]}0C`
            : 'rgba(255,255,255,0.02)',
          border: `1px solid ${activeInterpretation ? ZONE_COLORS[selected.zone] + '30' : 'var(--border-subtle)'}`,
          minHeight: 96,
          transition: 'all 0.2s ease'
        }}>
          {activeInterpretation ? (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10
              }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: activeKPI?.color,
                  boxShadow: `0 0 6px ${activeKPI?.color}80`
                }} />
                <span style={{
                  fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
                  color: 'var(--text-primary)'
                }}>
                  {activeKPI?.label}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 9,
                  color: ZONE_COLORS[selected.zone],
                  background: `${ZONE_COLORS[selected.zone]}18`,
                  padding: '2px 7px', borderRadius: 3
                }}>
                  {ZONE_LABELS[selected.zone]} zone
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10,
                  fontWeight: 600, color: barColor(activeInterpretation.val),
                  marginLeft: 'auto'
                }}>
                  {activeInterpretation.val}/100
                </span>
              </div>
              <p style={{
                fontFamily: 'var(--font-body)', fontSize: 12,
                color: 'var(--text-secondary)', lineHeight: 1.75,
                margin: 0
              }}>
                {activeInterpretation.text}
              </p>
            </>
          ) : (
            <div style={{
              textAlign: 'center', paddingTop: 20,
              fontFamily: 'var(--font-mono)', fontSize: 10,
              color: 'var(--text-muted)', lineHeight: 1.8
            }}>
              Select any cell to read the full interpretation for that KPI in zone context
            </div>
          )}
        </div>

        {/* Legend */}
        <div style={{
          marginTop: 12, display: 'flex', gap: 16,
          fontFamily: 'var(--font-mono)', fontSize: 9,
          color: 'var(--text-muted)'
        }}>
          {[['#14B8A6', '70+'], ['#F59E0B', '40–69'], ['#F87171', '<40']].map(([c, l]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 8, height: 3, borderRadius: 2, background: c }} />
              {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
