#!/usr/bin/env python3
"""
Generate anime portrait frames for Aither using ComfyUI.
Saves to the exact locations expected by portrait.ts.
"""

import json
import time
import urllib.request
import urllib.error
import ssl
from pathlib import Path

# Disable SSL verification for self-signed cert
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

COMFYUI_URL = "https://localhost:8188"
PORTRAIT_DIR = Path(r"D:\AitherOS-Fresh\.PRODUCTS\.AITHERSHELL\cli\assets\aither-portrait")
CHECKPOINT = "waiIllustriousSDXL_v140.safetensors"

# Base prompt: consistent character across all variations
BASE_PROMPT = (
    "a beautiful anime girl, head and shoulders portrait, "
    "soft pale skin, expressive anime eyes, dark hair, "
    "soft natural lighting, clean white background, "
    "professional illustration style, masterpiece quality"
)

# Emotions with prompt modifiers
EMOTIONS = {
    "neutral": "calm and serene, gentle smile, peaceful expression",
    "happy": "bright cheerful smile, joyful expression, sparkling eyes, excited",
    "angry": "furrowed brows, frowning, pouting lips, frustrated expression",
    "thinking": "looking up thoughtfully, hand near chin, curious expression, concentrated",
}

NEGATIVE_PROMPT = (
    "ugly, blurry, distorted, deformed, text, watermark, signature, "
    "multiple heads, lowres, bad quality, nsfw"
)


def build_workflow(prompt: str, seed: int = 42) -> dict:
    """Build a minimal SDXL txt2img workflow."""
    return {
        "1": {
            "inputs": {
                "ckpt_name": CHECKPOINT
            },
            "class_type": "CheckpointLoaderSimple",
            "_meta": {"title": "Load Checkpoint"}
        },
        "2": {
            "inputs": {
                "text": prompt,
                "clip": ["1", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP Text Encode (Positive)"}
        },
        "3": {
            "inputs": {
                "text": NEGATIVE_PROMPT,
                "clip": ["1", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP Text Encode (Negative)"}
        },
        "4": {
            "inputs": {
                "width": 512,
                "height": 768,
                "batch_size": 1
            },
            "class_type": "EmptyLatentImage",
            "_meta": {"title": "Empty Latent Image"}
        },
        "5": {
            "inputs": {
                "seed": seed,
                "steps": 20,
                "cfg": 7.0,
                "sampler_name": "euler",
                "scheduler": "karras",
                "denoise": 1.0,
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0]
            },
            "class_type": "KSampler",
            "_meta": {"title": "KSampler"}
        },
        "6": {
            "inputs": {
                "samples": ["5", 0],
                "vae": ["1", 2]
            },
            "class_type": "VAEDecode",
            "_meta": {"title": "VAE Decode"}
        },
        "7": {
            "inputs": {
                "filename_prefix": "aither",
                "images": ["6", 0]
            },
            "class_type": "SaveImage",
            "_meta": {"title": "Save Image"}
        }
    }


def submit_workflow(workflow: dict) -> str:
    """Submit workflow to ComfyUI and return prompt_id."""
    # ComfyUI expects the workflow wrapped in a "prompt" key
    payload = {"prompt": workflow}
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        f"{COMFYUI_URL}/prompt",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            return result.get("prompt_id", "")
    except urllib.error.URLError as e:
        print(f"Failed to submit workflow: {e}")
        return ""


def wait_for_completion(prompt_id: str, timeout: int = 120) -> dict:
    """Poll history until generation completes."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(
                f"{COMFYUI_URL}/history/{prompt_id}",
                context=ctx,
                timeout=10
            ) as resp:
                history = json.loads(resp.read().decode('utf-8'))
                if prompt_id in history:
                    entry = history[prompt_id]
                    # Check if generation is complete
                    if entry.get("status", {}).get("completed"):
                        return entry
        except Exception as e:
            print(f"Poll error: {e}")
        time.sleep(2)
    raise TimeoutError(f"Generation timed out after {timeout}s")


def fetch_image(filename: str, subfolder: str = "") -> bytes:
    """Fetch generated image from ComfyUI."""
    # subfolder might be empty string, which means "output" directory
    url = f"{COMFYUI_URL}/view?filename={filename}&subfolder={subfolder}&type=output"
    try:
        with urllib.request.urlopen(url, context=ctx, timeout=10) as resp:
            return resp.read()
    except Exception as e:
        print(f"Failed to fetch image {filename}: {e}")
        return b""


def generate_emotion(emotion: str, emotion_prompt: str, seed: int = 42):
    """Generate a portrait for one emotion."""
    prompt = f"{BASE_PROMPT}, {emotion_prompt}"
    print(f"\n[{emotion}] Prompt: {prompt[:80]}...")

    workflow = build_workflow(prompt, seed=seed)

    print("Submitting workflow to ComfyUI...")
    prompt_id = submit_workflow(workflow)
    if not prompt_id:
        print("  ERROR: Failed to submit workflow")
        return False

    print(f"  Prompt ID: {prompt_id}, waiting for completion...")
    try:
        history = wait_for_completion(prompt_id, timeout=180)
    except TimeoutError as e:
        print(f"  ERROR: {e}")
        return False

    # Extract output filename from SaveImage node (node 7)
    outputs = history.get("outputs", {})
    if "7" not in outputs or "images" not in outputs["7"]:
        print("  ERROR: No images in outputs")
        print(f"  Debug: outputs keys = {list(outputs.keys())}")
        return False

    images = outputs["7"]["images"]
    if not images:
        print("  ERROR: No images returned")
        return False

    image_info = images[0]
    filename = image_info["filename"]
    subfolder = image_info.get("subfolder", "")
    print(f"  Generated: {filename} (subfolder: {subfolder or 'output'})")

    # Fetch the PNG
    print("  Fetching image...")
    png_data = fetch_image(filename, subfolder)
    if not png_data:
        print("  ERROR: Failed to fetch image")
        return False

    # Save to portrait directory
    output_path = PORTRAIT_DIR / f"{emotion}.png"
    with open(output_path, 'wb') as f:
        f.write(png_data)

    size_kb = len(png_data) / 1024
    print(f"  Saved: {output_path} ({size_kb:.1f} KB)")
    return True


def main():
    print(f"Generating Aither portraits using ComfyUI at {COMFYUI_URL}")
    print(f"Checkpoint: {CHECKPOINT}")
    print(f"Output: {PORTRAIT_DIR}")

    PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)

    results = {}
    for emotion, emotion_prompt in EMOTIONS.items():
        # Use different seed for each emotion for variation
        seed = hash(emotion) % (2**31)
        success = generate_emotion(emotion, emotion_prompt, seed=seed)
        results[emotion] = success

    print("\n" + "="*60)
    print("SUMMARY:")
    for emotion, success in results.items():
        status = "[OK]" if success else "[FAIL]"
        print(f"  {status} {emotion}")

    # List generated files
    print("\nGenerated files:")
    for png in sorted(PORTRAIT_DIR.glob("*.png")):
        size_kb = png.stat().st_size / 1024
        print(f"  {png.name} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
