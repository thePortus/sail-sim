#include "net_mp.hpp"

#include <atomic>
#include <chrono>
#include <mutex>

#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXNetSystem.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace mp {

struct Client::Impl {
  ix::WebSocket ws;
  mutable std::mutex mtx;
  std::atomic<ConnState> conn{ ConnState::Idle };
  std::string myId;
  std::string ownedShip;
  std::map<std::string, RemotePlayer> players;
  WaveState wave;
  std::vector<ChatMessage> chatIn;   // drained by the render loop each frame
  SquadronState squad;               // our current squadron roster (live-read)
  TownState townSt;                  // wallet/crew/market/dock-menu replies
  std::vector<LaneHotspot> lanes;
  std::vector<MapShip> allMerchants;
  std::vector<MapPirate> allPirates;
  Correction corr;
  // ── Combat state (drained/read by the render loop) ──
  std::vector<RemoteShot> shotsIn;
  std::vector<CombatHit> hitsIn;
  std::vector<SunkEvent> sunkIn;
  std::vector<std::string> repairedIn;
  std::map<std::string, CombatShipState> combat;
  std::map<std::string, FortState> forts;
  std::map<std::string, std::map<std::string, std::string>> diplo;   // faction relation matrix (diplomacy_state)
  std::map<std::string, std::pair<int, int>> crewBy;   // playerId -> {crew, maxCrew}
  float mastRepairMs = 0;                              // armed jury-rig duration (0 = none)
  std::map<std::string, std::pair<int, int>> gunBy;    // playerId -> {port, stbd} deploy targets
  std::map<std::string, SalvageCrate> crates;
  SalvageCollected salvaged;
  RepairResult repairRes;
  // ── Intro tutorial / quests ──
  QuestUpdate questUpd;          // live-read active quest (active=false => none)
  QuestNarrative questNarr;      // closing-beat panels (consume-once)
  int questReward = -1;          // silent stage gold for a toast (-1 = none pending)
  RenamePrompt renamePrompt;     // server invited a ship rename (consume-once)
  ShipNameReply shipNameReply;   // reply to a setShipName (consume-once)

  // Null-safe string read: the quest payload sends nullable fields (e.g. an
  // objective's `image: o.image || null`), and json::value(key, "") THROWS on a
  // present-but-null field — so read only when it's actually a string.
  static std::string jstr(const json& j, const char* key) {
    auto it = j.find(key);
    return (it != j.end() && it->is_string()) ? it->get<std::string>() : std::string();
  }
  static std::vector<QuestPanel> parsePanels(const json& arr) {
    std::vector<QuestPanel> v;
    if (arr.is_array())
      for (const auto& p : arr) v.push_back({ jstr(p, "image"), jstr(p, "text") });
    return v;
  }

  static void parseZones(const json& j, CombatZones& z) {
    z.bow       = j.value("bow", z.bow);
    z.stern     = j.value("stern", z.stern);
    z.port      = j.value("port", z.port);
    z.starboard = j.value("starboard", z.starboard);
    z.masts     = j.value("masts", z.masts);
  }

  static RemotePlayer parsePlayer(const json& j) {
    RemotePlayer r;
    r.id         = j.value("id", std::string());
    r.x          = j.value("x", 0.0f);
    r.z          = j.value("z", 0.0f);
    r.heading    = j.value("heading", 0.0f);
    r.speed      = j.value("speed", 0.0f);
    r.callsign   = j.value("callsign", std::string());
    r.vesselName = j.value("vesselName", std::string());
    r.vesselSlug = j.value("vesselSlug", std::string());
    r.sailState  = j.value("sailState", std::string());
    r.npc        = j.value("npc", false);
    r.role       = j.value("role", std::string());
    r.turnRate   = j.value("turnRate", 0.0f);
    r.seq        = j.value("seq", 0);
    r.sheetAngle = j.value("sheetAngle", 30.0f);
    r.isPortTack = j.value("isPortTack", false);
    r.anchored   = j.value("anchored", false);
    r.anchorSide = j.value("anchorSide", std::string("S"));
    return r;
  }

