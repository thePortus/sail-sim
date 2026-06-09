# todo

# General or Current TODO Items

* clouds occlude birds
* shallow water gets into boat, not displaced
* keypress makes songs lock up
* cannonfire smoke is occluded by clouds
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

Great, it's time for another module.... I want to start to add (harbor) towns. Eventually, these towns will have a bunch of assets... different buildings, etc... but for now, they are going to be represented by the most central asset in the town for any sailing vessel.... the pier. I have pier assets (three variations) attached here with handoff documentation.

Physical Placement - We need to automatically identify, during terrain generation, about 30-50 sites for harbors. A suitable site is any area of beach that is relatively flat that could have a pier running out into the water where a player's ship can pull up to reach it. So, we need to find the spot... and figure out the orientation that would put the pier so one end is on the beach, and one hangs out over the water. Terrain maps can change over time, so we will want to identify sites each time we make a new map

Naming, Describing - We will want to give names and a short description to each of these towns.... now, we can have a bank of canned names/descriptions, and they just get semi-randomly assigned to each location when we generate good harbor sites.... but I want these places to have "identities"... not every town in the canned list has to appear on every map, if there are not enough suitable locations

Map - I want these towns to appear on the player's map, and their names to display when the player hovers

Geometry - Eventually, each town will have its own geometry... for now that will just be one of the three pier variants... but have space to accomodate other geometry, which will be placed nearby. We can use asset scattering for this or not, whatever you think is most efficient

So, every time we generate a new map, it identifies good locations, then maps existing town name/description/geometries onto those location candidates... also, if we have generated a new map and seed, the player will need a new starting location

No doubt this involves new server routes and client services