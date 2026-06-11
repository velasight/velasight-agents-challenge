"""
Velasight — ACS Tract Demographic Ingest
========================================

One-shot script to populate `median_income` and `total_households` on
every CensusTract node in Neo4j using the U.S. Census Bureau's ACS 5-year
API. Runs in dry-run mode by default; pass `--commit` to write.

Why this script exists
----------------------
Diagnostic against the live Velasight graph (Apr 2026) found that all 478
Atlanta-MSA CensusTract nodes carry `median_income = 0` and
`total_households = 0`. The assessment rollup properties on the same
nodes (`avgAssessedValue`, `propertyCount`) are populated on 445/478
tracts. The original tract ingest clearly created the schema slots but
never successfully joined ACS demographic data. This script is the fix.

The fix is intentionally narrow: pull B19013 (median household income)
and B11001 (household count) at tract level for the seven Atlanta MSA
counties, match into Neo4j on the tract's 11-digit GEOID, and SET the
two properties. No other tract attributes are touched.

Data source
-----------
Census ACS 5-year (vintage configurable, default 2023). Tract-level
estimates are stable (16-month rolling sample) and update annually in
December. Fully free, no credit card, instant API key registration at
https://api.census.gov/data/key_signup.html.

Tables pulled:
    B19013_001E  — Median household income in the past 12 months
    B11001_001E  — Total households

Environment
-----------
Reads the same .env used by the FastAPI service:
    NEO4J_URI
    NEO4J_USER          (default: neo4j)
    NEO4J_PASSWORD
    CENSUS_API_KEY      (get from https://api.census.gov/data/key_signup.html)

Usage
-----
Dry run (safe — reads everything, writes nothing, prints diff summary):
    python ingest_acs_tract_demographics.py

Actual write:
    python ingest_acs_tract_demographics.py --commit

Limit counties (e.g. debug):
    python ingest_acs_tract_demographics.py --counties 121,089

Different ACS vintage:
    python ingest_acs_tract_demographics.py --vintage 2022

Idempotency
-----------
Safe to re-run. Every tract gets overwritten to the API's current value.
Running twice in a row produces zero diff on the second run.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from neo4j import GraphDatabase

# ─────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────

# Georgia state FIPS code.
GEORGIA_FIPS = "13"

# Atlanta MSA counties (county FIPS within Georgia).
# Source: U.S. Office of Management and Budget CBSA definition of the
# Atlanta–Sandy Springs–Alpharetta MSA. We use the seven highest-parcel-
# density counties that anchor Velasight's Atlanta coverage. The MSA
# technically includes more outlying counties, but parcel data density
# in them is negligible and their CensusTract nodes are not loaded.
ATLANTA_MSA_COUNTIES: Dict[str, str] = {
    "121": "Fulton",
    "089": "DeKalb",
    "067": "Cobb",
    "135": "Gwinnett",
    "063": "Clayton",
    "113": "Fayette",
    "151": "Henry",
}

# ACS 5-year variables. The "E" suffix denotes point estimate
# (vs "M" for margin of error, which we do not store).
VAR_MEDIAN_INCOME = "B19013_001E"   # Median household income
VAR_TOTAL_HOUSEHOLDS = "B11001_001E"  # Total households

ACS_BASE_URL = "https://api.census.gov/data"

# Census API returns -666666666 as the sentinel for "jam value" — i.e.
# estimate suppressed for data-quality reasons (typically a tract with
# too few observations). We treat these as null, not zero.
CENSUS_NULL_SENTINEL = -666666666

# Neo4j write batch size. 100 is conservative but keeps each transaction
# well under any plausible timeout while limiting round-trips.
WRITE_BATCH_SIZE = 100

# HTTP retry config for the Census API (flaky on occasion).
HTTP_MAX_RETRIES = 3
HTTP_BACKOFF_SECONDS = 2.0
HTTP_TIMEOUT_SECONDS = 30.0


# ─────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("acs_ingest")


# ─────────────────────────────────────────────────────────────────────
# Types
# ─────────────────────────────────────────────────────────────────────

@dataclass
class TractRecord:
    """One tract's worth of ACS demographic data, keyed by 11-digit GEOID."""
    geoid: str               # e.g. "13121010100" (state+county+tract)
    state_fips: str
    county_fips: str
    tract_fips: str
    median_income: Optional[int]
    total_households: Optional[int]

    def is_usable(self) -> bool:
        """True if at least one of the two fields has real data."""
        return self.median_income is not None or self.total_households is not None


