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
    } else if (type == "wallet") {
      ownedShip = msg.value("ship", ownedShip);   // server-authoritative owned hull
    }
    // combat / chat / economy message types are handled as game systems land.
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

} // namespace mp
