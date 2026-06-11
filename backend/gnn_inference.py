"""
GNN inference service for Velasight Explore API.

Loads the trained v2.2 multi-bedroom GraphSAGE model + pre-computed HeteroData
once at startup. Runs one full forward pass at startup (~50ms on CPU) and
caches per-tract predictions in memory — subsequent API calls are dictionary
lookups, sub-millisecond latency.

For Atlanta scale (1,122 tracts), the cache is tiny (~50 KB). Re-run the
forward pass when the model is hot-swapped (out of scope tonight).

Amsterdam DC discovery is served from a pre-computed predictions parquet
(amsterdam_dc_discovery_top200_cleaned.parquet) rather than live inference.
The cleaned parquet is the canonical output of the Amsterdam GNN v3 training
pipeline, filtered to remove suspect BAG anomalies and known existing DCs.
"""
import json
import logging
import math
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import HeteroConv, SAGEConv

logger = logging.getLogger(__name__)

BEDROOMS = ["0br", "1br", "2br", "3br", "4br"]
YEAR_PAIRS = ["2023_2024", "2024_2025", "2025_2026"]

# K-fold-validated test R² per head (5/23 results)
# Used to report confidence intervals alongside point predictions
KFOLD_STATS = {
    "displacement": {"r2_mean": 0.6544, "r2_std": 0.0552, "n_folds": 5},
    "rent_2023_2024": {"r2_mean": 0.1329, "r2_std": 0.0376, "n_folds": 5},
    "rent_2024_2025": {"r2_mean": 0.0906, "r2_std": 0.1237, "n_folds": 5},
    "rent_2025_2026": {"r2_mean": 0.2257, "r2_std": 0.1158, "n_folds": 5},
}


class VelasightGNNv22(nn.Module):
    """Multi-bedroom heterogeneous GraphSAGE — matches v2.2 training architecture exactly."""

    def __init__(
        self,
        parcel_dim: int,
        tract_dim: int,
        hidden_dim: int = 64,
        num_layers: int = 3,
        dropout: float = 0.2,
        year_pairs: List[str] = None,
        n_bedrooms: int = 5,
    ):
        super().__init__()
        self.year_pairs = year_pairs or YEAR_PAIRS
        self.n_bedrooms = n_bedrooms
        self.parcel_lin = nn.Linear(parcel_dim, hidden_dim)
        self.tract_lin = nn.Linear(tract_dim, hidden_dim)
        self.convs = nn.ModuleList([
            HeteroConv({
                ("parcel", "in_tract", "tract"): SAGEConv(hidden_dim, hidden_dim),
                ("tract", "has_parcel", "parcel"): SAGEConv(hidden_dim, hidden_dim),
                ("tract", "adjacent", "tract"): SAGEConv(hidden_dim, hidden_dim),
            }, aggr="mean") for _ in range(num_layers)
        ])
        self.dropout = dropout
        self.head_displacement = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden_dim // 2, 1),
        )
        self.rent_heads = nn.ModuleDict({
            yp: nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim // 2), nn.ReLU(), nn.Dropout(dropout),
                nn.Linear(hidden_dim // 2, n_bedrooms),
            ) for yp in self.year_pairs
        })

    def forward(self, x_dict, edge_index_dict):
        x_dict = {"parcel": self.parcel_lin(x_dict["parcel"]),
                  "tract": self.tract_lin(x_dict["tract"])}
        for conv in self.convs:
            x_new = conv(x_dict, edge_index_dict)
            x_new = {k: F.relu(v) for k, v in x_new.items()}
            x_dict = {k: F.dropout(x_dict[k] + x_new.get(k, 0),
                                    p=self.dropout, training=self.training)
                      for k in x_dict}
        tract_emb = x_dict["tract"]
        return {
            "displacement": self.head_displacement(tract_emb).squeeze(-1),
            **{f"rent_{yp}": self.rent_heads[yp](tract_emb) for yp in self.year_pairs},
        }


