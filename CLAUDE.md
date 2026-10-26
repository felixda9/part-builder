# part-builder

Turns an idea into a Roblox model made of native parts (Block / Wedge / CornerWedge, solid
colors): AI reference images -> Claude builds the model through this project's MCP server ->
rigged `.rbxmx` / Luau export. The modelling procedure: `.claude/skills/roblox-part-model/SKILL.md`.

## Run
- `npm test` (vitest), `npm run typecheck`
- `npm run editor` - editor server only (http://localhost:5178); `npm run build:web` builds its UI
- `node scripts/smoke-mcp.mjs [outDir]` - drives the MCP server end to end
- `npx tsx scripts/smoke-refs.ts [outDir]` - offline reference pipeline test (fake images of a demo
  knight; evaluate must score ~0.99)
- `npx tsx scripts/smoke-import.ts [outDir]` - offline test of the user's own pictures (`refs_import`)
- `npx tsx scripts/plan-preview.ts <project> <plan.json> [outDir]` - build a plan offline: checks,
  evaluation, renders. `scripts/apply-plan.ts <plan.json>` builds it in the running editor.
- `npx tsx scripts/comfy-check.ts` - tests the ComfyUI connection
- Optional 3D AI path (image -> textured mesh): `scripts/make-3d.ts <project>` ->
  `scripts/view-3d.ts <project> <glb>` -> `scripts/export-3d.ts <project> <glb>`
- Image source (`.env`, see `.env.example`): ComfyUI (`COMFYUI_URL` or `COMFYUI_SSH`,
  `docs/local-gpu.md`) or an API key (Gemini, OpenAI, fal.ai, Replicate). Or none: the user's own
  pictures (`refs_import`, editor uploads). `PART_BUILDER_FAKE_IMAGES=1` = offline test mode.

## Layout
- `src/core/` pure TS shared by server + browser: `scene` (schemas), `shapes` (geometry, mirror),
  `bevel` (plan box -> core + wedge slopes), `commands` (edit language, atomic batches, linked
  mirrors), `lints`, `history`, `raster` (CPU renderer), `export/` (rig, rbxmx, luau)
- `src/server/` Node: `session` (project + history on disk), `http` (static + WS), `mcp` +
  `mcp-refs` (tools), `render`, `images`, `imagegen` (provider switch + cost log), `comfy`,
  `remote` (starts ComfyUI on another PC over SSH), `gemini`, `apis` (OpenAI, fal.ai,
  Replicate), `prompts`, `styles`, `refs` (generate/import/slice/normalize/measure), `imaging` (segmentation, metrics), `likeness`, `evaluate`,
  `plan` (build plan: schema, checks, plan -> commands), `similarity`, `fake` (offline images)
- `styles/<name>/` style presets, `comfy/workflows/` ComfyUI workflows, `web/` editor (Vite +
  Three.js), `projects/<name>/` per-project data (gitignored)

## Conventions (Roblox-native)
- 1 unit = 1 stud, Y up, model faces -Z, its right side is +X, feet on y=0, centred on x=0.
- Rotation stored as an exact row-major 3x3 (CFrame R00..R22); Orientation (YXZ) is derived.
- View names say which side is visible: front = camera at -Z (model's right on image-left).
- Default look: smooth Plastic, no studs (studs only on request); largest side < 1 stud ->
  SmoothPlastic. Chunky and boxy; only the back of the head and the rear of the body get ONE
  slope (the plan part's `bevel`), never stacked smaller boxes.
- Group = rig bone (Motor6D at its pivot to the group's main part). Linked mirror groups (limbs)
  and linked twin parts (`mirror` op) are regenerated after every batch; they are read-only.
- Reference views: front, side, back (+ top). "side" is stored as the `right` view (model faces
  image-right). They plus the 3/4 hero are the comparison targets.
- Close-ups (`refs/parts/<Part>_<view>.png`) are fitted onto that part's place in the normalized
  view, so they measure in world studs. Detail references only - never scored.
- Similarity level (`project.json` `similarity`: close / balanced / distinct / free): how close
  the build stays to the references. Rules in `src/server/similarity.ts`.
- Four-legged animal heroes start from a pose mannequin (`assets/poses/quadruped.png`); on
  ComfyUI, Qwen-Image redraws it as the animal (`qwen-edit.json`), which keeps the stance.

## Gotchas
- stdout is MCP traffic in `--mcp` mode: log with `log()` (stderr), never `console.log`.
- Windows PowerShell 5.1 `Get-Content`/`Set-Content` corrupts UTF-8; edit sources with the
  Edit/Write tools.
- Wedge/CornerWedge geometry comes from community sources; confirm in Studio before relying on
  it for anything new.
- The floating-part lint uses bounding boxes, so a part resting on a wedge's empty corner is not
  flagged. Check renders.
- Reference frames: the front view fixes x=0, the right view fixes z=0; back/top are aligned to
  those. Evaluation renders in the same frames, so a model built from `refs_measure` numbers
  lines up by construction.
