from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, List, Dict, Any
from enum import Enum

class ProgramType(str, Enum):
    mixed_use = "mixed_use"
    multifamily = "multifamily"
    affordable = "affordable"
    commercial = "commercial"
    industrial = "industrial"
    data_center = "data_center"


class VerdictType(str, Enum):
    DEVELOP = "DEVELOP"
    CAUTION = "CAUTION"
    HOLD = "HOLD"
    AVOID = "AVOID"


class ZoneType(str, Enum):
    opportunity = "opportunity"
    displacement = "displacement"
    stable = "stable"
    custom = "custom"


# ── KPI ──────────────────────────────────────────────────────

class KPIVector(BaseModel):
    # ── Existing multifamily-shared fields ──────────────────────
    transit_centrality: float = Field(ge=0, le=1)
    school_gradient: float = Field(ge=0, le=1)
    noi_growth: float = Field(ge=0, le=1)
    income_migration: float = Field(ge=0, le=1)
    lien_density: float = Field(ge=0, le=1)
    cap_rate_delta: float = Field(ge=0, le=1)
    street_entropy: float = Field(ge=0, le=1)
    displacement_risk: float = Field(ge=0, le=1)
    lihtc_eligibility: float = Field(ge=0, le=1)
    irr_horizon: float = Field(ge=0, le=1)

    # ── NEW: DC-program fields (Optional so multifamily payloads stay valid) ──
    dc_suitability_score: Optional[float] = Field(default=None, ge=0, le=1)
    substation_proximity: Optional[float] = Field(default=None, ge=0, le=1)
    fiber_latency: Optional[float] = Field(default=None, ge=0, le=1)
    appreciation_trajectory: Optional[float] = Field(default=None, ge=0, le=1)

    def to_list(self) -> List[float]:
        # NOTE: existing callers expect 10-element list. Keep that contract;
        # DC fields don't enter the legacy vector. The DC-program flow reads
        # the named fields directly off the KPIVector instance.
        return [
            self.transit_centrality, self.school_gradient, self.noi_growth,
            self.income_migration, self.lien_density, self.cap_rate_delta,
            self.street_entropy, self.displacement_risk, self.lihtc_eligibility,
            self.irr_horizon
        ]


class ParcelKPI(BaseModel):
    parcel_id: str
    address: Optional[str] = None
    lng: float
    lat: float
    kpi: KPIVector
    gentrification_score: int = Field(ge=0, le=100)
    zone: ZoneType
    data_as_of: Optional[str] = None


# ── Zone score ───────────────────────────────────────────────

class ZoneScore(BaseModel):
    lng: float
    lat: float
    gentrification_score: int = Field(ge=0, le=100)
    zone: ZoneType
    kpi: Optional[KPIVector] = None
    nearest_parcel_id: Optional[str] = None
    nearest_parcel_distance_ft: Optional[float] = None


# ── Site analysis ────────────────────────────────────────────

class OwnershipSignal(BaseModel):
    top_entity_pct: float
    entity_count: int
    top_entity_name: Optional[str] = None
    hhi_score: Optional[float] = None  # Herfindahl-Hirschman Index


class SiteAnalysis(BaseModel):
    parcel_id: Optional[str] = None
    address: Optional[str] = None
    lng: float
    lat: float
    program_type: ProgramType = ProgramType.mixed_use
    verdict: VerdictType
    reasoning: str
    gentrification_score: int
    displacement_eta_months: Optional[int] = None
    estimated_irr: Optional[float] = None
    lihtc_eligible: bool = False
    qct_status: Optional[str] = None
    dda_status: Optional[str] = None
    basis_boost_eligible: bool = False
    kpi: Optional[KPIVector] = None
    ownership_concentration: Optional[OwnershipSignal] = None
    risk_factors: List[str] = []
    opportunity_factors: List[str] = []
    tract_geoid: Optional[str] = None


class SiteAnalysisRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    parcel_id: Optional[str] = None
    lng: float
    lat: float
    # Alias allows the backend to accept 'programType' from the frontend
    program_type: str = Field(default="mixed_use", alias="programType")
    units: Optional[int] = 0

# ── Nearby parcels ───────────────────────────────────────────

class ParcelFeature(BaseModel):
    parcel_id: str
    address: Optional[str] = None
    lng: float
    lat: float
    gentrification_score: int
    zone: ZoneType
    distance_ft: float


class NearbyParcels(BaseModel):
    count: int
    parcels: List[ParcelFeature]
    avg_gentrification_score: float
    dominant_zone: ZoneType


# ── Displacement trajectory ──────────────────────────────────

class TrajectoryPoint(BaseModel):
    date: str  # ISO date string
    gentrification_score: int
    income_migration: float
    lien_density: float
    displacement_risk: float


class DisplacementTrajectory(BaseModel):
    parcel_id: str
    address: Optional[str] = None
    wave_start_date: Optional[str] = None
    current_phase: str  # "pre-wave", "early", "peak", "post"
    velocity: float  # score change per month
    trajectory: List[TrajectoryPoint]
    projected_peak_date: Optional[str] = None
    intervention_window_open: bool


