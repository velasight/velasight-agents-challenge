content = open("src/components/EruptionRadar.jsx", encoding="utf-8", errors="ignore").read()

old = 'const kpis = [\n    normUrban,                                       // 0 BETWEENNESS\n    Math.abs(normUrban - normPop),                   // 1 STREET ENTROPY\n    1 - normPop,                                     // 2 LIEN DENSITY (inverse)\n    normRecency,                                     // 3 PERMIT VELOCITY\n    1 - normClusterSize,                             // 4 ZONING FLUX\n    1 - normPop,                                     // 5 INCOME GRADIENT\n    Math.min(1, pand.rank / 200),                    // 6 TENURE CHURN (rank-derived)\n    1 - normScore,                                   // 7 RENT BURDEN (inverse score)\n    normUrban,                                       // 8 TRANSIT REACH\n    normPop * 0.5,                                   // 9 DISPLACEMENT RISK (NIMBY proxy)\n  ];'

new = 'const kpis = [\n    normScore,                                       // 0 BETWEENNESS\n    Math.min(1, normFootprint * 1.8),                // 1 FIBER LATENCY\n    Math.min(1, (1 - normPop) * 1.4),               // 2 POWER CAPACITY\n    normRecency,                                     // 3 PERMIT VELOCITY\n    Math.min(1, normClusterSize * 2.5),              // 4 ZONING FLUX\n    Math.min(1, Math.abs(normUrban - normPop) * 3),  // 5 INCOME GRADIENT\n    Math.min(1, pand.rank / 100),                    // 6 WATER STRESS\n    Math.min(1, normScore * 1.5),                    // 7 RENT BURDEN\n    Math.min(1, normUrban * 1.6),                    // 8 TRANSIT REACH\n    Math.min(1, normPop * 2.0),                      // 9 NIMBY RISK\n  ];'

if old in content:
    result = content.replace(old, new)
    open("src/components/EruptionRadar.jsx", "w", encoding="utf-8").write(result)
    print("Fixed.")
else:
    print("Not found.")
