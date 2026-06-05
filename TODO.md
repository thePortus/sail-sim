# todo

# General or Current TODO Items

* all rain drops hit at the same time.... even pattern
* clouds don't move so much as jitter
* switching from geometry to clip map raised all the shallows to super shallow on many different maps
* add sharks... make their appearance procedural... so everyone has same experience, yet make them rare.. make the summonable by admin for testing
* Backlighting refreaction color issue in shallows
* bloom lighting and improved sun ring?
* introduce map iteration (a game id # basically) number so if player is connecting to a new map, they can get starting location
* improved landscape generation (and bathymetry... and hydrography).... plan techniques for making
* dolphins? make shallows fish move more like fish... wish irregular darting motions and then slower periods (use instancing?)
* add back in butterfly scattering?
* improve rain from https://playground.babylonjs.com/#XQ8H3C#0
* improve trees and rocks... textures and alpha for leaves... procudral noise for normals on rocks
* improve noise where shallows transparency meet deep water
* add in damage morph targets
* fix steering wheel bones
* add player ship collision
* add improved land collision
* add damage from collisions and aground
* add camera clipping to prevent going underwater but especially under terrain
* First Person View / VR Mode / Which will have an exit Vr mode button on the HUD
* Make emissive lights cast light on
* Bring DRACO compression in, remove any CDNs
* Add in more ambient sounds... wind, water... ships bells at certain hours?
* Improve landscape/bathyscape by improved land generation methods
* Add in town geometries (just worry about piers at first)
* Add in towns themselves
* Add repairing
* Add sailors on deck
* Add ship names
* Improved asset scattereing
* Add /teleport playername x y and /teleportTo playername to admins
* Add lost server connection detection
* Add server side checking of movement, to prevent shenanigans
* encrypt websocket server? wss instead of ws?

# TODO Items by Module

Amazing... just a few bugs to clean up....

1. I can see the reflection map of the water THROUGH the boat (see screenshot)... so I can see what looks like it would be the ripples of the waves behind the boat.. except I am seeing them through the boat. If I am near the shoreline, I can see the shoreline through the boat
2. Possibly tied to issues with seeing through the boat mentioned above.. but when I zoom way out, the boat goes very dark, sails and hulls. Unnaturally so.
3. I still see weird very blue shadows cast by the boat and shoreline when I am in the shallows... which you suspected earlier, was environment mapping
4. Raindrops look weird now... every rain drop animation is evenly spaced and plays at exactly the same time