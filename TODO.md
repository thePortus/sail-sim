# todo

# General or Current TODO Items

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

Terrain Load Failure

```
chunk-3I73J34F.js:10848 [Minimap] GPU bake failed — falling back to CPU raster: Error: minimap bake compute never became ready
    at h.callback (chunk-3I73J34F.js:10848:938)
    at n.notifyObservers (chunk-JXDCAROX.js:1:3060)
    at h.render (chunk-BQ3KWY4V.js:1:120323)
    at chunk-3I73J34F.js:5243:13608
    at a._renderFrame (chunk-LBASZION.js:19:3877)
    at a._processFrame (chunk-LBASZION.js:19:3562)
    at a._renderLoop (chunk-LBASZION.js:19:3615)
    at _boundRenderFunction (chunk-LBASZION.js:19:10953)
    at P.<computed> (polyfills-B6TNHZQ6.js:1:21585)
    at f.invokeTask (polyfills-B6TNHZQ6.js:1:7505)
```

---

Intermittend Black Screen on Windows

```
ID3D12Device::CreateDescriptorHeap failed with E_OUTOFMEMORY (0x8007000E)
 - While handling unexpected error type Internal when allowed errors are (Validation|DeviceLost).
    at CheckHRESULTImpl (..\..\third_party\dawn\src\dawn\native\d3d\D3DError.cpp:121)

Backend messages:
 * Device removed reason: S_OK (0x00000000)

chunk-PTJ4CXVK.js:1 BJS - [23:18:46]: WebGPU context lost. [object GPUDeviceLostInfo]
_LogEnabled @ chunk-PTJ4CXVK.js:1
16chunk-3I73J34F.js:7137 [terrain] clipmap shader compiled OK
chunk-PTJ4CXVK.js:1 BJS - [23:18:48]: WebGPU context successfully restored.
_LogEnabled @ chunk-PTJ4CXVK.js:1
polyfills-B6TNHZQ6.js:1 Uncaught TypeError: Cannot read properties of undefined (reading '0')
    at a.getBindGroups (chunk-E7T7GJXF.js:289:54543)
    at a._draw (chunk-E7T7GJXF.js:301:24775)
    at a.drawElementsType (chunk-E7T7GJXF.js:301:26167)
    at n._draw (chunk-3I73J34F.js:2:209275)
    at n._processRendering (chunk-3I73J34F.js:2:216269)
    at d (chunk-3I73J34F.js:332:9748)
    at _depthMap.customRenderFunction (chunk-3I73J34F.js:332:9990)
    at i.render (chunk-5M5CKCJO.js:1:4899)
    at i.render (chunk-5M5CKCJO.js:1:12096)
    at u.render (chunk-SRV2SGOJ.js:1:8915)
chunk-PTJ4CXVK.js:1 BJS - [23:18:48]: A fatal error occurred during WebGPU creation/initialization.
_LogEnabled @ chunk-PTJ4CXVK.js:1
polyfills-B6TNHZQ6.js:1 OperationError: Failed to execute 'requestDevice' on 'GPUAdapter': ID3D12Device::CreateDescriptorHeap
    at CheckOutOfMemoryHRESULTImpl (..\..\third_party\dawn\src\dawn\native\d3d\D3DError.cpp:127)

    at CheckOutOfMemoryHRESULTImpl (..\..\third_party\dawn\src\dawn\native\d3d\D3DError.cpp:127)
```