class GNNInferenceService:
    """
    Singleton: holds the loaded model + HeteroData + cached predictions.
    Initialized once at FastAPI startup via lifespan, queried by endpoint handlers.
    """

    def __init__(self, artifacts_dir: Path):
        self.artifacts_dir = artifacts_dir
        self.model: Optional[VelasightGNNv22] = None
        self.data = None
        self.tract_geoids: List[str] = []
        self.geoid_to_idx: Dict[str, int] = {}
        # Per-tract cached predictions (populated on startup)
        self.predictions: Dict[str, dict] = {}
        # Normalization stats — needed to un-z-score predictions
        self.disp_mean: Optional[float] = None
        self.disp_std: Optional[float] = None
        self.rent_stats: Dict[str, dict] = {}  # year_pair -> {means: [5], stds: [5]}

        # Amsterdam DC discovery (top-200 candidates, served from cleaned parquet).
        # pand_id (str) -> PandRecord-shaped dict
        self.amsterdam_predictions: Dict[str, dict] = {}
        # buurtcode -> list of pand_ids in that buurt, sorted by score desc
        self.amsterdam_clusters: Dict[str, List[str]] = {}
        # Source filename for response metadata
        self.amsterdam_source: Optional[str] = None

    def initialize(self):
        """Load model + HeteroData, compute normalization stats, run forward pass, cache predictions."""
        logger.info(f"GNN inference: loading from {self.artifacts_dir}")

        # Load tract metadata
        with open(self.artifacts_dir / "tract_metadata.json") as f:
            meta = json.load(f)
        self.tract_geoids = meta["tract_geoids"]
        self.geoid_to_idx = {g: i for i, g in enumerate(self.tract_geoids)}
        logger.info(f"  loaded {len(self.tract_geoids)} tract geoids")

        # Load pre-built HeteroData
        self.data = torch.load(
            self.artifacts_dir / "velasight_v2_heterodata.pt",
            weights_only=False
        )
        logger.info(
            f"  loaded HeteroData: {self.data['parcel'].num_nodes} parcels, "
            f"{self.data['tract'].num_nodes} tracts"
        )

        # Recover normalization stats from the training-time train mask
        # (these MUST match training; we use the same mask that was saved)
        self._compute_normalization_stats()

        # Instantiate model with correct dims
        parcel_dim = self.data["parcel"].x.shape[1]
        tract_dim = self.data["tract"].x.shape[1]
        self.model = VelasightGNNv22(parcel_dim=parcel_dim, tract_dim=tract_dim)
        state = torch.load(
            self.artifacts_dir / "model_safmr_v2_2_multibedroom.pt",
            weights_only=True,
            map_location="cpu"
        )
        self.model.load_state_dict(state)
        self.model.eval()
        logger.info(f"  loaded model_safmr_v2_2_multibedroom.pt")

        # Run forward pass once, cache per-tract predictions
        self._cache_all_predictions()
        logger.info(f"GNN inference: ready, {len(self.predictions)} tract predictions cached")

        # Load Amsterdam DC discovery predictions. This is independent of the
        # Atlanta GNN — failure here logs a warning but doesn't break Atlanta.
        try:
            self._load_amsterdam_predictions()
        except Exception as e:
            logger.warning(
                "Amsterdam DC predictions load failed (radar endpoints will "
                "return 503): %s", e
            )

    def _load_amsterdam_predictions(self):
        """Load top-N DC discovery candidates from cleaned parquet.

        Expected file: artifacts_dir/amsterdam_dc_discovery_top200_cleaned.parquet
        Override via AMSTERDAM_PREDICTIONS_PATH env if needed.
        """
        import os
        path_override = os.environ.get("AMSTERDAM_PREDICTIONS_PATH")
        candidate_paths = []
        if path_override:
            candidate_paths.append(Path(path_override))
        candidate_paths.extend([
            self.artifacts_dir / "amsterdam_dc_discovery_top200_cleaned.parquet",
            self.artifacts_dir / "amsterdam_dc_discovery_top200.parquet",
        ])

        path = None
        for p in candidate_paths:
            if p.exists():
                path = p
                break
        if path is None:
            raise FileNotFoundError(
                f"No Amsterdam predictions file found. Tried: "
                f"{[str(p) for p in candidate_paths]}"
            )

        logger.info(f"Amsterdam predictions: loading from {path}")
        df = pd.read_parquet(path)
        logger.info(f"  loaded {len(df)} rows, cols: {df.columns.tolist()}")

        # Ensure pand_id is string — int64 in some files, str in others
        df["pand_id"] = df["pand_id"].astype(str)
        # Sort by score desc to make rank stable
        df = df.sort_values("score", ascending=False).reset_index(drop=True)

        # Build per-pand records keyed by pand_id
        for _, row in df.iterrows():
            pid = row["pand_id"]
            self.amsterdam_predictions[pid] = {
                "pand_id": pid,
                "score": float(row["score"]),
                "rank": int(row["rank"]),
                "latitude": float(row["latitude"]),
                "longitude": float(row["longitude"]),
                "pand_opp_max": float(row["pand_opp_max"]),
                "pand_bouwjaar": int(row["pand_bouwjaar"]),
                "omgevingsadressendichtheid": (
                    float(row["omgevingsadressendichtheid"])
                    if pd.notna(row["omgevingsadressendichtheid"]) else None
                ),
                "bevolkingsdichtheid_inwoners_per_km2": (
                    float(row["bevolkingsdichtheid_inwoners_per_km2"])
                    if pd.notna(row["bevolkingsdichtheid_inwoners_per_km2"]) else None
                ),
                "aantal_inwoners": (
                    float(row["aantal_inwoners"])
                    if pd.notna(row["aantal_inwoners"]) else None
                ),
                "buurtcode": str(row["buurtcode"]),
                "buurtnaam": (str(row["buurtnaam"]) if pd.notna(row["buurtnaam"]) else None),
                "gemeentenaam": (str(row["gemeentenaam"]) if pd.notna(row["gemeentenaam"]) else None),
            }

        # Build cluster index: buurtcode -> [pand_ids sorted by score desc]
        for buurtcode, group in df.groupby("buurtcode"):
            ordered_ids = group.sort_values("score", ascending=False)["pand_id"].tolist()
            self.amsterdam_clusters[buurtcode] = ordered_ids

        # Annotate each prediction with cluster size + anchor flag
        for buurtcode, pand_ids in self.amsterdam_clusters.items():
            anchor_id = pand_ids[0]  # highest score in buurt
            for pid in pand_ids:
                self.amsterdam_predictions[pid]["cluster_size"] = len(pand_ids)
                self.amsterdam_predictions[pid]["is_cluster_anchor"] = (pid == anchor_id)
                self.amsterdam_predictions[pid]["cluster_anchor_pand_id"] = anchor_id

        self.amsterdam_source = path.name
        logger.info(
            f"Amsterdam predictions: ready, {len(self.amsterdam_predictions)} panden "
            f"across {len(self.amsterdam_clusters)} unique buurts"
        )

    def predict_pand(self, pand_id: str) -> Optional[dict]:
        """Get cached prediction for a single pand. Returns None if not in cohort."""
        return self.amsterdam_predictions.get(str(pand_id))

    def get_pand_discovery(self, limit: Optional[int] = None) -> List[dict]:
        """Return top-N candidates sorted by score desc (rank ascending)."""
        records = sorted(
            self.amsterdam_predictions.values(),
            key=lambda r: r["rank"]
        )
        if limit is not None:
            records = records[:limit]
        return records

    def get_pand_cluster(self, buurtcode: str) -> Optional[List[dict]]:
        """Return all candidates in a buurt, sorted by score desc (anchor first)."""
        pand_ids = self.amsterdam_clusters.get(buurtcode)
        if not pand_ids:
            return None
        return [self.amsterdam_predictions[pid] for pid in pand_ids]

    def _compute_normalization_stats(self):
        """Re-derive z-score means/stds from the training data, using saved train mask if available."""
        # Try to load v2 train mask; fall back to displacement mask if not available
        mask_path = self.artifacts_dir / "mask_train_v2.pt"
        if mask_path.exists():
            train_mask = torch.load(mask_path, weights_only=True)
        else:
            logger.warning("  mask_train_v2.pt not in artifacts — using displacement mask "
                           "as proxy for normalization stats")
            train_mask = self.data["tract"].mask_displacement

        # Displacement stats
        y_disp = self.data["tract"].y_displacement
        disp_train_mask = self.data["tract"].mask_displacement & train_mask
        self.disp_mean = float(y_disp[disp_train_mask].mean())
        self.disp_std = float(y_disp[disp_train_mask].std().clamp(min=1e-8))

        # Rent stats per year_pair — these would normally come from the rent labels,
        # which are NOT in the heterodata. For serving without retraining infra,
        # we use locked stats from training (5/23 run output):
        self.rent_stats = {
            "2023_2024": {
                "means": [0.1882, 0.1945, 0.1864, 0.1784, 0.1718],
                "stds":  [0.0244, 0.0244, 0.0245, 0.0242, 0.0241],
            },
            "2024_2025": {
                "means": [-0.0049, 0.0069, -0.0069, -0.0101, -0.0191],
                "stds":  [0.0192, 0.0188, 0.0184, 0.0188, 0.0185],
            },
            "2025_2026": {
                "means": [-0.0108, -0.0040, -0.0132, -0.0182, -0.0254],
                "stds":  [0.0275, 0.0282, 0.0274, 0.0273, 0.0259],
            },
        }
        logger.info(f"  normalization stats: disp_mean={self.disp_mean:.4f}, "
                    f"disp_std={self.disp_std:.4f}")

    def _cache_all_predictions(self):
        """Run model forward pass once over the full graph, cache per-tract outputs."""
        with torch.no_grad():
            out = self.model(self.data.x_dict, self.data.edge_index_dict)

        for i, geoid in enumerate(self.tract_geoids):
            # Un-normalize predictions
            disp_pred = float(out["displacement"][i]) * self.disp_std + self.disp_mean
            rent_preds = {}
            for yp in YEAR_PAIRS:
                key = f"rent_{yp}"
                means = self.rent_stats[yp]["means"]
                stds = self.rent_stats[yp]["stds"]
                yoy_5vec = [
                    float(out[key][i, j]) * stds[j] + means[j]
                    for j in range(5)
                ]
                rent_preds[yp] = dict(zip(BEDROOMS, yoy_5vec))

            self.predictions[geoid] = {
                "displacement_risk": disp_pred,
                "displacement_risk_confidence": KFOLD_STATS["displacement"],
                "rent_growth_yoy": rent_preds,
                "rent_growth_confidence": {
                    yp: KFOLD_STATS[f"rent_{yp}"] for yp in YEAR_PAIRS
                },
                "model_version": "v2_2_multibedroom_5fold_cv",
            }

    def predict_tract(self, geoid: str) -> Optional[dict]:
        """Get cached prediction for a tract. Returns None if not in our index."""
        return self.predictions.get(geoid)

    def predict_absolute_rents(self, geoid: str, current_safmr: Dict[str, float]) -> Optional[dict]:
        """
        Given current SAFMR per bedroom for a tract, project predicted rents forward
        using the model's YoY estimates for the 2025→2026 year-pair.
        current_safmr keys must be in BEDROOMS list.
        """
        pred = self.predictions.get(geoid)
        if not pred:
            return None
        yoy = pred["rent_growth_yoy"]["2025_2026"]
        return {
            br: {
                "current_rent": current_safmr.get(br),
                "predicted_yoy_change": yoy[br],
                "predicted_next_year_rent": (
                    current_safmr[br] * (1 + yoy[br]) if br in current_safmr else None
                ),
                "confidence_r2_mean": KFOLD_STATS["rent_2025_2026"]["r2_mean"],
                "confidence_r2_std": KFOLD_STATS["rent_2025_2026"]["r2_std"],
            }
            for br in BEDROOMS
        }