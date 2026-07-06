// Admin REST calls against the sail-sim server — mirrors the client's
// admin.service: weather/time-of-day overrides and the teleport authorization
// gate. All routes require a JWT with role admin|owner (server returns 403
// otherwise). Synchronous — callers run these off the render thread.
#pragma once
#include <string>

namespace net {

struct AdminResult {
  bool ok = false;
  int  status = 0;       // HTTP status; 0 = couldn't reach the server
  std::string error;     // server "error"/"message" or a transport error
};

// POST /weather/override {windSpeed (m/s), fromBearingDeg, cloudiness 0-1}.
// Pins wind + sky for EVERY connected player until cleared.
AdminResult setWeatherOverride(const std::string& host, int port, const std::string& token,
                               float windSpeed, float fromBearingDeg, float cloudiness);

// DELETE /weather/override — resume natural weather evolution.
AdminResult clearWeatherOverride(const std::string& host, int port, const std::string& token);

// POST /weather/time-offset {targetGameHour 0-23.99} — the server computes the
// day/night clock offset and broadcasts it to everyone.
AdminResult setTimeOffset(const std::string& host, int port, const std::string& token,
                          float targetGameHour);

// DELETE /weather/time-offset — back to real-time-derived game time.
AdminResult clearTimeOffset(const std::string& host, int port, const std::string& token);

// POST /admin/teleport {x, z} — authorization gate only; the client moves its
// own vessel on a 200 (matches the browser client's flow).
AdminResult teleport(const std::string& host, int port, const std::string& token,
                     float x, float z);

} // namespace net