@dataclass
class IngestStats:
    """Summary of what the ingest touched. Printed at end."""
    counties_processed: int = 0
    tracts_fetched_from_acs: int = 0
    tracts_matched_in_neo4j: int = 0
    tracts_unmatched_in_neo4j: int = 0
    tracts_updated: int = 0
    tracts_with_income: int = 0
    tracts_with_households: int = 0
    income_before_nonzero: int = 0
    income_after_nonzero: int = 0
    households_before_nonzero: int = 0
    households_after_nonzero: int = 0
    unmatched_geoids: List[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────
# ACS fetch
# ─────────────────────────────────────────────────────────────────────

def _parse_int_or_none(raw: str) -> Optional[int]:
    """Parse an ACS numeric field, treating the suppression sentinel as None."""
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    if value == CENSUS_NULL_SENTINEL:
        return None
    # Census encodes "no value" as negative numbers in some tables;
    # a negative income or household count is nonsensical, so drop.
    if value < 0:
        return None
    return value


def fetch_county_tracts(
    api_key: str,
    vintage: int,
    state_fips: str,
    county_fips: str,
) -> List[TractRecord]:
    """
    Pull all tract-level records for one county from the ACS 5-year API.

    Returns a list of TractRecord. The caller is responsible for matching
    these into Neo4j — this function does not touch the graph.
    """
    url = f"{ACS_BASE_URL}/{vintage}/acs/acs5"
    params = {
        "get": f"NAME,{VAR_MEDIAN_INCOME},{VAR_TOTAL_HOUSEHOLDS}",
        "for": "tract:*",
        "in": f"state:{state_fips} county:{county_fips}",
        "key": api_key,
    }

    last_err: Optional[Exception] = None
    resp = None
    for attempt in range(1, HTTP_MAX_RETRIES + 1):
        try:
            resp = requests.get(url, params=params, timeout=HTTP_TIMEOUT_SECONDS)
            resp.raise_for_status()
            break
        except requests.RequestException as e:
            last_err = e
            if attempt < HTTP_MAX_RETRIES:
                sleep_for = HTTP_BACKOFF_SECONDS * attempt
                logger.warning(
                    "ACS fetch attempt %d/%d failed for county %s: %s — retrying in %.1fs",
                    attempt, HTTP_MAX_RETRIES, county_fips, e, sleep_for,
                )
                time.sleep(sleep_for)
    else:
        raise RuntimeError(f"ACS fetch exhausted retries for county {county_fips}: {last_err}")

    # The Census API returns 200 OK with a non-JSON body for certain classes
    # of errors — most commonly an invalid or not-yet-activated API key, which
    # returns a short plain-text complaint rather than a JSON error object.
    # Surface the body content so the user sees what Census actually said.
    content_type = (resp.headers.get("Content-Type") or "").lower()
    body_preview = (resp.text or "").strip()
    if "json" not in content_type:
        # Common Census error messages arrive as plain text like:
        #   "error: error: unknown/unsupported geography heirarchy"
        # or HTML pages for key-related failures.
        snippet = body_preview[:400].replace("\n", " ")
        raise RuntimeError(
            f"ACS API returned non-JSON response for county {county_fips}. "
            f"Content-Type: {content_type or 'unset'}. Body (first 400 chars): {snippet!r}. "
            f"Most common cause: API key not yet activated (wait 15 min after email arrives) "
            f"or malformed CENSUS_API_KEY in .env (strip any surrounding quotes/whitespace)."
        )

    try:
        rows = resp.json()
    except ValueError as e:
        snippet = body_preview[:400].replace("\n", " ")
        raise RuntimeError(
            f"ACS JSON parse failed for county {county_fips}: {e}. Body: {snippet!r}"
        )
    if not rows or len(rows) < 2:
        logger.warning("ACS returned no rows for county %s", county_fips)
        return []

    # First row is headers: ["NAME", "B19013_001E", "B11001_001E", "state", "county", "tract"]
    header = rows[0]
    try:
        idx_income = header.index(VAR_MEDIAN_INCOME)
        idx_hh = header.index(VAR_TOTAL_HOUSEHOLDS)
        idx_state = header.index("state")
        idx_county = header.index("county")
        idx_tract = header.index("tract")
    except ValueError as e:
        raise RuntimeError(f"ACS response shape unexpected for county {county_fips}: {e}")

    records: List[TractRecord] = []
    for row in rows[1:]:
        state_f = row[idx_state]
        county_f = row[idx_county]
        tract_f = row[idx_tract]
        geoid = f"{state_f}{county_f}{tract_f}"
        records.append(TractRecord(
            geoid=geoid,
            state_fips=state_f,
            county_fips=county_f,
            tract_fips=tract_f,
            median_income=_parse_int_or_none(row[idx_income]),
            total_households=_parse_int_or_none(row[idx_hh]),
        ))
    return records


# ─────────────────────────────────────────────────────────────────────
# Neo4j operations
# ─────────────────────────────────────────────────────────────────────

def read_current_tract_state(driver) -> Dict[int, Dict[str, Optional[float]]]:
    """
    Snapshot of every CensusTract's current (median_income, total_households)
    keyed by the graph's INTEGER TractID.

    See write_tracts docstring for why we key by integer (last 6 digits of
    Census GEOID with leading zeros stripped).

    Returns dict[tract_int] -> {'median_income': x, 'total_households': y}
    """
    query = """
    MATCH (t:CensusTract)
    WHERE t.TractID IS NOT NULL
    RETURN
        toInteger(t.TractID) AS tract_int,
        t.median_income      AS median_income,
        t.total_households   AS total_households
    """
    snapshot: Dict[int, Dict[str, Optional[float]]] = {}
    with driver.session() as session:
        for row in session.run(query):
            tract_int = row["tract_int"]
            if tract_int is None:
                continue
            snapshot[int(tract_int)] = {
                "median_income": row["median_income"],
                "total_households": row["total_households"],
            }
    return snapshot


def _tract_int_from_geoid(geoid: str) -> Optional[int]:
    """
    Transform an 11-digit Census GEOID to the graph's integer TractID format.

    Census GEOID: 11 chars = state(2) + county(3) + tract(6)
    Graph TractID: integer representation of the tract(6) portion, leading
                   zeros stripped.

    Returns None if the GEOID is malformed (short, non-numeric tract code, etc).
    """
    if not geoid or len(geoid) < 11:
        return None
    tract_portion = geoid[-6:]
    try:
        return int(tract_portion)  # strips leading zeros automatically
    except (TypeError, ValueError):
        return None


def _payload_from_records(records: List[TractRecord], vintage: int) -> List[dict]:
    """Serialize a batch of TractRecords for the Cypher UNWIND.

    Emits `tract_int` (integer, graph-compatible) alongside the raw GEOID
    (kept for debug/logging). See write_tracts docstring for the format rationale.
    """
    payload: List[dict] = []
    for r in records:
        tract_int = _tract_int_from_geoid(r.geoid)
        if tract_int is None:
            # Malformed GEOID — skip. Should be extremely rare.
            continue
        payload.append({
            "geoid": r.geoid,
            "tract_int": tract_int,
            "median_income": r.median_income,
            "total_households": r.total_households,
            "vintage": vintage,
        })
    return payload


def write_tracts(
    driver,
    records: List[TractRecord],
    vintage: int,
) -> int:
    """
    Batched write. Returns total updated count.

    GRAPH FORMAT NOTE
    -----------------
    This graph's CensusTract.TractID is an INTEGER representing the last
    six digits of the Census GEOID with leading zeros stripped. Example:
        Census GEOID           13121011202   (state 13 + county 121 + tract 011202)
        Graph TractID          11202         (integer; leading zeros dropped)

    So the join transformation is:
        graph_tract_id = toInteger(right(acs_geoid, 6))

    Some tract IDs in the graph are stored as float (e.g. 11202.0) because
    the original ATTOM parcel-side `census_tract` property was float and
    the MERGE coerced the CensusTract side. We use toInteger() on both
    sides of the comparison to normalize.

    We do NOT try to disambiguate by county. In the Atlanta MSA, the last
    6 digits of the GEOID are unique within each of the 7 counties we
    process, so the integer join is 1:1. If ambiguity is ever detected
    (multiple ACS records mapping to the same graph TractID), the batch
    counts will show it because the total updated count will exceed the
    batch size.
    """
    query = """
    UNWIND $batch AS row
    MATCH (t:CensusTract)
    WHERE toInteger(t.TractID) = row.tract_int
    SET
        t.median_income    = coalesce(row.median_income, t.median_income),
        t.total_households = coalesce(row.total_households, t.total_households),
        t.acs_vintage      = row.vintage,
        t.acs_ingested_at  = datetime()
    RETURN count(t) AS updated
    """
    total_updated = 0
    with driver.session() as session:
        for i in range(0, len(records), WRITE_BATCH_SIZE):
            chunk = records[i:i + WRITE_BATCH_SIZE]
            payload = _payload_from_records(chunk, vintage)
            result = session.run(query, batch=payload).single()
            chunk_updated = int(result["updated"] or 0) if result else 0
            total_updated += chunk_updated
            logger.info(
                "  batch %d-%d: %d tracts updated",
                i + 1, i + len(chunk), chunk_updated,
            )
    return total_updated


# ─────────────────────────────────────────────────────────────────────
# Orchestration
# ─────────────────────────────────────────────────────────────────────

def plan_diff(
    before: Dict[int, Dict[str, Optional[float]]],
    acs_records: List[TractRecord],
) -> Tuple[List[TractRecord], List[TractRecord], IngestStats]:
    """
    Compare ACS-fetched records against the current graph snapshot.
    Partitions records into matched (will be written) and unmatched
    (no CensusTract node in Neo4j with that tract_int).

    Matching key is the integer transform of the ACS GEOID — see
    _tract_int_from_geoid and write_tracts docstrings for format.
    """
    stats = IngestStats()
    stats.tracts_fetched_from_acs = len(acs_records)

    # Count pre-ingest "populated" tracts across the WHOLE graph
    for _, props in before.items():
        mi = props.get("median_income")
        hh = props.get("total_households")
        try:
            if mi is not None and float(mi) > 0:
                stats.income_before_nonzero += 1
        except (TypeError, ValueError):
            pass
        try:
            if hh is not None and float(hh) > 0:
                stats.households_before_nonzero += 1
        except (TypeError, ValueError):
            pass

    matched: List[TractRecord] = []
    unmatched: List[TractRecord] = []
    for rec in acs_records:
        tract_int = _tract_int_from_geoid(rec.geoid)
        if tract_int is not None and tract_int in before:
            matched.append(rec)
        else:
            unmatched.append(rec)

    stats.tracts_matched_in_neo4j = len(matched)
    stats.tracts_unmatched_in_neo4j = len(unmatched)
    stats.unmatched_geoids = [r.geoid for r in unmatched][:20]  # cap for logging

    for rec in matched:
        if rec.median_income is not None and rec.median_income > 0:
            stats.tracts_with_income += 1
        if rec.total_households is not None and rec.total_households > 0:
            stats.tracts_with_households += 1

    return matched, unmatched, stats


def projected_after_state(
    before: Dict[int, Dict[str, Optional[float]]],
    matched: List[TractRecord],
    stats: IngestStats,
) -> None:
    """
    Compute what the graph would look like *after* ingest. Mutates `stats`
    in place. Used for the dry-run summary.
    """
    # Start from the current state across the whole graph.
    merged: Dict[int, Dict[str, Optional[float]]] = {}
    for tract_int, props in before.items():
        merged[tract_int] = dict(props)

    # Overlay the ACS matches.
    for rec in matched:
        tract_int = _tract_int_from_geoid(rec.geoid)
        if tract_int is None:
            continue
        entry = merged.setdefault(tract_int, {
            "median_income": None, "total_households": None,
        })
        if rec.median_income is not None:
            entry["median_income"] = rec.median_income
        if rec.total_households is not None:
            entry["total_households"] = rec.total_households

    # Count after-state.
    for props in merged.values():
        mi = props.get("median_income")
        hh = props.get("total_households")
        try:
            if mi is not None and float(mi) > 0:
                stats.income_after_nonzero += 1
        except (TypeError, ValueError):
            pass
        try:
            if hh is not None and float(hh) > 0:
                stats.households_after_nonzero += 1
        except (TypeError, ValueError):
            pass


def print_stats_report(stats: IngestStats, committed: bool) -> None:
    """Human-readable summary. Printed at end of both dry-run and commit paths."""
    tag = "COMMITTED" if committed else "DRY RUN"
    header = f" INGEST SUMMARY — {tag} "
    bar = "═" * len(header)
    print()
    print(bar)
    print(header)
    print(bar)
    print(f"Counties processed:          {stats.counties_processed}")
    print(f"Tracts fetched from ACS:     {stats.tracts_fetched_from_acs}")
    print(f"  ...with real income:       {stats.tracts_with_income}")
    print(f"  ...with real households:   {stats.tracts_with_households}")
    print(f"Tracts matched in Neo4j:     {stats.tracts_matched_in_neo4j}")
    print(f"Tracts unmatched in Neo4j:   {stats.tracts_unmatched_in_neo4j}")
    if stats.unmatched_geoids:
        print(f"  first few unmatched GEOIDs: {', '.join(stats.unmatched_geoids[:5])}...")
    print()
    print(f"{'':<30} {'BEFORE':>8} {'AFTER':>8} {'DELTA':>8}")
    delta_inc = stats.income_after_nonzero - stats.income_before_nonzero
    delta_hh = stats.households_after_nonzero - stats.households_before_nonzero
    print(f"{'Tracts w/ income > 0':<30} {stats.income_before_nonzero:>8} {stats.income_after_nonzero:>8} {delta_inc:>+8}")
    print(f"{'Tracts w/ households > 0':<30} {stats.households_before_nonzero:>8} {stats.households_after_nonzero:>8} {delta_hh:>+8}")
    if committed:
        print(f"\nTracts actually updated:     {stats.tracts_updated}")
    print()


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Ingest ACS 5-year tract demographics into Velasight Neo4j.",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually write to Neo4j. Default is dry-run (reads only).",
    )
    parser.add_argument(
        "--vintage",
        type=int,
        default=2023,
        help="ACS 5-year vintage year (default: 2023, covering 2019-2023).",
    )
    parser.add_argument(
        "--counties",
        type=str,
        default=None,
        help=("Comma-separated county FIPS to process (e.g. '121,089'). "
              "Default: all seven Atlanta MSA counties."),
    )
    parser.add_argument(
        "--env-file",
        type=str,
        default=".env",
        help="Path to .env file (default: ./.env).",
    )
    args = parser.parse_args()

    load_dotenv(args.env_file)

    neo4j_uri = os.environ.get("NEO4J_URI")
    neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
    neo4j_pass = os.environ.get("NEO4J_PASSWORD")
    census_key = os.environ.get("CENSUS_API_KEY")

    missing = []
    if not neo4j_uri:
        missing.append("NEO4J_URI")
    if not neo4j_pass:
        missing.append("NEO4J_PASSWORD")
    if not census_key:
        missing.append("CENSUS_API_KEY")
    if missing:
        logger.error("Missing required env vars: %s", ", ".join(missing))
        logger.error("Get a free Census API key at https://api.census.gov/data/key_signup.html")
        logger.error("Add CENSUS_API_KEY=<your-key> to your .env file.")
        return 2

    # Select counties. Default is Fulton-only because the current Velasight
    # graph only has parcel+tract coverage for Fulton County (confirmed via
    # graph diagnostic on 2026-04-19). Pass --counties explicitly to ingest
    # additional counties as their parcel data comes online.
    if args.counties:
        county_fips_list = [c.strip() for c in args.counties.split(",")]
        counties = {
            fips: ATLANTA_MSA_COUNTIES.get(fips, f"Unknown-{fips}")
            for fips in county_fips_list
        }
    else:
        counties = {"121": "Fulton"}

    logger.info("Velasight ACS Ingest — %s mode", "COMMIT" if args.commit else "DRY RUN")
    logger.info("ACS vintage: %d (5-year estimates)", args.vintage)
    logger.info("Counties: %s", ", ".join(f"{name} ({fips})" for fips, name in counties.items()))

    driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_pass))

    try:
        # 1. Snapshot current state
        logger.info("Snapshotting current CensusTract state from Neo4j...")
        before = read_current_tract_state(driver)
        logger.info("  graph has %d CensusTract nodes with identifiable GEOIDs", len(before))

        # 2. Fetch from ACS
        all_records: List[TractRecord] = []
        for fips, name in counties.items():
            logger.info("Fetching ACS for %s County (%s)...", name, fips)
            records = fetch_county_tracts(
                census_key, args.vintage, GEORGIA_FIPS, fips,
            )
            logger.info("  %d tracts returned", len(records))
            all_records.extend(records)

        # 3. Plan diff
        matched, unmatched, stats = plan_diff(before, all_records)
        stats.counties_processed = len(counties)

        # 4. Project after-state for dry-run preview
        projected_after_state(before, matched, stats)

        # 5. Execute or skip
        if args.commit:
            logger.info("Committing %d matched tract updates to Neo4j...", len(matched))
            stats.tracts_updated = write_tracts(driver, matched, args.vintage)
            logger.info("Write complete: %d tracts updated.", stats.tracts_updated)
        else:
            logger.info("DRY RUN — no writes performed.")
            logger.info("Re-run with --commit to actually write the %d matched updates.", len(matched))

        # 6. Report
        print_stats_report(stats, committed=args.commit)

        if stats.tracts_unmatched_in_neo4j > 0:
            logger.warning(
                "%d ACS tracts had no matching CensusTract node in Neo4j. "
                "Common causes: leading-zero GEOID stripping during tract ingest, "
                "or CensusTract nodes not yet loaded for this county.",
                stats.tracts_unmatched_in_neo4j,
            )

        if args.commit:
            logger.info("Next step: restart the API (or call graph.refresh_baselines()) to reload city-wide percentile cuts.")

        return 0

    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