  // Store an update, bumping the per-player message counter + arrival stamp the
  // motion smoothing keys on (the client's per-message buffer.push equivalent —
  // the protocol seq can't be used: NPC broadcasts always carry seq 0).
  void stampAndStore(RemotePlayer& rp) {
    auto it = players.find(rp.id);
    rp.updSeq = (it != players.end() ? it->second.updSeq : 0) + 1;
    rp.arrivedMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    players[rp.id] = rp;
  }

  void onMessage(const json& msg) {
    const std::string type = msg.value("type", std::string());
    std::lock_guard<std::mutex> lock(mtx);
    if (type == "welcome") {
      myId = msg.value("id", std::string());
    } else if (type == "snapshot") {
      players.clear();
      if (msg.contains("players") && msg["players"].is_array()) {
        for (const auto& p : msg["players"]) {
          RemotePlayer rp = parsePlayer(p);
          if (!rp.id.empty() && rp.id != myId) stampAndStore(rp);
        }
      }
    } else if (type == "update") {
      RemotePlayer rp = parsePlayer(msg);
      if (!rp.id.empty() && rp.id != myId) stampAndStore(rp);
    } else if (type == "correction") {
      corr.valid = true;
      corr.x = msg.value("x", 0.0f);
      corr.z = msg.value("z", 0.0f);
      corr.heading = msg.value("heading", 0.0f);
      corr.speed = msg.value("speed", 0.0f);
    } else if (type == "leave") {
      players.erase(msg.value("id", std::string()));
      gunBy.erase(msg.value("id", std::string()));
    } else if (type == "wave_state") {
      wave.valid       = true;
      wave.windBearing = msg.value("windBearing", 0.0f);
      wave.windSpeed   = msg.value("windSpeed", 0.0f);
      wave.beaufort    = msg.value("beaufort", 0);
      wave.t           = msg.value("t", 0.0f);
      wave.cloudiness    = msg.value("cloudiness", 0.25f);
      wave.timeOffsetSec = msg.value("timeOffsetSec", 0.0f);
      wave.overrideOn    = msg.value("override", false);
    } else if (type == "wallet") {
      ownedShip = msg.value("ship", ownedShip);   // server-authoritative owned hull
      townSt.gold     = msg.value("gold", townSt.gold);
      townSt.capacity = msg.value("capacity", townSt.capacity);
      townSt.ship     = msg.value("ship", townSt.ship);
      townSt.shipName = msg.value("shipName", townSt.shipName);
      townSt.cannonUpgrade = msg.value("cannonUpgrade", townSt.cannonUpgrade);
      townSt.armorUpgrade  = msg.value("armorUpgrade", townSt.armorUpgrade);
      if (msg.contains("cargo") && msg["cargo"].is_object()) {
        townSt.cargo.clear();
        for (auto& [k, v] : msg["cargo"].items()) if (v.is_number()) townSt.cargo[k] = v.get<int>();
      }
      if (msg.contains("catalog") && msg["catalog"].is_object()) {
        for (auto& [k, v] : msg["catalog"].items()) if (v.is_string()) townSt.catalog[k] = v.get<std::string>();
      }
      if (msg.contains("factionRep") && msg["factionRep"].is_object()) {
        for (auto& [k, v] : msg["factionRep"].items()) if (v.is_number()) townSt.factionRep[k] = v.get<float>();
      }
    } else if (type == "crew_state") {
      const std::string pid = msg.value("playerId", std::string());
      if (pid == myId) {
        townSt.crew    = msg.value("crew", townSt.crew);
        townSt.maxCrew = msg.value("maxCrew", townSt.maxCrew);
      }
      if (!pid.empty())
        crewBy[pid] = { msg.value("crew", 0), msg.value("maxCrew", 0) };
    } else if (type == "cannon_shot") {
      // Only broadcasts carry an id (our own sends are never echoed back).
      RemoteShot s;
      s.id = msg.value("id", std::string());
      if (!s.id.empty() && s.id != myId) {
        s.seq = msg.value("seq", 0);
        s.ox = msg.value("ox", 0.0f); s.oy = msg.value("oy", 0.0f); s.oz = msg.value("oz", 0.0f);
        s.vx = msg.value("vx", 0.0f); s.vy = msg.value("vy", 0.0f); s.vz = msg.value("vz", 0.0f);
        s.shotType = msg.value("shotType", std::string("round"));
        if (shotsIn.size() >= 256) shotsIn.erase(shotsIn.begin());
        shotsIn.push_back(std::move(s));
      }
    } else if (type == "gun_state") {
      const std::string pid = msg.value("id", std::string());
      if (!pid.empty() && pid != myId) {
        auto& g = gunBy[pid];
        int dep = msg.value("deploy", 0);
        if (msg.value("side", std::string()) == "port") g.first = dep; else g.second = dep;
      }
    } else if (type == "combat_hit") {
      CombatHit h;
      h.shooterId = msg.value("shooterId", std::string());
      h.victimId  = msg.value("victimId", std::string());
      h.seq       = msg.value("seq", 0);
      h.zone      = msg.value("zone", std::string());
      h.hx = msg.value("hx", 0.0f); h.hy = msg.value("hy", 0.0f); h.hz = msg.value("hz", 0.0f);
      h.side      = msg.value("side", std::string());
      h.tof       = msg.value("tof", 0.0f);
      h.grape     = msg.value("grape", false);
      h.fortId    = msg.value("fortId", std::string());
      h.fort      = msg.value("fort", false) || !h.fortId.empty();
      if (hitsIn.size() >= 256) hitsIn.erase(hitsIn.begin());
      hitsIn.push_back(std::move(h));
    } else if (type == "combat_state") {
      const std::string pid = msg.value("playerId", std::string());
      if (!pid.empty()) {
        CombatShipState& cs = combat[pid];
        cs.valid = true;
        if (msg.contains("zones") && msg["zones"].is_object()) parseZones(msg["zones"], cs.zones);
        if (msg.contains("maxHp") && msg["maxHp"].is_object()) parseZones(msg["maxHp"], cs.maxHp);
        // The armed jury-rig clears once our masts climb back above zero.
        if (pid == myId && cs.zones.masts > 0.0f) mastRepairMs = 0;
      }
    } else if (type == "fort_state") {
      const std::string fid = msg.value("id", std::string());
      if (!fid.empty() && msg.contains("guns") && msg["guns"].is_array()) {
        FortState fs; fs.neutralized = msg.value("neutralized", false);
        for (const auto& g : msg["guns"]) {
          float hp = g.value("hp", 0.0f), mx = g.value("maxHp", 0.0f);
          fs.hp += hp; fs.maxHp += mx; fs.gunsTotal++; if (hp > 0.0f) fs.gunsUp++;
        }
        forts[fid] = fs;
      }
    } else if (type == "diplomacy_state") {
      if (msg.contains("matrix") && msg["matrix"].is_object()) {
        diplo.clear();
        for (auto& [a, row] : msg["matrix"].items())
          if (row.is_object())
            for (auto& [b, rel] : row.items())
              if (rel.is_string()) diplo[a][b] = rel.get<std::string>();
      }
    } else if (type == "mast_repair") {
      mastRepairMs = msg.value("ms", 60000.0f);
    } else if (type == "combat_sunk") {
      SunkEvent e;
      e.victimId    = msg.value("victimId", std::string());
      e.shooterId   = msg.value("shooterId", std::string());
      e.shooterName = msg.value("shooterName", std::string());
      if (sunkIn.size() >= 64) sunkIn.erase(sunkIn.begin());
      sunkIn.push_back(std::move(e));
    } else if (type == "combat_repair") {
      std::string pid = msg.value("playerId", msg.value("id", std::string()));
      if (!pid.empty()) {
        if (repairedIn.size() >= 64) repairedIn.erase(repairedIn.begin());
        repairedIn.push_back(std::move(pid));
      }
    } else if (type == "repair_result") {
      repairRes.valid   = true;
      repairRes.ok      = msg.value("ok", false);
      repairRes.gold    = msg.value("gold", 0);
      repairRes.charged = msg.value("charged", 0);
      repairRes.mercy   = msg.value("mercy", false);
      repairRes.free    = msg.value("free", false);
      if (repairRes.ok) townSt.gold = repairRes.gold;
    } else if (type == "salvage_snapshot") {
      crates.clear();
      if (msg.contains("crates") && msg["crates"].is_array())
        for (const auto& c : msg["crates"]) {
          SalvageCrate sc{ c.value("id", std::string()), c.value("x", 0.0f), c.value("z", 0.0f) };
          if (!sc.id.empty()) crates[sc.id] = sc;
        }
    } else if (type == "salvage_spawn") {
      SalvageCrate sc{ msg.value("id", std::string()), msg.value("x", 0.0f), msg.value("z", 0.0f) };
      if (!sc.id.empty()) crates[sc.id] = sc;
    } else if (type == "salvage_despawn") {
      crates.erase(msg.value("id", std::string()));
    } else if (type == "salvage_collected") {
      salvaged.valid = true;
      salvaged.gold += msg.value("gold", 0);
      if (msg.contains("goods") && msg["goods"].is_object())
        for (auto& [k, v] : msg["goods"].items())
          if (v.is_number()) salvaged.goods[k] += v.get<int>();
    } else if (type == "recruit_result") {
      if (msg.value("ok", false)) {
        int charged = msg.value("charged", 0);
        townSt.recruitStatus = charged > 0 ? "Signed a hand for " + std::to_string(charged) + "g."
                                           : "A willing hand signs on for free.";
      } else {
        townSt.recruitStatus = "No luck: " + msg.value("reason", std::string("unknown"));
      }
    } else if (type == "rumor_result") {
      if (msg.value("ok", false)) {
        std::string slug = msg.value("slug", std::string("ship"));
        std::string to = msg.value("to", std::string());
        std::string from;
        if (msg.contains("from") && msg["from"].is_string()) from = msg["from"].get<std::string>();
        townSt.rumorText = "A " + slug + (from.empty() ? "" : " out of " + from)
                         + " is bound for " + (to.empty() ? "parts unknown" : to) + ".";
        townSt.rumorStatus.clear();
        townSt.rumorShipId = msg.value("shipId", std::string());
      } else {
        townSt.rumorText.clear();
        std::string r = msg.value("reason", std::string());
        townSt.rumorStatus = r == "no_rumours" ? "No talk of treasure ships tonight."
                                               : "The talk dries up (" + r + ").";
      }
    } else if (type == "sell_hint") {
      // Server replays the trade sell-hint (map SELL-HERE beacon) — e.g. on reconnect, since the
      // market-state hint that normally sets it is connection state lost on disconnect.
      townSt.hintTownId = msg.value("townId", std::string());
    } else if (type == "pirate_report_result") {
      townSt.pirate.valid = true;
      townSt.pirate.ok = msg.value("ok", false);
      if (townSt.pirate.ok) townSt.pirateShipId = msg.value("shipId", std::string());
      townSt.pirate.reason = msg.value("reason", std::string());
      townSt.pirate.name = msg.value("name", std::string());
      townSt.pirate.slug = msg.value("slug", std::string());
      townSt.pirate.kills = msg.value("kills", 0);
      townSt.pirate.bounty = msg.value("bounty", 0);
      townSt.pirate.plunder = msg.value("plunder", 0);
    } else if (type == "market_state") {
      townSt.market.valid = true;
      townSt.market.townId = msg.value("townId", std::string());
      townSt.market.specialty = msg.value("specialty", std::string());
      townSt.market.goods.clear();
      if (msg.contains("goods") && msg["goods"].is_array()) {
        for (const auto& g : msg["goods"]) {
          MarketGood mg;
          mg.id  = g.value("goodId", g.value("id", std::string()));
          mg.ask = g.value("ask", 0);
          mg.bid = g.value("bid", 0);
          if (!mg.id.empty()) townSt.market.goods.push_back(mg);
        }
      }
      if (msg.contains("hint") && msg["hint"].is_object()) {
        const auto& h = msg["hint"];
        townSt.market.hintText = "Best buyer for " + h.value("goodId", std::string("goods"))
                               + ": " + h.value("townName", h.value("townId", std::string("?")))
                               + " (pays " + std::to_string(h.value("bid", 0)) + "g)";
        townSt.hintTownId = h.value("townId", std::string());
      } else townSt.market.hintText.clear();
      townSt.gold = msg.value("gold", townSt.gold);
      townSt.capacity = msg.value("capacity", townSt.capacity);
      if (msg.contains("cargo") && msg["cargo"].is_object()) {
        townSt.cargo.clear();
        for (auto& [k, v] : msg["cargo"].items()) if (v.is_number()) townSt.cargo[k] = v.get<int>();
      }
      townSt.tradeStatus.clear();
    } else if (type == "trade_error") {
      townSt.tradeStatus = msg.value("reason", std::string("rejected"));
    } else if (type == "pardon_ok") {
      townSt.pardonStatus = "Pardon granted: standing restored by "
                          + std::to_string(msg.value("restored", 0)) + " for "
                          + std::to_string(msg.value("cost", 0)) + "g.";
    } else if (type == "pardon_error") {
      std::string r = msg.value("reason", std::string());
      townSt.pardonStatus = r == "not_needed" ? "Your standing needs no pardon."
                          : r == "no_gold"    ? "You can't afford the fee."
                          : "Petition refused (" + r + ").";
    } else if (type == "ship_bought") {
      townSt.shipStatus = "She's yours - " + msg.value("slug", std::string())
                        + " for " + std::to_string(msg.value("cost", 0)) + "g.";
    } else if (type == "ship_error") {
      std::string r = msg.value("reason", std::string());
      townSt.shipStatus = r == "no_gold" ? "Not enough gold."
                        : r == "hold_too_small" ? "Your cargo won't fit her hold - sell down first."
                        : r == "already_owned" ? "You already sail her."
                        : "The shipwright refuses (" + r + ").";
    } else if (type == "upgrade_bought") {
      townSt.shipStatus = "Fitted: " + msg.value("kind", std::string()) + " upgrade for "
                        + std::to_string(msg.value("cost", 0)) + "g.";
    } else if (type == "upgrade_error") {
      std::string r = msg.value("reason", std::string());
      townSt.shipStatus = r == "already_owned" ? "Already fitted on this hull."
                        : r == "no_gold" ? "Not enough gold."
                        : "No upgrade (" + r + ").";
    } else if (type == "shipping_lanes") {
      lanes.clear();
      if (msg.contains("hotspots") && msg["hotspots"].is_array())
        for (const auto& h : msg["hotspots"]) {
          LaneHotspot lh;
          lh.x = h.value("x", 0.0f); lh.z = h.value("z", 0.0f);
          lh.w = std::min(1.0f, std::max(0.0f, h.value("w", 0.0f)));
          lanes.push_back(lh);
        }
    } else if (type == "all_merchants") {
      allMerchants.clear();
      if (msg.contains("ships") && msg["ships"].is_array())
        for (const auto& m : msg["ships"])
          allMerchants.push_back({ m.value("x", 0.0f), m.value("z", 0.0f) });
    } else if (type == "all_pirates") {
      allPirates.clear();
      if (msg.contains("ships") && msg["ships"].is_array())
        for (const auto& m : msg["ships"]) {
          MapPirate mp;
          mp.x = m.value("x", 0.0f); mp.z = m.value("z", 0.0f);
          mp.hunter = m.value("role", std::string()) == "hunter";
          mp.name = m.value("name", std::string());
          if (m.contains("faction") && m["faction"].is_string()) mp.faction = m["faction"].get<std::string>();
          mp.slug = m.value("slug", std::string());
          mp.bounty = m.value("bounty", 0); mp.kills = m.value("kills", 0);
          allPirates.push_back(std::move(mp));
        }
    } else if (type == "reputation_changed") {
      if (msg.contains("factionRep") && msg["factionRep"].is_object())
        for (auto& [k, v] : msg["factionRep"].items()) if (v.is_number()) townSt.factionRep[k] = v.get<float>();
    } else if (type == "chat") {
      ChatMessage cm;
      cm.chatType = msg.value("chatType", std::string("global"));
      cm.from     = msg.value("from", std::string());
      cm.to       = msg.value("to", std::string());
      cm.text     = msg.value("text", std::string());
      if (!cm.text.empty()) {
        if (chatIn.size() >= 256) chatIn.erase(chatIn.begin());   // undrained backstop
        chatIn.push_back(std::move(cm));
      }
    } else if (type == "squadron_state") {
      // Roster broadcast: squadronId null (or empty members) => we left/disbanded.
      squad = SquadronState{};
      if (!msg.value("squadronId", json()).is_null()) {
        squad.id       = msg.value("squadronId", std::string());
        squad.leaderId = msg.value("leaderId", std::string());
        if (msg.contains("members") && msg["members"].is_array()) {
          for (const auto& m : msg["members"])
            squad.members.push_back({ m.value("id", std::string()),
                                      m.value("callsign", std::string()) });
        }
      }
    } else if (type == "quest_update") {
      // Active-quest stage snapshot; questId null => clear the tracker (intro done/skipped).
      questUpd = QuestUpdate{};
      if (!msg.value("questId", json()).is_null()) {
        questUpd.active     = true;
        questUpd.questId    = jstr(msg, "questId");
        questUpd.intro      = questUpd.questId.rfind("intro_", 0) == 0;
        questUpd.title      = jstr(msg, "title");
        questUpd.stageIndex = msg.value("stageIndex", 0);
        questUpd.stageCount = msg.value("stageCount", 0);
        questUpd.narrative  = parsePanels(msg.value("narrative", json::array()));
        if (msg.contains("objectives") && msg["objectives"].is_array())
          for (const auto& o : msg["objectives"]) {
            QuestObjective q;
            q.id     = jstr(o, "id");
            q.type   = jstr(o, "type");
            q.image  = jstr(o, "image");   // nullable on the wire
            q.townId = jstr(o, "townId");  // nullable; set for dock_at objectives
            q.label  = jstr(o, "label");
            q.hint   = jstr(o, "hint");
            q.manual = o.value("manual", false);
            q.done   = o.value("done", false);
            questUpd.objectives.push_back(std::move(q));
          }
        if (msg.contains("reward") && msg["reward"].is_object())
          questUpd.rewardGold = msg["reward"].value("gold", 0);
      }
    } else if (type == "quest_narrative") {
      questNarr.valid = true;
      questNarr.panels = parsePanels(msg.value("panels", json::array()));
      questNarr.rewardGold = msg.value("rewardGold", 0);
    } else if (type == "quest_reward") {
      questReward = msg.value("gold", 0);
    } else if (type == "rename_prompt") {
      renamePrompt.valid = true;
      std::string sn = jstr(msg, "shipName");
      renamePrompt.shipName = sn.empty() ? "Saltmeadow" : sn;
    } else if (type == "ship_name_set") {
      // Reply to set_ship_name: adopt the accepted name, or flag a profanity rejection.
      shipNameReply.valid = true;
      shipNameReply.ok = jstr(msg, "rejected").empty();
      std::string sn = jstr(msg, "shipName");
      shipNameReply.name = sn.empty() ? "Saltmeadow" : sn;
      if (shipNameReply.ok) townSt.shipName = shipNameReply.name;
    }
    // squadron_invited needs no special handling: the server also sends a system
    // chat line ("... invited you ... type /squad accept"), which the chat panel
    // already shows, and /squad accept goes back through sendChat.
  }
};

