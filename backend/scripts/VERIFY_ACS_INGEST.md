# ACS Ingest — Pre/Post Verification

Run these in Neo4j Browser before and after the ingest to confirm it worked.
Paste one query block at a time.

---

## 1. BEFORE — confirm the current broken state

```cypher
MATCH (t:CensusTract)
RETURN
    count(t)                                                  AS total_tracts,
    count(CASE WHEN t.median_income > 0 THEN 1 END)           AS income_populated,
    count(CASE WHEN t.total_households > 0 THEN 1 END)        AS households_populated
```

Expected (current Apr 2026 state):
- total_tracts: 478
- income_populated: 0
- households_populated: 0

---

## 2. RUN THE SCRIPT

```powershell
# dry run first
cd C:\Users\theca\velasight-submission\velasight-explore\backend
python scripts\ingest_acs_tract_demographics.py

# review the summary — if matched count looks right and unmatched is small, commit:
python scripts\ingest_acs_tract_demographics.py --commit
```

---

## 3. AFTER — confirm ingest populated the fields

```cypher
MATCH (t:CensusTract)
RETURN
    count(t)                                                  AS total_tracts,
    count(CASE WHEN t.median_income > 0 THEN 1 END)           AS income_populated,
    count(CASE WHEN t.total_households > 0 THEN 1 END)        AS households_populated,
    count(CASE WHEN t.acs_vintage IS NOT NULL THEN 1 END)     AS acs_stamped
```

Expected after commit (Atlanta MSA, 7 counties):
- total_tracts: 478
- income_populated: ~450+  (a handful of tracts suppress income if <5 sampled households)
- households_populated: ~470+
- acs_stamped: ~450-478 (whatever matched the GEOID join)

---

## 4. SANITY-CHECK THE DISTRIBUTION

```cypher
MATCH (t:CensusTract)
WHERE t.median_income > 0
RETURN
    percentileCont(t.median_income, 0.05) AS p05,
    percentileCont(t.median_income, 0.25) AS p25,
    percentileCont(t.median_income, 0.50) AS p50_median,
    percentileCont(t.median_income, 0.75) AS p75,
    percentileCont(t.median_income, 0.95) AS p95,
    min(t.median_income)                   AS min_val,
    max(t.median_income)                   AS max_val,
    avg(t.median_income)                   AS avg_val
```

Expected Atlanta MSA ranges (rough):
- p05: ~$22K (lowest-income tracts in downtown / south side)
- p50: ~$55-70K (metro median)
- p95: ~$175-200K (Buckhead, Johns Creek, Alpharetta)
- min: probably $10-15K
- max: probably $225-250K+

If p50 comes back near $52K *exactly*, something is wrong — that was
the fallback value. Real data will NOT round to that number.

---

## 5. SPOT-CHECK SPECIFIC TRACTS

```cypher
// A few Atlanta-specific tracts to eyeball
MATCH (t:CensusTract)
WHERE t.TractID STARTS WITH '13121'  // Fulton County
RETURN t.TractID, t.median_income, t.total_households, t.avgAssessedValue
ORDER BY t.median_income DESC
LIMIT 20
```

The top rows should be north Fulton (Sandy Springs / Johns Creek /
Alpharetta) with incomes $150K+. Bottom rows should be downtown /
south Fulton tracts in the $25-40K range.

---

## 6. RESTART THE BACKEND

After a successful commit, restart uvicorn. On startup you should see a
log line like:

```
INFO:neo4j_queries:Velasight baselines loaded —
  BaselineStats(intBeta exp(p50)=153,802 exp(p95)=2,974,562;
                inc p50=$63,400 p95=$187,500;     ← these should be NEW, not $52K/$145K
                valRatio p50=0.61 p95=1.89;
                app p50=-0.61 p95=+0.63)
```

The `inc p50` and `inc p95` should be different from the old
$52,000 / $145,000 fallback values. That confirms the end-to-end loop
(Census → Neo4j → baseline load → synthesis) is now working on real data.

---

## 7. VERIFY KPI RESPONSE SHOWS "full" QUALITY TAGS

Hit any parcel endpoint:

```
GET http://localhost:8000/api/v1/parcels/<some-parcel-id>/kpi
```

The response should now have `kpi_data_quality` showing `"full"` for
every income-dependent KPI (previously showed `"proxy"` or `"unavailable"`):

```json
{
  "kpi_data_quality": {
    "transit_centrality": "full",
    "school_gradient": "full",        ← was "proxy"
    "income_migration": "full",       ← was "proxy"
    "lihtc_eligibility": "full",      ← was "unavailable"
    ...
  }
}
```
