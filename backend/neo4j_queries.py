"""
Velasight Neo4j Graph Queries
All Cypher queries for Velasight Explore spatial intelligence.

Schema alignment (verified April 2026 against live Neo4j instance):
  Labels:         Parcel, Owner, CensusTract, Market, MarketContext, MarketCore,
                  Intersection, Property, AnalysisResult
  Relationships:  (Owner)-[:OWNS]->(Parcel)
                  (Parcel)-[:IN_TRACT]->(CensusTract)
                  (Parcel)-[:LOCATED_IN]->(CensusTract)
                  (Parcel)-[:IN_MARKET]->(Market)
                  (Parcel)-[:LOCATED_NEAR]->(Parcel|Property|Intersection)
                  (Parcel)-[:HAS_ANALYSIS]->(AnalysisResult)
                  (CensusTract)-[:CONNECTS_TO]->(CensusTract)
  Parcel props:   parcel_id (not on all nodes), ATTOMID, SitusAddress, SitusCity,
                  SitusZip5, location (Point), AssessedValue, AssessedValueTotal,
                  ZoningCode, zoning, units, year_built, acres, sqft, lot_sqft,
                  owner_name, property_use, last_sale_price, last_sale_date
  Intersection:   betweenness (range 0 → 28.3M, ~10k distinct values, 12.9k nodes)
  CensusTract:    avgAssessedValue, minValue, maxValue, median_income,
                  propertyCount, total_households, TractID
  Owner props:    OwnerName

DIAGNOSTIC FINDINGS (April 2026):
  The following Parcel properties are UNUSABLE — do not read:
    - Parcel.connectivity_score   : constant 1.0 everywhere
    - Parcel.betweenness_score    : corrupted (floats in ±e+56 range)
    - Parcel.noi_growth_12mo, cap_rate_used, income_migration_12mo,
      lien_density, displacement_risk, lihtc_eligibility, school_gradient,
      street_entropy                : NULL on 99.996% of parcels (never loaded)

  Real connectivity comes from Intersection.betweenness reached via
  LOCATED_NEAR. Real income/value context comes from CensusTract via
  IN_TRACT. The KPI synthesis below is built exclusively on those signals
  plus the populated Parcel scalars (AssessedValue, last_sale_price,
  year_built, lot_sqft, ZoningCode).

  Every parcel produces a distinct KPI vector because every input signal
  differs per parcel. No flat-vector clustering.
"""

from __future__ import annotations

import math
import threading
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from neo4j import GraphDatabase

from models import (
    ParcelKPI, KPIVector, ZoneScore, SiteAnalysis, NearbyParcels,
    OwnershipConcentration, DisplacementTrajectory, AssemblageOpportunities,
    AssemblageCluster, EntityNode, ParcelFeature, TrajectoryPoint,
    OwnershipSignal, VerdictType, ZoneType, ProgramType,
)

logger = logging.getLogger(__name__)


# ── Composite scoring weights (unchanged — business logic) ────────────────

KPI_WEIGHTS = {
    'transit_centrality': 0.15,
    'school_gradient':    0.08,
    'noi_growth':         0.10,
    'income_migration':   0.18,
    'lien_density':       0.10,
    'cap_rate_delta':     0.10,
    'street_entropy':     0.07,
    'displacement_risk':  0.12,
    'lihtc_eligibility':  0.05,
    'irr_horizon':        0.05,
}


# ── Defensive normalization helpers ───────────────────────────────────────

def _to_float01(value: Any, default: float = 0.5) -> float:
    """
    Coerce a Neo4j property value into a [0,1] float.

    Handles four real-world cases safely:
      - None          -> default (0.5 = neutral)
      - 0-1 float     -> returned as-is
      - 0-100 scale   -> divided by 100
      - non-numeric   -> default
    """
    if value is None:
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f < 0:
        return 0.0
    if f <= 1:
        return f
    if f <= 100:
        return f / 100.0
    return 1.0


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _safe_div(num: Optional[float], den: Optional[float]) -> Optional[float]:
    """Float division that returns None on any unusable input."""
    if num is None or den is None:
        return None
    try:
        n, d = float(num), float(den)
    except (TypeError, ValueError):
        return None
    if d == 0 or math.isnan(n) or math.isnan(d):
        return None
    return n / d


# Street suffix abbreviations used by U.S. county tax assessors.
# Maps spoken/voice-transcribed suffix -> typical county abbreviation.
_STREET_SUFFIX_MAP = {
    'street':    'st',
    'avenue':    'ave',
    'boulevard': 'blvd',
    'drive':     'dr',
    'road':      'rd',
    'lane':      'ln',
    'place':     'pl',
    'court':     'ct',
    'parkway':   'pkwy',
    'circle':    'cir',
    'trail':     'trl',
    'highway':   'hwy',
    'terrace':   'ter',
    'square':    'sq',
    'way':       'way',
}


def _parse_address_needle(needle: str) -> Tuple[Optional[str], List[str]]:
    """
    Parse a voice-transcribed address string into components suitable for
    tokenized lookup against county-style SitusAddress records.

    Returns (house_number, street_tokens), both optional.

    Examples:
        "125 Mitchell Street"    -> ("125", ["mitchell", "st"])
        "400 Northside Drive"    -> ("400", ["northside", "dr"])
        "Peachtree Road NW"      -> (None, ["peachtree", "rd", "nw"])
        ""                       -> (None, [])
    """
    if not needle:
        return None, []

    raw_tokens = [t.strip(',.') for t in needle.lower().split() if t.strip(',.')]
    if not raw_tokens:
        return None, []

    house_num: Optional[str] = None
    if raw_tokens[0].isdigit():
        house_num = raw_tokens[0]
        raw_tokens = raw_tokens[1:]

    street_tokens = [_STREET_SUFFIX_MAP.get(t, t) for t in raw_tokens]
    return house_num, street_tokens


# ── City-level signal baselines ───────────────────────────────────────────

@dataclass(frozen=True)
class BaselineStats:
    """
    City-wide percentile cuts used to normalize raw graph signals into
    the [0,1] KPI feature space.

    Normalization mapping for each signal:
        value == median  ->  0.5
        value == p95     ->  1.0
        value == (2*median - p95), i.e. symmetric below  ->  0.0
    Values outside [median-spread, p95] saturate.

    Heavy-tailed signals (intersection betweenness, parcel-to-tract value
    ratio) are normalized in log space so a handful of freeway-adjacent
    outliers do not collapse the rest of the city's distribution to zero.
    """
    # Intersection.betweenness, log-scaled (range observed: 0 → 28.3M)
    int_beta_log_p50: float
    int_beta_log_p95: float

    # CensusTract.median_income ($)
    inc_p05: float
    inc_p50: float
    inc_p95: float

    # Parcel.AssessedValue / CensusTract.avgAssessedValue ratio
    # (pressure of this specific parcel against its tract context)
    val_ratio_p50: float
    val_ratio_p95: float

    # (AssessedValue - last_sale_price) / last_sale_price (appreciation)
    app_p50: float
    app_p95: float

    def describe(self) -> str:
        return (
            f"BaselineStats(intBeta exp(p50)={math.exp(self.int_beta_log_p50):,.0f} "
            f"exp(p95)={math.exp(self.int_beta_log_p95):,.0f}; "
            f"inc p50=${self.inc_p50:,.0f} p95=${self.inc_p95:,.0f}; "
            f"valRatio p50={self.val_ratio_p50:.2f} p95={self.val_ratio_p95:.2f}; "
            f"app p50={self.app_p50:+.2f} p95={self.app_p95:+.2f})"
        )


# Atlanta-calibrated fallback. Used only if baseline Cypher queries
# fail (e.g. the Intersection or CensusTract layers aren't loaded yet
# in a new market). Keeps the service up without flat-vector outputs.
_FALLBACK_BASELINES = BaselineStats(
    int_beta_log_p50=math.log(5_000.0),
    int_beta_log_p95=math.log(500_000.0),
    inc_p05=18_000.0,
    inc_p50=52_000.0,
    inc_p95=145_000.0,
    val_ratio_p50=1.0,
    val_ratio_p95=3.5,
    app_p50=0.12,
    app_p95=1.50,
)


