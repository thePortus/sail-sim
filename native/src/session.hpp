// "Remember me": persist the authenticated session (JWT + identity) to a file so
// the next launch can skip the login screen. Cleared on logout or a rejected token
// (401). Plain-text on disk — fine for a local dev spike; revisit (OS keychain)
// before shipping.
#pragma once
#include <string>

namespace session {

struct Saved {
  std::string token;
  std::string username;
  std::string callsign;
  std::string role;
};

bool load(Saved& out);      // true if a saved session exists and has a token
void save(const Saved& s);
void clear();

} // namespace session