Client::Client() : p_(std::make_unique<Impl>()) {
  ix::initNetSystem();
}

Client::~Client() {
  p_->ws.stop();
}

void Client::connect(const std::string& host, int port, const std::string& token) {
  // Explicit "/" path so the query survives (raw clients don't normalise an empty
  // path the way browsers do). JWT is base64url, so it needs no percent-encoding.
  p_->ws.setUrl("ws://" + host + ":" + std::to_string(port) + "/?token=" + token);
  p_->conn = ConnState::Connecting;

  Impl* impl = p_.get();
  p_->ws.setOnMessageCallback([impl](const ix::WebSocketMessagePtr& m) {
    if (m->type == ix::WebSocketMessageType::Open) {
      impl->conn = ConnState::Open;
    } else if (m->type == ix::WebSocketMessageType::Close) {
      // 4401 = server rejected/expired the JWT (see multiplayer.js).
      impl->conn = (m->closeInfo.code == 4401) ? ConnState::AuthFailed : ConnState::Closed;
    } else if (m->type == ix::WebSocketMessageType::Error) {
      impl->conn = ConnState::Closed;
    } else if (m->type == ix::WebSocketMessageType::Message) {
      json j = json::parse(m->str, nullptr, false);
      if (!j.is_discarded() && j.is_object()) impl->onMessage(j);
    }
  });
  p_->ws.disableAutomaticReconnection();
  p_->ws.setPingInterval(2);   // protocol-level keepalive (server auto-pongs)
  p_->ws.start();
}

