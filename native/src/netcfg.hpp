// Backend connection config — where the client finds the server, and whether to speak TLS. Resolved once at
// startup from env (SAILSIM_HOST / SAILSIM_PORT / SAILSIM_TLS) layered over the values compiled into the build
// (SAILSIM_SERVER_HOST / SAILSIM_SERVER_PORT / SAILSIM_SERVER_TLS_DEFAULT). All HTTP fetches build their client
// from baseUrl(); the gameplay WebSocket uses wsScheme(). TLS is only honoured when compiled in (SAILSIM_TLS).
#pragma once

#include <string>

namespace netcfg {

// Resolve host/port/tls from env over the compiled defaults. Call once, early in main().
void init();

const std::string& host();
int  port();
bool tls();   // always false in a build without TLS support (SAILSIM_TLS=OFF)

// "http://h:p" or "https://h:p" — pass to an httplib::Client (scheme picks plain vs SSL).
std::string baseUrl(const std::string& h, int p);
// "ws" or "wss" for the gameplay WebSocket URL.
const char* wsScheme();

}  // namespace netcfg