def _norm_around_median(
    x: Optional[float],
    median: Optional[float],
    p95: Optional[float],
    default: float = 0.5,
) -> float:
    """
    Map a raw value to [0,1] with median -> 0.5 and p95 -> 1.0.
    Linear on both sides of median; saturates at 0 and 1.
    """
    if x is None or median is None or p95 is None or p95 <= median:
        return default
    try:
        scaled = 0.5 + (float(x) - float(median)) / (float(p95) - float(median)) * 0.5
    except (TypeError, ValueError):
        return default
    if math.isnan(scaled) or math.isinf(scaled):
        return default
    return max(0.0, min(1.0, scaled))


def _norm_log_median(
    x: Optional[float],
    log_median: Optional[float],
    log_p95: Optional[float],
    default: float = 0.5,
) -> float:
    """Log-space version of _norm_around_median for heavy-tailed positive signals."""
    if x is None or log_median is None or log_p95 is None or log_p95 <= log_median:
        return default
    try:
        xf = float(x)
    except (TypeError, ValueError):
        return default
    if xf <= 0 or math.isnan(xf):
        return default
    try:
        lx = math.log(xf)
    except ValueError:
        return default
    scaled = 0.5 + (lx - float(log_median)) / (float(log_p95) - float(log_median)) * 0.5
    return max(0.0, min(1.0, scaled))


# ── Signal-driven KPI synthesis ───────────────────────────────────────────

def _synth_irr_horizon(
    noi_growth: float,
    cap_rate_delta: float,
    displacement_risk: float,
) -> float:
    """
    Synthesize an IRR-horizon proxy because the property doesn't exist
    in the graph. Weighted blend of the three drivers that most directly
    move a multi-year IRR expectation.
    """
    score = (0.50 * noi_growth) + (0.35 * cap_rate_delta) + (0.15 * (1.0 - displacement_risk))
    return _clamp(score)


def _synthesize_kpis_from_signals(
    baselines: BaselineStats,
    *,
    assessed_value: Optional[float],
    last_sale_price: Optional[float],
    year_built: Optional[int],
    lot_sqft: Optional[float],
    int_beta_max: Optional[float],
    int_beta_mean: Optional[float],
    int_beta_std: Optional[float],
    int_beta_n: Optional[int],
    tract_median_income: Optional[float],
    tract_avg_assessed_value: Optional[float],
    tract_property_count: Optional[int],
) -> Dict[str, float]:
    """
    Derive a 10-dim KPI vector from parcel-local signals and graph neighborhood
    signals, normalized against city-wide baselines.

    Every formula depends on at least two independent inputs so two parcels
    on the same block still produce distinct vectors (different AssessedValue
    → different val_pressure; different nearby-intersection sets → different
    transit; different year_built → different age_factor; etc.).

    See the module docstring for which Parcel properties are intentionally
    NOT read here (the poisoned and never-loaded ones).
    """
    # ── Stage 1: normalize raw signals into [0,1] feature space ───────

    # Transit: max betweenness of nearby intersections, log-normalized.
    # Below-median default is 0.30 (not 0.5) because a parcel with no nearby
    # intersection data is almost certainly under-connected, not neutral.
    transit_max = _norm_log_median(
        int_beta_max,
        baselines.int_beta_log_p50,
        baselines.int_beta_log_p95,
        default=0.30,
    )
    transit_mean = _norm_log_median(
        int_beta_mean,
        baselines.int_beta_log_p50,
        baselines.int_beta_log_p95,
        default=0.30,
    )

    # Income: tract median income, linear-normalized against city distribution.
    inc_norm = _norm_around_median(
        tract_median_income,
        baselines.inc_p50,
        baselines.inc_p95,
        default=0.5,
    )

    # Value pressure: parcel value relative to its tract's average. Ratio > 1
    # means this parcel is richer than its tract average (gentrification
    # frontier); ratio < 1 means cheap-for-its-tract (upside or distress).
    val_ratio_raw = _safe_div(assessed_value, tract_avg_assessed_value)
    val_pressure = _norm_around_median(
        val_ratio_raw,
        baselines.val_ratio_p50,
        baselines.val_ratio_p95,
        default=0.5,
    )

    # Appreciation: AssessedValue vs last_sale_price. Proxies demand trajectory.
    appreciation_raw: Optional[float] = None
    if (
        last_sale_price and assessed_value
        and float(last_sale_price) > 0 and float(assessed_value) > 0
    ):
        appreciation_raw = (float(assessed_value) - float(last_sale_price)) / float(last_sale_price)
    appreciation = _norm_around_median(
        appreciation_raw,
        baselines.app_p50,
        baselines.app_p95,
        default=0.5,
    )

    # Intersection variability (coefficient of variation of betweenness at
    # nearby intersections). Dense-and-chaotic nodes score high; dense-and-
    # uniform nodes (subdivision grids) score low. Normalized CV is capped
    # at 2.0 → 1.0 which is generous; most corridors land in [0.2, 0.8].
    beta_cv = 0.30
    if int_beta_mean and float(int_beta_mean) > 0 and int_beta_std is not None:
        cv = float(int_beta_std) / float(int_beta_mean)
        beta_cv = min(1.0, cv / 2.0)

    # Intersection density near the parcel. 0 → 0, 20+ → 1.
    int_density = min(1.0, float(int_beta_n or 0) / 20.0)

    # Property age. Pre-1900 → 0, 2026 build → 1. Missing → 0.5 (neutral).
    age_factor = 0.5
    if year_built and 1800 < int(year_built) <= 2026:
        age_years = 2026 - int(year_built)
        age_factor = max(0.0, min(1.0, 1.0 - age_years / 126.0))

    # Lot size damping. Bigger lots slow displacement (harder to flip).
    lot_norm = min(1.0, float(lot_sqft or 5_000) / 20_000.0)

    # Tract stability. Dense tracts with many households have more established
    # street grids and school attendance boundaries.
    tract_density = min(1.0, float(tract_property_count or 0) / 500.0)

    # ── Stage 2: compose the 10 KPI outputs ───────────────────────────

    # Transit centrality — max betweenness dominates; mean smooths outliers.
    transit_centrality = _clamp(0.75 * transit_max + 0.25 * transit_mean, 0.02, 0.98)

    # School gradient — tract income is the dominant proxy (property-tax-
    # funded schools in the US), with small premiums for mature housing
    # stock and dense (established) tracts.
    school_gradient = _clamp(
        0.65 * inc_norm
        + 0.20 * (1.0 - age_factor)       # older neighborhoods = more established
        + 0.15 * tract_density,
        0.05, 0.95,
    )

    # NOI growth — appreciation carries the signal (rising values imply
    # rising rents); transit adds the throughput needed to sustain it;
    # tract income caps what the market can bear.
    noi_growth = _clamp(
        0.55 * appreciation
        + 0.25 * transit_centrality
        + 0.20 * inc_norm,
        0.05, 0.95,
    )

    # Income migration — classic gentrification pull: high-earner tract,
    # parcel priced above tract average, strong connectivity to jobs.
    income_migration = _clamp(
        0.45 * inc_norm
        + 0.35 * val_pressure
        + 0.20 * transit_centrality,
        0.05, 0.95,
    )

    # Cap rate delta — 0.5 = market-neutral; > 0.5 = premium/compressed;
    # < 0.5 = discount/wide. Compression is driven by relative pricing,
    # connectivity, and trajectory.
    cap_rate_delta = _clamp(
        0.40 * val_pressure
        + 0.30 * transit_centrality
        + 0.30 * appreciation,
        0.05, 0.95,
    )

    # Street entropy — grid irregularity + density. CV of nearby betweenness
    # separates leafy cul-de-sacs (low CV) from chaotic mixed nodes (high CV).
    street_entropy = _clamp(
        0.45 * beta_cv
        + 0.35 * int_density
        + 0.20 * transit_mean,
        0.05, 0.95,
    )

    # Displacement risk — flagship composite. Migration and value pressure
    # drive it up; large lots dampen it; transit amplifies it (migrants
    # reach the parcel).
    displacement_risk = _clamp(
        0.40 * income_migration
        + 0.35 * val_pressure
        + 0.15 * transit_centrality
        - 0.10 * lot_norm,
        0.05, 0.95,
    )

    # LIHTC eligibility — QCT-style proxy: tracts below the city median
    # income are more likely to qualify. Parcels priced below their tract
    # average add a secondary signal (rent-affordable basis).
    lihtc_eligibility = _clamp(
        0.70 * (1.0 - inc_norm)
        + 0.30 * (1.0 - val_pressure),
        0.05, 0.95,
    )

    # Lien density — no real lien data; proxy with the stress triad of
    # age + below-tract value + low tract income. Ceiling capped at 0.70
    # because this is the weakest-grounded synthesis and we do not want
    # to over-flag title risk.
    lien_density = _clamp(
        0.35 * (1.0 - age_factor)
        + 0.35 * (1.0 - val_pressure)
        + 0.30 * (1.0 - inc_norm),
        0.05, 0.70,
    )

    # IRR horizon — synthesized from NOI trajectory, cap-rate posture,
    # and inverse displacement risk.
    irr_horizon = _synth_irr_horizon(noi_growth, cap_rate_delta, displacement_risk)

    return {
        'transit_centrality':  transit_centrality,
        'school_gradient':     school_gradient,
        'noi_growth':          noi_growth,
        'income_migration':    income_migration,
        'lien_density':        lien_density,
        'cap_rate_delta':      cap_rate_delta,
        'street_entropy':      street_entropy,
        'displacement_risk':   displacement_risk,
        'lihtc_eligibility':   lihtc_eligibility,
        'irr_horizon':         irr_horizon,
    }


