# todo

# General or Current TODO Items

* add full sinking & capsize animation
* fix speed of asset scattering loading in?
* birds cast reflections, improved bird flight
* add photo (hide hud mode)
* clouds don't seem to meet water at horizon.. not for spherical world?
* check landscape hit detection... make sure balls don't go through land
* add sharks... make their appearance procedural... so everyone has same experience, yet make them rare.. make the summonable by admin for testing
* made cannon elevation aiming smooth and by decimals
* fix tree height
* persistent logoff locations & serverside authoritative location
* tidal pull?
* Refactor a systemwide shared audio context so you don't hit browser cap
* introduce map iteration (a game id # basically) number so if player is connecting to a new map, they can get starting location
* improve rain from https://playground.babylonjs.com/#XQ8H3C#0
* add in damage morph targets
* add player ship collision
* add damage from collisions and aground
* First Person View
* Bring DRACO compression in, remove any CDNs
* Add in town geometries (just worry about piers at first)
* Add in towns themselves
* Add repairing
* Add sailors on deck
* Add ship names
* Add /teleport playername x y and /teleportTo playername to admins
* Add lost server connection detection
* encrypt websocket server? wss instead of ws?

# TODO Items by Module

Now, I'd love to add a capsize animation when someone is sunk, either the player or another player... if it is yourself that is sunk, I want to delay the message about being sunk until after they see the animation...basically... I want to sink the ship.. already it will be riding low in the water where it was damanged... on that portion of the boat... basically, I just want to decrease buoyancey overall, so that the whole boat goes into the water, but especially so on the size with the most damage... would be great if the boat rolled or just had a dramatic pitch as it went down. It doesn't have to go fully underwater... but look like it is wrecked for sure.... Then, when the player clicks the clear message... as before, they will be repaired and have full buoyance again and be able to sail off...