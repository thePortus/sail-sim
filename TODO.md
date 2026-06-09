# todo

# General or Current TODO Items

* add spawns close to coast
* clouds occlude birds
* shallow water gets into boat, not displaced
* keypress makes songs lock up
* cannonfire smoke is occluded by clouds
* add server-side authoritative movement... and force player to re-login if 401 on player-location at start... and have server check collisions for future damage bounces
* adjust water displacement to better fit hull of pinnace
* add dedication
* add damage from collisions and aground
* fix speed of asset scattering loading in?
* Change "callsign" to "Pirate Name" in front end UI (leave backend unchanged)...
* add keymap help screen
* clouds don't seem to meet water at horizon.. not for spherical world?
* check landscape hit detection... make sure balls don't go through land
* add sharks... make their appearance procedural... so everyone has same experience, yet make them rare.. make the summonable by admin for testing
* fix tree height
* persistent logoff locations & serverside authoritative location
* tidal pull?
* introduce map iteration (a game id # basically) number so if player is connecting to a new map, they can get starting location
* add in damage morph targets
* Bring DRACO compression in, remove any CDNs
* Add in town geometries (just worry about piers at first)
* Add in towns themselves
* Add repairing
* Add sailors on deck
* Add ship names
* Add /teleport playername x y and /teleportTo playername to admins
* Add lost server connection detection
* encrypt websocket server? wss instead of ws?
* Add swear list filter, see if we can source from not us and build into the pipeline
* Optimization pass
* Security pass

# TODO Items by Module

Great. I committed, and we are onto a major module upgrade on multiplayer movement, where we are going to make all player movement server-side authoritative... which will require thinking about the player's vessel, remote vessels... server side and client side.... thinking on systems like player collision, which had been handled locally. Basically, I want to prevent player tampering by being able to broadcast crap locations... I want server to enforce fair movement rules... Also.... I realize this means changing the player model, as we will have to store the player's location to make that authoritative between sessions. I'd also like to store the last map/seed they were on, so that we can check it against the current, and if they don't match.... start at a new spawn location.

But before we get started there are two related minor changes I want to make...

1.) Sometimes a player gets into the game without being properly authenticated, and as they log in get a 401 from the servers `/player-locations` route.... when this happens, the current result is that they just start over at the new player spawn (0,0)... rather than where they should be. What I want to have happen is that they are taken back to the log in screen and forced to reauthenticate, and thus have their real location

2.) I'd like to have new player spawns happen automatically near a coast.... can we have a way to identify good spawn points, choose one, and then spawn new players there