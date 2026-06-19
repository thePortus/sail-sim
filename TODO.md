# todo

# General or Current TODO Items

* This game needs an introduction, both in the sense of a story, but also some introductory quests (perhaps driven by oncreen guidance) of the basics of the game. I'd like the introduction to mention something about a mutiny on a small local trading craft, and the harshness of an unbearable captain. Leading the resistance, the mutineers cheer and elect you as their new captain. (Please fill that out and make it feel atmospheric)... but then they should be taken on some quests to 1. learn how to steer the boat, trim the sails, read the wind and then after 2. buy goods in one port and sail to another 3.) defeat some kind of dummy or easy NPC who is in a weakened pinnace, to learn the basics of combat. All of this should be accompanied by oncreen help. Can you help me come up with a plan on how to implement that? Ask me any questions you want..... Note. I can generate graphics to add alongside your dialog separately using another tool... so you can just assume some of these will eventually have accompanying (static) imagery in the quest... so make sure to have a place where I can put that when I make it. Oh, and while yes, much of the interface of the quest will be client side... I would like that in general, quest and its completion be somehow verified server-side. I mean stuff like making sure the user knows how to rotate the camera is fine client side.. but like, checking if they have sunk the vessel they were supposed to before marking quest as done. Also, we can give the player some minor gold rewards for completing each stage of the intro tutorial. But understand, later we will use this quest system to build later storyline quests, so the plan should be to make it extensible.
* Expand list of NPC merchant vessel names
* Switch to Georgia font
* brig flags seem off from wind direction... off because they also rotate with trim in addition to wind
* spawn "pirate" npcs, who will attack player and also NPCs.... never the largest class of ship. And if they sink a ship (no loot crate drops unless it was a player)... a pirate hunter will spawn at a nearby capital and start making their way to engage the pirate. While pirate ships should sail around and attack the player if they get too close, their aggro range should be limited enough that if a player notices a pirate by their label, they can stay outside the aggro range (so aggro range should be a fair bit less than label visibility)
* make salvage crate asset
* increase render resolution in spyglass
* update profile page and update password page (and 404 page with a funny 404)
* why a dark patch around player ship? is it because of transparency to see hull?
* make trading and ship buying server-side secure
* intro text for newest players saying how they overthrew their captain and struck out for a life of siezing what you can come up with story
* crew eat rations,,, start to desert at ports if no rations for awhile and leaving with still no rations... slowly desert
* more realistic bird flight paths... momentum starting and stopping... speed of flapping wings relative to flight speed
* Add ship names, which display somewhere on the ship... think for each, renaming at shipwright.... changable flag colors
* placeholder ship for other players when that model hasnt loaded yet (or LOD imposter?)
* grapeshot doesn't make cannonball impacts on the water
* update to cannon aim sight to show spread of all cannon shots somehow
* add ship armor + cannon upgrades
* general materials atlas draw cycle reduction
* Paying for powder and shot
* any way to reduce load times?
* add forts to town that will fire when super hostile
* streaming assets has gotten weird, trees move in and out.. can we make them fade in?
* Plan to make towns or areas "different"... things to see, special marvels... missions?
* sound is chunking on windows machines still
* server optimization pass
* Add swear list filter, see if we can source from not us and build into the pipeline https://github.com/zautumnz/profane-words
* add damage from collisions and aground
* add sharks and schools of colorful fish and whales
* clouds don't seem to meet water at horizon.. not for spherical world?
* check landscape hit detection... make sure balls don't go through land
* tidal pull?
* Bring DRACO compression in, remove any CDNs
* Add /teleport playername x y and /teleportTo playername to admins
* encrypt websocket server? wss instead of ws?
* Optimization pass
* Security pass

# TODO Items by Module
