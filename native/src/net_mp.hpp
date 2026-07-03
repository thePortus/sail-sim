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
  bool npc = false;          // NPC merchant / pirate / hunter (hidden from the map for non-staff)
  std::string role;          // merchant | pirate | hunter (NPCs only)
  // Rig-animation state (relayed by the server; NPCs send sheetAngle 0).
  float turnRate = 0, sheetAngle = 30;
  bool isPortTack = false, anchored = false;
  std::string anchorSide = "S";
};

// Minimap intel (npc.js broadcasts): lane hotspots for everyone; the full
// merchant/pirate fleets arrive for staff accounts only.
struct LaneHotspot { float x = 0, z = 0, w = 0; };
struct MapShip    { float x = 0, z = 0; };
struct MapPirate  {
  float x = 0, z = 0;
  bool hunter = false;
  std::string name, faction, slug;
  int bounty = 0, kills = 0;
};

// Latest weather tick (server "wave_state").
struct WaveState {
  bool valid = false;
  float windBearing = 0, windSpeed = 0, t = 0;
  int beaufort = 0;
  float cloudiness = 0.25f;     // 0 clear -> 1 storm (drives the cloud layer)
  float timeOffsetSec = 0;      // admin day/night clock shift (game-cycle seconds)
  bool overrideOn = false;      // an admin weather override is pinning the state
};

// One chat line (server "chat"). chatType: global | dm | squadron | system.
// DMs carry `to` (the target callsign) so the sender's echo can be routed.
struct ChatMessage {
  std::string chatType, from, to, text;
};

// Our outbound pose (server "update" from client).
struct PlayerUpdate {
  float x = 0, z = 0, heading = 0, speed = 0;
  std::string sailState, vesselName, vesselSlug, callsign;
  // Rig-animation state (remote clients pose our yards/boom/anchor from these).
  float turnRate = 0, sheetAngle = 30;
  bool isPortTack = false, anchored = false;
  std::string anchorSide = "S";
};

// ── Town economy (dock menu) state — mirrors the browser's MultiplayerService
//    signals. All server-authoritative; we render whatever the last replies said.
struct MarketGood { std::string id; int ask = 0, bid = 0; };
struct Market {
  bool valid = false;
  std::string townId, specialty, hintText;
  std::vector<MarketGood> goods;
};
struct PirateReportInfo {
  bool valid = false, ok = false;
  std::string reason, name, slug;
  int kills = 0, bounty = 0, plunder = 0;
};
struct TownState {
  int gold = 0, capacity = 0;
  std::map<std::string, int> cargo;             // goodId -> qty held
  std::map<std::string, std::string> catalog;   // goodId -> display name
  std::map<std::string, float> factionRep;      // faction id -> standing
  std::string ship, shipName;
  bool cannonUpgrade = false, armorUpgrade = false;
  int crew = 0, maxCrew = 0;
  std::string hintTownId;                       // market demand hint target (map SELL-HERE beacon)
  std::string rumorShipId;                      // tavern rumour merchant (map TARGET mark)
  std::string pirateShipId;                     // tavern pirate report (map HUNT mark)
  std::string recruitStatus;                    // last recruit_result line ("" = none yet)
  std::string rumorText, rumorStatus;           // composed rumour sentence / failure note
  PirateReportInfo pirate;
  Market market;
  std::string tradeStatus;                      // last trade_error reason ("" = ok)
  std::string pardonStatus;                     // pardon_ok/pardon_error summary
  std::string shipStatus;                       // ship_bought/ship_error/upgrade_* summary
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

  // Chat: raw text goes to the server verbatim ({type:'chat', text}) — the server
  // parses /commands itself. drainChat() hands back lines received since last call.
  void sendChat(const std::string& text);
  std::vector<ChatMessage> drainChat();

  std::vector<RemotePlayer> players() const;   // copy of everyone but us
  WaveState wave() const;
  std::vector<LaneHotspot> lanes() const;      // busiest shipping-lane hotspots (all players)
  std::vector<MapShip> merchantsAll() const;   // staff-only full merchant fleet (else empty)
  std::vector<MapPirate> piratesAll() const;   // staff-only pirates + hunters (else empty)

  // ── Town economy (dock menu) — fire-and-forget sends; replies land in town(). ──
  TownState town() const;
  void recruitCrew();                          // tavern: hire one sailor
  void listenRumor();                          // tavern: overhear a treasure-ship rumour
  void askPirates();                           // tavern: ask about pirate activity
  void tradeOpen(const std::string& townId);   // trader: request the market quote
  void tradeBuy(const std::string& townId, const std::string& goodId, int qty);
  void tradeSell(const std::string& townId, const std::string& goodId, int qty);
  void petitionPardon(const std::string& townId);          // governor: buy back standing
  void buyShip(const std::string& slug);                   // shipwright: replace the hull
  void buyUpgrade(const std::string& kind);                // shipwright: 'cannon' | 'armor'
  void requestCombatReset();                               // shipwright: hull repair

private:
  struct Impl;
  std::unique_ptr<Impl> p_;
};

} // namespace mp
