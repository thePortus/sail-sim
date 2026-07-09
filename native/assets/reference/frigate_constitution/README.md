# Frigate reference — USS *Constitution* (Humphreys 44)

Base ship for the sim's new top-tier warship: the **frigate**. Modelled after USS
*Constitution* ("Old Ironsides"), a Joshua Humphreys–designed heavy frigate. Chosen
because its real history directly supports our variant scheme:

- The Humphreys "original six" were built in **two armament classes on one design
  family** — the 44-gun ships (*Constitution*, *President*, *United States*) and the
  38-gun ships (*Constellation*, *Congress*, *Chesapeake*). That is our light↔heavy axis.
- The hull was **copper-sheathed** below the waterline (Paul Revere's copper), which
  gives the heavy variant its distinctive plating.
- Best-documented sailing warship in existence — afloat in Boston with public-domain
  measured draughts, so we get an exact rotoscope.

## Principal dimensions (read off the 1794/Doughty lines plan, feet-inches)

| Dimension | Value | metric |
|---|---|---|
| Length of gun deck (between perpendiculars) | 174′ 10½″ | 53.3 m |
| Length of keel (for tonnage) | 145′ 0″ | 44.2 m |
| Extreme moulded breadth | 43′ 6″ | 13.26 m |
| Depth of hold | 14′ 3″ | 4.34 m |
| Height, lower ↔ gun deck | 6′ 4″ | 1.93 m |
| Height, gun ↔ upper (spar) deck | 7′ 0″ | 2.13 m |

Sparred length ≈ 204 ft; LOA over bowsprit/jibboom ≈ 304 ft; mainmast truck ≈ 220 ft
above waterline. (Use these to set overall scale relative to the existing brig.)

## What's here

### rotoscope/  — for laying out the hull & rig
- `ware_1817_outboard_profile_master.jpg` — Charles Ware, 1817, *"A Draft of the U.S.
  Frigate Constitution."* Orthographic outboard profile **with full sail/rig plan**.
  14060 × 9465, public domain (NARA / Wikimedia). The rig & sheer rotoscope master.
- `ware_1817_outboard_profile_6k.jpg` — 6000-px working copy for a Blender background image.

### plans/  — measured draughts (the real construction geometry)
- `lines_plan_hires_18k.png` / `lines_sheer_halfbreadth_body_plan.pdf` — **the hull
  rotoscope.** Sheer plan (side elevation + numbered stations 1–49 = the ribs), body
  plan (station sections = rib profiles), half-breadth plan (waterline plan), dimensions
  table. This is what you loft the keel and ribs from.
- `outboard_profile_2007.pdf` — modern outboard profile (caprail-removal survey).
- `midship_section_1926.pdf` — the master rib / midship frame section.
- `gun_deck_arrangement_1931.pdf` — gun-deck plan (battery layout, gunport spacing).
- `sail_plan_1817.pdf` — 1817 sail plan.

### photos/  — texture & detail reference
- `broadside_underway_2012.jpg`, `underway_sets_sail.jpg`, `broadside_17gun_salute_2014.jpg`
  — overall character afloat: black topsides, white gunport stripe (Nelson chequer),
  scroll billethead, headrails, ship rig.
- `stern_dpla.jpg` (1914) — elliptical stern: eagle crest, star frieze, quarter
  galleries, name board, quarterdeck guns run out. Stern-detail master.
- `bow_chase.jpg`, `bow_figurehead_1858.jpg` — head/beakhead structure; the 1858 shot
  shows the Andrew Jackson figurehead (option for a figurehead variant vs. the plain
  billethead scroll).
- `drydock_stern_hull_1997.jpg` — **copper sheathing** below the waterline (weathered
  verdigris), draft marks, boot-top. Reference for the heavy variant's copper hull.
- `gunports_firing_2021.jpg` — gunports open, guns run out, muzzle flash.
- `painting_underway_1803.jpg` — period painting, c. 1803 rig/sail set.

## Proposed variant mapping (grounded in the above)

| Variant | Historical basis | Battery | Hull |
|---|---|---|---|
| **Light** | 36/38-gun sister (*Constellation* class) | reduced battery, spar deck largely clear of carronades, some ports blanked | painted (black topsides, white or ochre stripe), plain bottom |
| **Medium** | standard 44-rated fit | full gun deck of long 24-pdrs + partial carronade battery | painted, standard |
| **Heavy** | *Constitution* fully armed (~50–54 guns) | full 24-pdr gun deck + full 32-pdr carronade spar-deck battery, chase guns, boarding netting | **copper-plated below waterline**, sits deeper |

## Licensing
All sources are public domain: Charles Ware 1817 draught and the museum-restoration
measured plans (US Navy / Charlestown Navy Yard work), NARA, and US-government / US-Navy
photographs. Safe to keep as internal modelling reference.

> Note: `rotoscope/ware_1817_outboard_profile_master.jpg` is ~57 MB. If committing this
> folder bloats the repo, keep the 6k working copy and gitignore the master (or move it to
> git-lfs).

## Rotoscope calibration (Blender: `~/Desktop/3D/frigate/frigate.blend`)

**The 18k lines-plan scan is truncated at the bow (stations ≤2 + stem missing).** Complete
replacement profile: `plans/magoun_1927_lines_plan_VIII_complete.jpg` (F.A. Magoun, MIT 1927,
drawn from the official 1927-restoration plans; NARA 75841374, public domain). Cropped/inverted
working plates in `rotoscope/plates/`, placed + calibrated in the .blend.

- Blender frame: **bow = −Y, starboard = +X, up = +Z** → glTF export lands bow = +Z, starboard = +X,
  up = +Y (brig/sloop fleet convention; verified by parsing a test GLB export). Do NOT copy the
  merchantman (bow +X) or pinnace (mirrored) conventions.
- World origin: midships between perpendiculars; **load waterline = Z 0**. FPP Y = −26.651,
  APP Y = +26.651 (LBP 53.302 m). Stations 0–10 every 5.3302 m (empties ST00–ST10).
- Magoun sheer plate: 15.911 mm/px (10 stations = 3350 px; cross-checked by 3-ft waterline grid ±1%).
  Keel bottom: −6.42 m at midships, slight drag to −6.62 m at the sternpost heel.
- Doughty 18k body plan plate: 2.637 mm/px (3-ft waterline grid = 346.8 px) — use for lofting ribs.
- `rotoscope/plates/calibration_world_points.json` — extracted keel/stem/sternpost world points.
- Fleet GLBs use KHR_texture_basisu; Blender's importer can't read them (witness box used instead).

## Hull ribs + surface — parametric two-master loft (rev 2, 2026-07-08)

Superseded the first (kinky, per-station-anchor) ribs. Now a smooth parametric hull:
- **masterU** — full midship section faired from the Lord 1926 *Midship Section* drawing
  (`plans/midship_section_1926.pdf`; outer-plank trace in
  `rotoscope/plates/midship_section_1926_trace.json`): hollow garboard → firm bilge →
  near-wall-sided midbody → tumblehome. Extreme half-breadth 6.807 m (43'6" moulded), rail z+5.7.
- **masterV** — fine flaring end section (deadrise, hollow garboard, no tumblehome).
- Per station, `hull(s,v) = Beam(s)·[(1-c)·wfV + c·wfU]`, spanning rabbet(s)→rail(s).
  Beam/RailZ/Fullness are Catmull-Rom through faired anchors; rabbet sampled from `Keel_Line`.
  All four vary smoothly ⇒ every rib is fair by construction (no kinks).
- Generator `rotoscope/plates/hull_model_v2.py` → `hull_param_v2.json` (rib pts + 37 dense
  stations). In the blend: `Rib_ST01–ST10` (NURBS) + `Hull_Surface` (dense loft, Mirror + 2×
  Subsurf) in `Frigate_Hull`. Validated vs the independent Doughty body plan + sheer overlays.

Follow-ups for hull skinning: stern still tapers to a point (transom/counter + fashion pieces
to build); head/quarter-gallery flare excluded from Beam(s) on purpose (separate structures);
bulwark run above spar deck is approximated; tune Fullness(s) if body-plan overlay wants it.

## Hull rev 3 — section shapes gauged from the Doughty body plan (2026-07-08)

Rev 2 used one synthesized fine-end section. Rev 3 reads the real section widths off the
Doughty 1794 body plan (`plans/lines_plan_hires_18k.png`, the plate placed as REF_BodyPlan_Doughty):
- A tangent-following curve tracer walks individual station curves through the plan's dense
  waterline/diagonal overlay (naive min/max envelope failed — it jumped between curves).
  Traces in `rotoscope/plates/{fore,aft}_traces.json`; calibration CLX=2765, keel y=5257,
  3-ft grid = 347 px (0.002636 m/px), bow=right / stern=left.
- **masterMid** = the traced midship (outer) section: fuller bilge + harder garboard hollow
  than the 1926 lines (real Humphreys-original vs rebuilt-ship difference; the two agree within
  0.1 m above the waterline, diverge up to ~0.85 m in the bilge). **masterEnd** = traced fine
  forebody section (deadrise V, hollow garboard, flaring topside). `masters_v3_doughty.json`.
- Blend `hull(s,v)=Beam(s)·[(1-c)·masterEnd + c·masterMid]`, generator `hull_model_v3.py`
  → `hull_param_v3.json`. Rebuilt Rib_ST01–ST10 + Hull_Surface. Validated on the body-plan overlay.

Still open: stern taper→transom/counter; head/quarter-gallery flare separate; the finest bow
sections (near the stem) trace only partially so masterEnd is a mid-forebody section extended.

## Hull rev 4 — true hollow bow/stern entry (2026-07-08)

Rev 3's end master was a mid-forebody section (not hollow enough). Rev 4 extracts the *finest*
end sections: near the stem the body-plan curves bunch, so instead of the 2D tracer (which drifts
onto diagonals there) a **continuity tracker** walks a single section by nearest-half-breadth
across a dense stack of waterlines — the ordered crossing structure keeps it on one curve.
- **masterFore** = finest forebody section: hollow garboard (half-beam 0.4→0.7→1.2 m over the
  bottom metre, then sweeps out), flaring topside. **masterAft** = finest afterbody: long fine
  deadwood run low, rounding up. Data: `fine_end_sections_tracked.json`, `masters_v4_fore_mid_aft.json`.
- Now a **3-master blend**: `hull(s,v)=Beam(s)·[(1-c)·endM + c·masterMid]`, endM=masterFore for
  the forebody, masterAft for the afterbody, c=Fullness(s). Generator `hull_model_v4.py`
  → `hull_param_v4.json`. Rib_ST01–ST10 + Hull_Surface rebuilt; forebody ribs validated against
  the Doughty fine sections (garboards now tuck in and match).

Remaining: stern still needs the transom/counter + fashion pieces; head/quarter-gallery separate.

## Stern: square transom + counter (rev 5, 2026-07-08)

Built the War-of-1812 / Doughty-era **square transom stern** (NOT the post-1857 elliptical
stern in `photos/stern_dpla.jpg`) to match the lines we lofted. Geometry read off the Magoun
sheer stern + half-breadth aft:
- Afterbody `Beam(s)` bumped (s8-10: 5.90/5.20/4.40) so the quarter carries width for the
  transom to close onto (was pinching to 1.9). `hull_model_v5.py`.
- `Stern` mesh in `Frigate_Hull`: lofts the hull's aft ring (s=10, Y=26.65) back to a raked
  transom outline — below the tuck (z<0.6 m) it closes to the sternpost centerline (deadwood/
  rudder area); above, it opens to the transom face. Rake Yc(z): 27.6→29.65 m; transom
  half-width(z): 0→~4.0 m (widest near taffrail); taffrail z≈6.9 m. Mirror + 2× Subsurf,
  centerline welded. Verified dead-astern (closed) + quarter + profile.

Ornamentation still to add (own pass): stern-gallery windows, quarter galleries, transom
moldings/name board, taffrail cap; the eagle+stars are the *elliptical*-stern decoration —
only if we later switch to that stern. Rudder not yet modelled.

## Hull rev 6 — one continuous watertight mesh, closed bow (2026-07-08)

Rev 5 had two defects: the loft started at station 1 (bow was an open hole) and the transom
was a separate mesh (visible subsurf seam at the hull join). Rev 6 builds the whole hull as a
SINGLE ordered ring loft, bow->stern, so there are no seams:
- Bow closed onto the stem: a `stem_ring` (leading edge, x=0, Y=Ystem(z) from the traced
  cutwater) is the forward-most ring; forward sections (s=0.08..0.8) converge onto it.
- Stern folded into the same loft: the transom `target` + `center` rings are the last two rings.
- Keel closed: section bottom point forced to x=0 (the sided keel/deadwood is a separate piece
  to add later). Verified: 0 non-manifold edges, no holes except the deck rim (correct).
- Generator `hull_model_v6.py` -> `hull_param_v6.json` (46 rings x 46 pts). One `Hull_Surface`
  object, Mirror + 2x Subsurf. `Stern` object removed (now integral).

## Hull rev 7 — fairing pass (removed aft buttock streaks) (2026-07-08)

The traced masters carried small non-monotonic wiggles (tracking noise, worst in masterAft's
lower run), which every section inherited -> visible longitudinal streaks in the aft/keel run.
Fix: re-fair the three masters (`masters_v5_faired.json`) — resample + smooth, enforce
monotone-up for fore/aft and unimodal (single peak at the tumblehome) for mid. Also doubled
longitudinal station density and added an intermediate counter ring so the transom transition
doesn't ripple. `hull_model_v7.py` -> `hull_param_v7.json`. Aft run is now a single fair sweep.

## Hull rev 8 — forefoot + stem cleanup (2026-07-08)

Two bow defects: (1) a notch where keel meets stem (my keel and stem were traced separately and
crossed at the forefoot: the stem trace started ~0.6 m aft of the keel end, and the rabbet
stepped ~0.8 m there); (2) a small forward tab/nub at the waterline from a redundant section
sitting on the forward perpendicular (its bottom vertex protruded fwd with nothing below it).
Fixes:
- One faired, monotone `Ycut(z)` cutwater curve (forefoot z-6.3/Y-22 -> head z4.7/Y-30.9) used
  BOTH for the stem leading edge and (inverted, `Zcut`) for the bow rabbet, so keel->stem is
  one smooth sweep. Keel rabbet aft of the forefoot uses the faired keel `Zkeel(Y)`.
- Removed the redundant FPP ring; bow now = stem_ring + forward sections (s=0.12/0.28/0.48/0.72)
  whose bottoms ride the cutwater. `hull_model_v8.py`.
Verified: forefoot is a single graceful curve; stem passes cleanly through the waterline (no tab).

## Backbone timbers + rudder (2026-07-08)

Added as separate objects in Frigate_Hull (flat-shaded, no subsurf), registered to the hull's
own cutwater/keel/sternpost curves:
- **Keel** — box beam (sided 0.60 m) along the keel line Y -22..+25.7, top tucked into the
  garboard, bottom projecting ~0.4 m proud so it reads as a distinct timber.
- **Stem** — beam swept up the faired cutwater `Ycut(z)` (forefoot -> stem head), molded ~0.72 m
  aft; meets the keel cleanly at the forefoot.
- **Sternpost** — raking beam heel (25.7,-6.62) -> head, extended up to the wing transom (z+2.3).
- **Rudder** — flat blade (0.34 m thick) hung on the sternpost aft face, keel bottom -> z+2.0,
  ~1.65 m fore-aft at the heel tapering up. Pivot/pintles not yet modelled; it's a static blade.

All four read correctly in profile against the sheer plate and in 3/4. Next: decks + wales, then
armament + the 3 variants + copper.

## Pintles + gudgeons (rudder hinges) (2026-07-08)

`RudderHinges` object in Frigate_Hull (dark iron): 6 strap bands marching down the raking
sternpost-rudder joint (pivot line = rudder leading edge), each protruding on both sides, with
a continuous vertical pintle pin through the knuckles. Currently one welded assembly with a
static rudder — when we animate steering, split into hull-side gudgeon straps vs rudder-side
pintle straps so the rudder can swing. Reads clearly from the stern quarter; tucked under the
counter overhang so partly occluded from pure broadside (fine for where a rudder lives).

## Decks + wales (first pass) (2026-07-08)

Generated from the hull's own section geometry (`decks_wales.py` -> `decks_wales.json`); heights
read off the sheer plan (rail ~z+6, spar-deck line z+4.98, gun-deck line z+2.88 — 7 ft apart,
matching the section table).
- **SparDeck** / **GunDeck** (Frigate_Deck): cambered surfaces (arch ~0.2 m) following the sheer,
  spanning the hull inside a small bulwark inset. Spar deck z+4.25 @mid (rail − 1.45 m bulwark),
  gun deck z+2.12 @mid (spar − 7 ft). Stop short of stem/sternpost.
- **MainWale** (~z−0.45, at the waterline) + **SheerWale** (~z+4.55, below the spar-deck ports)
  in Frigate_Hull: strakes riding the hull surface, following the sheer, Mirror + Solidify,
  standing ~0.11 m proud. Colours are placeholder (dark); real black/paint comes with materials.

First pass — geometry only. Later: waterways/margin planks, mast partners/hatches/gratings on the
spar deck, plank texturing, and the gunport bands (ports cut + white stripe) which drive the
armament variants.

## Stem flush fix (2026-07-08)

The Stem timber was pinned to the raw cutwater `Ycut(z)`, but the hull's 2x subsurf shrinks its
sharp bow leading edge aft (up to ~1.7 m at the upper bow), so the stem floated forward of the
planking with a growing gap. Fix: rebuilt Stem to follow the *evaluated* (subsurfed) hull leading
edge — sampled min-Y near the centreplane per z-band — sitting 0.06 m proud, stopping at the rail
(no free-floating beakhead projection; the head structure/figurehead/headrails come later).
NOTE: this stem is baked to the current hull shape; re-sample if the hull is regenerated.

## Stem/keel cleanup 2 (2026-07-08)

- Stem: widened (half 0.30) + more proud (0.12 m) + re-sampled the hull leading edge finely
  (110 z-bins, 7-pt smoothed) so the rounded forefoot no longer pokes through the timber.
- Keel: was a blunt box ending in a square face. Rebuilt as a swept beam whose path ramps UP
  and tapers at both ends — a short gripe up the cutwater into the stem foot (fwd) and up the
  sternpost into the deadwood (aft) — so it scarfs into the backbone instead of a blunt cut.

## Backbone joinery detail (2026-07-08)

Replaced the faired-overlap timbers with a fitted assembly of distinct pieces (Frigate_Hull),
crisp flat mating faces + iron through-bolts so the joints read as real joinery:
`Keel` (clean beam) + `FalseKeel` (strip below) + `Stem` (hugs the sampled hull edge) +
`Forefoot` (gripe knee filling the keel->stem corner) + `Deadwood` (wedge filling the
keel->sternpost angle) + `Sternpost` + `SternKnee` + `BackboneBolts` (bolt rows down keel/stem/
sternpost). Widths ~0.6 m sided. Built inline in Blender (no standalone .py); Stem still baked
to the current hull leading edge — re-sample if the hull changes. Still stylised, not true stepped
scarf cuts, but the pieces now fit rather than interpenetrate.

## Head / bow structure (2026-07-08)

Finished the bow forward of the stem, built to the Magoun sheer head profile (billethead scroll
default, not a full figurehead). Pieces in Frigate_Hull:
`KneeOfHead` (solid centreplane knee grounding the head, stem->billet) + `Head_MainRail` /
`Head_MidRail` (twin headrails bowing out in plan, converging to the billet) + `Head_Timber_*`
(connect rails to knee) + `Billethead` (scroll volute at the tip) + `Bowsprit` (tapered spar at
~20deg steeve, matched to the drawing) + `Cathead_S/P`. Verified against REF_Sheer_Magoun.
Stylised (open-lattice rails, no gratings/hair-brackets/gammoning); good enough at game distance.

## Stern galleries + quarter galleries (2026-07-08)

Decorated the square transom (new collection `Frigate_SternGallery`, ~55 pieces), built to the
Magoun sheer quarter-gallery profile + the 1914 stern photo's decoration vocabulary (adapted to
the square stern, not the elliptical one in the photo):
- Transom aft surface sampled from the hull (halfwidth 3.3->4.2 m, rakes aft ~17deg over z 0.6->6.5).
- 6 great-cabin stern windows (glass) with frames + white pilasters; cornice bands (sill/cove/
  taffrail); name board on the counter; star frieze + central eagle (stylised gold); taffrail + posts.
- Quarter galleries (`Gal_Quarter_S/P`): lofted rounded bays projecting at the aft corners, ogee
  cone base finial, 2 tiers of gallery windows, cornice + domed cap. Broadened after a first
  too-narrow/column-like attempt.
Built inline in Blender (no standalone .py). Stylised carvings (no fine relief); eagle/stars/name
are simple shapes. Good at game distance.
