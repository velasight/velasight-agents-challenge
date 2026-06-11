"""
Velasight Prediction Service
FastAPI service exposing GNN-calibrated tract and parcel predictions
backed by Neo4j. Reads predictions written by the velasight_v1
training pipeline.
"""

import json
import logging
import math
import os
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# === Model metadata (held in code; v2 retrain will write these to a config file) ===
DISP_HEAD_R2 = 0.782
RENT_HEAD_R2 = 0.120
DISP_TYPICAL_SCALE = 0.10
RENT_TYPICAL_SCALE = 0.15


# === Schemas ===
class ConfidenceBreakdown(BaseModel):
    model_quality: float = Field(..., description="Test R² of this head")
    local_precision: float = Field(..., description="Tightness of this PI relative to scale")
    composite: float = Field(..., description="0.7 × quality + 0.3 × precision")


class TileMetric(BaseModel):
    value: float
    lower: float
    upper: float
    regime: str
    confidence: ConfidenceBreakdown


class CompositeMetric(BaseModel):
    value: float
    regime: str
    components: dict


class PredictionResponse(BaseModel):
    tract_geoid: str
    parcel_id: Optional[str] = None
    displacement_risk: TileMetric
    rent_growth: TileMetric
    gent_score: CompositeMetric
    absorption_driven_appreciation: CompositeMetric
    blended_irr: CompositeMetric
    prediction_run_id: str
    prediction_updated_at: str


# === Helpers ===
def classify_regime(v, low_t, high_t):
    return "low" if v < low_t else ("high" if v > high_t else "medium")


def compute_confidence(pi_halfwidth, head_r2, typical_scale):
    model_quality = max(0.0, head_r2)
    local_precision = max(0.0, min(1.0, 1 - pi_halfwidth / typical_scale))
    composite = 0.7 * model_quality + 0.3 * local_precision
    return {
        "model_quality": round(model_quality, 3),
        "local_precision": round(local_precision, 3),
        "composite": round(composite, 3),
    }


def compute_gent_score(disp, rent):
    disp_norm = min(disp / 0.20, 1.0)
    rent_norm = min(max(rent / 0.20, 0.0), 1.0)
    score = 100 * (0.5 * disp_norm + 0.5 * rent_norm)
    return CompositeMetric(
        value=round(score, 2),
        regime=classify_regime(score, 30, 60),
        components={
            "displacement_contribution": round(50 * disp_norm, 2),
            "rent_growth_contribution": round(50 * rent_norm, 2),
        },
    )


def compute_ada(disp, rent, pi_disp, pi_rent):
    z_rent = (rent - 0.05) / max(pi_rent / 1.645, 0.001)
    p_rent = 0.5 * (1 + math.erf(z_rent / math.sqrt(2)))
    z_disp = (disp - 0.03) / max(pi_disp / 1.645, 0.001)
    p_disp = 0.5 * (1 + math.erf(z_disp / math.sqrt(2)))
    ada = p_rent * (1 - p_disp) * 1.0 * 100
    return CompositeMetric(
        value=round(ada, 2),
        regime=classify_regime(ada, 25, 60),
        components={
            "p_rent_above_5pct": round(p_rent, 3),
            "p_disp_above_3pct": round(p_disp, 3),
            "absorption_multiplier": 1.0,
        },
    )


def compute_blended_irr(rent, disp, base_cap=0.06):
    risk_premium = disp * 12 * 0.4  # TODO v2: replace 0.4 placeholder with property-type-aware weighting
    irr = base_cap + rent - risk_premium
    return CompositeMetric(
        value=round(irr, 4),
        regime=classify_regime(irr, 0.05, 0.12),
        components={
            "base_cap_rate": base_cap,
            "rent_growth_appreciation": round(rent, 4),
            "displacement_risk_premium": round(risk_premium, 4),
        },
    )