void Client::close() {
  p_->ws.stop();
  p_->conn = ConnState::Closed;
  std::lock_guard<std::mutex> lock(p_->mtx);
  p_->players.clear();
  p_->myId.clear();
  p_->chatIn.clear();
}

ConnState Client::state() const { return p_->conn.load(); }

std::string Client::myId() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->myId;
}

Correction Client::consumeCorrection() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  Correction c = p_->corr;
  p_->corr = Correction{};
  return c;
}

std::string Client::ownedShip() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->ownedShip;
}

void Client::sendUpdate(const PlayerUpdate& u, uint32_t seq) {
  if (p_->conn.load() != ConnState::Open) return;
  json j = {
    { "type", "update" },
    { "x", u.x }, { "z", u.z }, { "heading", u.heading }, { "speed", u.speed },
    { "sailState", u.sailState }, { "vesselName", u.vesselName },
    { "vesselSlug", u.vesselSlug }, { "callsign", u.callsign }, { "seq", seq },
    { "turnRate", u.turnRate }, { "sheetAngle", u.sheetAngle },
    { "isPortTack", u.isPortTack }, { "anchored", u.anchored }, { "anchorSide", u.anchorSide },
  };
  p_->ws.send(j.dump());
}

void Client::sendChat(const std::string& text) {
  if (p_->conn.load() != ConnState::Open || text.empty()) return;
  json j = { { "type", "chat" }, { "text", text } };
  p_->ws.send(j.dump());
}

