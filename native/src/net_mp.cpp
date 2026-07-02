#include "net_mp.hpp"

#include <atomic>
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
  TownState townSt;                  // wallet/crew/market/dock-menu replies

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
    return r;
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
          if (!rp.id.empty() && rp.id != myId) players[rp.id] = rp;
        }
      }
    } else if (type == "update") {
      RemotePlayer rp = parsePlayer(msg);
      if (!rp.id.empty() && rp.id != myId) players[rp.id] = rp;
    } else if (type == "leave") {
      players.erase(msg.value("id", std::string()));
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
      if (msg.value("playerId", std::string()) == myId) {
        townSt.crew    = msg.value("crew", townSt.crew);
        townSt.maxCrew = msg.value("maxCrew", townSt.maxCrew);
      }
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
      } else {
        townSt.rumorText.clear();
        std::string r = msg.value("reason", std::string());
        townSt.rumorStatus = r == "no_rumours" ? "No talk of treasure ships tonight."
                                               : "The talk dries up (" + r + ").";
      }
    } else if (type == "pirate_report_result") {
      townSt.pirate.valid = true;
      townSt.pirate.ok = msg.value("ok", false);
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
    }
    // combat / economy message types are handled as game systems land.
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
  };
  p_->ws.send(j.dump());
}

void Client::sendChat(const std::string& text) {
  if (p_->conn.load() != ConnState::Open || text.empty()) return;
  json j = { { "type", "chat" }, { "text", text } };
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

} // namespace mp
