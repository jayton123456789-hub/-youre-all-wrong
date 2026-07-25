from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MODEL_ID = "parler-tts/parler-tts-mini-v1.1"
MODEL_LICENSE = "Apache-2.0"
PARLER_REVISION = "d108732cd57788ec86bc857d99a6cabd66663d68"
REFERENCE_SCRIPT = (
    "Good evening. Welcome to You're All Wrong. I hope you're feeling confident, "
    "because confidence makes this so much more entertaining. Take your time. "
    "Think carefully. Then prepare to explain yourself."
)
VOICE_DIRECTIONS = [
    (
        "A mature American male game-show host with a warm mid-low register, a lightly "
        "rough texture, crisp diction, and elastic pitch. He sounds privately amused, "
        "intellectually smug, and theatrical without becoming a movie-trailer announcer. "
        "His timing is deliberate and conversational, with controlled pauses before "
        "punchlines. The recording is very clear, close, dry studio audio with no noise "
        "or reverberation."
    ),
    (
        "An American male host in his early forties with a smooth mid-low voice, precise "
        "consonants, lively pitch movement, and relaxed confidence. He performs witty "
        "game-show copy like the smartest person in the room, amused rather than angry. "
        "The pace is measured, the delivery is expressive and mischievous, and the audio "
        "is an immaculate close studio recording with no background sound or reverb."
    ),
    (
        "A charismatic American male comedy host with a smoky baritone, clear articulation, "
        "and a subtle smile audible in the voice. He is pompous in a playful way, capable "
        "of mock sincerity and sudden theatrical emphasis while remaining natural. He "
        "speaks at a moderate, controlled pace. The microphone is close and the recording "
        "is exceptionally clean, dry, and free of noise."
    ),
]


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_and_trim(audio: Any, sample_rate: int, np: Any) -> Any:
    waveform = np.asarray(audio, dtype=np.float32).reshape(-1)
    if waveform.size == 0 or not np.isfinite(waveform).all():
        raise RuntimeError("The model returned empty or invalid audio.")

    threshold = max(0.0025, float(np.max(np.abs(waveform))) * 0.015)
    audible = np.flatnonzero(np.abs(waveform) >= threshold)
    if audible.size:
        padding = int(sample_rate * 0.12)
        start = max(0, int(audible[0]) - padding)
        end = min(waveform.size, int(audible[-1]) + padding + 1)
        waveform = waveform[start:end]

    peak = float(np.max(np.abs(waveform)))
    if peak <= 0:
        raise RuntimeError("The model returned silent audio.")
    waveform = waveform * (math.pow(10.0, -2.0 / 20.0) / peak)

    fade_samples = min(int(sample_rate * 0.015), waveform.size // 2)
    if fade_samples > 1:
        fade = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
        waveform[:fade_samples] *= fade
        waveform[-fade_samples:] *= fade[::-1]
    return waveform


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=9)
    parser.add_argument("--seed", type=int, default=7319)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.count < 3 or args.count > 24:
        raise RuntimeError("Candidate count must be between 3 and 24.")

    output = Path(args.output).resolve()
    if args.force and output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)

    try:
        import numpy as np
        import soundfile as sf
        import torch
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer
    except Exception as error:
        raise RuntimeError(
            "The host foundry is not installed. Run services/setup-host-foundry.ps1."
        ) from error

    if not torch.cuda.is_available():
        raise RuntimeError(
            "The host foundry requires CUDA for this production audition. "
            "Run setup-host-foundry.ps1 and verify the NVIDIA backend."
        )

    device = "cuda:0"
    emit(
        {
            "type": "foundry-stage",
            "stage": "loading-model",
            "model": MODEL_ID,
            "device": torch.cuda.get_device_name(0),
        }
    )
    model = ParlerTTSForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float16,
        low_cpu_mem_usage=True,
    ).to(device)
    prompt_tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    description_tokenizer = AutoTokenizer.from_pretrained(
        model.config.text_encoder._name_or_path
    )
    sample_rate = int(model.config.sampling_rate)
    emit(
        {
            "type": "foundry-stage",
            "stage": "model-loaded",
            "sampleRate": sample_rate,
        }
    )

    prompt_ids = prompt_tokenizer(
        REFERENCE_SCRIPT, return_tensors="pt"
    ).input_ids.to(device)
    candidates: list[dict[str, Any]] = []
    for index in range(args.count):
        candidate_id = f"host-{index + 1:02d}"
        destination = output / f"{candidate_id}.wav"
        seed = args.seed + index * 97
        direction = VOICE_DIRECTIONS[index % len(VOICE_DIRECTIONS)]

        if destination.exists() and not args.force:
            raise RuntimeError(
                f"{destination} already exists. Pass -Force to create a fresh audition set."
            )

        emit(
            {
                "type": "foundry-stage",
                "stage": "generating",
                "candidateId": candidate_id,
                "candidate": index + 1,
                "total": args.count,
                "seed": seed,
            }
        )
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        description_ids = description_tokenizer(
            direction, return_tensors="pt"
        ).input_ids.to(device)
        with torch.inference_mode():
            generation = model.generate(
                input_ids=description_ids,
                prompt_input_ids=prompt_ids,
                do_sample=True,
                temperature=1.0,
            )
        waveform = normalize_and_trim(
            generation.detach().float().cpu().numpy().squeeze(),
            sample_rate,
            np,
        )
        duration_seconds = float(waveform.size / sample_rate)
        if duration_seconds < 5 or duration_seconds > 35:
            raise RuntimeError(
                f"{candidate_id} has an unsafe reference duration of "
                f"{duration_seconds:.2f} seconds."
            )
        sf.write(destination, waveform, sample_rate, subtype="PCM_16")
        candidates.append(
            {
                "id": candidate_id,
                "file": destination.name,
                "seed": seed,
                "direction": direction,
                "durationSeconds": round(duration_seconds, 3),
                "sha256": sha256(destination),
            }
        )
        emit(
            {
                "type": "foundry-progress",
                "candidateId": candidate_id,
                "completed": index + 1,
                "total": args.count,
                "durationSeconds": round(duration_seconds, 3),
            }
        )

    manifest = {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "model": {
            "id": MODEL_ID,
            "license": MODEL_LICENSE,
            "parlerRevision": PARLER_REVISION,
        },
        "referenceScript": REFERENCE_SCRIPT,
        "baseSeed": args.seed,
        "candidateCount": args.count,
        "candidates": candidates,
        "selectionPolicy": [
            "Reject any voice that resembles a recognizable real person.",
            "Judge identity, clarity, pacing, comic timing, and consistency.",
            "Run the selected WAV through the Chatterbox Turbo audition before approval.",
        ],
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    emit(
        {
            "type": "foundry-complete",
            "output": str(output),
            "manifest": str(output / "manifest.json"),
            "candidateCount": len(candidates),
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Host foundry failed: {error}", file=sys.stderr)
        raise
