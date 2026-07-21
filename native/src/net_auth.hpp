// REST auth against the sail-sim Node server (JWT bearer). Mirrors the client's
// user.service: POST /user/login and /user/register. Synchronous — the caller
// runs these off the render thread (see main.cpp's std::async use).
#pragma once
#include <string>
#include <utility>
#include <vector>

namespace net {

struct AuthResult {
  bool ok = false;
  int  status = 0;           // HTTP status; 0 = couldn't reach the server
  std::string error;         // server "message" or a transport error, for the UI

  // Populated on success:
  int id = 0;
  std::string username;
  std::string callsign;
  std::string role;
  std::string token;         // JWT — sent as `Authorization: Bearer` / ws `?token=`
};

// POST /user/login {username,password} -> {id,username,callsign,role,token}.
AuthResult login(const std::string& host, int port,
                 const std::string& username, const std::string& password);

// POST /user/register {username,callsign,password}. The server returns no token,
// so on success this immediately logs in and returns the logged-in result.
AuthResult registerUser(const std::string& host, int port, const std::string& username,
                        const std::string& callsign, const std::string& password);

// GET /user/me with `Authorization: Bearer <token>` — validates a stored token.
// ok on 200 (echoes the token back; note /user/me returns no callsign). A 401
// means the token was rejected/expired, so the caller should drop it.
AuthResult me(const std::string& host, int port, const std::string& token);

// The player's last saved anchorage, for restarting where they logged out.
struct LocationResult {
  bool  ok = false;              // true only when a usable, non-stale position came back
  int   status = 0;             // HTTP status; 0 = couldn't reach the server
  float x = 0, z = 0;
  float heading = 270.0f;        // degrees (protocol convention, = degrees(vessel.heading))
  std::string vesselSlug;
};

// GET /player-location/:callsign (JWT bearer). The server reads by the token's
// user id, so it returns THIS player's saved pose. ok on 200 with a fresh
// position (incl. the intro anchor for brand-new players); 404 (none / saved on
// an old map) or any transport error -> ok=false, so the caller harbour-spawns.
LocationResult playerLocation(const std::string& host, int port, const std::string& token);

// Server-authoritative per-vessel sailing physics (GET /vessels/:slug .physics).
// The server is the single source of truth for handling; the client maps this
// onto sail::Rig. Every field defaults to the sloop, so a partial/absent response
// still yields a usable rig. `ok` is true only on a 200 with a physics object.
struct VesselPhysics {
  bool ok = false;
  int  status = 0;
  float maxSpeed = 9.0f, accelerationRate = 0.22f, minTackAngle = 32.0f, sailAreaFactor = 0.40f, weight = 2800.0f;
  float turnFactor = 1.0f;                       // helm turn-rate multiplier (<1 = slower; frigate ~0.5)
  bool  hasRig = false;                          // server sent the v2 rig block (forceK/trim/leeway/hull)
  float forceK = 0.26f, trimForgive = 1.0f, leewayK = 1.0f;
  std::vector<std::pair<float, float>> polar;   // [apparentAngleDeg, driveCoeff] breakpoints
  float hullHalfLen = 7.0f, hullHalfBeam = 2.2f;
  bool  hasBuoyancy = false;
  float pitchScale = 0.14f, heaveTau = 1.5f, tiltTau = -1.0f;   // legacy kinematic (unused by the oscillator)
  // v3 dynamic buoyancy: per-axis damped-harmonic-oscillator params (server deriveBuoyancy). Defaults ≈ sloop.
  float heaveOmega = 2.05f, heaveZeta = 0.30f;
  float pitchOmega = 3.59f, pitchZeta = 0.22f, pitchGain = 0.85f;
  float rollOmega  = 1.69f, rollZeta  = 0.16f, rollGain  = 1.05f;
  float heelGain   = 0.5f,  maxTilt   = 0.24f;
};

VesselPhysics vesselPhysics(const std::string& host, int port, const std::string& slug,
                            const std::string& token);

} // namespace net