void Client::sendProfanityFilter(bool on) {
  if (p_->conn.load() != ConnState::Open) return;
  // The server does all masking per-recipient; this just records our preference
  // (it persists it to our user row and echoes 'profanity_filter_set').
  json j = { { "type", "profanity_filter" }, { "on", on } };
  p_->ws.send(j.dump());
}

std::vector<ChatMessage> Client::drainChat() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  std::vector<ChatMessage> out;
  out.swap(p_->chatIn);
  return out;
}

std::vector<RemotePlayer> Client::players() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  std::vector<RemotePlayer> out;
  out.reserve(p_->players.size());
  for (const auto& kv : p_->players) out.push_back(kv.second);
  return out;
}

WaveState Client::wave() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->wave;
}

SquadronState Client::squadron() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->squad;
}

std::vector<LaneHotspot> Client::lanes() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->lanes;
}
std::vector<MapShip> Client::merchantsAll() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->allMerchants;
}
std::vector<MapPirate> Client::piratesAll() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->allPirates;
}

// ── Town economy sends (fire-and-forget; server replies update townSt) ────────
TownState Client::town() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->townSt;
}
void Client::recruitCrew() {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "recruit_crew"}}.dump());
}
void Client::listenRumor() {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "listen_rumor"}}.dump());
}
void Client::askPirates() {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "pirate_report"}}.dump());
}
void Client::tradeOpen(const std::string& townId) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "trade_open"}, {"townId", townId}}.dump());
}
void Client::tradeBuy(const std::string& townId, const std::string& goodId, int qty) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "trade_buy"}, {"townId", townId}, {"goodId", goodId}, {"qty", qty}}.dump());
}
void Client::tradeSell(const std::string& townId, const std::string& goodId, int qty) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "trade_sell"}, {"townId", townId}, {"goodId", goodId}, {"qty", qty}}.dump());
}
void Client::petitionPardon(const std::string& townId) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "petition_pardon"}, {"townId", townId}}.dump());
}
void Client::buyShip(const std::string& slug) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "ship_buy"}, {"slug", slug}}.dump());
}
void Client::buyUpgrade(const std::string& kind) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "buy_upgrade"}, {"kind", kind}}.dump());
}
void Client::requestCombatReset() {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "combat_reset"}}.dump());
}

