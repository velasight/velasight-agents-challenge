// --- VELASIGHT API CLIENT ---

const BASE_URL = "https://e0e4-136-116-246-148.ngrok-free.app";

// Centralized headers
const AUTH_HEADER = {
  'Content-Type': 'application/json',
  
  'Authorization': 'Bearer velasight_demo_key_2026'
};

export const getSiteAnalysis = async (params) => {
  try {
    // 🛡️ CRITICAL FIX: Sanitize the program_type to strictly match FastAPI's lowercase Enum
    const rawProgramType = params.asset_class || params.assetClass || params.program_type || "multifamily";
    const safeProgramType = rawProgramType.toLowerCase().replace(" ", "_");

    const response = await fetch(`${BASE_URL}/api/v1/site/analyze`, {
      method: 'POST',
      headers: AUTH_HEADER,
      body: JSON.stringify({ 
        parcel_id: params.parcelId || params.address || params.address_string || "unknown_parcel",
        lng: params.lng || -84.3879,
        lat: params.lat || 33.7488,
        program_type: safeProgramType,
        units: params.units || 250
      })
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getSiteAnalysis):", error);
    return { error: error.message };
  }
};

export const getZoneScore = async (lng, lat) => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/parcels/zone-score?lng=${lng}&lat=${lat}`, {
      method: 'GET',
      headers: AUTH_HEADER
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getZoneScore):", error);
    return { error: error.message };
  }
};

export const getNearbyParcels = async (lng, lat, radius_miles = 0.5) => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/parcels/nearby?lng=${lng}&lat=${lat}&radius_miles=${radius_miles}`, {
      method: 'GET',
      headers: AUTH_HEADER
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getNearbyParcels):", error);
    return { error: error.message };
  }
};

export const getOwnershipConcentration = async (lng, lat, radius_miles = 1.0) => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/ownership/concentration?lng=${lng}&lat=${lat}&radius_miles=${radius_miles}`, {
      method: 'GET',
      headers: AUTH_HEADER
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getOwnershipConcentration):", error);
    return { error: error.message };
  }
};

export const getDisplacementTrajectory = async (parcel_id) => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/parcels/${parcel_id}/trajectory`, {
      method: 'GET',
      headers: AUTH_HEADER
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getDisplacementTrajectory):", error);
    return { error: error.message };
  }
};

// ── Amsterdam DC discovery ─────────────────────────────────

/**
 * Fetch top-N Amsterdam DC discovery candidates. Each pand carries
 * cluster_size, is_cluster_anchor, and cluster_anchor_pand_id so the
 * radar can render anchor/supporting relationships without follow-up
 * requests.
 */
export const getPandDiscovery = async (limit = 200) => {
  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/predict/pand/discovery?limit=${limit}`,
      { method: 'GET', headers: AUTH_HEADER }
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getPandDiscovery):", error);
    return { error: error.message };
  }
};

/** Single pand lookup — used when the user clicks a node in the radar. */
export const getPandPrediction = async (pand_id) => {
  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/predict/pand/${pand_id}`,
      { method: 'GET', headers: AUTH_HEADER }
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getPandPrediction):", error);
    return { error: error.message };
  }
};

/** All candidates in a buurt, anchor first. Powers the cluster-composition panel. */
export const getPandCluster = async (buurtcode) => {
  try {
    const response = await fetch(
      `${BASE_URL}/api/v1/predict/pand/cluster/${buurtcode}`,
      { method: 'GET', headers: AUTH_HEADER }
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getPandCluster):", error);
    return { error: error.message };
  }
};

export const getAssemblageOpportunities = async (lng, lat, radius_miles = 0.5) => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/assemblage/nearby?lng=${lng}&lat=${lat}&radius_miles=${radius_miles}`, {
      method: 'GET',
      headers: AUTH_HEADER
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Velasight API Error (getAssemblageOpportunities):", error);
    return { error: error.message };
  }
};

export const handleVapiToolCall = async (functionName, params) => {
  switch (functionName) {
    case 'get_property_analysis': 
    case 'get_site_analysis': 
    case 'query_property_graph':
    case 'update_dashboard':
        return await getSiteAnalysis(params); 
        
    case 'get_zone_score': 
        return await getZoneScore(params.lng, params.lat);
    case 'get_nearby_parcels': 
        return await getNearbyParcels(params.lng, params.lat, params.radius_miles);
    case 'get_ownership_concentration': 
        return await getOwnershipConcentration(params.lng, params.lat, params.radius_miles);
    case 'get_displacement_trajectory': 
        return await getDisplacementTrajectory(params.parcel_id);
    case 'get_assemblage_opportunities': 
        return await getAssemblageOpportunities(params.lng, params.lat, params.radius_miles);
    
    default: 
        throw new Error(`Unknown tool: ${functionName}`);
  }
};

const client = {
  getSiteAnalysis,
  getZoneScore,
  getNearbyParcels,
  getOwnershipConcentration,
  getDisplacementTrajectory,
  getAssemblageOpportunities,
  getPandDiscovery,
  getPandPrediction,
  getPandCluster,
  handleVapiToolCall
};

export default client;