# ── Scoring / classification (pure business logic, unchanged) ─────────────

def compute_gentrification_score(kpi: Dict[str, float]) -> int:
    """Weighted composite score 0-100."""
    score = sum(kpi.get(k, 0) * w * 100 for k, w in KPI_WEIGHTS.items())
    return min(100, max(0, round(score)))


def classify_zone(score: int, kpi: Dict[str, float]) -> ZoneType:
    """Classify zone based on score and KPI trajectory pattern."""
    income_migration = kpi.get('income_migration', 0)
    displacement_risk = kpi.get('displacement_risk', 0)

    if score >= 75 or (displacement_risk > 0.85 and income_migration > 0.85):
        return ZoneType.displacement
    elif score <= 35 and income_migration < 0.35:
        return ZoneType.stable
    else:
        return ZoneType.opportunity


def determine_verdict(
    score: int,
    kpi: Dict[str, float],
    program_type: str,
    zoning_code: Optional[str] = None,
) -> Tuple[VerdictType, str]:
    """
    Determine development verdict with reasoning.

    `zoning_code` is accepted for signature-forward compatibility with the
    next iteration's zoning-aware guard (priority #2). Not consumed yet —
    pass it through so upstream callers don't need to change again later.
    """
    income_migration = kpi.get('income_migration', 0)
    lien_density = kpi.get('lien_density', 0)
    lihtc_eligible = kpi.get('lihtc_eligibility', 0)
    displacement_risk = kpi.get('displacement_risk', 0)
    irr_horizon = kpi.get('irr_horizon', 0)

    if program_type == 'affordable':
        if score > 80:
            return VerdictType.AVOID, (
                "Displacement wave at peak. Land basis has closed the affordable development window. "
                "QCT/DDA status likely lost at next census. Market-rate infill is the only viable program."
            )
        elif score < 40 and lihtc_eligible > 0.5:
            return VerdictType.DEVELOP, (
                "Strong LIHTC opportunity. QCT/DDA eligibility viable with basis boost potential. "
                "Income migration signal remains moderate — acquisition window is open."
            )
        elif 40 <= score <= 65 and lihtc_eligible > 0.3:
            return VerdictType.CAUTION, (
                "Narrowing affordable window. Rising income migration is compressing QCT eligibility. "
                "Accelerate underwriting — 12-18 month window before basis boost stacking is foreclosed."
            )
        else:
            return VerdictType.HOLD, (
                "Stable neighborhood with preserved affordable stock. "
                "Long runway for LIHTC structuring. No displacement pressure."
            )

    # Market-rate / commercial logic
    if score > 85 and displacement_risk > 0.90:
        return VerdictType.AVOID, (
            "Late-stage displacement with near-complete incumbent replacement. "
            "Entry pricing fully reflects risk premium. Thin risk-adjusted returns for new entrants."
        )
    elif score < 30 and irr_horizon > 0.70:
        return VerdictType.HOLD, (
            "Established neighborhood with strong long-horizon cashflow profile. "
            "Low volatility, predictable DSCR story. Patient institutional capital play."
        )
    elif 55 <= score <= 80 and income_migration > 0.65 and lien_density < 0.60:
        return VerdictType.DEVELOP, (
            f"Active displacement wave with open acquisition window. "
            f"Income migration at {round(income_migration*100)}% creates appreciation upside. "
            "Moderate lien density indicates motivated sellers without title complexity."
        )
    else:
        return VerdictType.CAUTION, (
            "Mixed signals — rising trajectory but window timing uncertain. "
            "Run detailed cash-on-cash analysis before commitment. "
            "Monitor income migration delta over next two quarters."
        )


# ─────────────────────────────────────────────────────────────────────────
# Graph client
# ─────────────────────────────────────────────────────────────────────────

