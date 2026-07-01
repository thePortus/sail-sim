// Multiplayer gameplay client: a raw WebSocket to the sail-sim server
// (ws://host:port?token=<JWT>), exchanging the JSON protocol from server/
// multiplayer.js. Inbound messages are handled on IXWebSocket's own thread and
// merged into a mutex-guarded snapshot; the render loop reads copies via poll().
#pragma once
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace mp {

enum class ConnState { Idle, Connecting, Open, Closed, AuthFailed };

// A remote player's last-known pose (server "update"/"snapshot" entries).
struct RemotePlayer {
  std::string id;
  float x = 0, z = 0, heading = 0, speed = 0;
  std::string callsign, vesselName, vesselSlug, sailState;
};

// Latest weather tick (server "wave_state").
struct WaveState {
  bool valid = false;
  float windBearing = 0, windSpeed = 0, t = 0;
  int beaufort = 0;
};

// Our outbound pose (server "update" from client).
struct PlayerUpdate {
  float x = 0, z = 0, heading = 0, speed = 0;
  std::string sailState, vesselName, vesselSlug, callsign;
};

class Client {
public:
  Client();
  ~Client();
  Client(const Client&) = delete;
  Client& operator=(const Client&) = delete;

  void connect(const std::string& host, int port, const std::string& token);
  void close();

  ConnState state() const;
  std::string myId() const;
  std::string ownedShip() const;   // our vessel slug from the server "wallet" message

  void sendUpdate(const PlayerUpdate& u, uint32_t seq);   // fire-and-forget

  std::vector<RemotePlayer> players() const;   // copy of everyone but us
  WaveState wave() const;

private:
  struct Impl;
  std::unique_ptr<Impl> p_;
};

} // namespace mp
