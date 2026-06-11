# Velasight — Graph-Native Decision Intelligence for Institutional CRE
Google Cloud for Startups AI Agents Challenge — Submission
> *"The longer and more complex the task, the larger the lead."*
> Velasight applies this principle to institutional commercial real estate: graph-native spatial reasoning, multi-agent orchestration, and GNN-grounded site intelligence  for decisions that take weeks, not seconds.
---
What Velasight Does
Velasight is a decision intelligence platform for institutional capital allocators, acquisitions teams, and REITs operating across three asset classes: data centers, multifamily, and medical office buildings (MOB).
The platform answers a class of questions that are structurally unanswerable by flat-database tools like CoStar:
What is the displacement trajectory of this submarket, modeled as a network propagation problem?
Who actually owns this parcel past the three-hop SPE chain?
Which parcels are suitable for a data center that have not yet been identified as such?
What is the forward-looking LIHTC rent spread compression for this census tract?
These are graph-native question classes. Velasight answers them through a combination of a Neo4j property graph (800K+ nodes, 55M+ edges), a trained GraphSAGE GNN, and a multi-agent reasoning architecture built on Google Cloud ADK and Vertex AI.
---
Architecture
```
┌──────────────────────────────────────────────────────────────────┐
│                        User Interface                            │
│         React / Vite  ·  Mapbox GL  ·  Vapi Voice Layer         │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTPS / WebSocket
┌────────────────────────────▼─────────────────────────────────────┐
│                    Orchestrator Agent                            │
│              Google ADK  ·  Vertex AI  ·  A2A Protocol           │
│                                                                  │
│   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│   │  Spatial Network │  │   Underwriting   │  │   Market     │  │
│   │     Analyst      │  │      Agent       │  │  Synthesis   │  │
│   │                  │  │                  │  │    Agent     │  │
│   │ • Graph traversal│  │ • Monte Carlo    │  │ • Narrative  │  │
│   │ • Tobler rings   │  │ • MCDA scoring   │  │   synthesis  │  │
│   │ • SPE ownership  │  │ • IRR / DSCR     │  │ • Verdict    │  │
│   │ • Assemblage     │  │ • LTV headroom   │  │   generation │  │
│   └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
└────────────┼────────────────────┼───────────────────┼───────────┘
             │                    │                   │
             └────────────────────┼───────────────────┘
                                  │ MCP / Tool calls
┌─────────────────────────────────▼────────────────────────────────┐
│                        Tool Layer                                │
│                                                                  │
│  get_property_analysis   ·   query_property_graph                │
│  execute_real_estate_playbook   ·   consult_market_analyst       │
│  update_dashboard   ·   gnn_inference_endpoint                   │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
         ┌────────────────────────┼──────────────────────┐
         │                        │                      │
┌────────▼────────┐   ┌───────────▼────────┐  ┌─────────▼───────┐
│   Neo4j Graph   │   │  GraphSAGE GNN     │  │  Vertex AI      │
│                 │   │                    │  │  Gemini         │
│ • 800K+ nodes   │   │ • Displacement     │  │                 │
│ • 55M+ edges    │   │   risk head        │  │ • Gemini        │
│ • Atlanta MSA   │   │ • Per-bedroom      │  │   orchestration │
│ • Amsterdam     │   │   rent heads       │  │ • Adaptive      │
│   metro (675K   │   │ • AUC 0.9966       │  │   thinking      │
│   pand graph)   │   │ • Spatial 5-fold   │  │                 │
│                 │   │   CV               │  │                 │
└─────────────────┘   └────────────────────┘  └─────────────────┘
```
Agent Roles
Agent	Role	Key Tools
Orchestrator	Query routing, workflow coordination, synthesis	All tools
Spatial Network Analyst	Graph traversal, Tobler ring-buffer analysis, SPE chain resolution, assemblage detection	`query_property_graph`, Neo4j Cypher
Underwriting Agent	Monte Carlo uncertainty propagation, MCDA aggregation, IRR/DSCR/LTV projection, Value of Information estimation	`execute_real_estate_playbook`, GNN inference
Market Synthesis Agent	Submarket narrative, displacement trajectory, LIHTC spread compression analysis	`consult_market_analyst`, `get_property_analysis`
Key Design Decisions
Graph-native retrieval as moat. The Neo4j property graph is not a cache — it is the primary analytical substrate. Ownership traversal (nested SPE chains), displacement wave propagation (seed-and-spread diffusion), and assemblage detection (fragmented parcel clustering) are structurally unanswerable by row-based databases regardless of scale.
GNN as forward signal, not lookup. The GraphSAGE model (shared encoder + per-year rent heads + displacement risk head) encodes spatial network topology into embeddings. Predictions carry k-fold CV confidence intervals. The Amsterdam graph (675K pand polygons, AUC 0.9966) was trained and validated using spatial 5-fold cross-validation to prevent geographic leakage.
Adaptive reasoning via Claude. The decision engine uses Gemini as the orchestration layer for multi-stage feasibility verdicts. Adaptive thinking allocates reasoning depth automatically based on task complexity — short lookups get fast responses; multi-step assemblage analysis triggers deeper reasoning chains.
Voice-grounded spatial query. The Vapi voice interface accepts natural language property addresses, handles speech-to-text normalization (spoken "Mitchell Street" → abbreviated "MITCHELL ST SW" for county record matching), and returns structured audio + dashboard updates simultaneously.
---
Tech Stack
Layer	Technology
Cloud platform	Google Cloud Platform (GCP)
Agent framework	Google ADK · Vertex AI Agent Engine
Agent protocol	A2A (Agent-to-Agent) · MCP
LLM / reasoning	Vertex AI Gemini · Claude (Anthropic API)
Graph database	Neo4j AuraDB
GNN	PyTorch Geometric · GraphSAGE
Backend	FastAPI · Python 3.11 · Cloud Run
Frontend	React · Vite · Mapbox GL JS
Voice	Vapi
State management	Zustand
Data infrastructure	GCS · BigQuery · ATTOM · BAG/Kadastrale Kaart
---
Demo
The submission demo uses the Amsterdam data center siting pipeline — the Amsterdam MSA pand graph (675,894 building polygons, 1,032,817 verblijfsobject, 207,747 kadastrale parcels) with ground truth from 90 metro data centers.
Core demo query: "Show me data center-suitable sites in the Westpoort corridor that have not yet been identified as data centers."
The agent chain:
Orchestrator receives query via voice or text
Spatial Network Analyst traverses the Amsterdam graph, applies Tobler buffer rings, computes kNN edges
Underwriting Agent runs GNN inference (`/api/v1/predict/tract/{geoid}`) and scores each candidate against POWER / FIBER / WATER / NIMBY KPIs
Market Synthesis Agent generates the institutional feasibility verdict with SHAP-attributed signal contributions
Dashboard updates with 3D Mapbox visualization, spider chart, and six-page PDF report
[Demo video →] (https://www.youtube.com/watch?v=lwqsuRzEivg — see submission)
---
Repository Structure
```
velasight-agents-challenge/
├── README.md
├── architecture_diagram.png
├── requirements.txt
├── agent/
│   ├── agent.py                  # Orchestrator agent — stub (interface only)
│   ├── network_analyst.py        # Spatial network analyst — stub
│   ├── underwriting_agent.py     # Underwriting agent — stub
│   ├── market_synthesis.py       # Market synthesis agent — stub
│   └── tools/
│       ├── __init__.py
│       ├── property_analysis.py  # Tool interface stubs
│       ├── graph_query.py
│       ├── playbook_executor.py
│       └── dashboard_updater.py
├── gnn/
│   ├── model_architecture.py     # GraphSAGE architecture (public)
│   ├── inference_endpoint.py     # FastAPI GNN endpoint — stub
│   └── README_gnn.md             # Model card
├── demo/
│   ├── amsterdam_sample_output.json   # Real GNN predictions, Westpoort corridor
│   ├── mitchell_tract_output.json     # Atlanta Mitchell tract (13121003500)
│   └── kpi_schema.json                # Full 20-KPI schema with asset class mapping
└── docs/
    ├── architecture_diagram.png
    └── agent_card_schema.json         # A2A agent card structure
```
> **Note on proprietary components:** The Neo4j graph schema, trained GNN weights, `decision_engine.py` Monte Carlo implementation, and LIHTC spread parquet files are not included in this public repository. Agent files are provided as documented interface stubs. The full architecture is described above and demonstrated in the video.
---
Key Results
Metric	Value
Amsterdam GNN test AUC	0.9966
Spatial 5-fold CV mean	0.988 ± 0.013
Amsterdam pand graph nodes	675,894
Atlanta graph nodes	800K+
Atlanta graph edges	55M+
Mitchell tract displacement risk	3.0%
Mitchell tract 2BR forward rent growth	+1.2% (surge year +19.5%)
DC suitability — top operators identified	Digital Realty 17 · Equinix 15 · NorthC 15
---
Local Setup
```bash
git clone https://github.com/velasight/velasight-agents-challenge
cd velasight-agents-challenge
pip install -r requirements.txt
```
Environment variables required:
```
NEO4J_URI=
NEO4J_USERNAME=
NEO4J_PASSWORD=
GOOGLE_CLOUD_PROJECT=
VERTEX_AI_LOCATION=
ANTHROPIC_API_KEY=
VAPI_API_KEY=
MAPBOX_TOKEN=
```
A Neo4j AuraDB Free instance with the Amsterdam corridor subgraph can be used for local testing. See `demo/amsterdam_sample_output.json` for pre-computed outputs without a live graph connection.
---
Built With
Google ADK — Agent Development Kit
Vertex AI — Model hosting and agent engine
Neo4j — Graph database (startup program)
PyTorch Geometric — GNN training
Claude — Adaptive reasoning orchestration
Vapi — Voice AI interface
Mapbox GL JS — 3D spatial visualization
---
Velasight · Atlanta, GA · 2026
