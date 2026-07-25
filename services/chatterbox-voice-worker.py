from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def apply_pronunciation(text: str, pronunciation: dict[str, str]) -> str:
    spoken = text
    for written, replacement in sorted(
        pronunciation.items(), key=lambda item: len(item[0]), reverse=True
    ):
        if not written.strip() or not replacement.strip():
            continue
        pattern = rf"(?<![\w]){re.escape(written)}(?![\w])"
        spoken = re.sub(pattern, lambda _: replacement, spoken, flags=re.IGNORECASE)
    return spoken


def delivery_settings(delivery: str, pace_permille: int, energy_permille: int) -> dict[str, float]:
    exaggeration_by_delivery = {
        "conversational": 0.45,
        "dry": 0.28,
        "smug": 0.58,
        "mock_sincere": 0.52,
        "conspiratorial": 0.38,
        "announcer": 0.72,
        "excited": 0.92,
        "disappointed": 0.40,
        "furious": 1.05,
        "finale_shout": 1.15,
    }
    base = exaggeration_by_delivery.get(delivery, 0.5)
    energy_adjustment = (energy_permille - 550) / 2200
    pace_adjustment = (1000 - pace_permille) / 5000
    exaggeration = max(0.25, min(1.5, base + energy_adjustment + pace_adjustment))
    cfg_weight = max(0.2, min(0.8, 0.5 - (exaggeration - 0.5) * 0.12))
    return {"exaggeration": exaggeration, "cfg_weight": cfg_weight}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("protocolVersion") != 1:
        raise RuntimeError("Unsupported neural voice worker manifest version.")

    try:
        import torch
        import torchaudio
        from chatterbox.tts import ChatterboxTTS
    except Exception as error:  # pragma: no cover - exercised on the target PC
        raise RuntimeError(
            "Chatterbox is not installed. Run services/setup-chatterbox.ps1 first."
        ) from error

    requested_device = str(manifest.get("device", "auto"))
    device = "cuda" if requested_device == "auto" and torch.cuda.is_available() else requested_device
    if device == "auto":
        device = "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("Chatterbox requested CUDA, but PyTorch cannot see a CUDA GPU.")

    reference_audio = manifest.get("referenceAudioPath")
    if reference_audio:
        reference_audio = str(Path(reference_audio).resolve())
        if not Path(reference_audio).is_file():
            raise RuntimeError(f"Reference voice clip does not exist: {reference_audio}")

    emit({"type": "worker-ready", "device": device})
    model = ChatterboxTTS.from_pretrained(device=device)

    for job in manifest.get("jobs", []):
        output_path = Path(str(job["outputPath"])).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cached = output_path.is_file() and output_path.stat().st_size >= 46
        if not cached:
            spoken_text = apply_pronunciation(
                str(job["text"]), dict(job.get("pronunciation", {}))
            )
            settings = delivery_settings(
                str(job.get("delivery", "conversational")),
                int(job.get("pacePermille", 1000)),
                int(job.get("energyPermille", 550)),
            )
            kwargs: dict[str, Any] = {
                "exaggeration": settings["exaggeration"],
                "cfg_weight": settings["cfg_weight"],
            }
            if reference_audio:
                kwargs["audio_prompt_path"] = reference_audio
            wave = model.generate(spoken_text, **kwargs)
            temporary_path = output_path.with_suffix(output_path.suffix + f".part-{os.getpid()}")
            torchaudio.save(str(temporary_path), wave.cpu(), model.sr)
            temporary_path.replace(output_path)

        emit({"type": "progress", "cueId": str(job["cueId"]), "cached": cached})

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
