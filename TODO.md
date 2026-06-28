# todo

# General or Current TODO Items

* frigate, galleon, barque, junk
* redo crew
* forts and taking towns
* swordfighting, surrender & capture
* fleets with prize crews to take them over
* dancing
* career of lands gained, etc. adapted to this game
* server only accepts local requests, restricted to client
* capture ships
* brig flags seem off from wind direction... off because they also rotate with trim in addition to wind
* make salvage crate asset
* pirate fame: as a mechanism to allow you access to best ships... and larger fleet to have more ships following and aiding you
* town forts... capturing towns
* update profile page and update password page (and 404 page with a funny 404)
* make trading and ship buying server-side secure
* crew eat rations,,, start to desert at ports if no rations for awhile and leaving with still no rations... slowly desert
* placeholder ship for other players when that model hasnt loaded yet (or LOD imposter?)
* general materials atlas draw cycle reduction
* Paying for powder and shot
* any way to reduce load times?
* add forts to town that will fire when super hostile
* streaming assets has gotten weird, trees move in and out.. can we make them fade in?
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

Okay, done and commited.

Next, I want to do another major upgrade of the crew. So I don't even want to implement, I want to come up with a plan. Or a plan for more plans. But I need to further increase the realism. You gave them sway on the boat. That was great. But many of the animations are, well.... wanting. Mostly, as generic canned animations, they don't interact well with their environment. Sailors making the motion of tugging at rigging often are moving their arms in the air. Sailors climbing on ratlines don't actually put each foot in a rope rung, and they just make general climbing motions with their arms that often arn't even touching the ratlines they are climbing. Crew working the cannons are not particularly good at touching the right parts of the cannon... again they just seem to make generic canned motions NEAR a cannon. Can we make them more intellegently react to their environment on a micro level? At least for the player's own vessel if the calculations are too heavy otherwise. And in general, I'd just like more varied and fluid movements.

I also will want to eventually upgrade the meshes and look of the crew, which frankly is not very detailed, nor varied. They have a real boring and canned look, nor do they look convincingly real. But, should we upgrade the meshes first before worrying about animation, or can we save that for another day? Among things, there are few variations in their clothes, that needs more. More variations in colors, and the colors should be more subtle. And a big thing is when you tried to delete parts of the crew's body that was hidden by clothes, deleted parts where clothes didn't cover. For example, on a crew with the V neck pirate shirt, that area of the V under the laces has no chest mesh.. it's just empty. Creepy. But also, I'd like cooler looking clothes. We not only have makehuman as a plugin if you want to create a mesh from scratch, we have makehuman assets in for starting clothes mesh, so we can start with boots and then modify.