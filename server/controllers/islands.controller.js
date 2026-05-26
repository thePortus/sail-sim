'use strict';

/**
 * The Bay of Pirates — ~100 islands.
 *
 * Three zones:
 *   CENTRAL  (±3 000 X) — the neutral strait
 *   WEST     (X < -4 000) — West Faction home waters
 *   EAST     (X > +4 000) — East Faction home waters
 *
 * Coastline: 16 polar control points at 22.5° steps from North.
 *   [N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSW, SW, WSW, W, WNW, NW, NNW]
 */

function mkCoastline(radii) {
  const angles = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5];
  return angles.map((angleDeg, i) => ({ angleDeg, radius: radii[i] }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  CENTRAL STRAIT  (15 islands)
// ─────────────────────────────────────────────────────────────────────────────

const CENTRAL = [

  // 1. Isla del Centro — landmark mid-strait volcano
  {
    id: 'isla-del-centro', name: 'Isla del Centro',
    centerX: 0, centerZ: 0, maxRadius: 1950, peakElevation: 620,
    coastline: mkCoastline([1700,1850,1950,1800,1650,1800,1950,1800,1750,1900,1850,1750,1800,1950,1800,1700]),
    peaks: [{ dx: 0, dz: 0, elevation: 620, radius: 900 }, { dx: 400, dz: -300, elevation: 280, radius: 480 }],
    type: 'volcanic', description: 'The great central landmark, visible from both faction waters.',
    spawnX: 2700, spawnZ: 0,
  },

  // 2. Paso Norte — northern passage marker
  {
    id: 'paso-norte', name: 'Paso Norte',
    centerX: 1800, centerZ: 7000, maxRadius: 720, peakElevation: 240,
    coastline: mkCoastline([620,660,710,690,650,685,720,678,640,688,715,668,638,680,718,658]),
    peaks: [{ dx: 0, dz: 0, elevation: 240, radius: 320 }],
    type: 'volcanic', description: 'A lone rocky waypoint marking the northern strait passage.',
    spawnX: 2620, spawnZ: 7000,
  },

  // 3. Paso Sur — southern passage marker
  {
    id: 'paso-sur', name: 'Paso Sur',
    centerX: -1800, centerZ: -7500, maxRadius: 670, peakElevation: 210,
    coastline: mkCoastline([580,630,668,648,610,648,668,638,618,650,660,635,615,645,662,628]),
    peaks: [{ dx: 0, dz: 0, elevation: 210, radius: 280 }],
    type: 'volcanic', description: 'The southern passage marker. Tides run fast here.',
    spawnX: -2620, spawnZ: -7500,
  },

  // 4. La Vigía — tall narrow watchman's stack
  {
    id: 'la-vigia', name: 'La Vigía',
    centerX: 4000, centerZ: -3000, maxRadius: 460, peakElevation: 380,
    coastline: mkCoastline([360,455,385,440,350,425,390,448,362,442,378,435,355,448,388,430]),
    peaks: [{ dx: 0, dz: 0, elevation: 380, radius: 220 }],
    type: 'stack', description: 'A towering sea-stack used as a watchman\'s perch for centuries.',
    spawnX: 4680, spawnZ: -3000,
  },

  // 5. Bajo Central — barely-surfaced shoal, a navigation hazard
  {
    id: 'bajo-central', name: 'Bajo Central',
    centerX: -3000, centerZ: 4500, maxRadius: 225, peakElevation: 22,
    coastline: mkCoastline([200,215,222,216,205,218,223,212,202,218,222,213,204,218,222,210]),
    peaks: [],
    type: 'atoll', description: 'An almost-invisible shoal. Many a careless navigator has run aground here.',
    spawnX: -3750, spawnZ: 4500,
  },

  // 6. Islote el Puente — stepping-stone between strait and west waters
  {
    id: 'islote-el-puente', name: 'Islote el Puente',
    centerX: -2000, centerZ: 3200, maxRadius: 460, peakElevation: 185,
    coastline: mkCoastline([400,448,460,435,408,440,458,428,412,442,455,430,405,438,458,425]),
    peaks: [{ dx: 0, dz: 0, elevation: 185, radius: 220 }],
    type: 'volcanic', description: 'A small stepping-stone island in the western approaches to the strait.',
    spawnX: -1460, spawnZ: 3200,
  },

  // 7. Roca Norte Central — northern strait pillar
  {
    id: 'roca-norte-central', name: 'Roca Norte Central',
    centerX: -400, centerZ: 8500, maxRadius: 440, peakElevation: 320,
    coastline: mkCoastline([360,435,398,420,345,405,388,440,370,438,382,418,350,412,392,430]),
    peaks: [{ dx: 0, dz: 0, elevation: 320, radius: 200 }],
    type: 'stack', description: 'A stark pillar in the northern passage. A useful transit bearing.',
    spawnX: 140, spawnZ: 8500,
  },

  // 8. Cayo del Corriente — small island in the western tidal stream
  {
    id: 'cayo-del-corriente', name: 'Cayo del Corriente',
    centerX: -1200, centerZ: -2800, maxRadius: 740, peakElevation: 230,
    coastline: mkCoastline([660,705,738,720,690,715,740,712,665,710,735,705,662,708,732,700]),
    peaks: [{ dx: 0, dz: 0, elevation: 230, radius: 340 }],
    type: 'volcanic', description: 'Currents swirl around this small island. Approach with care.',
    spawnX: -360, spawnZ: -2800,
  },

  // 9. Isla del Canal — elongated ridge flanking the main channel
  {
    id: 'isla-del-canal', name: 'Isla del Canal',
    centerX: 3200, centerZ: 4200, maxRadius: 1000, peakElevation: 340,
    coastline: mkCoastline([980,680,380,210,180,220,420,720,1000,700,390,215,180,225,415,710]),
    peaks: [{ dx: 0, dz: 0, elevation: 340, radius: 420 }],
    type: 'ridge', description: 'A ridge island aligned with the main channel. Its spine makes a useful landmark.',
    spawnX: 4310, spawnZ: 4200,
  },

  // 10. Isla Media — mid-sized volcanic island east of centre
  {
    id: 'isla-media', name: 'Isla Media',
    centerX: 3500, centerZ: 1500, maxRadius: 820, peakElevation: 280,
    coastline: mkCoastline([750,792,818,800,762,788,820,795,755,795,815,785,755,790,818,780]),
    peaks: [{ dx: 0, dz: 0, elevation: 280, radius: 380 }],
    type: 'volcanic', description: 'A middling island in eastern strait waters. Often the first landfall after crossing.',
    spawnX: 4430, spawnZ: 1500,
  },

  // 11. Islote Misterio — fog-shrouded northern islet
  {
    id: 'islote-misterio', name: 'Islote Misterio',
    centerX: 1500, centerZ: 11000, maxRadius: 620, peakElevation: 195,
    coastline: mkCoastline([560,600,618,605,572,608,620,602,565,605,618,598,562,602,618,595]),
    peaks: [{ dx: 0, dz: 0, elevation: 195, radius: 285 }],
    type: 'volcanic', description: 'A fog-shrouded islet at the top of the northern passage. Rarely seen clearly.',
    spawnX: 2220, spawnZ: 11000,
  },

  // 12. Bajo del Estrecho — dangerous southern shoal
  {
    id: 'bajo-del-estrecho', name: 'Bajo del Estrecho',
    centerX: 1500, centerZ: -9500, maxRadius: 260, peakElevation: 18,
    coastline: mkCoastline([235,250,258,252,240,254,260,250,238,252,258,248,238,252,258,246]),
    peaks: [],
    type: 'atoll', description: 'A barely-surfaced shoal at the southern end of the strait. Unmarked and treacherous.',
    spawnX: 1860, spawnZ: -9500,
  },

  // 13. Roca Centinela Norte — north sentinel rock
  {
    id: 'roca-centinela-norte', name: 'Roca Centinela Norte',
    centerX: 2500, centerZ: 12500, maxRadius: 480, peakElevation: 360,
    coastline: mkCoastline([385,472,418,460,372,445,395,470,380,468,405,462,375,452,398,464]),
    peaks: [{ dx: 0, dz: 0, elevation: 360, radius: 218 }],
    type: 'stack', description: 'The northern sentinel. Its silhouette warns ships they are nearing the map\'s edge.',
    spawnX: 3080, spawnZ: 12500,
  },

  // 14. Isla Tres Corrientes — crescent-shaped tidal island
  {
    id: 'isla-tres-corrientes', name: 'Isla Tres Corrientes',
    centerX: -3200, centerZ: -5200, maxRadius: 880, peakElevation: 310,
    coastline: mkCoastline([820,870,880,820,680,440,280,350,600,820,880,870,820,860,875,840]),
    peaks: [{ dx: 0, dz: -100, elevation: 310, radius: 380 }],
    type: 'crescent', description: 'Three strong tidal streams meet here. The crescent shape channels the flow.',
    spawnX: -2220, spawnZ: -5200,
  },

  // 15. Bajo del Norte Central — northern atoll
  {
    id: 'bajo-del-norte-central', name: 'Bajo del Norte Central',
    centerX: 600, centerZ: 13000, maxRadius: 310, peakElevation: 20,
    coastline: mkCoastline([282,298,308,300,288,302,310,298,285,300,308,296,285,300,308,294]),
    peaks: [],
    type: 'atoll', description: 'A barely-visible atoll at the extreme northern end of the strait.',
    spawnX: 1010, spawnZ: 13000,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  WEST FACTION  (42 islands)
// ─────────────────────────────────────────────────────────────────────────────

const WEST = [

  // 16. Puerto de la Esperanza — WEST MAIN HARBOUR
  {
    id: 'puerto-de-la-esperanza', name: 'Puerto de la Esperanza',
    centerX: -8000, centerZ: 4000, maxRadius: 3100, peakElevation: 680,
    coastline: mkCoastline([2800,2950,2700,1200,400,300,550,1600,2850,3050,3100,2950,2850,2750,2700,2750]),
    peaks: [{ dx: -600, dz: 300, elevation: 680, radius: 1100 }, { dx: 500, dz: -200, elevation: 340, radius: 600 }],
    type: 'bay', description: 'The great western harbour. Its sheltered bay opens east toward the strait.',
    spawnX: -5500, spawnZ: 4000,
  },

  // 17. Isla Volcán Rojo — the red volcano, dramatic west landmark
  {
    id: 'isla-volcan-rojo', name: 'Isla Volcán Rojo',
    centerX: -14000, centerZ: -2000, maxRadius: 2650, peakElevation: 880,
    coastline: mkCoastline([2200,2300,2450,2650,2600,2380,2200,2000,1900,2100,2350,2500,2450,2250,2100,2180]),
    peaks: [{ dx: 0, dz: 0, elevation: 880, radius: 900 }, { dx: 600, dz: -400, elevation: 420, radius: 520 }, { dx: -550, dz: 350, elevation: 310, radius: 400 }],
    type: 'volcanic', description: 'A brooding volcano whose iron-rich slopes glow reddish at sunrise.',
    spawnX: -11700, spawnZ: -2000,
  },

  // 18. Isla Gemela Norte — northern twin
  {
    id: 'isla-gemela-norte', name: 'Isla Gemela Norte',
    centerX: -6500, centerZ: -4500, maxRadius: 1320, peakElevation: 440,
    coastline: mkCoastline([1180,1240,1310,1290,1240,1210,1300,1285,1250,1215,1275,1295,1285,1240,1215,1230]),
    peaks: [{ dx: 0, dz: 0, elevation: 440, radius: 580 }],
    type: 'volcanic', description: 'The northern of two sister islands. A narrow channel runs between them.',
    spawnX: -4960, spawnZ: -4500,
  },

  // 19. Isla Gemela Sur — southern twin, elongated E-W
  {
    id: 'isla-gemela-sur', name: 'Isla Gemela Sur',
    centerX: -6500, centerZ: -7800, maxRadius: 1520, peakElevation: 480,
    coastline: mkCoastline([1180,1290,1450,1520,1490,1430,1340,1200,1150,1210,1360,1460,1510,1460,1380,1260]),
    peaks: [{ dx: 200, dz: -80, elevation: 480, radius: 620 }, { dx: -350, dz: 120, elevation: 260, radius: 380 }],
    type: 'volcanic', description: 'The larger southern twin. Its east shore is a favourite anchorage.',
    spawnX: -4800, spawnZ: -7800,
  },

  // 20. Isla Media Luna — crescent, concave face NE
  {
    id: 'isla-media-luna', name: 'Isla Media Luna',
    centerX: -19000, centerZ: 2500, maxRadius: 2300, peakElevation: 560,
    coastline: mkCoastline([1600,900,400,280,360,800,1600,2100,2200,2100,2000,2100,2200,2150,1900,1700]),
    peaks: [{ dx: -400, dz: 600, elevation: 560, radius: 700 }, { dx: 300, dz: -400, elevation: 320, radius: 480 }],
    type: 'crescent', description: 'A half-moon island. The concave face shelters ships from the northern swells.',
    spawnX: -17100, spawnZ: 2500,
  },

  // 21. Isla del Arco — deep east-facing bay
  {
    id: 'isla-del-arco', name: 'Isla del Arco',
    centerX: -11000, centerZ: -11000, maxRadius: 2250, peakElevation: 540,
    coastline: mkCoastline([1900,2050,2200,1600,480,300,560,1700,2100,2200,2200,2100,2050,2100,2200,2050]),
    peaks: [{ dx: -300, dz: 200, elevation: 540, radius: 900 }, { dx: 200, dz: -500, elevation: 250, radius: 480 }],
    type: 'bay', description: 'An island bent around a deep eastern bay. Perfect shelter from westerly storms.',
    spawnX: -9100, spawnZ: -11000,
  },

  // 22. Arrecife de la Serpiente — long N-S ridge
  {
    id: 'arrecife-de-la-serpiente', name: 'Arrecife de la Serpiente',
    centerX: -4000, centerZ: 12000, maxRadius: 3000, peakElevation: 480,
    coastline: mkCoastline([2900,2050,950,480,350,460,950,2100,3050,2150,1000,490,360,500,1000,2200]),
    peaks: [{ dx: 0, dz: 900, elevation: 480, radius: 700 }, { dx: 50, dz: -850, elevation: 360, radius: 580 }],
    type: 'ridge', description: 'A serpentine ridge island, narrow as a blade, running north to south.',
    spawnX: -4000, spawnZ: 9200,
  },

  // 23. Caletón Blanco — flat sandy atoll
  {
    id: 'caleton-blanco', name: 'Caletón Blanco',
    centerX: -16000, centerZ: -10500, maxRadius: 870, peakElevation: 42,
    coastline: mkCoastline([802,835,858,848,820,845,862,842,820,847,860,840,820,840,858,820]),
    peaks: [],
    type: 'atoll', description: 'A low white-sand atoll barely visible above the swells.',
    spawnX: -15080, spawnZ: -10500,
  },

  // 24. Punta Rocosa — jagged volcanic cape
  {
    id: 'punta-rocosa', name: 'Punta Rocosa',
    centerX: -17500, centerZ: 9000, maxRadius: 1380, peakElevation: 500,
    coastline: mkCoastline([1080,1420,1180,1360,1100,1295,1370,1255,1100,1220,1370,1160,1100,1290,1370,1210]),
    peaks: [{ dx: 0, dz: 0, elevation: 500, radius: 580 }],
    type: 'volcanic', description: 'A jagged cape of volcanic rock at the western edge of the known world.',
    spawnX: -16100, spawnZ: 9000,
  },

  // 25. Bajo Sombrío — dark half-submerged shoal
  {
    id: 'bajo-sombrio', name: 'Bajo Sombrío',
    centerX: -8500, centerZ: -13500, maxRadius: 265, peakElevation: 18,
    coastline: mkCoastline([240,258,264,257,246,260,265,252,242,258,264,254,244,260,265,252]),
    peaks: [],
    type: 'atoll', description: 'A gloomy barely-surfaced shoal. Has holed many an unwary hull.',
    spawnX: -8100, spawnZ: -13500,
  },

  // 26. Islote Centinela — remote western sentinel
  {
    id: 'islote-centinela', name: 'Islote Centinela',
    centerX: -20000, centerZ: 7000, maxRadius: 665, peakElevation: 290,
    coastline: mkCoastline([600,645,662,652,628,652,668,648,622,652,665,645,625,650,665,640]),
    peaks: [{ dx: 0, dz: 0, elevation: 290, radius: 300 }],
    type: 'volcanic', description: 'A solitary sentinel at the world\'s western edge. Rarely visited.',
    spawnX: -19280, spawnZ: 7000,
  },

  // 27. Peñón Loco — dramatically tilted volcanic pinnacle
  {
    id: 'penon-loco', name: 'Peñón Loco',
    centerX: -11500, centerZ: 5500, maxRadius: 440, peakElevation: 400,
    coastline: mkCoastline([360,440,388,435,352,418,392,440,368,440,380,428,358,435,388,425]),
    peaks: [{ dx: 0, dz: 0, elevation: 400, radius: 200 }],
    type: 'stack', description: 'A wildly leaning volcanic spire. Sailors give it a wide berth.',
    spawnX: -11000, spawnZ: 5500,
  },

  // 28. Islote Pelícano — flat low nesting ground
  {
    id: 'islote-pelicano', name: 'Islote Pelícano',
    centerX: -18000, centerZ: -6000, maxRadius: 565, peakElevation: 55,
    coastline: mkCoastline([505,538,558,548,528,548,562,545,522,548,560,542,522,542,558,532]),
    peaks: [],
    type: 'atoll', description: 'A flat pelican rookery. The birds are not pleased to have visitors.',
    spawnX: -17340, spawnZ: -6000,
  },

  // 29. Los Farallones del Oeste — jagged sea stacks
  {
    id: 'los-farallones-del-oeste', name: 'Los Farallones del Oeste',
    centerX: -5000, centerZ: -15000, maxRadius: 335, peakElevation: 185,
    coastline: mkCoastline([252,325,278,318,260,312,285,328,265,315,280,320,262,318,282,320]),
    peaks: [{ dx: 0, dz: 0, elevation: 185, radius: 140 }, { dx: -70, dz: 80, elevation: 155, radius: 100 }],
    type: 'stack', description: 'Dramatic jagged pillars at the southern edge of western waters.',
    spawnX: -4520, spawnZ: -15000,
  },

  // 30. Arrecife del Diablo — remote northern reef
  {
    id: 'arrecife-del-diablo', name: 'Arrecife del Diablo',
    centerX: -15500, centerZ: 14000, maxRadius: 285, peakElevation: 20,
    coastline: mkCoastline([258,275,282,274,268,277,284,274,262,277,283,272,264,278,284,270]),
    peaks: [],
    type: 'atoll', description: 'The Devil\'s Reef — barely above water, impossible to see in heavy seas.',
    spawnX: -15180, spawnZ: 14000,
  },

  // ── NEW WEST ISLANDS ──────────────────────────────────────────────────────

  // 31. Isla del Puente Oeste — northern approach to harbour
  {
    id: 'isla-del-puente-oeste', name: 'Isla del Puente Oeste',
    centerX: -4500, centerZ: 7500, maxRadius: 950, peakElevation: 295,
    coastline: mkCoastline([870,928,948,935,900,938,950,928,875,932,946,920,872,928,948,918]),
    peaks: [{ dx: 0, dz: 0, elevation: 295, radius: 420 }],
    type: 'volcanic', description: 'A wooded island in the northern approaches to Puerto de la Esperanza.',
    spawnX: -3460, spawnZ: 7500,
  },

  // 32. Roca Aguila — eagle-shaped stack in the far west
  {
    id: 'roca-aguila', name: 'Roca Águila',
    centerX: -13000, centerZ: 8000, maxRadius: 540, peakElevation: 430,
    coastline: mkCoastline([420,535,460,510,388,480,408,528,435,522,418,505,398,492,415,518]),
    peaks: [{ dx: 0, dz: 0, elevation: 430, radius: 245 }],
    type: 'stack', description: 'An eagle-shaped pinnacle used as a landmark by west-faction navigators.',
    spawnX: -12360, spawnZ: 8000,
  },

  // 33. Isla Nublada — cloud-capped volcanic island
  {
    id: 'isla-nublada', name: 'Isla Nublada',
    centerX: -16000, centerZ: 6000, maxRadius: 1400, peakElevation: 560,
    coastline: mkCoastline([1250,1340,1395,1380,1320,1355,1400,1370,1260,1360,1395,1365,1255,1350,1392,1360]),
    peaks: [{ dx: 0, dz: 0, elevation: 560, radius: 580 }, { dx: 250, dz: -200, elevation: 280, radius: 340 }],
    type: 'volcanic', description: 'Always shrouded in low cloud. Its peak has never been seen clearly.',
    spawnX: -14520, spawnZ: 6000,
  },

  // 34. Isla del Norte Lejano — remote northern island
  {
    id: 'isla-del-norte-lejano', name: 'Isla del Norte Lejano',
    centerX: -12000, centerZ: 12500, maxRadius: 1250, peakElevation: 420,
    coastline: mkCoastline([1130,1195,1248,1230,1180,1210,1250,1220,1140,1205,1246,1215,1135,1200,1244,1210]),
    peaks: [{ dx: 0, dz: 0, elevation: 420, radius: 520 }],
    type: 'volcanic', description: 'A remote northern island, rarely visited. The fishing is excellent.',
    spawnX: -10680, spawnZ: 12500,
  },

  // 35. Cayo Noroeste — northwest key near the map edge
  {
    id: 'cayo-noroeste', name: 'Cayo Noroeste',
    centerX: -19500, centerZ: 11500, maxRadius: 680, peakElevation: 215,
    coastline: mkCoastline([620,658,678,665,635,660,680,655,622,658,678,650,620,656,678,648]),
    peaks: [{ dx: 0, dz: 0, elevation: 215, radius: 310 }],
    type: 'volcanic', description: 'The far northwest key. A waypoint for ships rounding the northern coast.',
    spawnX: -18770, spawnZ: 11500,
  },

  // 36. Bajo Blanco Norte — northern white-sand atoll
  {
    id: 'bajo-blanco-norte', name: 'Bajo Blanco Norte',
    centerX: -17500, centerZ: 14500, maxRadius: 310, peakElevation: 15,
    coastline: mkCoastline([282,298,308,300,288,302,310,298,285,300,308,296,285,300,308,294]),
    peaks: [],
    type: 'atoll', description: 'A bleached northern atoll. Its sand is almost luminously white.',
    spawnX: -17140, spawnZ: 14500,
  },

  // 37. Isla del Valle — lush valley island
  {
    id: 'isla-del-valle', name: 'Isla del Valle',
    centerX: -10000, centerZ: 14500, maxRadius: 1050, peakElevation: 380,
    coastline: mkCoastline([968,1018,1048,1032,988,1028,1050,1020,975,1022,1046,1015,970,1018,1044,1012]),
    peaks: [{ dx: 0, dz: 0, elevation: 380, radius: 445 }],
    type: 'volcanic', description: 'A green island with a hidden valley running north to south.',
    spawnX: -8900, spawnZ: 14500,
  },

  // 38. Isla Tres Picos — three-peaked northern volcano
  {
    id: 'isla-tres-picos', name: 'Isla Tres Picos',
    centerX: -14000, centerZ: 15500, maxRadius: 1450, peakElevation: 640,
    coastline: mkCoastline([1320,1395,1448,1430,1370,1408,1450,1418,1330,1402,1445,1410,1325,1395,1442,1405]),
    peaks: [{ dx: 0, dz: 0, elevation: 640, radius: 560 }, { dx: -350, dz: 200, elevation: 420, radius: 350 }, { dx: 300, dz: -180, elevation: 380, radius: 320 }],
    type: 'volcanic', description: 'Three distinct summits rise from this striking northern island.',
    spawnX: -12480, spawnZ: 15500,
  },

  // 39. Islote Bravo — small volcanic islet south of harbour
  {
    id: 'islote-bravo', name: 'Islote Bravo',
    centerX: -8000, centerZ: -1000, maxRadius: 680, peakElevation: 220,
    coastline: mkCoastline([622,658,678,665,635,660,680,654,624,658,678,650,621,656,676,648]),
    peaks: [{ dx: 0, dz: 0, elevation: 220, radius: 310 }],
    type: 'volcanic', description: 'A bold little island south of the harbour. Good for fresh water.',
    spawnX: -7240, spawnZ: -1000,
  },

  // 40. Roca Torcida — twisted volcanic stack in eastern west waters
  {
    id: 'roca-torcida', name: 'Roca Torcida',
    centerX: -4000, centerZ: 2000, maxRadius: 380, peakElevation: 310,
    coastline: mkCoastline([295,375,328,362,280,348,305,372,292,368,315,358,282,355,310,365]),
    peaks: [{ dx: 0, dz: 0, elevation: 310, radius: 172 }],
    type: 'stack', description: 'A twisted volcanic spire. The spiralling rock strata are remarkable.',
    spawnX: -3530, spawnZ: 2000,
  },

  // 41. Roca del Paso Oeste — passage marker between volcan and media luna
  {
    id: 'roca-del-paso-oeste', name: 'Roca del Paso Oeste',
    centerX: -15000, centerZ: 1500, maxRadius: 460, peakElevation: 195,
    coastline: mkCoastline([400,448,458,440,408,442,460,435,402,440,456,432,398,438,456,428]),
    peaks: [{ dx: 0, dz: 0, elevation: 195, radius: 210 }],
    type: 'volcanic', description: 'A small marker rock between Volcán Rojo and Isla Media Luna.',
    spawnX: -14460, spawnZ: 1500,
  },

  // 42. Isla del Cielo — sky island at the far west
  {
    id: 'isla-del-cielo', name: 'Isla del Cielo',
    centerX: -18000, centerZ: -3000, maxRadius: 950, peakElevation: 440,
    coastline: mkCoastline([878,928,948,932,895,930,950,922,882,925,946,918,875,922,944,915]),
    peaks: [{ dx: 0, dz: 0, elevation: 440, radius: 415 }],
    type: 'volcanic', description: 'High enough to catch the clouds. Its summit often vanishes into the sky.',
    spawnX: -17000, spawnZ: -3000,
  },

  // 43. Isla de los Pinos — pine-ridge island between the twins and arco
  {
    id: 'isla-de-los-pinos', name: 'Isla de los Pinos',
    centerX: -9500, centerZ: -6500, maxRadius: 1100, peakElevation: 380,
    coastline: mkCoastline([980,1050,1080,1010,820,620,440,540,780,980,1100,1080,1060,1040,1020,1015]),
    peaks: [{ dx: 0, dz: 0, elevation: 380, radius: 460 }],
    type: 'ridge', description: 'A pine-covered ridge. The resinous scent carries far out to sea.',
    spawnX: -8320, spawnZ: -6500,
  },

  // 44. Isla Paloma — dove island, gentle volcanic
  {
    id: 'isla-paloma', name: 'Isla Paloma',
    centerX: -12000, centerZ: -7000, maxRadius: 980, peakElevation: 360,
    coastline: mkCoastline([900,950,978,962,922,955,980,948,908,952,975,940,905,948,972,938]),
    peaks: [{ dx: 0, dz: 0, elevation: 360, radius: 430 }],
    type: 'volcanic', description: 'White doves nest here in great numbers. A peaceful anchorage.',
    spawnX: -10970, spawnZ: -7000,
  },

  // 45. Islote Gris — grey volcanic islet
  {
    id: 'islote-gris', name: 'Islote Gris',
    centerX: -16000, centerZ: -5500, maxRadius: 650, peakElevation: 240,
    coastline: mkCoastline([598,632,648,638,608,635,650,630,600,632,648,626,598,630,646,622]),
    peaks: [{ dx: 0, dz: 0, elevation: 240, radius: 295 }],
    type: 'volcanic', description: 'A grey basalt islet in the mid-west passage. Featureless but useful for navigation.',
    spawnX: -15300, spawnZ: -5500,
  },

  // 46. Isla Fuego — fire island, active in the far south-west
  {
    id: 'isla-fuego', name: 'Isla Fuego',
    centerX: -16000, centerZ: -14000, maxRadius: 1600, peakElevation: 720,
    coastline: mkCoastline([1430,1528,1595,1570,1490,1550,1600,1560,1440,1548,1590,1555,1435,1540,1585,1548]),
    peaks: [{ dx: 0, dz: 0, elevation: 720, radius: 640 }, { dx: 200, dz: -150, elevation: 360, radius: 380 }],
    type: 'volcanic', description: 'An active volcano, still smoking. The lava-blackened shores glow at night.',
    spawnX: -14380, spawnZ: -14000,
  },

  // 47. Isla Solitaria — solitary far south-west island
  {
    id: 'isla-solitaria', name: 'Isla Solitaria',
    centerX: -19500, centerZ: -11000, maxRadius: 1000, peakElevation: 395,
    coastline: mkCoastline([920,965,998,982,940,972,1000,968,928,968,996,960,924,962,994,955]),
    peaks: [{ dx: 0, dz: 0, elevation: 395, radius: 440 }],
    type: 'volcanic', description: 'Completely alone at the southwest extremity. Only the bravest venture here.',
    spawnX: -18460, spawnZ: -11000,
  },

  // 48. Arrecife del Sur Oeste — southern atoll hazard
  {
    id: 'arrecife-del-sur-oeste', name: 'Arrecife del Sur Oeste',
    centerX: -13000, centerZ: -14500, maxRadius: 480, peakElevation: 22,
    coastline: mkCoastline([438,462,478,468,448,465,480,462,440,464,478,458,438,462,476,455]),
    peaks: [],
    type: 'atoll', description: 'A dangerous southern reef. Barely appears on old charts.',
    spawnX: -12480, spawnZ: -14500,
  },

  // 49. Isla Tranquila — calm large southern island
  {
    id: 'isla-tranquila', name: 'Isla Tranquila',
    centerX: -10500, centerZ: -15500, maxRadius: 1500, peakElevation: 520,
    coastline: mkCoastline([1365,1440,1495,1478,1410,1462,1500,1468,1372,1455,1492,1460,1368,1448,1488,1452]),
    peaks: [{ dx: 0, dz: 0, elevation: 520, radius: 600 }],
    type: 'volcanic', description: 'Despite its remote southern position, this island has calm, clear waters.',
    spawnX: -8970, spawnZ: -15500,
  },

  // 50. Isla Corte — narrow cut-ridge in the south
  {
    id: 'isla-corte', name: 'Isla Corte',
    centerX: -7000, centerZ: -11500, maxRadius: 1100, peakElevation: 410,
    coastline: mkCoastline([1060,730,420,210,180,220,430,760,1100,740,435,215,182,228,432,745]),
    peaks: [{ dx: 0, dz: 0, elevation: 410, radius: 460 }],
    type: 'ridge', description: 'A narrow ridge like a knife-cut. Its cliffs drop straight to the sea.',
    spawnX: -5870, spawnZ: -11500,
  },

  // 51. Bajo Perdido — lost southern shoal
  {
    id: 'bajo-perdido', name: 'Bajo Perdido',
    centerX: -5200, centerZ: -11200, maxRadius: 280, peakElevation: 18,
    coastline: mkCoastline([252,268,278,272,258,272,280,268,255,270,278,266,254,268,278,264]),
    peaks: [],
    type: 'atoll', description: 'A lost shoal between the southern ridge islands. Appears on no chart.',
    spawnX: -4870, spawnZ: -11200,
  },

  // 52. Islote Pelao — bald southern islet
  {
    id: 'islote-pelao', name: 'Islote Pelao',
    centerX: -19000, centerZ: -15000, maxRadius: 520, peakElevation: 165,
    coastline: mkCoastline([478,505,518,510,488,508,520,505,480,506,518,502,478,504,516,500]),
    peaks: [{ dx: 0, dz: 0, elevation: 165, radius: 238 }],
    type: 'volcanic', description: 'A bald, treeless islet at the very southwest corner of the world.',
    spawnX: -18440, spawnZ: -15000,
  },

  // 53. Cayo del Viento — windswept northern passage key
  {
    id: 'cayo-del-viento', name: 'Cayo del Viento',
    centerX: -500, centerZ: 10000, maxRadius: 680, peakElevation: 215,
    coastline: mkCoastline([622,658,678,665,635,660,680,655,624,658,678,650,621,656,676,648]),
    peaks: [{ dx: 0, dz: 0, elevation: 215, radius: 312 }],
    type: 'volcanic', description: 'Wind never stops on this exposed northern cay. The gusts are legendary.',
    spawnX: 280, spawnZ: 10000,
  },

  // 54. Islote Arena — far northwest sandy atoll
  {
    id: 'islote-arena', name: 'Islote Arena',
    centerX: -20000, centerZ: 15000, maxRadius: 480, peakElevation: 22,
    coastline: mkCoastline([438,462,478,468,448,465,480,462,440,464,478,458,438,460,476,455]),
    peaks: [],
    type: 'atoll', description: 'A sandy atoll at the northwest corner. Nothing but sand and seabirds.',
    spawnX: -19490, spawnZ: 15000,
  },

  // 55. Isla del Este Oeste — mid-south isolated island
  {
    id: 'isla-del-este-oeste', name: 'Isla del Este Oeste',
    centerX: -3500, centerZ: -12000, maxRadius: 780, peakElevation: 265,
    coastline: mkCoastline([718,758,778,765,730,760,780,758,720,758,778,752,718,755,776,750]),
    peaks: [{ dx: 0, dz: 0, elevation: 265, radius: 350 }],
    type: 'volcanic', description: 'An isolated island midway along the southern corridor.',
    spawnX: -2680, spawnZ: -12000,
  },

  // 56. Isla Hermosa — beautiful island in the eastern west approaches
  {
    id: 'isla-hermosa', name: 'Isla Hermosa',
    centerX: -4200, centerZ: -1200, maxRadius: 860, peakElevation: 310,
    coastline: mkCoastline([792,835,858,842,808,838,860,830,795,835,856,825,790,832,855,820]),
    peaks: [{ dx: 0, dz: 0, elevation: 310, radius: 385 }],
    type: 'volcanic', description: 'Widely considered the most beautiful island in the western seas.',
    spawnX: -3300, spawnZ: -1200,
  },

  // 57. Roca del Puente — connecting stack between paloma and arco
  {
    id: 'roca-del-puente', name: 'Roca del Puente',
    centerX: -11500, centerZ: -4500, maxRadius: 440, peakElevation: 290,
    coastline: mkCoastline([355,435,388,420,345,408,375,432,362,428,382,415,348,415,378,428]),
    peaks: [{ dx: 0, dz: 0, elevation: 290, radius: 200 }],
    type: 'stack', description: 'A bridge of rock connecting the northern and southern west-faction waters.',
    spawnX: -11010, spawnZ: -4500,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  EAST FACTION  (43 islands)
// ─────────────────────────────────────────────────────────────────────────────

const EAST = [

  // 58. Puerto del Alba — EAST MAIN HARBOUR
  {
    id: 'puerto-del-alba', name: 'Puerto del Alba',
    centerX: 9000, centerZ: 5000, maxRadius: 3100, peakElevation: 650,
    coastline: mkCoastline([2700,2750,2820,2950,3050,2950,2760,2620,2500,2650,2720,1550,390,300,580,1900]),
    peaks: [{ dx: 600, dz: 300, elevation: 650, radius: 1100 }, { dx: -500, dz: -200, elevation: 320, radius: 600 }],
    type: 'bay', description: 'The great eastern harbour. Its sheltered bay faces west toward the strait.',
    spawnX: 11600, spawnZ: 5000,
  },

  // 59. Isla del Trueno — violent eastern stratovolcano
  {
    id: 'isla-del-trueno', name: 'Isla del Trueno',
    centerX: 15000, centerZ: -2000, maxRadius: 2720, peakElevation: 920,
    coastline: mkCoastline([2380,2500,2650,2720,2680,2480,2300,2060,1920,2100,2360,2540,2600,2680,2640,2520]),
    peaks: [{ dx: 0, dz: 0, elevation: 920, radius: 950 }, { dx: 700, dz: -500, elevation: 460, radius: 560 }, { dx: -600, dz: 400, elevation: 340, radius: 420 }],
    type: 'volcanic', description: 'A violent stratovolcano. Lightning frequently plays around its summit.',
    spawnX: 17900, spawnZ: -2000,
  },

  // 60. Isla Herradura — horseshoe / deep west-facing bay
  {
    id: 'isla-herradura', name: 'Isla Herradura',
    centerX: 12000, centerZ: 11000, maxRadius: 2280, peakElevation: 560,
    coastline: mkCoastline([1900,2050,2200,2280,2240,2100,1980,1900,1820,1940,1800,1200,420,300,520,1550]),
    peaks: [{ dx: 400, dz: -200, elevation: 560, radius: 850 }],
    type: 'bay', description: 'The horseshoe island. Its wide western bay is one of the best harbours in the east.',
    spawnX: 10100, spawnZ: 11000,
  },

  // 61. Isla Creciente — crescent with concave west face
  {
    id: 'isla-creciente', name: 'Isla Creciente',
    centerX: 18000, centerZ: 6000, maxRadius: 2450, peakElevation: 580,
    coastline: mkCoastline([1720,2020,2250,2380,2450,2350,2180,1850,1550,1020,420,260,300,460,1020,1580]),
    peaks: [{ dx: 300, dz: -600, elevation: 580, radius: 750 }, { dx: -250, dz: 500, elevation: 350, radius: 520 }],
    type: 'crescent', description: 'A sweeping crescent island. The concave western face shelters ships from the east wind.',
    spawnX: 19100, spawnZ: 6000,
  },

  // 62. Isla Colina Verde — lush rolling island
  {
    id: 'isla-colina-verde', name: 'Isla Colina Verde',
    centerX: 6500, centerZ: -9000, maxRadius: 1960, peakElevation: 490,
    coastline: mkCoastline([1760,1870,1960,1920,1840,1760,1780,1870,1920,1880,1820,1760,1720,1830,1950,1820]),
    peaks: [{ dx: 100, dz: -150, elevation: 490, radius: 780 }, { dx: -400, dz: 300, elevation: 240, radius: 460 }],
    type: 'volcanic', description: 'A lush, rolling island — the greenest in the archipelago.',
    spawnX: 8680, spawnZ: -9000,
  },

  // 63. Islote Palmar — tropical flat atoll
  {
    id: 'islote-palmar', name: 'Islote Palmar',
    centerX: 5000, centerZ: 10000, maxRadius: 1120, peakElevation: 38,
    coastline: mkCoastline([1048,1082,1105,1095,1072,1090,1108,1090,1065,1092,1105,1085,1068,1088,1105,1075]),
    peaks: [],
    type: 'atoll', description: 'A flat palm-fringed atoll. The water inside its lagoon is impossibly clear.',
    spawnX: 6240, spawnZ: 10000,
  },

  // 64. Isla Columna — near-vertical eastern spire
  {
    id: 'isla-columna', name: 'Isla Columna',
    centerX: 19000, centerZ: 12000, maxRadius: 762, peakElevation: 760,
    coastline: mkCoastline([625,755,685,728,648,715,688,748,632,738,678,730,638,748,682,738]),
    peaks: [{ dx: 0, dz: 0, elevation: 760, radius: 340 }],
    type: 'stack', description: 'A sheer volcanic column, impossibly tall. No safe landing exists.',
    spawnX: 19860, spawnZ: 12000,
  },

  // 65. Arrecife Pintado — colourful volcanic reef
  {
    id: 'arrecife-pintado', name: 'Arrecife Pintado',
    centerX: 12500, centerZ: -8000, maxRadius: 715, peakElevation: 195,
    coastline: mkCoastline([652,690,712,700,672,695,715,698,665,698,712,692,668,695,714,688]),
    peaks: [{ dx: 80, dz: -60, elevation: 195, radius: 300 }, { dx: -70, dz: 90, elevation: 155, radius: 240 }],
    type: 'volcanic', description: 'Vivid iron-oxide colours stripe this small reef. Striking from a distance.',
    spawnX: 13330, spawnZ: -8000,
  },

  // 66. Isla Azul — blue-lagoon flat atoll
  {
    id: 'isla-azul', name: 'Isla Azul',
    centerX: 8500, centerZ: 14000, maxRadius: 1065, peakElevation: 38,
    coastline: mkCoastline([1002,1035,1058,1048,1022,1042,1060,1040,1018,1045,1058,1038,1020,1042,1058,1030]),
    peaks: [],
    type: 'atoll', description: 'A perfect blue atoll, so flat that the sea spray washes clean across it.',
    spawnX: 9740, spawnZ: 14000,
  },

  // 67. Isla Larga — long E-W ridge
  {
    id: 'isla-larga', name: 'Isla Larga',
    centerX: 5500, centerZ: -14500, maxRadius: 2650, peakElevation: 520,
    coastline: mkCoastline([580,1020,1850,2480,2650,2520,1900,1050,560,1050,1900,2520,2640,2500,1840,1000]),
    peaks: [{ dx: 700, dz: -80, elevation: 520, radius: 620 }, { dx: -650, dz: 80, elevation: 420, radius: 540 }],
    type: 'ridge', description: 'A long, narrow ridge island stretching east to west like a finger in the sea.',
    spawnX: 5500, spawnZ: -12640,
  },

  // 68. Peñasco Negro — black basalt stack, far east edge
  {
    id: 'penasco-negro', name: 'Peñasco Negro',
    centerX: 19500, centerZ: -8000, maxRadius: 412, peakElevation: 340,
    coastline: mkCoastline([325,408,362,395,338,388,368,400,342,395,370,392,340,400,372,398]),
    peaks: [{ dx: 0, dz: 0, elevation: 340, radius: 195 }],
    type: 'stack', description: 'A stark black basalt pinnacle at the eastern limit of navigation.',
    spawnX: 19040, spawnZ: -8000,
  },

  // 69. Roca Bruja — witch's rock
  {
    id: 'roca-bruja', name: 'Roca Bruja',
    centerX: 11000, centerZ: -15500, maxRadius: 388, peakElevation: 305,
    coastline: mkCoastline([305,382,338,375,318,368,345,380,322,375,340,372,320,378,342,376]),
    peaks: [{ dx: 0, dz: 0, elevation: 305, radius: 175 }],
    type: 'stack', description: 'The Witch\'s Rock. Legend says it lures ships to their doom.',
    spawnX: 11580, spawnZ: -15500,
  },

  // 70. Roca Duende — goblin rock companion to Bruja
  {
    id: 'roca-duende', name: 'Roca Duende',
    centerX: 11900, centerZ: -15600, maxRadius: 308, peakElevation: 255,
    coastline: mkCoastline([248,298,272,296,258,288,278,298,262,292,275,290,260,294,278,292]),
    peaks: [{ dx: 0, dz: 0, elevation: 255, radius: 140 }],
    type: 'stack', description: 'The Goblin Rock, lurking beside its sister. A tight passage runs between them.',
    spawnX: 12540, spawnZ: -15600,
  },

  // 71. Bajo del Este — treacherous eastern shoal
  {
    id: 'bajo-del-este', name: 'Bajo del Este',
    centerX: 16000, centerZ: -13000, maxRadius: 258, peakElevation: 20,
    coastline: mkCoastline([230,246,255,248,238,250,256,246,234,250,255,246,236,250,256,244]),
    peaks: [],
    type: 'atoll', description: 'A treacherous eastern shoal, unmarked and difficult to spot.',
    spawnX: 16560, spawnZ: -13000,
  },

  // 72. Cayo del Sol — sunny mid-east key
  {
    id: 'cayo-del-sol', name: 'Cayo del Sol',
    centerX: 7000, centerZ: -5000, maxRadius: 1240, peakElevation: 340,
    coastline: mkCoastline([1105,1162,1215,1200,1155,1175,1220,1195,1155,1168,1210,1198,1175,1178,1215,1148]),
    peaks: [{ dx: 0, dz: 0, elevation: 340, radius: 560 }],
    type: 'volcanic', description: 'A cheerful sunny cay in eastern waters. A welcome rest between the great islands.',
    spawnX: 8380, spawnZ: -5000,
  },

  // ── NEW EAST ISLANDS ──────────────────────────────────────────────────────

  // 73. Isla del Sol Naciente — rising-sun island
  {
    id: 'isla-del-sol-naciente', name: 'Isla del Sol Naciente',
    centerX: 13500, centerZ: 6000, maxRadius: 1550, peakElevation: 590,
    coastline: mkCoastline([1415,1498,1548,1530,1470,1510,1550,1518,1422,1505,1545,1512,1418,1498,1542,1508]),
    peaks: [{ dx: 0, dz: 0, elevation: 590, radius: 620 }, { dx: 280, dz: -200, elevation: 295, radius: 380 }],
    type: 'volcanic', description: 'The first island lit by each sunrise. Its golden peak is a glorious sight.',
    spawnX: 15170, spawnZ: 6000,
  },

  // 74. Islote Dorado — golden islet between alba and trueno
  {
    id: 'islote-dorado', name: 'Islote Dorado',
    centerX: 10500, centerZ: -1000, maxRadius: 700, peakElevation: 225,
    coastline: mkCoastline([642,678,698,685,652,680,700,672,645,678,698,668,641,676,696,664]),
    peaks: [{ dx: 0, dz: 0, elevation: 225, radius: 322 }],
    type: 'volcanic', description: 'The iron-rich rock gives this islet a warm golden hue in late afternoon.',
    spawnX: 11300, spawnZ: -1000,
  },

  // 75. Roca de la Luna — moon rock stack
  {
    id: 'roca-de-la-luna', name: 'Roca de la Luna',
    centerX: 17000, centerZ: -6000, maxRadius: 480, peakElevation: 395,
    coastline: mkCoastline([380,472,412,458,362,438,388,468,375,462,398,450,365,445,392,460]),
    peaks: [{ dx: 0, dz: 0, elevation: 395, radius: 218 }],
    type: 'stack', description: 'Perfectly round when seen from the south, like the rising moon.',
    spawnX: 17580, spawnZ: -6000,
  },

  // 76. Isla Pacífica — large peaceful island in the northeast
  {
    id: 'isla-pacifica', name: 'Isla Pacífica',
    centerX: 16500, centerZ: 11000, maxRadius: 1600, peakElevation: 540,
    coastline: mkCoastline([1458,1540,1595,1578,1510,1558,1600,1565,1465,1552,1592,1558,1460,1545,1588,1552]),
    peaks: [{ dx: 0, dz: 0, elevation: 540, radius: 640 }, { dx: -300, dz: 200, elevation: 270, radius: 400 }],
    type: 'volcanic', description: 'Calm, lush, and unusually peaceful. A favourite retreat for the east faction.',
    spawnX: 18220, spawnZ: 11000,
  },

  // 77. Arrecife Este — northeast atoll
  {
    id: 'arrecife-este', name: 'Arrecife Este',
    centerX: 19500, centerZ: 14000, maxRadius: 360, peakElevation: 18,
    coastline: mkCoastline([325,345,358,350,332,348,360,345,328,346,358,342,326,344,356,340]),
    peaks: [],
    type: 'atoll', description: 'The easternmost atoll. Beyond it lies open ocean.',
    spawnX: 19900, spawnZ: 14000,
  },

  // 78. Isla Verde Oscura — dark-green volcanic island
  {
    id: 'isla-verde-oscura', name: 'Isla Verde Oscura',
    centerX: 6000, centerZ: 12500, maxRadius: 1050, peakElevation: 370,
    coastline: mkCoastline([968,1018,1048,1032,988,1025,1050,1020,972,1020,1046,1015,968,1015,1044,1010]),
    peaks: [{ dx: 0, dz: 0, elevation: 370, radius: 445 }],
    type: 'volcanic', description: 'Covered in deep-green forest so dense it looks almost black from a distance.',
    spawnX: 7170, spawnZ: 12500,
  },

  // 79. Cayo Coral — colourful small volcanic cay
  {
    id: 'cayo-coral', name: 'Cayo Coral',
    centerX: 14500, centerZ: -5500, maxRadius: 680, peakElevation: 215,
    coastline: mkCoastline([622,658,678,665,635,660,680,655,624,658,678,650,622,656,676,648]),
    peaks: [{ dx: 0, dz: 0, elevation: 215, radius: 312 }],
    type: 'volcanic', description: 'Named for the brilliant coral in the shallows around its base.',
    spawnX: 15280, spawnZ: -5500,
  },

  // 80. Isla Niebla — fog island in the southeast
  {
    id: 'isla-niebla', name: 'Isla Niebla',
    centerX: 10000, centerZ: -11000, maxRadius: 1150, peakElevation: 420,
    coastline: mkCoastline([1058,1108,1148,1130,1082,1118,1150,1112,1062,1110,1145,1105,1058,1105,1142,1102]),
    peaks: [{ dx: 0, dz: 0, elevation: 420, radius: 490 }],
    type: 'volcanic', description: 'Almost permanently wrapped in sea-fog. Approach with extreme caution.',
    spawnX: 11270, spawnZ: -11000,
  },

  // 81. Isla del Barco — ship island, sheltered cove
  {
    id: 'isla-del-barco', name: 'Isla del Barco',
    centerX: 9500, centerZ: -7000, maxRadius: 850, peakElevation: 298,
    coastline: mkCoastline([782,825,848,832,795,828,850,820,785,822,846,815,780,820,844,812]),
    peaks: [{ dx: 0, dz: 0, elevation: 298, radius: 380 }],
    type: 'volcanic', description: 'An old wreck is visible in the shallows on the east side. The island took its name from it.',
    spawnX: 10460, spawnZ: -7000,
  },

  // 82. Punta Este — eastward-pointing cape island
  {
    id: 'punta-este', name: 'Punta Este',
    centerX: 19500, centerZ: 0, maxRadius: 1000, peakElevation: 360,
    coastline: mkCoastline([920,965,998,982,940,972,1000,968,928,968,996,960,924,962,994,955]),
    peaks: [{ dx: 0, dz: 0, elevation: 360, radius: 440 }],
    type: 'volcanic', description: 'The easternmost prominent island. The end of the navigable world.',
    spawnX: 19900, spawnZ: 0,
  },

  // 83. Isla Caliente — hot volcanic island in the south-east
  {
    id: 'isla-caliente', name: 'Isla Caliente',
    centerX: 13000, centerZ: -13000, maxRadius: 1300, peakElevation: 560,
    coastline: mkCoastline([1188,1255,1295,1278,1222,1260,1300,1268,1195,1255,1292,1262,1190,1250,1288,1258]),
    peaks: [{ dx: 0, dz: 0, elevation: 560, radius: 530 }, { dx: 150, dz: -120, elevation: 280, radius: 320 }],
    type: 'volcanic', description: 'The ground is warm to the touch everywhere on this thermally active island.',
    spawnX: 14420, spawnZ: -13000,
  },

  // 84. Islote Alba Menor — minor dawn islet
  {
    id: 'islote-alba-menor', name: 'Islote Alba Menor',
    centerX: 12000, centerZ: 2000, maxRadius: 560, peakElevation: 188,
    coastline: mkCoastline([512,542,558,548,522,545,560,540,515,542,558,535,512,540,556,535]),
    peaks: [{ dx: 0, dz: 0, elevation: 188, radius: 258 }],
    type: 'volcanic', description: 'A smaller companion to Puerto del Alba. Often used as an outer anchorage.',
    spawnX: 12670, spawnZ: 2000,
  },

  // 85. Isla Piedra — stone-grey E-W ridge
  {
    id: 'isla-piedra', name: 'Isla Piedra',
    centerX: 16000, centerZ: 3000, maxRadius: 1200, peakElevation: 415,
    coastline: mkCoastline([610,895,1145,1200,1165,880,595,310,290,350,620,1180,1195,850,580,295]),
    peaks: [{ dx: 0, dz: 0, elevation: 415, radius: 500 }],
    type: 'ridge', description: 'A grey stone ridge running east-west, mid-way between Trueno and Creciente.',
    spawnX: 17320, spawnZ: 3000,
  },

  // 86. Cayo Quieto — quiet far-north eastern cay
  {
    id: 'cayo-quieto', name: 'Cayo Quieto',
    centerX: 4500, centerZ: 14500, maxRadius: 620, peakElevation: 28,
    coastline: mkCoastline([568,598,618,608,578,602,620,598,572,600,618,594,568,598,616,592]),
    peaks: [],
    type: 'atoll', description: 'An unusually quiet atoll in the north. Even the birds seem muted here.',
    spawnX: 5220, spawnZ: 14500,
  },

  // 87. Isla de los Vientos — crescent pointing into the trade winds
  {
    id: 'isla-de-los-vientos', name: 'Isla de los Vientos',
    centerX: 19000, centerZ: -4500, maxRadius: 1000, peakElevation: 340,
    coastline: mkCoastline([950,990,720,450,280,320,590,880,1000,960,740,460,290,330,600,890]),
    peaks: [{ dx: 0, dz: 0, elevation: 340, radius: 420 }],
    type: 'crescent', description: 'Shaped like a cupped hand to catch the prevailing wind. Sailors call it the Sail.',
    spawnX: 19900, spawnZ: -4500,
  },

  // 88. Islote Seco — dry barren stack
  {
    id: 'islote-seco', name: 'Islote Seco',
    centerX: 14500, centerZ: -11500, maxRadius: 440, peakElevation: 280,
    coastline: mkCoastline([352,435,388,418,342,405,368,428,358,425,378,412,345,410,372,420]),
    peaks: [{ dx: 0, dz: 0, elevation: 280, radius: 200 }],
    type: 'stack', description: 'A parched, waterless stack. No ship stops here willingly.',
    spawnX: 15040, spawnZ: -11500,
  },

  // 89. Isla Espejo — mirror-calm lagoon island
  {
    id: 'isla-espejo', name: 'Isla Espejo',
    centerX: 8500, centerZ: 9500, maxRadius: 950, peakElevation: 330,
    coastline: mkCoastline([875,920,948,932,895,928,950,918,878,922,945,915,872,918,942,910]),
    peaks: [{ dx: 0, dz: 0, elevation: 330, radius: 415 }],
    type: 'volcanic', description: 'The lagoon on the west side is completely flat — a perfect mirror of the sky.',
    spawnX: 9560, spawnZ: 9500,
  },

  // 90. Bajo Tormentoso — stormy southern shoal
  {
    id: 'bajo-tormentoso', name: 'Bajo Tormentoso',
    centerX: 7500, centerZ: -13000, maxRadius: 280, peakElevation: 18,
    coastline: mkCoastline([252,268,278,272,258,272,280,268,255,270,278,266,254,268,278,264]),
    peaks: [],
    type: 'atoll', description: 'Waves break across this shoal even in calm weather. Avoid in any storm.',
    spawnX: 7880, spawnZ: -13000,
  },

  // 91. Isla Frontera — frontier island at the edge of east waters
  {
    id: 'isla-frontera', name: 'Isla Frontera',
    centerX: 3000, centerZ: -8000, maxRadius: 1200, peakElevation: 440,
    coastline: mkCoastline([1098,1158,1195,1178,1120,1162,1200,1162,1105,1158,1192,1155,1098,1152,1188,1148]),
    peaks: [{ dx: 0, dz: 0, elevation: 440, radius: 510 }],
    type: 'volcanic', description: 'On the frontier between east and central waters. Often contested.',
    spawnX: 4320, spawnZ: -8000,
  },

  // 92. Roca Gris — grey volcanic rock in the far northeast
  {
    id: 'roca-gris', name: 'Roca Gris',
    centerX: 17000, centerZ: 14000, maxRadius: 580, peakElevation: 210,
    coastline: mkCoastline([532,562,578,568,542,565,580,558,535,562,578,554,532,560,576,552]),
    peaks: [{ dx: 0, dz: 0, elevation: 210, radius: 268 }],
    type: 'volcanic', description: 'A featureless grey rock in the far northeast. Useful only as a bearing.',
    spawnX: 17680, spawnZ: 14000,
  },

  // 93. Islote Blanco — white-cliffed small island
  {
    id: 'islote-blanco', name: 'Islote Blanco',
    centerX: 7000, centerZ: 1500, maxRadius: 620, peakElevation: 200,
    coastline: mkCoastline([568,600,618,608,578,602,620,598,572,600,618,595,568,598,616,592]),
    peaks: [{ dx: 0, dz: 0, elevation: 200, radius: 285 }],
    type: 'volcanic', description: 'White chalk cliffs on the east face catch the morning light beautifully.',
    spawnX: 7720, spawnZ: 1500,
  },

  // 94. Isla Rocosa del Este — rocky eastern mid-water ridge
  {
    id: 'isla-rocosa-del-este', name: 'Isla Rocosa del Este',
    centerX: 11000, centerZ: -5000, maxRadius: 1050, peakElevation: 385,
    coastline: mkCoastline([980,835,580,320,280,335,600,855,1050,840,595,328,282,340,605,848]),
    peaks: [{ dx: 0, dz: 0, elevation: 385, radius: 445 }],
    type: 'ridge', description: 'A rocky mid-water ridge in eastern waters. The passage between it and Trueno is narrow.',
    spawnX: 12170, spawnZ: -5000,
  },

  // 95. Bajo Limpio — clean northeastern atoll
  {
    id: 'bajo-limpio', name: 'Bajo Limpio',
    centerX: 10500, centerZ: 14500, maxRadius: 320, peakElevation: 18,
    coastline: mkCoastline([290,308,318,312,296,310,320,308,292,308,318,305,290,307,317,304]),
    peaks: [],
    type: 'atoll', description: 'The water here is extraordinarily clear. The seabed is visible at great depth.',
    spawnX: 10880, spawnZ: 14500,
  },

  // 96. Cayo del Este Lejano — far southeast volcanic key
  {
    id: 'cayo-del-este-lejano', name: 'Cayo del Este Lejano',
    centerX: 18500, centerZ: -13000, maxRadius: 520, peakElevation: 178,
    coastline: mkCoastline([478,505,518,510,488,508,520,505,480,506,518,502,478,504,516,500]),
    peaks: [{ dx: 0, dz: 0, elevation: 178, radius: 240 }],
    type: 'volcanic', description: 'The farthest southeast key. A lonely, windswept waypoint.',
    spawnX: 19120, spawnZ: -13000,
  },

  // 97. Islote Norte Este — northern eastern islet
  {
    id: 'islote-norte-este', name: 'Islote Norte Este',
    centerX: 12000, centerZ: 14000, maxRadius: 680, peakElevation: 222,
    coastline: mkCoastline([622,658,678,665,635,660,680,655,624,658,678,650,621,656,676,648]),
    peaks: [{ dx: 0, dz: 0, elevation: 222, radius: 312 }],
    type: 'volcanic', description: 'A small island in the far northeast. Rarely visited but well-charted.',
    spawnX: 12780, spawnZ: 14000,
  },

  // 98. Roca del Faro Este — eastern lighthouse rock
  {
    id: 'roca-del-faro-este', name: 'Roca del Faro Este',
    centerX: 9000, centerZ: -2000, maxRadius: 440, peakElevation: 295,
    coastline: mkCoastline([352,435,388,418,342,405,368,428,358,424,378,412,345,410,372,420]),
    peaks: [{ dx: 0, dz: 0, elevation: 295, radius: 200 }],
    type: 'stack', description: 'A pillar of rock that once bore a lighthouse, now long extinguished.',
    spawnX: 9540, spawnZ: -2000,
  },

  // 99. Isla del Amanecer — dawn island in the southeast
  {
    id: 'isla-del-amanecer', name: 'Isla del Amanecer',
    centerX: 17000, centerZ: -8500, maxRadius: 1050, peakElevation: 380,
    coastline: mkCoastline([968,1018,1048,1032,988,1025,1050,1020,972,1020,1046,1015,968,1015,1044,1010]),
    peaks: [{ dx: 0, dz: 0, elevation: 380, radius: 455 }],
    type: 'volcanic', description: 'Named by sailors who reached it at first light after crossing from the west.',
    spawnX: 18170, spawnZ: -8500,
  },

  // 100. Cayo Sur Este — far southeast atoll
  {
    id: 'cayo-sur-este', name: 'Cayo Sur Este',
    centerX: 13500, centerZ: 15000, maxRadius: 500, peakElevation: 22,
    coastline: mkCoastline([458,482,498,488,468,484,500,482,460,483,498,480,458,482,496,478]),
    peaks: [],
    type: 'atoll', description: 'A remote southeast atoll at the edge of charted waters.',
    spawnX: 14100, spawnZ: 15000,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Combined list — islands()[0] is the default spawn island.
//  Puerto de la Esperanza is first so new players appear in west waters.
// ─────────────────────────────────────────────────────────────────────────────

const ISLANDS = [
  WEST[0],    // Puerto de la Esperanza  ← default spawn
  EAST[0],    // Puerto del Alba         ← east faction spawn
  ...CENTRAL,
  ...WEST.slice(1),
  ...EAST.slice(1),
];

exports.getIslands = (req, res) => {
  res.json(ISLANDS);
};

exports.getIslandById = (req, res) => {
  const island = ISLANDS.find(i => i.id === req.params.id);
  if (!island) return res.status(404).json({ message: 'Island not found' });
  res.json(island);
};
