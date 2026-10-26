---
name: roblox-part-model
description: Build a Roblox model out of native parts (Block / Wedge / CornerWedge, solid colors) from an idea with this repo's part-builder MCP - AI reference images, part breakdown, build, evaluate-and-fix loop, rigged export and push to Studio. Use when asked to make, model, build, refine or continue a Roblox model, character, creature, prop or vehicle in this project.
---

# Roblox part model

Default look (style preset `roblox-game`): like models in popular modern Roblox games. Many
chunky blocks, wedges and corner wedges in flat saturated colors; natural proportions, slightly
stylized (not chibi); markings (stripes, spots, a light belly, trim) are separate blocks of a
second color; small block eyes with a dark pupil block, white block teeth, dark block claws.
Where something must look rounded (the back of the head, the rear) it is ONE slope (the plan's
`bevel`), never stair-stepped blocks - and nothing more is rounded. No cylinders, balls, meshes
or textures; studs only when the user asks. `roblox-parts` is the classic-studs look. If the
user asks for a different look, follow that instead.

Tools come from the `part-builder` MCP (this repo). The editor at the URL printed by
`project_open` shows everything live; the user watches there and can click checkpoint buttons.

## Procedure

### 0. Project
`project_open {name, idea, heightStuds, symmetric}`. Height guide (total height, y): R6-style
character 5, chunky hero 5-6; animals as pets next to a 5-stud character - chicken/cat 2-2.5,
dog/fox 3-3.5 (to the ear tips), wolf/tiger 3.5-4.5, bear/yeti 6-8, dinosaur/dragon 6-12;
props relative to a 5-stud character. Describe the colors and markings in the idea.
`symmetric: false` only for clearly lopsided subjects (the build still mirrors limbs).
`similarity` = how close the build stays to the references. The user picks it (editor
References panel, or tells you); default `balanced`. project_open, plan_build and evaluate all
print it - check it before planning and follow it all the way through:
- `close`: as similar as possible - every proportion, plate, band and detail; no deliberate
  differences.
- `balanced`: match proportions, outline, colors and main details, plus 1-3 DELIBERATE
  differences that make it a better part-built model (simplify a fussy detail, a cleaner or
  chunkier shape, a color accent). Choose them on purpose, list them in the plan, tell the user.
- `distinct`: same subject, theme, palette family and overall outline, but clearly its own
  take - 4+ deliberate differences. The score is only a sanity check that it still reads as
  the subject.
- `free`: only the overall theme (what it is, mood, palette family); design the build yourself
  and use the references for scale. Likeness is information only.
