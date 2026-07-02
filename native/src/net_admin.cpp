#include "net_admin.hpp"

#include <httplib.h>          // header-only; plain HTTP (dev server is http://localhost:9080)
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace {

net::AdminResult fromResponse(const httplib::Result& res,
                              const std::string& host, int port) {
  net::AdminResult r;
  if (!res) {
    r.error = "Cannot reach server at " + host + ":" + std::to_string(port);
    return r;
  }
  r.status = res->status;

  json parsed = json::object();
  if (!res->body.empty()) { try { parsed = json::parse(res->body); } catch (...) {} }

  if (res->status < 200 || res->status >= 300) {
    // The weather controller reports {error}, auth middleware {message}.
    r.error = parsed.value("error",
              parsed.value("message", "Server error (HTTP " + std::to_string(res->status) + ")"));
    return r;
  }
  r.ok = true;
  return r;
}

net::AdminResult postJson(const std::string& host, int port, const std::string& token,
                          const std::string& path, const json& body) {
  httplib::Client cli(host, port);
  cli.set_connection_timeout(5, 0);
  cli.set_read_timeout(5, 0);
  httplib::Headers headers = {{ "Authorization", "Bearer " + token }};
  return fromResponse(cli.Post(path, headers, body.dump(), "application/json"), host, port);
}

net::AdminResult del(const std::string& host, int port, const std::string& token,
                     const std::string& path) {
  httplib::Client cli(host, port);
  cli.set_connection_timeout(5, 0);
  cli.set_read_timeout(5, 0);
  httplib::Headers headers = {{ "Authorization", "Bearer " + token }};
  return fromResponse(cli.Delete(path, headers), host, port);
}

} // namespace

namespace net {

AdminResult setWeatherOverride(const std::string& host, int port, const std::string& token,
                               float windSpeed, float fromBearingDeg, float cloudiness) {
  return postJson(host, port, token, "/weather/override",
                  json{ {"windSpeed", windSpeed}, {"fromBearingDeg", fromBearingDeg},
                        {"cloudiness", cloudiness} });
}

AdminResult clearWeatherOverride(const std::string& host, int port, const std::string& token) {
  return del(host, port, token, "/weather/override");
}

AdminResult setTimeOffset(const std::string& host, int port, const std::string& token,
                          float targetGameHour) {
  return postJson(host, port, token, "/weather/time-offset",
                  json{ {"targetGameHour", targetGameHour} });
}

AdminResult clearTimeOffset(const std::string& host, int port, const std::string& token) {
  return del(host, port, token, "/weather/time-offset");
}

AdminResult teleport(const std::string& host, int port, const std::string& token,
                     float x, float z) {
  return postJson(host, port, token, "/admin/teleport", json{ {"x", x}, {"z", z} });
}

} // namespace net
