"""
Velasight Explore API
FastAPI backend serving spatial KPI intelligence for Velasight Explore.
Powered by Neo4j graph database on Google Cloud / Vertex AI.
"""

from fastapi import FastAPI, HTTPException, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import List
from contextlib import asynccontextmanager
from pathlib import Path
from gnn_inference import GNNInferenceService, BEDROOMS
from models import GNNTractPrediction, TractRentForecast, ConfidenceInterval

import os
import logging
from dotenv import load_dotenv

load_dotenv()

from models import (
    ParcelKPI, ZoneScore, SiteAnalysis, NearbyParcels,
    OwnershipConcentration, DisplacementTrajectory,
    AssemblageOpportunities, SiteAnalysisRequest,
    PandRecord, PandDiscoveryResponse,
)
from neo4j_queries import VelasightGraph

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── App lifespan ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Connect to Neo4j on startup
    app.state.graph = VelasightGraph(
        uri=os.environ.get("NEO4J_URI"),
        user=os.environ.get("NEO4J_USER", "neo4j"),
        password=os.environ.get("NEO4J_PASSWORD")
    )
    logger.info("Neo4j connected")

    # Warm + log KPI baselines
    try:
        logger.info("Velasight baselines: %s", app.state.graph.baselines.describe())
    except Exception as e:
        logger.warning("Baseline warm-up failed (will retry at request time): %s", e)

    # Load GNN inference service
    artifacts = Path(os.environ.get("GNN_ARTIFACTS_DIR", "./artifacts"))
    try:
        app.state.gnn = GNNInferenceService(artifacts)
        app.state.gnn.initialize()
        logger.info("GNN inference service initialized")
    except Exception as e:
        logger.error("GNN init failed (predict endpoints will return 503): %s", e)
        app.state.gnn = None

    yield

    app.state.graph.close()
    logger.info("Neo4j disconnected")

# Single app instance preserving the database lifespan
app = FastAPI(
    title="Velasight Explore API",
    version="1.0.0",
    lifespan=lifespan
)

# Explicitly allowing Vite and standard React ports
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _rent_forecast_from_dict(d: dict) -> TractRentForecast:
    return TractRentForecast(
        bedroom_0br=d["0br"], bedroom_1br=d["1br"], bedroom_2br=d["2br"],
        bedroom_3br=d["3br"], bedroom_4br=d["4br"],
    )

# ── Security & Dependencies ──────────────────────────────────

# auto_error=False lets requests WITHOUT an Authorization header reach
# verify_token rather than being rejected by FastAPI's built-in handler.
# In demo mode we accept all requests; in production we'll inspect the
# credentials object inside verify_token and raise 401 there instead.
security = HTTPBearer(auto_error=False)

def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """
    Auth gate for the Explore API.

    DEMO MODE (current): accepts all requests. This unblocks the Velasight
    Home pilot and the Vapi voice webhook — neither of which sends a
    bearer token today. Restore the real token check before any public
    deployment.

    PRODUCTION MODE (commented below): reads API_BEARER_TOKEN from env
    and rejects requests whose bearer value does not match.
    """
    # --- DEMO MODE -----------------------------------------------------
    return True

    # --- PRODUCTION MODE (uncomment when ready to re-enable auth) -----
    # if credentials is None:
    #     raise HTTPException(status_code=401, detail="Missing authentication token")
    # expected_token = os.environ.get("API_BEARER_TOKEN")
    # if not expected_token:
    #     raise HTTPException(status_code=500, detail="API_BEARER_TOKEN not configured")
    # if credentials.credentials != expected_token:
    #     raise HTTPException(status_code=401, detail="Invalid authentication token")
    # return credentials.credentials

def get_graph(request: Request) -> VelasightGraph:
    """Extract graph instance from app state."""
    return request.app.state.graph

# ── Health ───────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "velasight-explore-api"}

# ── Master Analysis Endpoint ─────────────────────────────────

@app.post("/api/v1/site/analyze", response_model=SiteAnalysis)
async def analyze_site(
    body: SiteAnalysisRequest,
    request: Request,
    _: HTTPAuthorizationCredentials = Depends(verify_token)
):
    """
    Master endpoint for Velasight Explore Vapi Tool.
    Requires Parcel ID/Address, extracts localized context, computes
    zoning viability, and runs programmatic underwriting heuristics.
    """
    graph: VelasightGraph = get_graph(request)
    return graph.analyze_site(
        parcel_id=body.parcel_id,
        lng=body.lng,
        lat=body.lat,
        program_type=body.program_type,
        units=body.units
    )

# ── Ownership ────────────────────────────────────────────────

@app.get("/api/v1/ownership/concentration", response_model=OwnershipConcentration)
async def get_ownership_concentration(
    request: Request,
    lng: float = Query(...),
    lat: float = Query(...),
    radius_miles: float = Query(1.0, ge=0.1, le=5.0),
    _: HTTPAuthorizationCredentials = Depends(verify_token)
):
    """
    Beneficial ownership concentration in submarket.
    Traverses LLC → registered agent → common signatory chains.
    """
    graph: VelasightGraph = get_graph(request)
    return graph.get_ownership_concentration(lng, lat, radius_miles)

