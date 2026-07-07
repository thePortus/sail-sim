module.exports = (sequelize, DataTypes) => {
  return sequelize.define('user', {
    username: { type: DataTypes.STRING(50),  allowNull: false, unique: true },
    callsign:    { type: DataTypes.STRING(100), allowNull: false, unique: true },
    password: { type: DataTypes.STRING,      allowNull: false },
    role: {
      type: DataTypes.ENUM('Owner', 'Admin', 'Editor', 'Viewer'),
      defaultValue: 'Viewer',
    },

    // When true, login is refused. Set/cleared by Owner/Admin via /ban /unban.
    banned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Per-user CHAT profanity filter — masks profane words in received chat. DEFAULT ON; the player may opt
    // out to see raw text. (The hard block on profane usernames/callsigns/ship names is always enforced and
    // is NOT this setting.)
    profanityFilter: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    // ── Last-known sailing position ──────────────────────────────────────────
    // Persisted on each auto-save (every 30 s), on exit, and on logout.
    // NULL means the player has never sailed — they will spawn at the island default.
    lastX:           { type: DataTypes.DOUBLE,     allowNull: true, defaultValue: null },
    lastZ:           { type: DataTypes.DOUBLE,     allowNull: true, defaultValue: null },
    lastHeading:     { type: DataTypes.FLOAT,      allowNull: true, defaultValue: null },
    lastVesselSlug:  { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
    lastCallsign:    { type: DataTypes.STRING(16), allowNull: true, defaultValue: null },
    locationSavedAt: { type: DataTypes.DATE,       allowNull: true, defaultValue: null },
    // Map version the saved position belongs to. On spawn, a saved location is restored only when this
    // matches the server's current MAP_VERSION (movement-constants.js); otherwise the player coastal-
    // spawns on the new map. NULL = a legacy save from before this column existed (treated as current).
    lastMapVersion:  { type: DataTypes.INTEGER,    allowNull: true, defaultValue: null },

    // ── Friend list ──────────────────────────────────────────────────────────
    // JSON array of callsigns this user has explicitly friended.
    // Mutual friendship requires both players to have each other in their list.
    friends: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },

    // ── Town Economy ───────────────────────────────────────────────────────────
    // gold: the player's purse (gold pieces). New players start with 500.
    // cargo: JSON object { goodId: qty } of held trade goods (the ship's hold).
    // tradeLedger: JSON array of recent transactions (written now; surfaced in a later phase).
    // gold/cargo persist across server restart AND across map regen (they are the player's, not the world's).
    gold:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 500 },
    cargo:       { type: DataTypes.TEXT,    allowNull: true,  defaultValue: null },
    tradeLedger: { type: DataTypes.TEXT,    allowNull: true,  defaultValue: null },

    // Persistent ship damage: JSON { zones, slug, mapVersion } of the player's last hull state. Restored on
    // reconnect (so battle damage survives logout/restart) UNLESS its mapVersion is stale (new map → full
    // hull). Cleared to full by a dock repair or a sunk→respawn.
    combatState: { type: DataTypes.TEXT,    allowNull: true,  defaultValue: null },

    // Phase 3 discovery ledger: JSON { mapVersion, towns:{ [townId]:{specialty,day,goods:[{id,ask,bid}]} } } of
    // the towns whose trader this player has opened (specialty + last-seen prices). MAP_VERSION-gated on load.
    marketLedger: { type: DataTypes.TEXT,   allowNull: true,  defaultValue: null },

    // Factions reputation: JSON { [factionId]: standing } (neutral 0 start). Persists across maps. Scaffold
    // only for now — surfaced in the Ship's Hold readout; the events module will move these values later.
    factionRep:   { type: DataTypes.TEXT,   allowNull: true,  defaultValue: null },

    // Ships-as-economy: the player's OWNED vessel slug, persisted across maps (the player's, not the world's).
    // New players start in the 'pinnace'; bigger hulls are bought at a port shipwright for gold.
    ship:         { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'pinnace' },

    // Player's custom SHIP NAME — shown to other players (label subtitle + a 3D nameboard on the stern). Set
    // when the intro tutorial ends, renamable at the shipwright, and named again on buying a new hull. Default
    // 'Saltmeadow' (the tutorial's starter trader). Not unique. Persists across maps (the player's, not the world's).
    shipName:     { type: DataTypes.STRING(64), allowNull: true, defaultValue: 'Saltmeadow' },

    // Shipwright UPGRADES on the CURRENT hull (each buyable once): cannonUpgrade → heavier guns (more damage),
    // armorUpgrade → +25% hull HP. Per-hull — reset to false when a new ship is bought. Persist across maps.
    cannonUpgrade: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    armorUpgrade:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Custom FLAG COLOUR (#rrggbb) — the player's chosen flag/ensign tint, shown on their ship's flags to
    // everyone. Set at the shipwright (RGB picker). The player's identity → persists across ship changes + maps.
    flagColor:    { type: DataTypes.STRING(7), allowNull: true, defaultValue: '#b22222' },

    // Crew resource: remaining sailors aboard (grapeshot attrites it; a port tavern re-hires). NULL = never
    // recorded → treated as the current vessel's FULL complement on load. Clamped to the vessel's max. A
    // ship change / sunk→respawn resets it to full. Drives sail/turn/reload/mast-repair speed (with a floor).
    crew:         { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },

    // Quest progress: JSON { [questId]: { stage, done:[objectiveId], status:'active'|'done' } }. NULL = brand-new
    // player → the server auto-starts the intro tutorial on login. Persists across maps (the player's, not the
    // world's). The intro's map-specific anchors (start port, spawn) are DERIVED from the live map, not stored here.
    questState:   { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
  });
};
