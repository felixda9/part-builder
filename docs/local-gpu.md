# ComfyUI setup (free, your own GPU)

Needs a recent ComfyUI (all nodes used are built in; no custom node packs). Tested on an
RTX 3090 (24 GB). Check the connection with `npx tsx scripts/comfy-check.ts`.

## Connect
Set one of these in `.env`:

- ComfyUI on this PC: `COMFYUI_URL=http://127.0.0.1:8188`
- ComfyUI on another PC: `COMFYUI_URL=http://<pc>:8188` (start it with `--listen`; keep it on a
  private network, e.g. Tailscale)
- Another PC, started only when needed: `COMFYUI_SSH=user@pc` and `COMFYUI_SSH_KEY=<key file>`.
  The tool starts ComfyUI over SSH on the first image and stops it after 30 idle minutes or when
  Claude Code closes. That PC must run Windows with Comfy Desktop and OpenSSH Server.

## Models
Put each file in ComfyUI's `models/<folder>/`. File names must match the workflows in
`comfy/workflows/` (or edit the workflow).

| Model | Used for | Commercial use |
|---|---|---|
| [FLUX.2 klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8) | hero images, views drawn from a prompt | yes (Apache 2.0) |
| [Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) | camera-angle views, animal heroes, part close-ups | **no** (Qwen Research License) |
| [Multiple-Angles LoRA](https://huggingface.co/akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA) | camera-angle views | no (runs on Qwen-Image) |
| [BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet) | background removal | yes (MIT) |
| [Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D) + [TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2) | optional image to 3D | yes (MIT; its DINOv3 encoder has [Meta's license](https://ai.meta.com/resources/models-and-libraries/dinov3-license/)) |

With ComfyUI, the default steps use Qwen-Image, so for commercial work use Gemini.

Files:
- FLUX.2 klein: `diffusion_models/flux-2-klein-4b-fp8.safetensors`,
  `text_encoders/qwen_3_4b.safetensors` ([Comfy-Org/flux2-klein-4B](https://huggingface.co/Comfy-Org/flux2-klein-4B)),
  `vae/flux2-vae.safetensors` ([Comfy-Org/flux2-dev](https://huggingface.co/Comfy-Org/flux2-dev))
- Qwen-Image-2.1: `diffusion_models/qwen_image_2.1_int8_convrot.safetensors`,
  `loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors`,
  `text_encoders/qwen3vl_8b_int8_convrot.safetensors`, `vae/qwen_image_2.1_vae_bf16.safetensors`
- Multiple-Angles LoRA: `checkpoints_v2/...000001500.safetensors` from the repo, saved as
  `loras/qwen21_multiple_angles_v2.safetensors`
- BiRefNet: `birefnet.safetensors`
- Pixal3D / TRELLIS.2: open ComfyUI's template `3d_pixal3d_trellis2_image_to_model`; it
  downloads them.

Comfy-Org repos keep each file under `split_files/<folder>/`; that is the `models/` folder it
goes in.
