/**
 * Quest engine + registry (server-authoritative). The intro tutorial is the first user, but the engine is the
 * reusable foundation for all later storyline quests: quests are DATA (stages → objectives), and progress lives
 * server-side in User.questState. The engine is pure-ish — it mutates a player's parsed questState and returns
 * instructions (reward gold, client payloads); the caller (multiplayer.js) does the I/O (ws.send, gold, persist).
 *
 * Objective types (each = a server verifier here + a client guidance handler):
 *   client_ack    — a trivial UI step the client confirms ('I rotated the camera'). Never gates real value.
 *   point_of_sail — server-verified: boat speed in KNOTS ≥ params.minSpeed (proves she's sailing / on a reach).
 *                   NB: params.minSpeed is KNOTS (what the HUD shows); multiplayer.js converts the raw m/s pose
 *                   speed to knots before dispatching the 'sail' event, so authoring matches the player's gauge.
 *   dock_at       — server-verified: docked at params.port (a townId, or a 'tutorial.*' anchor symbol).
 *   trade_buy /
 *   trade_sell    — server-verified off the real trade handler (qty, and profit>0 for the sell).
 *   sink_target   — server-verified off the combat resolver: a vessel tagged params.tag was sunk by this player.
 *
 * Anchors ('tutorial.portA' / 'tutorial.tavernPort') are resolved from quest-anchors.js (map-derived), so the
 * registry stays map-agnostic. Image slots (intro_01…) are slot ids; the client resolves them to art files.
 */
const anchors = require('./quest-anchors');

// ── Registry — the intro arc (3 quests, chained by prereq) ───────────────────────────────────────────────
const QUESTS = {
  intro_seamanship: {
    id: 'intro_seamanship', title: 'Take the Helm', intro: true, prereq: [], next: 'intro_trade',
    stages: [
      {
        id: 'mutiny',
        narrative: [
          { image: 'intro_01', text: "The Saltmeadow was a tired little trader, her seams weeping tar, her hold stinking of bilge and salt cod. For three years she'd worked the coastal runs under a captain with a ledger for a heart and a rope's end for a tongue. Half-rations when the winds went foul. The lash for a slack sheet." },
          { image: 'intro_02', text: "It broke on a grey morning off the Tern Rocks, when Crane sent old Maddox aloft in a gale and reached for the lash as the old man froze on the yard. The crew reached for the captain first. No words — just the slow turning of a dozen hard faces, and his own pistol taken from his own hand." },
          { image: 'intro_03', text: "They put the captain over the side with a breaker of water and a biscuit — more mercy than he'd shown. Then they turned to you: the one who spoke first, who stepped between the old man and the lash. \"Who else?\" said the bosun. The cheer went up ragged and fierce, and the captain's spyglass was pressed into your hand." },
          { image: 'intro_04', text: "But a captain is more than a loud voice. There's the helm to master, the wind to read, coin to be made in the coastal ports, and sharper men who'll take what you have if you can't hold it. The bosun grins. \"Well then, Captain. Show us you can sail her.\"" },
        ],
        objectives: [
          { id: 'accept_command', type: 'client_ack', manual: true, label: 'Take command of the Saltmeadow', hint: 'The crew await your first order, Captain.' },
        ],
        reward: { gold: 0 },
      },
      {
        id: 'steer',
        objectives: [
          { id: 'rotate_cam', type: 'client_ack', label: 'Look about your ship', hint: 'Drag the view to rotate the camera and get your bearings.' },
          { id: 'turn_helm',  type: 'client_ack', label: 'Try the helm — turn to port and starboard', hint: 'Steer left and right to feel how she answers.' },
          { id: 'make_way',   type: 'point_of_sail', params: { minSpeed: 1.5 }, label: 'Get her under way', hint: 'Bear off the wind until the Saltmeadow gathers speed.', verify: 'server' },
        ],
        reward: { gold: 60 },
      },
      {
        id: 'sails',
        objectives: [
          { id: 'trim_sails', type: 'client_ack', label: 'Set and trim your canvas', hint: 'Raise the sails and ease the sheets to the wind.' },
          { id: 'read_wind',  type: 'client_ack', manual: true, label: 'Read the wind', hint: 'Find the wind indicator — it shows where the wind blows from.' },
          { id: 'find_reach', type: 'point_of_sail', params: { minSpeed: 3.0 }, label: 'Find a good point of sail', hint: 'Turn off the wind until the sails fill hard and your speed climbs.', verify: 'server' },
        ],
        reward: { gold: 60 },
        onComplete: { image: 'intro_05', text: "The Saltmeadow heels and surges, spray bright on her bow. The bosun thumps the rail. \"She's yours and no mistake, Captain. Now — a hungry crew needs paying. Let's find some honest trade.\"" },
      },
    ],
  },

  intro_trade: {
    id: 'intro_trade', title: 'A Cargo Worth Carrying', intro: true, prereq: ['intro_seamanship'], next: 'intro_combat',
    stages: [
      {
        id: 'buy',
        narrative: [
          { image: 'trade_01', text: "Coin is made on the water by carrying what one port has spare to a port that wants it. Put in at {portA}, see what's cheap on her quays, and fill your hold — then watch the market's word on where it'll sell dear." },
        ],
        objectives: [
          { id: 'dock_portA', type: 'dock_at', params: { port: 'tutorial.portA' }, label: 'Sail to {portA} and put in at the pier', hint: 'Follow the marker and ease alongside the quay to dock.', verify: 'server' },
          { id: 'buy_cargo',  type: 'trade_buy', params: { minQty: 1 }, label: 'Buy a cargo to trade', hint: 'Open the market and buy some goods — buy low where they are plentiful.', verify: 'server' },
        ],
        reward: { gold: 0 },
      },
      {
        id: 'sell',
        objectives: [
          { id: 'sell_cargo', type: 'trade_sell', params: { minQty: 1 }, label: 'Carry it to the port the hint names and sell', hint: 'Read the sell-hint in the market — it tells you which port will pay the most for your cargo. Sail there and sell.', verify: 'server' },
        ],
        reward: { gold: 80 },
        onComplete: { image: 'trade_02', text: "Gold chinks into the strongbox and the crew grin like cats. You've the makings of a trader, Captain — but the coast is thick with rogues who'd rather take a cargo than carry one. Best you learn to bite back." },
      },
    ],
  },

  intro_combat: {
    id: 'intro_combat', title: 'Blood in the Water', intro: true, prereq: ['intro_trade'], next: null,
    stages: [
      {
        id: 'rumour',
        narrative: [
          { image: 'combat_01', text: "Every port has a tavern, and every tavern trades in whispers — who's carrying what, who's weak, who's worth the hunting. Buy a round, lend an ear, and the sea gives up its secrets." },
        ],
        objectives: [
          { id: 'dock_tavern', type: 'dock_at', params: { port: 'tutorial.tavernPort' }, label: 'Put in at the tavern at {tavernPort}', hint: 'Dock, then step into the tavern.', verify: 'server' },
          { id: 'listen_rumour', type: 'client_ack', label: 'Listen for a rumour', hint: 'Ask the tavern after easy prey — a rumour will mark a target on your chart.' },
        ],
        reward: { gold: 0 },
      },
      {
        id: 'hunt',
        objectives: [
          { id: 'sink_prey', type: 'sink_target', params: { tag: 'tutorial' }, label: 'Hunt down and sink the marked vessel', hint: 'Follow the gold marker. Run out your guns, lay her abeam, and fire a broadside until she goes down.', verify: 'server' },
        ],
        reward: { gold: 150 },
        onComplete: { image: 'combat_02', text: "She rolls over and the sea closes black above her. Your crew roar themselves hoarse. Helm, wind, trade, and powder — you've the whole of it now, Captain. The coast is yours to make your name upon." },
      },
    ],
  },
};