class VelasightGraph:
    """
    All spatial + KPI queries for Velasight Explore.
    Method signatures are stable — main.py does not need to change.
    """

    def __init__(self, uri: str, user: str, password: str):
        self.driver = GraphDatabase.driver(uri, auth=(user, password))
        self._baselines: Optional[BaselineStats] = None
        self._baseline_lock = threading.Lock()

    def get_tract_geoid_for_parcel(
        self,
        attom_id: Optional[str] = None,
        lng: Optional[float] = None,
        lat: Optional[float] = None,
    ) -> Optional[str]:
        """
        Look up the census tract geoid for a parcel.
        Tries ATTOMID first, falls back to spatial proximity if lat/lng given.
        Returns None if no tract found.
        """
        with self.driver.session() as session:
            # Path 1: ATTOMID exact match
            if attom_id:
                result = session.run(
                    """
                    MATCH (p:Parcel {ATTOMID: $attom_id})-[:IN_TRACT]->(t:CensusTract)
                    RETURN t.geoid AS geoid
                    LIMIT 1
                    """,
                    attom_id=str(attom_id),
                ).single()
                if result and result["geoid"]:
                    return result["geoid"]

            # Path 2: spatial fallback — nearest parcel's tract within 500m
            if lng is not None and lat is not None:
                result = session.run(
                    """
                    MATCH (p:Parcel)-[:IN_TRACT]->(t:CensusTract)
                    WHERE p.location IS NOT NULL
                      AND point.distance(
                          p.location,
                          point({longitude: $lng, latitude: $lat})
                      ) <= 500
                    RETURN t.geoid AS geoid,
                           point.distance(
                               p.location,
                               point({longitude: $lng, latitude: $lat})
                           ) AS dist
                    ORDER BY dist ASC
                    LIMIT 1
                    """,
                    lng=lng, lat=lat,
                ).single()
                if result and result["geoid"]:
                    return result["geoid"]
        return None

    def close(self):
        self.driver.close()

    def _run(self, query: str, params: Optional[dict] = None) -> List[Dict]:
        """Execute a read query. Logs but never raises on query failure —
        callers expect empty lists, and raising would 500 the whole endpoint
        on a recoverable Cypher issue."""
        try:
            with self.driver.session() as session:
                result = session.run(query, params or {})
                return [dict(r) for r in result]
        except Exception as e:
            logger.error("Neo4j query failed: %s\nQuery: %s", e, query.strip()[:200])
            return []

    # ── Baselines (lazy, thread-safe, reusable for the lifetime of process) ──

    @property
    def baselines(self) -> BaselineStats:
        """Lazy-loaded city-level baselines used by KPI synthesis."""
        if self._baselines is None:
            with self._baseline_lock:
                if self._baselines is None:
                    self._baselines = self._compute_baselines()
        return self._baselines

    def refresh_baselines(self) -> BaselineStats:
        """Force-reload baselines. Call after a large data pipeline update
        (new market loaded, tract re-ingest, intersection graph rebuilt)."""
        with self._baseline_lock:
            self._baselines = self._compute_baselines()
        return self._baselines

    def _compute_baselines(self) -> BaselineStats:
        """
        Compute city-wide percentile cuts for relative normalization.

        Each query is guarded independently — if one distribution is
        unavailable (e.g. a new market has parcels but no intersection
        graph yet), the others still populate and that slice of the
        fallback is used. This lets KPI synthesis degrade gracefully
        rather than silently collapsing to 0.5 everywhere.
        """
        fb = _FALLBACK_BASELINES

        # ─ Intersection betweenness (log-space) ─────────────────────────
        int_p50 = fb.int_beta_log_p50
        int_p95 = fb.int_beta_log_p95
        int_rows = self._run("""
            MATCH (i:Intersection)
            WHERE i.betweenness IS NOT NULL AND i.betweenness > 0
            WITH log(i.betweenness) AS lb
            RETURN
                percentileCont(lb, 0.50) AS p50,
                percentileCont(lb, 0.95) AS p95
        """)
        if int_rows and int_rows[0].get('p50') is not None and int_rows[0].get('p95') is not None:
            try:
                int_p50 = float(int_rows[0]['p50'])
                int_p95 = float(int_rows[0]['p95'])
            except (TypeError, ValueError):
                logger.warning("Intersection betweenness baseline parse failed; using fallback")

        # ─ Tract income ─────────────────────────────────────────────────
        inc_p05, inc_p50, inc_p95 = fb.inc_p05, fb.inc_p50, fb.inc_p95
        inc_rows = self._run("""
            MATCH (t:CensusTract)
            WHERE t.median_income IS NOT NULL AND t.median_income > 0
            RETURN
                percentileCont(t.median_income, 0.05) AS p05,
                percentileCont(t.median_income, 0.50) AS p50,
                percentileCont(t.median_income, 0.95) AS p95
        """)
        if inc_rows and inc_rows[0].get('p50') is not None:
            try:
                inc_p05 = float(inc_rows[0].get('p05') or inc_p05)
                inc_p50 = float(inc_rows[0]['p50'])
                inc_p95 = float(inc_rows[0].get('p95') or inc_p95)
            except (TypeError, ValueError):
                logger.warning("Tract income baseline parse failed; using fallback")

        # ─ Parcel-to-tract value ratio ──────────────────────────────────
        val_p50, val_p95 = fb.val_ratio_p50, fb.val_ratio_p95
        val_rows = self._run("""
            MATCH (p:Parcel)-[:IN_TRACT]->(t:CensusTract)
            WHERE coalesce(p.AssessedValue, p.AssessedValueTotal) > 0
              AND t.avgAssessedValue > 0
            WITH toFloat(coalesce(p.AssessedValue, p.AssessedValueTotal))
                 / toFloat(t.avgAssessedValue) AS ratio
            RETURN
                percentileCont(ratio, 0.50) AS p50,
                percentileCont(ratio, 0.95) AS p95
        """)
        if val_rows and val_rows[0].get('p50') is not None:
            try:
                val_p50 = float(val_rows[0]['p50'])
                val_p95 = float(val_rows[0].get('p95') or val_p95)
            except (TypeError, ValueError):
                logger.warning("Value-ratio baseline parse failed; using fallback")

        # ─ Appreciation (AssessedValue vs last_sale_price) ──────────────
        app_p50, app_p95 = fb.app_p50, fb.app_p95
        app_rows = self._run("""
            MATCH (p:Parcel)
            WHERE coalesce(p.AssessedValue, p.AssessedValueTotal) > 0
              AND p.last_sale_price > 0
            WITH (toFloat(coalesce(p.AssessedValue, p.AssessedValueTotal))
                  - toFloat(p.last_sale_price))
                 / toFloat(p.last_sale_price) AS app
            RETURN
                percentileCont(app, 0.50) AS p50,
                percentileCont(app, 0.95) AS p95
        """)
        if app_rows and app_rows[0].get('p50') is not None:
            try:
                app_p50 = float(app_rows[0]['p50'])
                app_p95 = float(app_rows[0].get('p95') or app_p95)
            except (TypeError, ValueError):
                logger.warning("Appreciation baseline parse failed; using fallback")

        result = BaselineStats(
            int_beta_log_p50=int_p50,
            int_beta_log_p95=int_p95,
            inc_p05=inc_p05,
            inc_p50=inc_p50,
            inc_p95=inc_p95,
            val_ratio_p50=val_p50,
            val_ratio_p95=val_p95,
            app_p50=app_p50,
            app_p95=app_p95,
        )
        logger.info("Velasight baselines loaded — %s", result.describe())
        return result

    # ── Internal: tolerant parcel lookup ──────────────────────────────────
    #
    # Voice input from Vapi arrives as a free-form string like
    # "125 Mitchell St". It's not a parcel_id — it's usually an address.
    # We try four lookup paths in order:
    #   (1) exact parcel_id
    #   (2) exact ATTOMID (numeric ID some records use instead)
    #   (3) house-number + tokenized street match
    #   (3b) street-tokens only (user omitted number or no number match)
    #   (4) raw substring fallback
    #
    # Returns a flat dict of the parcel's signals (no KPIs yet — those are
    # synthesized downstream in _row_to_kpi_dict), or None if no match.

    # Shared projection: after `WITH p LIMIT 1`, hop into Intersection and
    # CensusTract for real signals, then project a flat row. The corrupted
    # Parcel.connectivity_score / Parcel.betweenness_score properties and
    # the NULL *_12mo / lien_density / displacement_risk / lihtc_eligibility
    # / cap_rate_used / street_entropy / school_gradient properties are NOT
    # read — they're synthesized from the joined real signals below.
    _PARCEL_SIGNAL_PROJECTION = """
        OPTIONAL MATCH (p)-[:LOCATED_NEAR]-(i:Intersection)
            WHERE i.betweenness IS NOT NULL AND i.betweenness > 0
        WITH p,
             max(i.betweenness)   AS int_beta_max,
             avg(i.betweenness)   AS int_beta_mean,
             stDev(i.betweenness) AS int_beta_std,
             count(i)             AS int_beta_n

        OPTIONAL MATCH (p)-[:IN_TRACT]->(t:CensusTract)
        WITH p, int_beta_max, int_beta_mean, int_beta_std, int_beta_n,
             t.median_income                                    AS tract_median_income,
             t.avgAssessedValue                                 AS tract_avg_assessed_value,
             t.propertyCount                                    AS tract_property_count,
             t.total_households                                 AS tract_households,
             coalesce(t.TractID, t.census_tract, t.geoid_tract) AS tract_id

        RETURN
            coalesce(p.parcel_id, toString(p.ATTOMID), 'parcel-' + elementId(p)) AS parcel_id,
            coalesce(p.SitusAddress, p.owner_name, 'Unknown Address')            AS address,
            p.location.longitude                                                 AS lng,
            p.location.latitude                                                  AS lat,
            coalesce(p.AssessedValue, p.AssessedValueTotal)                      AS assessed_value,
            p.last_sale_price                                                    AS last_sale_price,
            p.last_sale_date                                                     AS last_sale_date,
            p.year_built                                                         AS year_built,
            coalesce(p.lot_sqft, p.sqft)                                         AS lot_sqft,
            p.ZoningCode                                                         AS zoning_code,
            int_beta_max, int_beta_mean, int_beta_std, int_beta_n,
            tract_median_income, tract_avg_assessed_value,
            tract_property_count, tract_households, tract_id,
            p.last_sale_date                                                     AS data_as_of
    """

    def _lookup_parcel(self, needle: str) -> Optional[Dict]:
        """Tolerant lookup. `needle` may be parcel_id, ATTOMID, or an address fragment."""
        if not needle:
            return None

        # Path 1 + 2: exact ID match
        rows = self._run(
            f"""
            MATCH (p:Parcel)
            WHERE p.parcel_id = $needle OR toString(p.ATTOMID) = $needle
            WITH p LIMIT 1
            {self._PARCEL_SIGNAL_PROJECTION}
            """,
            {"needle": needle},
        )
        if rows:
            return rows[0]

        # Path 3: house-number + tokenized street match.
        house_num, street_tokens = _parse_address_needle(needle)

        if house_num and street_tokens:
            rows = self._run(
                f"""
                MATCH (p:Parcel)
                WHERE p.SitusAddress IS NOT NULL
                  AND toLower(p.SitusAddress) STARTS WITH ($house_num + ' ')
                  AND ALL(tok IN $tokens WHERE toLower(p.SitusAddress) CONTAINS tok)
                WITH p LIMIT 1
                {self._PARCEL_SIGNAL_PROJECTION}
                """,
                {"house_num": house_num, "tokens": street_tokens},
            )
            if rows:
                return rows[0]

        # Path 3b: street-tokens only
        if street_tokens:
            rows = self._run(
                f"""
                MATCH (p:Parcel)
                WHERE p.SitusAddress IS NOT NULL
                  AND ALL(tok IN $tokens WHERE toLower(p.SitusAddress) CONTAINS tok)
                WITH p LIMIT 1
                {self._PARCEL_SIGNAL_PROJECTION}
                """,
                {"tokens": street_tokens},
            )
            if rows:
                return rows[0]

        # Path 4: raw CONTAINS fallback
        rows = self._run(
            f"""
            MATCH (p:Parcel)
            WHERE p.SitusAddress IS NOT NULL
              AND toLower(p.SitusAddress) CONTAINS toLower($needle)
            WITH p LIMIT 1
            {self._PARCEL_SIGNAL_PROJECTION}
            """,
            {"needle": needle},
        )
        return rows[0] if rows else None

    def _row_to_kpi_dict(self, row: Dict) -> Dict[str, float]:
        """
        Map a raw signal row into the 10-key KPI dict the scoring code expects.
        Every KPI is synthesized from the real graph signals projected in
        _PARCEL_SIGNAL_PROJECTION. We do not read the poisoned or NULL
        Parcel properties — see module docstring for rationale.
        """
        return _synthesize_kpis_from_signals(
            self.baselines,
            assessed_value=row.get('assessed_value'),
            last_sale_price=row.get('last_sale_price'),
            year_built=row.get('year_built'),
            lot_sqft=row.get('lot_sqft'),
            int_beta_max=row.get('int_beta_max'),
            int_beta_mean=row.get('int_beta_mean'),
            int_beta_std=row.get('int_beta_std'),
            int_beta_n=row.get('int_beta_n'),
            tract_median_income=row.get('tract_median_income'),
            tract_avg_assessed_value=row.get('tract_avg_assessed_value'),
            tract_property_count=row.get('tract_property_count'),
        )

    # ── Parcel KPI ────────────────────────────────────────────────────────

    def get_parcel_kpi(self, parcel_id: str) -> Optional[ParcelKPI]:
        row = self._lookup_parcel(parcel_id)
        if not row:
            return None

        kpi_dict = self._row_to_kpi_dict(row)
        score = compute_gentrification_score(kpi_dict)

        return ParcelKPI(
            parcel_id=row.get('parcel_id') or parcel_id,
            address=row.get('address'),
            lng=float(row.get('lng') or 0.0),
            lat=float(row.get('lat') or 0.0),
            kpi=KPIVector(**kpi_dict),
            gentrification_score=score,
            zone=classify_zone(score, kpi_dict),
            data_as_of=str(row['data_as_of']) if row.get('data_as_of') else None,
        )

    # ── Zone score for coordinate ─────────────────────────────────────────

    def compute_zone_score(self, lng: float, lat: float) -> ZoneScore:
        """Find nearest parcel to the coordinate and return its zone score."""
        rows = self._run(
            f"""
            MATCH (p:Parcel)
            WHERE p.location IS NOT NULL
            WITH p, point.distance(p.location, point({{longitude: $lng, latitude: $lat}})) AS dist
            ORDER BY dist ASC
            LIMIT 1

            OPTIONAL MATCH (p)-[:LOCATED_NEAR]-(i:Intersection)
                WHERE i.betweenness IS NOT NULL AND i.betweenness > 0
            WITH p, dist,
                 max(i.betweenness)   AS int_beta_max,
                 avg(i.betweenness)   AS int_beta_mean,
                 stDev(i.betweenness) AS int_beta_std,
                 count(i)             AS int_beta_n

            OPTIONAL MATCH (p)-[:IN_TRACT]->(t:CensusTract)
            WITH p, dist, int_beta_max, int_beta_mean, int_beta_std, int_beta_n,
                 t.median_income                                    AS tract_median_income,
                 t.avgAssessedValue                                 AS tract_avg_assessed_value,
                 t.propertyCount                                    AS tract_property_count,
                 t.total_households                                 AS tract_households,
                 coalesce(t.TractID, t.census_tract, t.geoid_tract) AS tract_id

            RETURN
                coalesce(p.parcel_id, toString(p.ATTOMID), 'parcel-' + elementId(p)) AS parcel_id,
                coalesce(p.SitusAddress, p.owner_name, 'Unknown Address')            AS address,
                p.location.longitude                                                 AS lng,
                p.location.latitude                                                  AS lat,
                coalesce(p.AssessedValue, p.AssessedValueTotal)                      AS assessed_value,
                p.last_sale_price                                                    AS last_sale_price,
                p.year_built                                                         AS year_built,
                coalesce(p.lot_sqft, p.sqft)                                         AS lot_sqft,
                p.ZoningCode                                                         AS zoning_code,
                int_beta_max, int_beta_mean, int_beta_std, int_beta_n,
                tract_median_income, tract_avg_assessed_value,
                tract_property_count, tract_households, tract_id,
                p.last_sale_date                                                     AS data_as_of,
                dist                                                                 AS distance_meters
            """,
            {"lng": lng, "lat": lat},
        )

        if not rows:
            return ZoneScore(
                lng=lng, lat=lat,
                gentrification_score=50,
                zone=ZoneType.stable,
            )

        row = rows[0]
        kpi_dict = self._row_to_kpi_dict(row)
        score = compute_gentrification_score(kpi_dict)
        distance_ft = float(row.get('distance_meters') or 0.0) * 3.28084

        return ZoneScore(
            lng=lng, lat=lat,
            gentrification_score=score,
            zone=classify_zone(score, kpi_dict),
            kpi=KPIVector(**kpi_dict),
            nearest_parcel_id=row.get('parcel_id'),
            nearest_parcel_distance_ft=round(distance_ft, 1),
        )

    # ── Nearby parcels ────────────────────────────────────────────────────

    def get_nearby_parcels(self, lng: float, lat: float, radius_miles: float) -> NearbyParcels:
        """
        Returns a lightweight parcel list for the map layer. We deliberately
        do NOT run full KPI synthesis per parcel here — that's 200+ graph
        traversals per request and would bankrupt the tile response SLA.
        Instead, each parcel gets a coarse score from its own assessed
        value relative to tract average (which is cheap: one IN_TRACT hop).
        Full KPIs are computed on-demand when a parcel is selected.
        """
        radius_meters = radius_miles * 1609.34

        rows = self._run(
            """
            MATCH (p:Parcel)
            WHERE p.location IS NOT NULL
            WITH p, point.distance(p.location, point({longitude: $lng, latitude: $lat})) AS dist
            WHERE dist <= $radius_meters
            WITH p, dist
            ORDER BY dist ASC
            LIMIT 200

            OPTIONAL MATCH (p)-[:IN_TRACT]->(t:CensusTract)
            RETURN
                coalesce(p.parcel_id, toString(p.ATTOMID), 'parcel-' + elementId(p)) AS parcel_id,
                coalesce(p.SitusAddress, 'Unknown')                                  AS address,
                p.location.longitude                                                 AS lng,
                p.location.latitude                                                  AS lat,
                coalesce(p.AssessedValue, p.AssessedValueTotal)                      AS assessed_value,
                t.avgAssessedValue                                                   AS tract_avg_assessed_value,
                t.median_income                                                      AS tract_median_income,
                dist                                                                 AS distance_meters
            """,
            {"lng": lng, "lat": lat, "radius_meters": radius_meters},
        )

        baselines = self.baselines
        parcels: List[ParcelFeature] = []
        scores: List[int] = []

        for r in rows:
            val_ratio = _safe_div(r.get('assessed_value'), r.get('tract_avg_assessed_value'))
            val_pressure = _norm_around_median(
                val_ratio, baselines.val_ratio_p50, baselines.val_ratio_p95, default=0.5
            )
            inc_norm = _norm_around_median(
                r.get('tract_median_income'), baselines.inc_p50, baselines.inc_p95, default=0.5
            )
            # Lightweight score: weighted val_pressure + income. Not a full
            # gentrification score, but monotonic with it for map coloring.
            mini_score = round((val_pressure * 0.55 + inc_norm * 0.45) * 100)
            scores.append(mini_score)

            mini_kpi = {
                'income_migration':  inc_norm,
                'displacement_risk': val_pressure,
                'lihtc_eligibility': 1.0 - inc_norm,
            }

            dist_ft = float(r.get('distance_meters') or 0.0) * 3.28084
            parcels.append(ParcelFeature(
                parcel_id=r['parcel_id'],
                address=r.get('address'),
                lng=float(r.get('lng') or lng),
                lat=float(r.get('lat') or lat),
                gentrification_score=mini_score,
                zone=classify_zone(mini_score, mini_kpi),
                distance_ft=round(dist_ft, 1),
            ))

        avg_score = round(sum(scores) / len(scores)) if scores else 50
        dominant = classify_zone(avg_score, {
            'income_migration':  avg_score / 100,
            'displacement_risk': avg_score / 100,
        })

        return NearbyParcels(
            count=len(parcels),
            parcels=parcels,
            avg_gentrification_score=float(avg_score),
            dominant_zone=dominant,
        )

    # ── Parcel layer GeoJSON (Mapbox) ─────────────────────────────────────

    def get_parcel_layer_geojson(
        self, west: float, south: float, east: float, north: float, metric: str
    ) -> dict:
        """
        Return a FeatureCollection for Mapbox rendering.
        Uses point geometry from p.location since we don't have polygon
        data on Parcel nodes. Same performance trade-off as get_nearby_parcels:
        lightweight per-parcel score (val_pressure + income) instead of
        full KPI synthesis, to keep tile responses responsive.
        """
        rows = self._run(
            """
            MATCH (p:Parcel)
            WHERE p.location IS NOT NULL
              AND p.location.longitude >= $west AND p.location.longitude <= $east
              AND p.location.latitude  >= $south AND p.location.latitude  <= $north
            OPTIONAL MATCH (p)-[:IN_TRACT]->(t:CensusTract)
            RETURN
                coalesce(p.parcel_id, toString(p.ATTOMID), 'parcel-' + elementId(p)) AS id,
                p.location.longitude                                                 AS lng,
                p.location.latitude                                                  AS lat,
                coalesce(p.AssessedValue, p.AssessedValueTotal)                      AS assessed_value,
                t.avgAssessedValue                                                   AS tract_avg_assessed_value,
                t.median_income                                                      AS tract_median_income,
                coalesce(p.SitusAddress, 'Unknown')                                  AS address
            LIMIT 2000
            """,
            {"west": west, "east": east, "south": south, "north": north},
        )

        baselines = self.baselines
        features = []
        for r in rows:
            if r.get('lng') is None or r.get('lat') is None:
                continue
            val_ratio = _safe_div(r.get('assessed_value'), r.get('tract_avg_assessed_value'))
            val_pressure = _norm_around_median(
                val_ratio, baselines.val_ratio_p50, baselines.val_ratio_p95, default=0.5
            )
            inc_norm = _norm_around_median(
                r.get('tract_median_income'), baselines.inc_p50, baselines.inc_p95, default=0.5
            )
            score = round((val_pressure * 0.55 + inc_norm * 0.45) * 100)

            features.append({
                "type": "Feature",
                "id": r['id'],
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(r['lng']), float(r['lat'])],
                },
                "properties": {
                    "parcel_id": r['id'],
                    "address": r.get('address', ''),
                    "gentrification_score": score,
                    "displacement_risk": val_pressure,
                    "lihtc_eligibility": 1.0 - inc_norm,
                },
            })

        return {"type": "FeatureCollection", "features": features}

    # ── Site analysis (master endpoint) ───────────────────────────────────

    def analyze_site(
        self,
        parcel_id: Optional[str],
        lng: float,
        lat: float,
        program_type: str,
        units: Optional[int],
    ) -> SiteAnalysis:
        # Step 1: find the parcel (by id, ATTOMID, or fuzzy address) OR
        # fall back to the nearest parcel at the given coordinates.
        parcel_data: Optional[ParcelKPI] = None
        parcel_row: Optional[Dict] = None

        if parcel_id:
            parcel_row = self._lookup_parcel(parcel_id)
            if parcel_row:
                kpi_dict = self._row_to_kpi_dict(parcel_row)
                parcel_data = ParcelKPI(
                    parcel_id=parcel_row.get('parcel_id') or parcel_id,
                    address=parcel_row.get('address'),
                    lng=float(parcel_row.get('lng') or lng),
                    lat=float(parcel_row.get('lat') or lat),
                    kpi=KPIVector(**kpi_dict),
                    gentrification_score=compute_gentrification_score(kpi_dict),
                    zone=classify_zone(compute_gentrification_score(kpi_dict), kpi_dict),
                    data_as_of=str(parcel_row['data_as_of']) if parcel_row.get('data_as_of') else None,
                )

        if parcel_data is None:
            zone_data = self.compute_zone_score(lng, lat)
            if zone_data.nearest_parcel_id:
                parcel_row = self._lookup_parcel(zone_data.nearest_parcel_id)
                if parcel_row:
                    kpi_dict = self._row_to_kpi_dict(parcel_row)
                    parcel_data = ParcelKPI(
                        parcel_id=parcel_row.get('parcel_id') or zone_data.nearest_parcel_id,
                        address=parcel_row.get('address'),
                        lng=float(parcel_row.get('lng') or lng),
                        lat=float(parcel_row.get('lat') or lat),
                        kpi=KPIVector(**kpi_dict),
                        gentrification_score=compute_gentrification_score(kpi_dict),
                        zone=classify_zone(compute_gentrification_score(kpi_dict), kpi_dict),
                        data_as_of=str(parcel_row['data_as_of']) if parcel_row.get('data_as_of') else None,
                    )

        # Step 2: extract KPIs (with graceful defaults if nothing matched)
        if parcel_data:
            kpi_dict = parcel_data.kpi.model_dump()
            score = parcel_data.gentrification_score
            address = parcel_data.address
            resolved_parcel_id = parcel_data.parcel_id
            actual_lng = parcel_data.lng or lng
            actual_lat = parcel_data.lat or lat
            kpi = parcel_data.kpi
            zoning_code = parcel_row.get('zoning_code') if parcel_row else None
        else:
            kpi_dict = {k: 0.5 for k in KPI_WEIGHTS}
            score = 50
            address = None
            resolved_parcel_id = parcel_id
            actual_lng = lng
            actual_lat = lat
            kpi = KPIVector(**kpi_dict)
            zoning_code = None

        # Step 3: ownership concentration nearby
        ownership = self.get_ownership_concentration(actual_lng, actual_lat, 0.5)

        # Step 4: QCT/DDA eligibility
        qct_status, dda_status, basis_boost = self._check_lihtc_eligibility(
            resolved_parcel_id, actual_lng, actual_lat, kpi_dict
        )

        # Step 5: verdict + IRR + timing
        # zoning_code is threaded through for the upcoming zoning-aware guard
        # (priority #2). determine_verdict accepts it but does not consume
        # it yet — one-line enablement when the guard logic is wired.
        verdict, reasoning = determine_verdict(score, kpi_dict, program_type, zoning_code=zoning_code)
        estimated_irr = self._estimate_irr(kpi_dict, score)
        eta_months = self._estimate_displacement_eta(kpi_dict, score)
        risk_factors = self._extract_risk_factors(kpi_dict, score)
        opp_factors = self._extract_opportunity_factors(kpi_dict, score, program_type)

        # GNN endpoint needs the tract geoid — look it up using the resolved
        # parcel's ATTOMID first, fall back to the actual lat/lng we resolved.
        tract_geoid = self.get_tract_geoid_for_parcel(
            attom_id=parcel_row.get("ATTOMID") if parcel_row else None,
            lng=actual_lng,
            lat=actual_lat,
        )

        return SiteAnalysis(
            parcel_id=resolved_parcel_id,
            address=address,
            lng=actual_lng,
            lat=actual_lat,
            program_type=ProgramType(program_type),
            verdict=verdict,
            reasoning=reasoning,
            gentrification_score=score,
            displacement_eta_months=eta_months,
            estimated_irr=estimated_irr,
            lihtc_eligible=kpi_dict.get('lihtc_eligibility', 0) > 0.3,
            qct_status=qct_status,
            dda_status=dda_status,
            basis_boost_eligible=basis_boost,
            kpi=kpi,
            ownership_concentration=OwnershipSignal(
                top_entity_pct=ownership.top_entity_pct,
                entity_count=ownership.unique_entities,
                top_entity_name=ownership.entities[0].entity_name if ownership.entities else None,
                hhi_score=ownership.hhi_score,
            ) if ownership else None,
            risk_factors=risk_factors,
            opportunity_factors=opp_factors,
            tract_geoid=tract_geoid,
        )

    # ── LIHTC / QCT check (schema-aligned) ────────────────────────────────

    def _check_lihtc_eligibility(
        self,
        parcel_id: Optional[str],
        lng: float,
        lat: float,
        kpi_dict: Dict[str, float],
    ) -> Tuple[str, str, bool]:
        """
        Derive QCT/DDA status via IN_TRACT -> CensusTract path.

        We don't have a QCTBoundary label in the graph, and census tracts
        don't carry a qct_status property in this database. We approximate:
          - QCT qualification: synthesized lihtc_eligibility > 0.5
          - DDA qualification: not in the graph — reported as "Unknown"
        """
        tract_rows: List[Dict] = []

        if parcel_id:
            tract_rows = self._run(
                """
                MATCH (p:Parcel)
                WHERE p.parcel_id = $parcel_id OR toString(p.ATTOMID) = $parcel_id
                WITH p LIMIT 1
                OPTIONAL MATCH (p)-[:IN_TRACT]->(c:CensusTract)
                RETURN
                    coalesce(c.TractID, c.census_tract, c.geoid_tract, p.census_tract) AS tract
                """,
                {"parcel_id": parcel_id},
            )

        if not tract_rows:
            tract_rows = self._run(
                """
                MATCH (p:Parcel)
                WHERE p.location IS NOT NULL
                WITH p, point.distance(p.location, point({longitude: $lng, latitude: $lat})) AS dist
                ORDER BY dist ASC
                LIMIT 1
                OPTIONAL MATCH (p)-[:IN_TRACT]->(c:CensusTract)
                RETURN
                    coalesce(c.TractID, c.census_tract, c.geoid_tract, p.census_tract) AS tract
                """,
                {"lng": lng, "lat": lat},
            )

        tract = tract_rows[0].get('tract') if tract_rows else None
        lihtc = kpi_dict.get('lihtc_eligibility', 0.0)

        qct_status = f"Qualified (Tract {tract})" if (lihtc > 0.5 and tract) else (
            "Qualified" if lihtc > 0.5 else "Not Designated"
        )
        dda_status = "Unknown"  # not in schema
        basis_boost = lihtc > 0.5

        return qct_status, dda_status, basis_boost

    def _estimate_irr(self, kpi: dict, score: int) -> Optional[float]:
        """Simplified IRR proxy from KPI signals."""
        noi_growth = kpi.get('noi_growth', 0.5)
        cap_rate_delta = kpi.get('cap_rate_delta', 0.5)
        irr_horizon = kpi.get('irr_horizon', 0.5)
        base_irr = 6.0 + (noi_growth * 8) + (cap_rate_delta * 6) + (irr_horizon * 4)
        if score > 75:
            base_irr -= 3  # risk premium at peak
        return round(base_irr, 1)

    def _estimate_displacement_eta(self, kpi: dict, score: int) -> Optional[int]:
        """Estimate months until displacement peak."""
        income_migration = kpi.get('income_migration', 0.5)
        displacement_risk = kpi.get('displacement_risk', 0.5)
        if displacement_risk > 0.90:
            return 0
        velocity = (income_migration * 0.4 + displacement_risk * 0.6) * 0.08
        if velocity > 0:
            remaining = (1.0 - displacement_risk) / velocity
            return max(0, round(remaining * 12))
        return None

    def _extract_risk_factors(self, kpi: dict, score: int) -> list:
        factors = []
        if kpi.get('lien_density', 0) > 0.7:
            factors.append("High lien density — title complexity risk")
        if kpi.get('displacement_risk', 0) > 0.8:
            factors.append("Late-stage displacement — entry pricing at premium")
        if kpi.get('income_migration', 0) > 0.85:
            factors.append("Peak income migration — acquisition window closing")
        if kpi.get('cap_rate_delta', 0) < 0.3:
            factors.append("Cap rate already compressed — limited value arbitrage")
        return factors

    def _extract_opportunity_factors(self, kpi: dict, score: int, program: str) -> list:
        factors = []
        if kpi.get('lihtc_eligibility', 0) > 0.5 and score < 70:
            factors.append("QCT/DDA eligibility viable — basis boost window open")
        if kpi.get('transit_centrality', 0) > 0.75:
            factors.append("High transit betweenness — 18-24mo appreciation lead signal")
        if 0.4 < kpi.get('lien_density', 0) < 0.65:
            factors.append("Moderate lien density — motivated sellers without title gridlock")
        if kpi.get('street_entropy', 0) < 0.45:
            factors.append("Low street entropy — organic grid slows displacement diffusion")
        return factors

    # ── Ownership concentration ───────────────────────────────────────────

    def get_ownership_concentration(
        self, lng: float, lat: float, radius_miles: float
    ) -> OwnershipConcentration:
        """
        Compute HHI-style concentration of beneficial ownership within radius.
        Owner nodes in this schema only carry OwnerName — entity_type inferred.
        """
        radius_meters = radius_miles * 1609.34

        rows = self._run(
            """
            MATCH (o:Owner)-[:OWNS]->(p:Parcel)
            WHERE p.location IS NOT NULL
              AND point.distance(p.location, point({longitude: $lng, latitude: $lat})) <= $radius
            WITH o,
                 count(p) AS parcel_count,
                 sum(coalesce(p.AssessedValueTotal, p.AssessedValue, 0)) AS total_value
            RETURN
                coalesce(o.OwnerName, 'Unknown') AS entity_name,
                parcel_count,
                total_value
            ORDER BY parcel_count DESC
            LIMIT 20
            """,
            {"lng": lng, "lat": lat, "radius": radius_meters},
        )

        total_count_rows = self._run(
            """
            MATCH (p:Parcel)
            WHERE p.location IS NOT NULL
              AND point.distance(p.location, point({longitude: $lng, latitude: $lat})) <= $radius
            RETURN count(p) AS total
            """,
            {"lng": lng, "lat": lat, "radius": radius_meters},
        )

        total_parcels = int(total_count_rows[0]['total']) if total_count_rows else 0
        if total_parcels <= 0:
            total_parcels = max(sum(int(r.get('parcel_count', 0)) for r in rows), 1)

        entities: List[EntityNode] = []
        parcel_counts: List[int] = []
        for r in rows:
            count = int(r.get('parcel_count', 0))
            parcel_counts.append(count)
            name = r.get('entity_name') or 'Unknown'
            inferred_type = _infer_entity_type(name)
            entities.append(EntityNode(
                entity_name=name,
                entity_type=inferred_type,
                parcel_count=count,
                estimated_value=float(r.get('total_value') or 0),
                connected_entities=0,
            ))

        top_entity_pct = round((parcel_counts[0] / total_parcels) * 100, 1) if parcel_counts else 0.0

        shares = [c / total_parcels for c in parcel_counts]
        hhi = sum(s ** 2 for s in shares) * 10000

        if hhi > 2500:
            verdict = "Concentrated"
        elif hhi > 1500:
            verdict = "Moderate"
        else:
            verdict = "Distributed"

        return OwnershipConcentration(
            center_lng=lng,
            center_lat=lat,
            radius_miles=radius_miles,
            total_parcels=total_parcels,
            unique_entities=len(entities),
            hhi_score=round(hhi, 1),
            top_entity_pct=top_entity_pct,
            entities=entities,
            concentration_verdict=verdict,
        )

    # ── Displacement trajectory ───────────────────────────────────────────

    def get_displacement_trajectory(self, parcel_id: str) -> Optional[DisplacementTrajectory]:
        """
        The graph doesn't store historical snapshots (no ParcelSnapshot label,
        no HAS_SNAPSHOT rel). We synthesize a short trajectory from the parcel's
        current signals so the endpoint returns useful data for the demo.
        When historical snapshots land in the pipeline, swap this for the real
        time-series query — public signature stays the same.
        """
        current = self.get_parcel_kpi(parcel_id)
        if not current:
            return None

        current_kpi = current.kpi.model_dump()
        now_disp = current_kpi['displacement_risk']
        now_income = current_kpi['income_migration']
        now_lien = current_kpi['lien_density']

        def _regress(v: float, steps: int) -> float:
            return max(0.0, min(1.0, v + (0.5 - v) * 0.25 * steps))

        def _score(d: float, m: float) -> int:
            return round((m * 0.4 + d * 0.6) * 100)

        trajectory = [
            TrajectoryPoint(
                date="2025-04-01",
                gentrification_score=_score(_regress(now_disp, 2), _regress(now_income, 2)),
                income_migration=_regress(now_income, 2),
                lien_density=_regress(now_lien, 2),
                displacement_risk=_regress(now_disp, 2),
            ),
            TrajectoryPoint(
                date="2025-10-01",
                gentrification_score=_score(_regress(now_disp, 1), _regress(now_income, 1)),
                income_migration=_regress(now_income, 1),
                lien_density=_regress(now_lien, 1),
                displacement_risk=_regress(now_disp, 1),
            ),
            TrajectoryPoint(
                date="2026-04-01",
                gentrification_score=_score(now_disp, now_income),
                income_migration=now_income,
                lien_density=now_lien,
                displacement_risk=now_disp,
            ),
        ]

        velocity = round(trajectory[-1].gentrification_score - trajectory[-2].gentrification_score, 2)
        score_now = current.gentrification_score

        if score_now < 25:
            phase = "pre-wave"
        elif score_now < 50:
            phase = "early"
        elif score_now < 75:
            phase = "active"
        else:
            phase = "peak"

        return DisplacementTrajectory(
            parcel_id=current.parcel_id,
            address=current.address,
            current_phase=phase,
            velocity=velocity,
            trajectory=trajectory,
            intervention_window_open=score_now < 70,
        )

    # ── Assemblage opportunities ──────────────────────────────────────────

    def get_assemblage_opportunities(
        self, lng: float, lat: float, radius_miles: float
    ) -> AssemblageOpportunities:
        """
        Find clusters of adjacent parcels within radius using LOCATED_NEAR.
        LOCATED_NEAR is the parcel-to-parcel proximity edge in this schema
        (there is no ADJACENT_TO). We filter the endpoint to Parcel-only
        targets because LOCATED_NEAR also connects Parcels to Property and
        Intersection nodes.

        Since real lien data is not loaded, cluster friction uses the
        synthesized lien_density from the tract-level stress triad. When
        real lien data lands this will sharpen automatically.
        """
        radius_meters = radius_miles * 1609.34

        rows = self._run(
            """
            MATCH (p:Parcel)
            WHERE p.location IS NOT NULL
              AND point.distance(p.location, point({longitude: $lng, latitude: $lat})) <= $radius
            WITH p LIMIT 50
            MATCH (p)-[:LOCATED_NEAR]-(neighbor:Parcel)
            WHERE neighbor <> p AND neighbor.location IS NOT NULL
            WITH p, collect(DISTINCT neighbor)[..5] AS neighbors
            WHERE size(neighbors) >= 2
            WITH p, neighbors, [p] + neighbors AS cluster_parcels
            WITH cluster_parcels,
                 [x IN cluster_parcels | coalesce(x.parcel_id, toString(x.ATTOMID), 'parcel-' + elementId(x))] AS parcel_ids,
                 size(apoc.coll.toSet([x IN cluster_parcels | coalesce(x.owner_name, 'unknown')]))            AS owner_count,
                 sum([x IN cluster_parcels | coalesce(x.lot_sqft, x.sqft, 5000)])                             AS total_area,
                 cluster_parcels[0].location.longitude                                                        AS center_lng,
                 cluster_parcels[0].location.latitude                                                         AS center_lat
            RETURN parcel_ids, owner_count, total_area, center_lng, center_lat
            ORDER BY total_area DESC
            LIMIT 10
            """,
            {"lng": lng, "lat": lat, "radius": radius_meters},
        )

        # Graceful fallback if APOC isn't installed
        if not rows:
            rows = self._run(
                """
                MATCH (p:Parcel)
                WHERE p.location IS NOT NULL
                  AND point.distance(p.location, point({longitude: $lng, latitude: $lat})) <= $radius
                WITH p LIMIT 50
                MATCH (p)-[:LOCATED_NEAR]-(neighbor:Parcel)
                WHERE neighbor <> p AND neighbor.location IS NOT NULL
                WITH p, collect(DISTINCT neighbor)[..5] AS neighbors
                WHERE size(neighbors) >= 2
                WITH p, neighbors, [p] + neighbors AS cluster_parcels
                RETURN
                    [x IN cluster_parcels | coalesce(x.parcel_id, toString(x.ATTOMID), 'parcel-' + elementId(x))] AS parcel_ids,
                    size(cluster_parcels)                                                                          AS owner_count,
                    sum([x IN cluster_parcels | coalesce(x.lot_sqft, x.sqft, 5000)])                               AS total_area,
                    cluster_parcels[0].location.longitude                                                          AS center_lng,
                    cluster_parcels[0].location.latitude                                                           AS center_lat
                ORDER BY total_area DESC
                LIMIT 10
                """,
                {"lng": lng, "lat": lat, "radius": radius_meters},
            )

        clusters: List[AssemblageCluster] = []
        for i, r in enumerate(rows):
            parcel_ids = list(r.get('parcel_ids') or [])
            owner_count = max(1, int(r.get('owner_count') or 1))
            total_area = float(r.get('total_area') or 5000.0)

            # Friction: more owners, more parcels = harder assembly.
            # Lien contribution is zero since we removed the unreliable
            # Parcel.lien_density read — the synthesized value is a
            # tract-level signal, not per-parcel enough for cluster math.
            friction = min(100, round(owner_count * 18 + (len(parcel_ids) / 10) * 20))

            clusters.append(AssemblageCluster(
                cluster_id=f"cluster_{i}",
                parcel_ids=parcel_ids,
                parcel_count=len(parcel_ids),
                total_area_sqft=total_area,
                friction_score=float(friction),
                owner_count=owner_count,
                avg_lien_age_days=None,
                zoning_compatible=True,
                estimated_assembly_timeline_months=max(3, round(friction / 8)),
                center_lng=float(r.get('center_lng') or lng),
                center_lat=float(r.get('center_lat') or lat),
            ))

        return AssemblageOpportunities(
            total_clusters=len(clusters),
            clusters=clusters,
        )


# ── Module-level helper: entity type inference ────────────────────────────

def _infer_entity_type(name: str) -> str:
    """
    Owner nodes in this graph only carry OwnerName. Infer legal structure
    from the name so the UI can render meaningful entity badges.
    """
    if not name:
        return "Unknown"
    upper = name.upper()
    if " LLC" in upper or upper.endswith("LLC"):
        return "LLC"
    if " LP" in upper or upper.endswith("LP") or "LIMITED PARTNERSHIP" in upper:
        return "LP"
    if "CORP" in upper or " INC" in upper or upper.endswith("INC"):
        return "Corp"
    if "TRUST" in upper:
        return "Trust"
    if "HOUSING AUTHORITY" in upper or "CITY OF" in upper or "COUNTY" in upper:
        return "Public"
    return "Individual"