If the level changes mid-build (a note "similarity set to ..." appears), re-plan.
Image source: `comfyui` (the user's own GPU, free) or a paid API: `gemini`, `openai`, `fal`,
`replicate`. With `COMFYUI_SSH`, ComfyUI is started on the other PC on the first image (~40 s),
then ~20-30 s per image. If the first image fails, tell the user; don't silently switch to
another source. `image_backend status` / `test` show what is set up and diagnose it. With no
source at all, the user's own pictures still work (`refs_import`).

### 1. Style (optional)
`style {action:'list'|'get'}`. Example screenshots in `styles/<name>/` are sent along as style
references. Tune the text with `style {action:'save', description, avoid}` and preview with
`style {action:'test'}` (2 cheap images). Use `model:'pro'` only if flash keeps missing the style.

### 2. Hero - CHECKPOINT 1
`refs_generate {kind:'hero', count:3}`. Describe the candidates briefly, then STOP and wait for
the user to pick (Pick button in the editor, or in chat; then `refs_pick {hero}`). If none fit,
regenerate with `extra` describing what to change, or `refs_edit` one candidate.
The user's own picture: `refs_import {kind:'hero', file}` (a path or URL) instead; it is picked
right away. They can also upload it in the editor (References > Your own pictures); a note says so.

### 3. Views - CHECKPOINT 2
Views: `front`, `side` and `back`, plus `top` when it helps. There is ONE side view (the
model's right side, facing image-right); the left side is its mirror, so never generate `left`.
1. ComfyUI: `refs_generate {kind:'view', view}` one view at a time. It turns the camera around
   the hero (Qwen-Image-2.1 + Multiple-Angles LoRA, ~12 s each). Results vary: look at every
   view, flip a side view that faces image-left (`refs_flip {view:'side'}`), and regenerate a
   back view that came out as a three-quarter view or shows the face (usually 1-3 tries).
   `method:'prompt'` draws the view from a prompt instead.
   Gemini: `refs_generate {kind:'sheet'}` (front | side | back from the hero), then
   `refs_generate {kind:'view', view:'top'}` if wanted.
   OpenAI, fal, Replicate: `refs_generate {kind:'view', view}` one view at a time, as above.
   The user's own views: `refs_import {kind:'view', view, file}` for each one they have (or editor
   uploads); generate the rest from the hero. With no image source set up they must supply
   front, side and back. A refused picture needs a plain background or a transparent PNG.
2. `refs_normalize` - read the report and look at both images:
   - segmentation overlay: the red outline must hug the subject. Specks or holes -> adjust
     `tolerance` (higher removes more background, lower keeps more subject).
   - FLAGs: front and back must be mirror-image silhouettes. Fix a bad view with
     `refs_generate {kind:'view', view, extra:'<what is wrong>'}` or `refs_edit`, then normalize again.
   - left/right swapped (held item on the wrong side vs the hero) -> regenerate that view.
3. STOP: show the user the normalized views + report and wait for approval (editor button or
   chat -> `refs_pick {approve_views:true}`). Do not build before this.

### 4. Build plan - always BEFORE building
Write a plan from the references before any part exists. It is saved to `parts/plan.json`,
shown in the editor's "Checks & plan" panel, and `evaluate` checks the model against its
landmarks every round.
1. `plan_build {action:'analyze'}` - per view (front, side, back): outline bands, H lines
   (heights inside the outline: helmet brim, chest top/bottom, belt, crotch, knees, boot tops),
   V lines (widths: face plate, torso vs arms) and S spots (eye slits, rivets), plus a sheet with
   every line/spot numbered on the references. Look at the sheet and at `refs/norm_front.png` /
   `norm_right.png` (Read) - the numbers say where, your eyes say what (claw hands, layered
   pads, a crest). Measuring only the outline gets proportions wrong (legs a third too short);
   the H lines prevent that.
   More numbers when needed: `refs_measure {view, mode:'profile'|'lines'|'spots'|'colors'}`
   with `h`/`v` ranges (one arm, the head). All values are world studs.
2. Write the plan and `plan_build {action:'save', plan}`:
   - `summary`: what it is, overall proportions, what is mirrored.
   - `landmarks`: the key heights/widths you read off the analysis, each with its view and axis
     (`{name:'chest_bottom', view:'front', axis:'y', value:2.75}`). These are what evaluate checks.
   - `palette`: the refs palette, so parts use `p0`, `p1`...
   - `groups` (= rig bones) with pivots at the joints: neck = top centre of the torso, shoulder =
     top centre of the arm, hip = top centre of the leg. Humanoid: `Torso` (root) -> `Head`,
     `RightArm`, `RightLeg`, plus `LeftArm {mirrorOf:'RightArm'}`, `LeftLeg {mirrorOf:'RightLeg'}`.
     Four-legged animal: `Body` (root) -> `Head` (-> `Jaw` if the mouth opens), `Tail` (a chain
     `Tail1` -> `Tail2` for a long tail), `FrontRightLeg`, `BackRightLeg`, plus
     `FrontLeftLeg {mirrorOf:'FrontRightLeg'}`, `BackLeftLeg {mirrorOf:'BackRightLeg'}`; pivots at
     the shoulder / hip (top of the leg), neck (front-top of the body), tail base.
     Extra groups for anything that moves on its own (hat, weapon, cape, tail, wings, jaw, ears).
   - `parts`: world boxes `{name, group, shape, min, max, color}` (+ `tall`/`flat` for wedges,
     `apex` for corner wedges, `note` = which landmark it follows, `rotate` to tilt it, `bevel`
     to round it off - see "Rounding" below).
   - `details`: small parts on a face `{name, to, face, size, offset, color}` (eye slits, rivets).
   - `differences`: the deliberate differences from the references `{what, why, where}` - as
     many as the similarity level asks (none at close, 1-3 balanced, 4+ distinct; free is your
     own design). Evaluate lists them so the fix lists don't undo them.
   - `closeups`: parts worth a close-up reference `{name, notes}` - only when a detail is too
     small to read in the views. Leave empty otherwise.
   - SYMMETRY - build once, mirror the rest. Limbs: list parts only in `RightArm`/`RightLeg`;
     the Left groups are generated (save refuses parts in a mirror group). Side parts of centred
     groups (shoulder pads on the torso, cheek plates, rivet pairs): list the RIGHT one (+x) with
     `mirror: true` - a linked twin follows it. Nothing symmetric is listed twice.
   Save checks the plan (and the differences against the similarity level) and prints
   errors/warnings; fix and save again.
3. `plan_build {action:'build'}` builds the whole plan in one revision (replaces the current
   parts) and prints the checks. Then go to the evaluate loop.
To change the model later: edit the plan and build again for big changes (proportions, new
parts), or `scene_apply` for small fixes - but then the plan no longer matches, so for anything
more than tweaks update the plan too.

### 5. Close-ups - optional detail references
Close-ups show ONE part on its own, large, so its details are readable; they are never scored.
- `refs_generate {kind:'part', part:'Head'}` - box and notes come from the plan's close-up
  entry (or pass `box`/`notes`). Add `views:['front','side','back']` for measurable views.
- Each ortho close-up is fitted onto the part's place in the matching view. `outline vs view
  IoU` near 1 = same shape as the views; a FLAG ("drawn 20% wider") means trust it for WHAT the
  details are, not exactly where.
- `plan_build {action:'analyze', part:'Head'}` (or `refs_measure {view, part, mode:'spots'}`)
  gives the close-up's lines and details in world studs.
- A bad close-up: regenerate with `extra`, or `refs_edit {target:'part:Head:front', instruction}`.

### 6. Fixing and adding parts by hand
- `box` / `wedge` / `cornerwedge` / `attach`; one group at a time, right side only.
- New side part outside a mirrored limb: build the right one, then `{op:'mirror', parts:'RightX'}`
  for its linked twin. Never build both sides by hand.
- Detail: eyes, mouth, belts, buckles, trims, armor plates with `attach` (protrude 0.05-0.1);
  wedges for chamfers. Rounded volumes come from the plan's `bevel`, not from layered blocks.
- Check often: `render {mode:'parts'}` shows names on parts, `render {group}` isolates one,
  `evaluate {group}` scores one group in its own area.
- Typical budget: 40-80 parts for a character, 50-150 for an animal (markings, eyes, teeth and
  claws add up). Every part should read; merge what doesn't.

### 7. Evaluate-and-fix loop
The user can follow along in the editor's Review screen (toolbar "Review"). Write evaluate
notes they can read there ("tail raised to match the hero").
After each round: `evaluate {note:'what changed'}`. It scores likeness from four parts -
outline 0.3, structure 0.3, color 0.25, details 0.15 - per view and per body part ("by part,
worst first" tells you where to work), lists concrete fixes, and returns a sheet: reference |
model | overlay | lines per view, plus the hero next to the model's 3/4 view.
Work through the lists in this order:
0. CHECKS and LANDMARKS - z-fighting, "not symmetric", floating parts; and every plan landmark
   the model misses (X = more than 0.12 off).
1. STRUCTURE - reference lines with no model line: usually a height that's off (move the
   belt/knee/chest edge to it) or a plate/band you haven't built. Extra model lines are seams
   the reference doesn't have (merge or move those parts).
2. DETAILS - small features with no small part: add them at those coordinates (`attach`).
3. COLOR - compares color families, so a hit means a real color difference.
4. OUTLINE - missing/extra areas.
- Look at the sheet every round: the overlay shows shifts, the lines tile shows proportions.
- Ignore differences that appear in only one view while the others agree (AI views are never
  perfectly consistent); the back view counts half.
- Stop at the STOP HINT, after 8 rounds, or when likeness stops improving - then SHOW THE USER
  the hero next to `render {views:['threequarter','front','right']}`, name the deliberate
  differences, and ask what still looks off. Typical likeness with AI references: close
  0.8-0.9, balanced 0.72-0.85, distinct 0.5-0.7. The user's eye is the final judge, not the
  number.

### 8. Finish
- Checks must be clean of `zfight`, `asymmetric` (on symmetric projects), `floating` and
  `disconnected`.
- `export {rig:true}` -> .rbxmx (Studio: right-click Workspace > Insert from File).
- Push to Studio if the `roblox-studio` MCP is connected: `export {include_luau:true}` ->
  `list_roblox_studios` -> `execute_luau` (Edit datamodel) with the returned code ->
  `screen_capture` to compare with our render. It's wrapped in an undo recording.

## Building rules
- Coordinates: studs, Y up, model faces -Z, its right side is +X, feet on y=0, centred on x=0.
- Prefer `box` / `wedge` / `cornerwedge` / `attach`; raw `part` only for rotated pieces.
  `rotate` a group around its pivot for angled limbs.
- Every part belongs to a group (= bone). Name sides with Right/Left so mirrors rename cleanly.
- Build every symmetric thing ONCE (the right side, +x) and mirror it: `mirrorOf` groups for
  limbs, `mirror: true` / the `mirror` op for side parts. Never edit generated mirror parts or
  twins (they're read-only); edit their source and the other side follows.
- Default look: smooth Plastic, no studs (`surfaces:'Studs'` only when asked). Parts smaller
  than 1 stud become SmoothPlastic. `paint {material:'Neon'}` for glowing bits.
- Match the reference's proportions inside the outline, not just the outline: where the legs
  start, where the chest ends, belt/hip bands, helmet shape.
- The user's taste beats the score: if they prefer an earlier look, keep it.
- At close/balanced the fix lists are targets (minus the plan's deliberate differences); at
  distinct/free they are information. Don't "fix" a deliberate difference back.
- Reference colors: refs_normalize removes the background's tint from the normalized views. If
  a raw image is strongly lit in a color, regenerate it.
- Shape like the picture: organic subjects get no square-cut back of the head and no cut-off
  rear - those two slope off (see below). Tilt parts with plan `rotate` where the form is angled
  (ears leaning out, a raised tail; parts that turn together share a `pivot`). Ears and other
  sticking-out parts sit IN a base that rises out of the body, never on its edge.
- ROUND ONLY THE BACKS, WITH ONE SLOPE. Stacking smaller boxes on an end is not rounding (it
  adds little 90-degree steps), and rounding everything looks worse. Legs, paws, faces, chests,
  ears and tail chunks stay boxes and wedges (at most a small top-edge chamfer); only the back of
  the head and the rear of the body get a single slope with the plan part's `bevel`. Make each of
  those one part (one box for the head, one for the torso) so the slope runs across it.
  `bevel` reference (exact slopes from wedges + corner wedges, nothing sticks out, no holes):
  `{ends:['+z'], size:0.3}` slopes off the back (`size` = how far in from the rim, `depth` = how
  far along, default = size = 45 degrees). `sizes:{'-z':0.15}` a smaller slope at another end.
  `rim:['+x','-x','+y']` leaves a side flat where it sits on something; `rims:{'-z':[...]}` per
  end. `edges:['+x+y','-x+y'], edgeSize:0.1` cuts the long top edges. Sizes are multiples of
  0.05. Example (fox): head `{ends:['-z','+z'], size:0.3, sizes:{'-z':0.15},
  rims:{'+z':['+x','-x','+y'], '-z':['+y']}, edges:['+x+y','-x+y'], edgeSize:0.1}`, torso
  `{ends:['+z'], size:0.3, edges:['+x+y','-x+y'], edgeSize:0.2}`; everything else plain.
- Legs must look attached: keep each leg's top inside the body's footprint (where the rump
  slopes in, move the back legs forward or shorten the slope). Let the leg's color run up onto
  the body as a haunch (a part in the leg's bone, 0.05 proud) so the leg grows out of it. Back
  legs about the size of the front legs unless the animal clearly has big thighs.
- Preview a plan without touching the project: `npx tsx scripts/plan-preview.ts <project>
  <plan.json> <outDir>`. `npx tsx scripts/check-model.ts <project>` prints the checks.
- Checks after every build must be clean, including "Thin gap" (a visible crack - let the parts
  overlap), "Barely attached" and "Blunt end" (fix with `bevel` on that one part, never with
  another box).
- Overlapping parts are fine, coplanar overlapping faces are not (z-fighting): let details
  protrude or inset by at least 0.05. Write every plan number as a multiple of 0.05 (save
  refuses others). Small details (eyes, glints, noses) must not share any face plane with each
  other; if the check names one, move it by 0.05.
- API images cost money (a few US cents each): use a paid source other than the default only
  when the user agrees. Don't loop endlessly on free images either - after 3 failed redos of the
  same view, ask the user.