const FIRST_INTRO = 'intro_seamanship';

// ── State helpers ────────────────────────────────────────────────────────────────────────────────────────
function parseState(jsonStr) { try { const o = JSON.parse(jsonStr || 'null'); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
function serializeState(qs) { return JSON.stringify(qs || {}); }
function isNewPlayer(qs) { return !qs || Object.keys(qs).length === 0; }

function quest(id) { return QUESTS[id]; }
function activeQuestId(qs) { for (const id of Object.keys(qs)) { if (qs[id] && qs[id].status === 'active') return id; } return null; }
/** True while the player is still working through the INTRO tutorial arc (their active quest is an intro quest).
 *  Used to shield brand-new captains — e.g. pirates leave them be until the tutorial's done so they aren't
 *  discouraged by an immediate attack. A skipped/finished intro → no intro quest active → false. */
function inIntro(qs) { const id = qs ? activeQuestId(qs) : null; return !!(id && QUESTS[id] && QUESTS[id].intro); }

/** Resolve a port symbol ('tutorial.portA' | literal townId) to a townId, or null if anchors aren't ready. */
function resolvePort(sym) {
  if (typeof sym !== 'string') return null;
  if (sym.startsWith('tutorial.')) { const a = anchors.getAnchors(); return a ? a[sym.slice('tutorial.'.length)] || null : null; }
  return sym;
}

// ── Public: lifecycle ───────────────────────────────────────────────────────────────────────────────────

/** Start the intro for a brand-new player. Returns true if it just activated (caller should persist + push). */
function startIfNew(qs) {
  if (!isNewPlayer(qs)) return false;
  qs[FIRST_INTRO] = { stage: 0, done: [], status: 'active' };
  return true;
}

/** Skip the whole intro (mark every intro quest done, no rewards). Returns true if anything changed. */
function skipIntro(qs) {
  let changed = false;
  for (const id of Object.keys(QUESTS)) {
    if (!QUESTS[id].intro) continue;
    if (!qs[id] || qs[id].status !== 'done') { qs[id] = { stage: 0, done: [], status: 'done' }; changed = true; }
  }
  return changed;
}

// ── Public: events → progress ─────────────────────────────────────────────────────────────────────────────

/** Does `obj` match this game event? (data shape per eventType — see file header.) */
function matches(obj, eventType, data) {
  switch (obj.type) {
    case 'client_ack':    return eventType === 'ack'   && data.objectiveId === obj.id;
    case 'point_of_sail': return eventType === 'sail'  && (data.speed || 0) >= (obj.params.minSpeed || 0);   // data.speed is KNOTS
    case 'dock_at':       return eventType === 'dock'  && data.townId != null && data.townId === resolvePort(obj.params.port);
    case 'trade_buy':     return eventType === 'trade' && data.action === 'buy'  && (data.qty || 0) >= (obj.params.minQty || 1);
    case 'trade_sell':    return eventType === 'trade' && data.action === 'sell' && (data.qty || 0) >= (obj.params.minQty || 1) && (!obj.params.profit || (data.profit || 0) > 0);
    case 'sink_target':   return eventType === 'sink'  && data.tag === obj.params.tag;
    default: return false;
  }
}

/**
 * Feed a game event into the active quest. Mutates `qs`. Returns an effect descriptor for the caller:
 *   { changed, rewardGold, completed:[questId], narratives:[{image,text}] }
 * The caller adds rewardGold to the purse, persists qs, and re-pushes the quest state (renderActive).
 */
function onEvent(qs, eventType, data) {
  const out = { changed: false, rewardGold: 0, completed: [], narratives: [] };
  let guard = 0;
  // A single event can finish a stage AND satisfy the next stage's already-met objective, so loop until stable.
  while (guard++ < 8) {
    const qid = activeQuestId(qs);
    if (!qid) break;
    const q = QUESTS[qid], st = qs[qid];
    const stage = q.stages[st.stage];
    if (!stage) { st.status = 'done'; out.changed = true; break; }

    let any = false;
    for (const obj of stage.objectives) {
      if (st.done.includes(obj.id)) continue;
      if (matches(obj, eventType, data)) { st.done.push(obj.id); any = true; out.changed = true; }
    }

    const stageDone = stage.objectives.every((o) => st.done.includes(o.id));
    if (!stageDone) { if (!any) break; else continue; }

    // Stage complete → reward + narrative, then advance (or finish the quest + activate next).
    if (stage.reward && stage.reward.gold) out.rewardGold += stage.reward.gold;
    if (stage.onComplete) out.narratives.push(stage.onComplete);
    if (st.stage + 1 < q.stages.length) {
      st.stage += 1; st.done = [];
    } else {
      st.status = 'done'; out.completed.push(qid);
      if (q.next && QUESTS[q.next] && (!qs[q.next] || qs[q.next].status !== 'done')) {
        qs[q.next] = { stage: 0, done: [], status: 'active' };
      }
    }
    out.changed = true;
    // loop again: the new stage's objectives may already be satisfied by THIS event (e.g. dock already true).
  }
  return out;
}

// ── Public: client render model ──────────────────────────────────────────────────────────────────────────

/** Fill {portA}/{portB}/{tavernPort} placeholders in a label/hint with the resolved town NAMES. */
function fillNames(text, townName) {
  if (!text) return text;
  return text.replace(/\{(portA|portB|tavernPort)\}/g, (_, k) => {
    const id = resolvePort('tutorial.' + k); const t = id && townName ? townName(id) : null; return t || 'the port';
  });
}

/** The client-facing payload for the active quest, or null if none active. `townName(id)`→ display name. */
function renderActive(qs, townName) {
  const qid = activeQuestId(qs);
  if (!qid) return null;
  const q = QUESTS[qid], st = qs[qid], stage = q.stages[st.stage];
  if (!stage) return null;
  return {
    type: 'quest_update',
    questId: qid,
    title: q.title,
    stageIndex: st.stage,
    stageCount: q.stages.length,
    narrative: (stage.narrative || []).map((n) => ({ image: n.image, text: fillNames(n.text, townName) })),
    objectives: stage.objectives.map((o) => ({
      id: o.id, type: o.type, image: o.image || null,
      // manual = a pure narrative acknowledgement (a 'Done' button); the rest are completed by a real action
      // (client-detected steering/trim/look, or a server-verified event), never by clicking.
      manual: o.type === 'client_ack' ? !!o.manual : false,
      // The resolved destination town for a dock objective (the client marks it on the map). Null otherwise.
      townId: o.type === 'dock_at' ? resolvePort(o.params.port) : null,
      label: fillNames(o.label, townName), hint: fillNames(o.hint, townName),
      done: st.done.includes(o.id),
    })),
    reward: stage.reward || { gold: 0 },
    status: 'active',
  };
}

module.exports = {
  QUESTS, FIRST_INTRO,
  parseState, serializeState, isNewPlayer,
  startIfNew, skipIntro, onEvent, renderActive,
  activeQuestId, inIntro, resolvePort, quest,
};