// ── Intro tutorial / quests ───────────────────────────────────────────────────
QuestUpdate Client::quest() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->questUpd;
}
QuestNarrative Client::consumeQuestNarrative() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  QuestNarrative n = p_->questNarr;
  p_->questNarr = QuestNarrative{};
  return n;
}
int Client::consumeQuestReward() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  int g = p_->questReward;
  p_->questReward = -1;
  return g;
}
RenamePrompt Client::consumeRenamePrompt() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  RenamePrompt r = p_->renamePrompt;
  p_->renamePrompt = RenamePrompt{};
  return r;
}
std::string Client::myShipName() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->townSt.shipName;
}
ShipNameReply Client::consumeShipNameReply() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  ShipNameReply r = p_->shipNameReply;
  p_->shipNameReply = ShipNameReply{};
  return r;
}
void Client::questAck(const std::string& objectiveId) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "quest_ack"}, {"objectiveId", objectiveId}}.dump());
}
void Client::questSkip() {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "quest_skip"}}.dump());
}
void Client::setShipName(const std::string& name) {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "set_ship_name"}, {"shipName", name}}.dump());
}

// ── Combat sends + state accessors ────────────────────────────────────────────
void Client::sendGunState(int side, int deploy) {
  if (p_->conn.load() != ConnState::Open) return;
  json j = { { "type", "gun_state" },
             { "side", side == 0 ? "port" : "stbd" },
             { "deploy", deploy } };
  p_->ws.send(j.dump());
}
std::map<std::string, std::pair<int, int>> Client::gunStates() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->gunBy;
}

