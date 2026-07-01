// REST auth against the sail-sim Node server (JWT bearer). Mirrors the client's
// user.service: POST /user/login and /user/register. Synchronous — the caller
// runs these off the render thread (see main.cpp's std::async use).
#pragma once
#include <string>

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

} // namespace net
