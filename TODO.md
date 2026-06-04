# todo

# General or Current TODO Items

* way to add wave function to transparency noise of water on shore's edge? Want to add a lapping effect... even better if in the direction of the wind
* add sharks... make their appearance procedural... so everyone has same experience, yet make them rare.. make the summonable by admin for testing
* Backlighting refreaction color issue in shallows
* bloom lighting and improved sun ring?
* improved landscape generation (and bathymetry... and hydrography).... plan techniques for making
* dolphins? make shallows fish move more like fish... wish irregular darting motions and then slower periods (use instancing?)
* add back in butterfly scattering?
* improve rain from https://playground.babylonjs.com/#XQ8H3C#0
* improve landscape performance with dynamic terrain? https://github.com/BabylonJS/Extensions/blob/master/DynamicTerrain/documentation/dynamicTerrainDocumentation.md
* improve landscape with https://medium.com/@trushkinsimon/semi-procedural-landscape-with-babylonjs-e9373bc3091d
* improve trees and rocks... textures and alpha for leaves... procudral noise for normals on rocks
* improve noise where shallows transparency meet deep water
* add in damage morph targets
* fix steering wheel bones
* add player ship collision
* add improved land collision
* add damage from collisions and aground
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

Okay, I want to plan another major upgrade: this time, landscape generation..... let me tell you a few thigns as background.

We already tried to do a simple landscape generation, where I had you generate elevation levels for a bunch of islands. It was fine, but it did not look good.... everything was too blocky, not fine detailed enough... and frankly having you draw islands like an SVG was always going to lead to something boring

To combat that, I tried to come up with a pipeline to generate geometry from real world heightmaps.... this is our current system. It is far better, and the islands are more believeable. But the terrain elevation data seems clunky, and didn't build into super realistic worlds in our pipeline... often there isn't enough gradation of height, especially at the non-macro scale. Island often end up all being vertiginous mountains, with very little low lying or moderate territory

I am asking for a plan to drastically improve our landscape generation... Note. I am not yet talking about "skinning" that terrain (though that will be a part of making it look more real up close)... right now I am talking about defining th ebasic shape of it. We can do this via using online resources (if so, suggest some) to find good elevation and bathymetry data (for water depths), and use those as starting points.... or... it can be to use a fully procedural solution, though one that hopefully stacks multiple procedural methods and shaders to create a truly relastic variation in landscape.... or... some combination of both. I want ultra realistic landscapes... rather than the boring mush I have....

Basically I want the most realistic looking terrain elevation (and ocean depth if we can do that too)

Feel free to run searches for any material you want to find on how to produce realistic looking landscapes...

Keep in mind we will mostly want an archapelago... but within that we want variation... some should have large volcanic mountains, other atolls... even within an island there is variation.. low lying bays vrs highlands or plains....

And I'd like to make sure it looks interesting both a distance and close up. Which means posssibly using procedural LoD

Right now, this is the brainstorm and plan phase. What are you thinking?