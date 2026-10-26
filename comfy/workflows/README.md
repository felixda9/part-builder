ComfyUI workflows (API format) used by the tool:

- `generate.json` - text to image (hero candidates). FLUX.2 [klein] 4B.
- `edit.json` - images + text to image (views, close-ups). FLUX.2 [klein] 4B.
- `qwen-angles.json` - turns the hero to front / side / back / top. Qwen-Image-2.1 + Multiple-Angles LoRA.
- `qwen-edit.json` - image edit (animal heroes from the pose mannequin, close-ups). Qwen-Image-2.1.
- `rembg.json` - background removal only.
- `pixal3d.json` - optional image to 3D mesh (`scripts/make-3d.ts`).

To use another model, export your workflow with **Workflow > Export (API)** and save it under the
same name. Prompt, image and output nodes are found automatically; to point at them yourself, title
them `MB_PROMPT`, `MB_NEGATIVE`, `MB_REF_1..n`, `MB_SIZE`, `MB_OUTPUT`.
