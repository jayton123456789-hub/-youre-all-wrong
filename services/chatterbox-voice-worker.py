from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
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


def delivery_settings(
    delivery: str, pace_permille: int, energy_permille: int
) -> dict[str, float]:
    exaggeration_by_delivery = {
        "conversational": 0.43,
        "dry": 0.32,
        "smug": 0.48,
        "mock_sincere": 0.45,
        "conspiratorial": 0.38,
        "announcer": 0.55,
        "excited": 0.70,
        "disappointed": 0.38,
        "furious": 0.78,
        "finale_shout": 0.72,
    }
    cfg_by_delivery = {
        "conversational": 0.35,
        "dry": 0.32,
        "smug": 0.30,
        "mock_sincere": 0.30,
        "conspiratorial": 0.28,
        "announcer": 0.27,
        "excited": 0.24,
        "disappointed": 0.30,
        "furious": 0.22,
        "finale_shout": 0.22,
    }
    tempo_multiplier_by_delivery = {
        "conversational": 0.96,
        "dry": 0.92,
        "smug": 0.94,
        "mock_sincere": 0.92,
        "conspiratorial": 0.88,
        "announcer": 0.88,
        "excited": 0.96,
        "disappointed": 0.90,
        "furious": 0.94,
        "finale_shout": 0.90,
    }

    energy_adjustment = (energy_permille - 550) / 4000
    exaggeration = max(
        0.25,
        min(0.85, exaggeration_by_delivery.get(delivery, 0.43) + energy_adjustment),
    )
    cfg_weight = cfg_by_delivery.get(delivery, 0.32)
    authored_pace = pace_permille / 1000
    tempo = max(
        0.72,
        min(1.15, authored_pace * tempo_multiplier_by_delivery.get(delivery, 0.96)),
    )
    return {
        "exaggeration": exaggeration,
        "cfg_weight": cfg_weight,
        "tempo": tempo,
    }


def apply_tempo(wave: Any, tempo: float, torch: Any, librosa: Any, np: Any) -> Any:
    if abs(tempo - 1.0) < 0.01:
        return wave.detach().cpu()

    audio = wave.detach().cpu().numpy()
    stretched_channels = [
        librosa.effects.time_stretch(channel.astype(np.float32), rate=tempo)
        for channel in audio
    ]
    shortest = min(len(channel) for channel in stretched_channels)
    stacked = np.stack([channel[:shortest] for channel in stretched_channels])
    return torch.from_numpy(stacked)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("protocolVersion") != 1:
        raise RuntimeError("Unsupported neural voice worker manifest version.")

    try:
        import librosa
        import numpy as np
        import perth
        import torch
        import torchaudio
        import transformers
        from chatterbox.tts import ChatterboxTTS
        from chatterbox.tts_turbo import ChatterboxTurboTTS
    except Exception as error:  # pragma: no cover - exercised on the target PC
        raise RuntimeError(
            "Chatterbox is not installed correctly. Run services/setup-chatterbox.ps1."
        ) from error

    requested_device = os.environ.get("YAW_CHATTERBOX_DEVICE", "auto").strip().lower()
    if requested_device not in {"auto", "cuda", "cpu"}:
        raise RuntimeError("YAW_CHATTERBOX_DEVICE must be auto, cuda, or cpu.")
    device = (
        "cuda"
        if requested_device == "auto" and torch.cuda.is_available()
        else requested_device
    )
    if device == "auto":
        device = "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("Chatterbox requested CUDA, but PyTorch cannot see a CUDA GPU.")

    model_kind = os.environ.get("YAW_CHATTERBOX_MODEL", "turbo").strip().lower()
    if model_kind not in {"original", "turbo"}:
        raise RuntimeError("YAW_CHATTERBOX_MODEL must be original or turbo.")

    reference_audio = os.environ.get("YAW_CHATTERBOX_REFERENCE", "").strip()
    if reference_audio:
        reference_audio = str(Path(reference_audio).resolve())
        if not Path(reference_audio).is_file():
            raise RuntimeError(f"Reference voice clip does not exist: {reference_audio}")
    elif os.environ.get("YAW_CHATTERBOX_ALLOW_DEFAULT", "0") != "1":
        raise RuntimeError(
            "A production Chatterbox voice requires YAW_CHATTERBOX_REFERENCE. "
            "Use only a clip you own or have permission to clone."
        )

    if model_kind == "turbo" and not reference_audio:
        raise RuntimeError("Chatterbox Turbo requires a reference voice clip.")

    emit(
        {
            "type": "worker-ready",
            "device": device,
            "model": model_kind,
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "perthPath": str(Path(perth.__file__).resolve()),
        }
    )
    emit({"type": "worker-stage", "stage": "loading-model", "model": model_kind})
    model = (
        ChatterboxTurboTTS.from_pretrained(device=device)
        if model_kind == "turbo"
        else ChatterboxTTS.from_pretrained(device=device)
    )
    emit(
        {
            "type": "worker-stage",
            "stage": "model-loaded",
            "model": model_kind,
            "sampleRate": model.sr,
        }
    )

    for job in manifest.get("jobs", []):
        cue_id = str(job["cueId"])
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
            kwargs: dict[str, Any] = {}
            if reference_audio:
                kwargs["audio_prompt_path"] = reference_audio
            if model_kind == "original":
                kwargs["exaggeration"] = settings["exaggeration"]
                kwargs["cfg_weight"] = settings["cfg_weight"]

            emit(
                {
                    "type": "worker-stage",
                    "stage": "generating",
                    "cueId": cue_id,
                    "model": model_kind,
                    "tempo": settings["tempo"],
                    "exaggeration": settings["exaggeration"],
                    "cfgWeight": settings["cfg_weight"],
                }
            )
            try:
                with torch.inference_mode():
                    wave = model.generate(spoken_text, **kwargs)
                wave = apply_tempo(wave, settings["tempo"], torch, librosa, np)
            except Exception as error:
                raise RuntimeError(
                    f'Chatterbox failed while generating cue "{cue_id}": {error}'
                ) from error

            emit({"type": "worker-stage", "stage": "saving", "cueId": cue_id})
            temporary_path = output_path.with_name(
                f"{output_path.stem}.part-{os.getpid()}{output_path.suffix}"
            )
            try:
                torchaudio.save(
                    str(temporary_path),
                    wave.detach().cpu(),
                    model.sr,
                    format="wav",
                )
                temporary_path.replace(output_path)
            finally:
                temporary_path.unlink(missing_ok=True)

        emit({"type": "progress", "cueId": cue_id, "cached": cached})

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)
