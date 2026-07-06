#include "net_auth.hpp"

#include <httplib.h>          // header-only; plain HTTP (dev server is http://localhost:9080)
#include <nlohmann/json.hpp>
#include <cmath>

using json = nlohmann::json;

namespace {

// POST `path` with a JSON body; parse a JSON response. Fills status/error and, on
// a 2xx, the top-level {id,username,callsign,role,token} fields if present.
net::AuthResult postJson(const std::string& host, int port,
                         const std::string& path, const json& body) {
  net::AuthResult r;
  httplib::Client cli(host, port);
  cli.set_connection_timeout(5, 0);
  cli.set_read_timeout(5, 0);

  auto res = cli.Post(path, body.dump(), "application/json");
  if (!res) {
    r.error = "Cannot reach server at " + host + ":" + std::to_string(port);
    return r;
  }
  r.status = res->status;

  json parsed = json::object();
  if (!res->body.empty()) { try { parsed = json::parse(res->body); } catch (...) {} }

  if (res->status < 200 || res->status >= 300) {
    r.error = parsed.value("message", "Server error (HTTP " + std::to_string(res->status) + ")");
    return r;
  }

  r.ok       = true;
  r.id       = parsed.value("id", 0);
  r.username = parsed.value("username", std::string());
  r.callsign = parsed.value("callsign", std::string());
  r.role     = parsed.value("role", std::string());
  r.token    = parsed.value("token", std::string());
  return r;
}

} // namespace

namespace net {

AuthResult login(const std::string& host, int port,
                 const std::string& username, const std::string& password) {
  return postJson(host, port, "/user/login",
                  json{ {"username", username}, {"password", password} });
}

AuthResult me(const std::string& host, int port, const std::string& token) {
  AuthResult r;
  httplib::Client cli(host, port);
  cli.set_connection_timeout(5, 0);
  cli.set_read_timeout(5, 0);

  httplib::Headers headers = {{ "Authorization", "Bearer " + token }};
  auto res = cli.Get("/user/me", headers);
  if (!res) {
    r.error = "Cannot reach server at " + host + ":" + std::to_string(port);
    return r;
  }
  r.status = res->status;

  json parsed = json::object();
  if (!res->body.empty()) { try { parsed = json::parse(res->body); } catch (...) {} }

  if (res->status < 200 || res->status >= 300) {
    r.error = parsed.value("message", "Session expired (HTTP " + std::to_string(res->status) + ")");
    return r;
  }
  r.ok       = true;
  r.id       = parsed.value("id", 0);
  r.username = parsed.value("username", std::string());
  r.role     = parsed.value("role", std::string());
  r.token    = token;   // echo it back so the caller can keep using it
  return r;
}

LocationResult playerLocation(const std::string& host, int port, const std::string& token) {
  LocationResult r;
  httplib::Client cli(host, port);
  cli.set_connection_timeout(5, 0);
  cli.set_read_timeout(5, 0);
  httplib::Headers headers = {{ "Authorization", "Bearer " + token }};
  // The controller keys off the JWT user id and ignores the :callsign path param,
  // so a fixed safe segment avoids URL-encoding a callsign that may hold spaces.
  auto res = cli.Get("/player-location/self", headers);
  if (!res) return r;                               // unreachable -> harbour fallback
  r.status = res->status;
  if (res->status < 200 || res->status >= 300) return r;   // 404 none/stale -> fallback
  json parsed = json::object();
  if (!res->body.empty()) { try { parsed = json::parse(res->body); } catch (...) { return r; } }
  if (!parsed.contains("x") || !parsed.contains("z") ||
      !parsed["x"].is_number() || !parsed["z"].is_number()) return r;
  r.x = parsed.value("x", 0.0f);
  r.z = parsed.value("z", 0.0f);
  r.heading = parsed.value("heading", 270.0f);
  r.vesselSlug = parsed.value("vesselSlug", std::string());
  r.ok = std::isfinite(r.x) && std::isfinite(r.z);
  return r;
}

AuthResult registerUser(const std::string& host, int port, const std::string& username,
                        const std::string& callsign, const std::string& password) {
  // Register returns {message, user:{...}} with no token; report failure straight
  // through, then log in to obtain a token so the caller lands authenticated.
  AuthResult reg = postJson(host, port, "/user/register",
                            json{ {"username", username}, {"callsign", callsign},
                                  {"password", password} });
  if (!reg.ok) return reg;
  return login(host, port, username, password);
}

} // namespace net
