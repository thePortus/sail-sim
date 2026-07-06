#include "session.hpp"

#include <cstdio>
#include <cstdlib>
#include <fstream>

namespace {

std::string sessionPath() {
  const char* home = std::getenv("HOME");
  if (!home) home = std::getenv("USERPROFILE");   // Windows
  std::string dir = home ? home : ".";
  return dir + "/.sailsim_session";
}

} // namespace

namespace session {

bool load(Saved& out) {
  std::ifstream f(sessionPath());
  if (!f) return false;
  std::getline(f, out.token);
  std::getline(f, out.username);
  std::getline(f, out.callsign);
  std::getline(f, out.role);
  return !out.token.empty();
}

void save(const Saved& s) {
  std::ofstream f(sessionPath(), std::ios::trunc);
  if (!f) return;
  f << s.token << "\n" << s.username << "\n" << s.callsign << "\n" << s.role << "\n";
}

void clear() {
  std::remove(sessionPath().c_str());
}

} // namespace session