def _build_response(rec, parcel_id=None):
    disp, disp_lo, disp_hi = rec["disp"], rec["disp_lo"], rec["disp_hi"]
    rent, rent_lo, rent_hi = rec["rent"], rec["rent_lo"], rec["rent_hi"]
    pi_disp = (disp_hi - disp_lo) / 2
    pi_rent = (rent_hi - rent_lo) / 2

    return PredictionResponse(
        tract_geoid=rec["geoid"],
        parcel_id=parcel_id,
        displacement_risk=TileMetric(
            value=disp, lower=disp_lo, upper=disp_hi,
            regime=classify_regime(disp, 0.02, 0.08),
            confidence=ConfidenceBreakdown(**compute_confidence(pi_disp, DISP_HEAD_R2, DISP_TYPICAL_SCALE)),
        ),
        rent_growth=TileMetric(
            value=rent, lower=rent_lo, upper=rent_hi,
            regime=classify_regime(rent, 0.03, 0.10),
            confidence=ConfidenceBreakdown(**compute_confidence(pi_rent, RENT_HEAD_R2, RENT_TYPICAL_SCALE)),
        ),
        gent_score=compute_gent_score(disp, rent),
        absorption_driven_appreciation=compute_ada(disp, rent, pi_disp, pi_rent),
        blended_irr=compute_blended_irr(rent, disp),
        prediction_run_id=rec["run_id"],
        prediction_updated_at=str(rec["updated_at"]),
    )


# === Lifespan ===
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.driver = GraphDatabase.driver(
        os.environ.get("NEO4J_URI"),
        auth=(os.environ.get("NEO4J_USER", "neo4j"), os.environ.get("NEO4J_PASSWORD"))
    )
    logger.info("Neo4j connected (predictor service)")
    yield
    app.state.driver.close()
    logger.info("Neo4j disconnected (predictor service)")


# === App ===
app = FastAPI(
    title="Velasight Prediction Service",
    description="GNN-calibrated tract and parcel predictions for institutional CRE",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "service": "velasight-predictor", "model_version": "velasight_v1_heterosage"}


@app.get("/predictions/tract/{tract_geoid}", response_model=PredictionResponse)
def get_tract_prediction(tract_geoid: str):
    with app.state.driver.session() as session:
        rec = session.run(
            """
            MATCH (t:EvictionTract {geoid: $geoid})
            WHERE t.predicted_displacement_risk IS NOT NULL
            RETURN t.geoid AS geoid,
                   t.predicted_displacement_risk AS disp,
                   t.predicted_displacement_risk_lower AS disp_lo,
                   t.predicted_displacement_risk_upper AS disp_hi,
                   t.predicted_rent_growth AS rent,
                   t.predicted_rent_growth_lower AS rent_lo,
                   t.predicted_rent_growth_upper AS rent_hi,
                   t.prediction_run_id AS run_id,
                   t.prediction_updated_at AS updated_at
            """,
            geoid=tract_geoid,
        ).single()
        if not rec:
            raise HTTPException(404, f"No predictions for tract {tract_geoid}")
        return _build_response(dict(rec))


@app.get("/predictions/parcel/{parcel_id}", response_model=PredictionResponse)
def get_parcel_prediction(parcel_id: str):
    with app.state.driver.session() as session:
        rec = session.run(
            """
            MATCH (p:Parcel {parcel_id: $pid})-[:IN_TRACT]->(t:EvictionTract)
            WHERE t.predicted_displacement_risk IS NOT NULL
            RETURN t.geoid AS geoid,
                   t.predicted_displacement_risk AS disp,
                   t.predicted_displacement_risk_lower AS disp_lo,
                   t.predicted_displacement_risk_upper AS disp_hi,
                   t.predicted_rent_growth AS rent,
                   t.predicted_rent_growth_lower AS rent_lo,
                   t.predicted_rent_growth_upper AS rent_hi,
                   t.prediction_run_id AS run_id,
                   t.prediction_updated_at AS updated_at
            LIMIT 1
            """,
            pid=parcel_id,
        ).single()
        if not rec:
            raise HTTPException(404, f"No predictions for parcel {parcel_id}")
        return _build_response(dict(rec), parcel_id=parcel_id)