# todo

* Two related upgrades I want to make. 1. It seems that the auto-aim functionality on native doesn't hit as often as it does with the angular client. Are there any differences that might account for this? I seem to get many more misses 2. How accurate and fine-grained is the hit detection from the server? It does differ for each ship right? I ask because when I actually did manage to hit the enemy ship, it often seems like the hit displayed in empty space above the ship. Like, in the general area of the rigging and masts, but often was not actually hitting a mast. It was often hitting empty space and then showing an explosive hit.
* thoughts on way to make the graphics and lighting "pop"?
* Can we change how towns and their roads are laid out? Instead of starting by placing the buildings, and then connecting them with roads. Can we start by laying out a road network (with parameters to allow places for the buildings), and then only after placing the buildings on those roads? And look up online how to generate these road networks so each town is realistic, and has the number of roads it needs.
* VR?
* asset storage/streaming
* all new player tutorial stuff from client INCLUDING not spawning as a new player near a pirate
* camera clipping w terain
* auto updater?
* polars for sailing serverside, sailing penalties for mast damage should be serverside. Want server to enforce fair play

# General or Current TODO Items

* flashing and or z fighting on white part of brig hull
* blur or smooth the wake creation
* make server/assets mounted/shared drive, so it can preserve past volumes-down
* error in water occlusion on brig for NPCs/other vessels that doesn't affect player. Keel line is visible. this was something we corrected earlier on the player's vessel
* put merchantman ahead of brig in shipwright list
* make ships names match nationality (no salted cod for spanish for example. Don't stereotype in naming, just use names in that language)
* long summer day?
* frigate, galleon, barque, junkå
* forts and taking towns
* more tree varieties, flora.... regional/island differences
* swordfighting, surrender & capture
* fleets with prize crews to take them over
* dancing
* career of lands gained, etc. adapted to this game
* server only accepts local requests, restricted to client
* capture ships
* brig flags seem off from wind direction... off because they also rotate with trim in addition to wind
* make salvage crate asset
* pirate fame: as a mechanism to allow you access to best ships... and larger fleet to have more ships following and aiding you
* update profile page and update password page (and 404 page with a funny 404)
* make trading and ship buying server-side secure
* crew eat rations,,, start to desert at ports if no rations for awhile and leaving with still no rations... slowly desert
* placeholder ship for other players when that model hasnt loaded yet (or LOD imposter?)
* general materials atlas draw cycle reduction
* Paying for powder and shot
* any way to reduce load times?
* add forts to town that will fire when super hostile
* Plan to make towns or areas "different"... things to see, special marvels... missions?
* server optimization pass
* Add swear list filter, see if we can source from not us and build into the pipeline https://github.com/zautumnz/profane-words
* add damage from collisions and aground
* clouds don't seem to meet water at horizon.. not for spherical world?
* tidal pull?
* Bring DRACO compression in, remove any CDNs
* encrypt websocket server? wss instead of ws?
* Optimization pass
* Security pass

# TODO Items by Module