# ── Ownership ────────────────────────────────────────────────

class EntityNode(BaseModel):
    entity_name: str
    entity_type: str  # LLC, LP, Corp, Individual
    parcel_count: int
    estimated_value: Optional[float] = None
    connected_entities: int


class OwnershipConcentration(BaseModel):
    center_lng: float
    center_lat: float
    radius_miles: float
    total_parcels: int
    unique_entities: int
    hhi_score: float
    top_entity_pct: float
    entities: List[EntityNode]
    concentration_verdict: str  # "Concentrated", "Moderate", "Distributed"


# ── Assemblage ───────────────────────────────────────────────

class AssemblageCluster(BaseModel):
    cluster_id: str
    parcel_ids: List[str]
    parcel_count: int
    total_area_sqft: float
    friction_score: float  # 0-100, lower = easier to assemble
    owner_count: int
    avg_lien_age_days: Optional[float] = None
    zoning_compatible: bool
    estimated_assembly_timeline_months: int
    center_lng: float
    center_lat: float

class ConfidenceInterval(BaseModel):
    r2_mean: float = Field(..., description="K-fold cross-validated mean R²")
    r2_std: float = Field(..., description="K-fold cross-validated std R²")
    n_folds: int = Field(5, description="Number of folds")

class DCCalibration(BaseModel):
    """Calibration metrics for DC suitability predictions (binary classification).

    Parallel to ConfidenceInterval, which is for regression heads.
    DC suitability is a binary outcome (DC-suitable or not), so we report
    Brier score and Expected Calibration Error rather than R².
    """
    brier_score: float = Field(..., description="Mean squared error of probabilistic predictions (0 = perfect, 0.25 = always-50%-baseline)")
    ece: float = Field(..., description="Expected Calibration Error across probability bins")
    auc_mean: float = Field(..., description="K-fold cross-validated mean AUC")
    auc_std: float = Field(..., description="K-fold cross-validated std AUC")
    n_folds: int = Field(5, description="Number of spatial cross-validation folds")


class TractRentForecast(BaseModel):
    """Per-bedroom rent prediction for a single year-pair."""
    bedroom_0br: float
    bedroom_1br: float
    bedroom_2br: float
    bedroom_3br: float
    bedroom_4br: float


class GNNTractPrediction(BaseModel):
    """Full GNN prediction output for one tract."""
    geoid: str
    displacement_risk: float = Field(..., description="Predicted forward eviction rate")
    displacement_risk_confidence: ConfidenceInterval
    rent_growth_yoy_2023_2024: TractRentForecast
    rent_growth_yoy_2024_2025: TractRentForecast
    rent_growth_yoy_2025_2026: TractRentForecast = Field(
        ..., description="Forward year prediction — most relevant for underwriting"
    )
    rent_growth_confidence: Dict[str, ConfidenceInterval]
    model_version: str

class AssemblageOpportunities(BaseModel):
    total_clusters: int
    clusters: List[AssemblageCluster]


# ── Amsterdam pand-level (DC discovery) ──────────────────────

class PandRecord(BaseModel):
    """Per-pand DC suitability prediction with cluster intelligence.

    Source: amsterdam_dc_discovery_top200_cleaned.parquet.
    The cleaned parquet excludes is_suspect rows and known DCs, so every
    record here is a discovery candidate.
    """
    pand_id: str
    score: float = Field(..., description="GNN DC suitability output, 0-1")
    rank: int = Field(..., description="Rank within the discovery cohort (1 = highest score)")
    latitude: float
    longitude: float
    # Raw features fed to the GNN
    pand_opp_max: float = Field(..., description="Building footprint area (m²)")
    pand_bouwjaar: int = Field(..., description="Year built")
    omgevingsadressendichtheid: Optional[float] = Field(None, description="Address density in surrounding area")
    bevolkingsdichtheid_inwoners_per_km2: Optional[float] = Field(None, description="Population density (inhabitants per km²)")
    aantal_inwoners: Optional[float] = Field(None, description="Number of inhabitants in surrounding area")
    # Geographic context
    buurtcode: str
    buurtnaam: Optional[str] = None
    gemeentenaam: Optional[str] = None
    # Cluster intelligence — derived at load time, not in the parquet
    cluster_size: int = Field(..., description="How many candidates in the same buurt (>= 1)")
    is_cluster_anchor: bool = Field(..., description="True if this is the highest-scoring pand in its buurt")
    cluster_anchor_pand_id: str = Field(..., description="Pand_id of the anchor (this pand if is_cluster_anchor)")


class PandDiscoveryResponse(BaseModel):
    """Batch response for the radar — all top-N candidates in one call."""
    panden: List[PandRecord]
    total: int
    unique_clusters: int = Field(..., description="Number of unique buurts in the response")
    model_version: str = "amsterdam_v3"
    data_vintage: str = Field(..., description="Predictions parquet filename")


