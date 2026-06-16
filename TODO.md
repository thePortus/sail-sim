# todo

# General or Current TODO Items

* smoke always renders overe the ship
* lod + imposters for ships at distance... same towns, * Cool towns = thin-instanced buildings + merged per-town clutter + impostor LODs for distance — all keep draw count flat.
* add admin right click on map brings up a teleport to option for those coordinates
* distance to dock should be based on size of ship
* magnifying glass on space bar?
* brig flags seem off from wind direction... off because they also rotate with trim in addition to wind
* revisit dead render pipeline
* make pinace buoyance more responsive
* ocean refelction/refraction delay mostly fine.... but seems extreme for distant landscape, since that moves a lot as you rotate the camera... any way to tweak that without rendering entire phase every frame?
* make it easier to catch merchants
* reduced crew slows reload speed of cannons... NPCs will use bar shot too... 
* check waves go right way for wind
* revisit landscape not loading (losing the landscape loading race)
* why a dark patch around player ship? is it because of transparency to see hull?
* hide all merchants on map (except for adamins)... then have "hints" at taverns where you can "listen to rumors" and it says "I heard about a pinnace (or whatever type) that was sailing around X (a town)" and then that merchant starts being tracked on the player map
* intro text for newest players saying how they overthrew their captain and struck out for a life of siezing what you can come up with story
* make faction standing affect trade prices (to a point, don't break economy or make it super easy to make profit on everything)
* crew eat rations,,, start to desert at ports if no rations for awhile and leaving with still no rations... slowly desert
* add occasional bosun whistle (no more than once a day)
* more realistic bird flight paths... momentum starting and stopping... speed of flapping wings relative to flight speed
* Change "callsign" to "Pirate Name" in front end UI (leave backend unchanged)...
* Add ship names, which display somewhere on the ship... think for each, renaming at shipwright.... changable flag colors
* placeholder ship for other players when that model hasnt loaded yet (or LOD imposter?)
* grapeshot doesn't make cannonball impacts on the water
* update to cannon aim sight to show spread of all cannon shots somehow
* add ship armor + cannon upgrades
* general materials atlas draw cycle reduction
* Paying for powder and shot
* any way to reduce load times?
* streaming assets has gotten weird, trees move in and out.. can we make them fade in?
* server is disconnected message
* Plan to make towns or areas "different"... things to see, special marvels... missions?
* sound is chunking on windows machines still
* server optimization pass
* make stuff look cool pass (bloom lighting?)
* Add swear list filter, see if we can source from not us and build into the pipeline https://github.com/zautumnz/profane-words
* add damage from collisions and aground
* add sharks and schools of colorful fish and whales
* clouds don't seem to meet water at horizon.. not for spherical world?
* check landscape hit detection... make sure balls don't go through land
* tidal pull?
* Bring DRACO compression in, remove any CDNs
* Add /teleport playername x y and /teleportTo playername to admins
* Add lost server connection detection
* encrypt websocket server? wss instead of ws?
* Optimization pass
* Security pass

# TODO Items by Module
