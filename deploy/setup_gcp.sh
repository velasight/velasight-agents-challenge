#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Velasight Explore — GCP Setup Script
# Run once before first deployment.
# Usage: chmod +x setup_gcp.sh && ./setup_gcp.sh
# ──────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="us-central1"

echo "Setting up Velasight Explore on GCP project: $PROJECT_ID"

# ── Enable APIs ───────────────────────────────────────────────
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project="$PROJECT_ID"

# ── Artifact Registry ─────────────────────────────────────────
gcloud artifacts repositories create velasight \
  --repository-format=docker \
  --location="$REGION" \
  --description="Velasight Docker images" \
  --project="$PROJECT_ID" || echo "Repo already exists"

# ── Secrets ───────────────────────────────────────────────────
echo "Creating secrets (you'll be prompted to enter values)..."

create_secret() {
  local name=$1
  local prompt=$2
  echo -n "$prompt: "
  read -rs value
  echo
  echo -n "$value" | gcloud secrets create "$name" \
    --data-file=- \
    --project="$PROJECT_ID" 2>/dev/null || \
  echo -n "$value" | gcloud secrets versions add "$name" \
    --data-file=- \
    --project="$PROJECT_ID"
  echo "  ✓ $name"
}

create_secret "neo4j-uri"          "Neo4j URI (bolt+s://...)"
create_secret "neo4j-user"         "Neo4j username"
create_secret "neo4j-password"     "Neo4j password"
create_secret "velasight-api-token" "API Bearer token (generate a secure random string)"
create_secret "mapbox-token"       "Mapbox public token"
create_secret "vapi-public-key"    "VAPI public key"
create_secret "vapi-assistant-id"  "VAPI assistant ID"

# ── Cloud Build IAM ───────────────────────────────────────────
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

for role in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer \
  roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${CB_SA}" \
    --role="$role" \
    --quiet
done

echo ""
echo "✓ GCP setup complete."
echo ""
echo "Next steps:"
echo "  1. Connect your GitHub repo to Cloud Build:"
echo "     https://console.cloud.google.com/cloud-build/triggers"
echo ""
echo "  2. Create a trigger pointing to deploy/cloudbuild.yaml"
echo "     on push to main branch."
echo ""
echo "  3. Update the VITE_API_URL in cloudbuild.yaml with your"
echo "     actual Cloud Run backend URL after first backend deploy."
echo ""
echo "  4. Configure your VAPI assistant at app.vapi.ai:"
echo "     - Enable the tool calls defined in src/hooks/useVapi.js"
echo "     - Set model: gpt-4o or claude-sonnet"
echo "     - Paste VELASIGHT_SYSTEM_PROMPT as the system message"