void Client::sendCannonShot(float ox, float oy, float oz,
                            float vx, float vy, float vz,
                            int seq, const std::string& shotType) {
  if (p_->conn.load() != ConnState::Open) return;
  json j = {
    { "type", "cannon_shot" },
    { "ox", ox }, { "oy", oy }, { "oz", oz },
    { "vx", vx }, { "vy", vy }, { "vz", vz },
    { "seq", seq }, { "shotType", shotType },
  };
  p_->ws.send(j.dump());
}
void Client::sendRespawn() {
  if (p_->conn.load() != ConnState::Open) return;
  p_->ws.send(json{{"type", "respawn"}}.dump());
}
void Client::sendSalvageCollect(const std::string& crateId) {
  if (p_->conn.load() != ConnState::Open || crateId.empty()) return;
  p_->ws.send(json{{"type", "salvage_collect"}, {"crateId", crateId}}.dump());
}

std::vector<RemoteShot> Client::drainShots() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  std::vector<RemoteShot> out;
  out.swap(p_->shotsIn);
  return out;
}
std::vector<CombatHit> Client::drainHits() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  std::vector<CombatHit> out;
  out.swap(p_->hitsIn);
  return out;
}
std::vector<SunkEvent> Client::drainSunk() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  std::vector<SunkEvent> out;
  out.swap(p_->sunkIn);
  return out;
}
std::vector<std::string> Client::drainRepaired() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  std::vector<std::string> out;
  out.swap(p_->repairedIn);
  return out;
}
std::map<std::string, CombatShipState> Client::combatStates() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->combat;
}
std::map<std::string, FortState> Client::fortStates() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->forts;
}
std::map<std::string, std::map<std::string, std::string>> Client::diplomacyMatrix() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->diplo;
}
std::map<std::string, float> Client::factionRep() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->townSt.factionRep;
}
std::map<std::string, std::pair<int, int>> Client::crews() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->crewBy;
}
float Client::mastRepairMs() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  return p_->mastRepairMs;
}
std::vector<SalvageCrate> Client::salvageCrates() const {
  std::lock_guard<std::mutex> lock(p_->mtx);
  std::vector<SalvageCrate> out;
  out.reserve(p_->crates.size());
  for (const auto& kv : p_->crates) out.push_back(kv.second);
  return out;
}
SalvageCollected Client::consumeSalvageCollected() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  SalvageCollected s = p_->salvaged;
  p_->salvaged = SalvageCollected{};
  return s;
}
RepairResult Client::consumeRepairResult() {
  std::lock_guard<std::mutex> lock(p_->mtx);
  RepairResult r = p_->repairRes;
  p_->repairRes = RepairResult{};
  return r;
}

} // namespace mp