# ── Assemblage ───────────────────────────────────────────────

@app.get("/api/v1/assemblage/nearby", response_model=AssemblageOpportunities)
async def get_assemblage_opportunities(
    request: Request,
    lng: float = Query(...),
    lat: float = Query(...),
    radius_miles: float = Query(0.5, ge=0.1, le=2.0),
    _: HTTPAuthorizationCredentials = Depends(verify_token)
):
    """
    Assemblageable parcel clusters near a point.
    Ranked by friction score (title complexity × ownership fragmentation).
    """
    graph: VelasightGraph = get_graph(request)
    return graph.get_assemblage_opportunities(lng, lat, radius_miles)


# ── NEW: GNN prediction endpoint ──

@app.get("/api/v1/predict/tract/{geoid}", response_model=GNNTractPrediction)
async def predict_tract_gnn(
    geoid: str,
    request: Request,
    _: HTTPAuthorizationCredentials = Depends(verify_token),
):
    """
    Returns GNN model predictions for a tract: displacement risk and
    per-bedroom rent growth across three year-pairs, with k-fold validated
    confidence intervals.
    """
    if request.app.state.gnn is None:
        raise HTTPException(503, "GNN service not initialized — check server logs")
    pred = request.app.state.gnn.predict_tract(geoid)
    if not pred:
        raise HTTPException(404, f"Tract {geoid} not in GNN index")

    return GNNTractPrediction(
        geoid=geoid,
        displacement_risk=pred["displacement_risk"],
        displacement_risk_confidence=ConfidenceInterval(**pred["displacement_risk_confidence"]),
        rent_growth_yoy_2023_2024=_rent_forecast_from_dict(pred["rent_growth_yoy"]["2023_2024"]),
        rent_growth_yoy_2024_2025=_rent_forecast_from_dict(pred["rent_growth_yoy"]["2024_2025"]),
        rent_growth_yoy_2025_2026=_rent_forecast_from_dict(pred["rent_growth_yoy"]["2025_2026"]),
        rent_growth_confidence={
            k: ConfidenceInterval(**v) for k, v in pred["rent_growth_confidence"].items()
        },
        model_version=pred["model_version"],
    )


# ── Amsterdam DC discovery (pand-level) ─────────────────────

@app.get("/api/v1/predict/pand/discovery", response_model=PandDiscoveryResponse)
async def get_pand_discovery(
    request: Request,
    limit: int = Query(200, ge=1, le=500),
    _: HTTPAuthorizationCredentials = Depends(verify_token),
):
    """
    Top-N Amsterdam DC discovery candidates with cluster intelligence.

    Each pand carries its buurt context plus derived cluster signals
    (cluster_size, is_cluster_anchor, cluster_anchor_pand_id) so the
    radar frontend can render anchor/supporting relationships without
    additional API calls.

    Source: amsterdam_dc_discovery_top200_cleaned.parquet (filtered to
    remove is_suspect rows and known existing DCs).
    """
    gnn = request.app.state.gnn
    if gnn is None or not gnn.amsterdam_predictions:
        raise HTTPException(503, "Amsterdam DC predictions not loaded — check server logs")

    records = gnn.get_pand_discovery(limit=limit)
    return PandDiscoveryResponse(
        panden=[PandRecord(**r) for r in records],
        total=len(records),
        unique_clusters=len({r["buurtcode"] for r in records}),
        data_vintage=gnn.amsterdam_source or "unknown",
    )


@app.get("/api/v1/predict/pand/{pand_id}", response_model=PandRecord)
async def predict_pand(
    pand_id: str,
    request: Request,
    _: HTTPAuthorizationCredentials = Depends(verify_token),
):
    """
    Single pand prediction lookup. Returns the same cluster-annotated
    record the discovery endpoint emits, scoped to one pand_id.
    """
    gnn = request.app.state.gnn
    if gnn is None or not gnn.amsterdam_predictions:
        raise HTTPException(503, "Amsterdam DC predictions not loaded — check server logs")

    pred = gnn.predict_pand(pand_id)
    if not pred:
        raise HTTPException(404, f"Pand {pand_id} not in discovery cohort")

    return PandRecord(**pred)


@app.get("/api/v1/predict/pand/cluster/{buurtcode}", response_model=List[PandRecord])
async def get_pand_cluster(
    buurtcode: str,
    request: Request,
    _: HTTPAuthorizationCredentials = Depends(verify_token),
):
    """
    All discovery candidates within a single buurt, sorted by score desc
    (anchor first). Used by the radar's cluster-composition panel.
    """
    gnn = request.app.state.gnn
    if gnn is None or not gnn.amsterdam_predictions:
        raise HTTPException(503, "Amsterdam DC predictions not loaded — check server logs")

    records = gnn.get_pand_cluster(buurtcode)
    if records is None:
        raise HTTPException(404, f"No candidates in buurt {buurtcode}")
    return [PandRecord(**r) for r in records]