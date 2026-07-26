from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MODEL_ID = "parler-tts/parler-tts-mini-v1.1"
MODEL_LICENSE = "Apache-2.0"
MODEL_REVISION = "fbb2dd281092c5b414ef29cf9d8895f386f1feef"
PARLER_CODE_REVISION = "d108732cd57788ec86bc857d99a6cabd66663d68"
AUDIBLE_GUARD_SECONDS = 0.12
EDGE_FADE_SECONDS = 0.015
REFERENCE_SCRIPT = (
    "Welcome to You're All Wrong. You get twenty seconds and four perfectly "
    "understandable buttons; after that, we learn what confidence sounds like just "
    "before impact. So take a breath, read carefully, and please—try not to make this "
    "interesting for the wrong reasons."
)
VOICE_DIRECTIONS = [
    (
        "An American male speaker in his late thirties has a natural mid-range voice "
        "with a faint rough edge. He speaks conversationally at a moderately quick pace, "
        "with light connective words, crisp stressed nouns, varied phrase lengths, and a "
        "short pause before reversals. His tone is dryly amused and lightly skeptical "
        "rather than booming or stern. Very clear close-microphone audio, with no "
        "background noise or reverberation."
    ),
    (
        "An American male speaker in his early forties has a warm mid-low register with "
        "a clean, unforced texture. He uses natural conversational rhythm, precise "
        "consonants, quick connective phrases, and an amused upward turn before a colder "
        "sarcastic payoff. He sounds confident but never like broadcast advertising. "
        "Close, dry, intimate studio audio with no noise or reverberation."
    ),
    (
        "An American male speaker in his mid-thirties has a lean, slightly brighter "
        "mid-range voice and fast comic instincts. His delivery is nimble and connected, "
        "with clean articulation, irregular phrase lengths, lightly tossed-off setup "
        "words, and one exact stress on the punchline. He sounds clever and genuinely "
        "entertained, never chirpy or sing-song. Clean, close, dry studio recording."
    ),
    (
        "An American male speaker around forty has a lightly rough mid-range voice and a "
        "brisk, deadpan delivery. He keeps the factual setup clear, lets a tiny pause expose "
        "the sarcastic pivot, and then lands the final phrase with restrained disbelief. "
        "His cadence varies from clause to clause and never falls the same way twice. "
        "Natural close-microphone studio audio without ambience or reverb."
    ),
    (
        "An erudite American male speaker in his early forties has a smooth natural "
        "mid-range voice, relaxed breath, and precise but unshowy diction. He moves between "
        "quiet mock warmth and cool private amusement, changing pitch because the thought "
        "changes rather than following a repeated melody. The pace is conversational and "
        "fluid. Intimate, clear, dry studio audio with no background sound."
    ),
    (
        "An American male comedy presenter in his late thirties has a flexible mid-low "
        "voice in his natural speaking register. He can widen his pitch and energy for one "
        "theatrical phrase, then immediately return to an understated conversational tone. "
        "The rhythm is connected and unpredictable, with a deliberate breath before the "
        "reversal. No trailer bass, radio polish, or constant smile. Pristine close, dry "
        "studio audio."
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
    leading_guard_samples = 0
    trailing_guard_samples = 0
    if audible.size:
        guard_samples = max(1, int(round(sample_rate * AUDIBLE_GUARD_SECONDS)))
        first_audible = int(audible[0])
        last_audible = int(audible[-1])
        start = max(0, first_audible - guard_samples)
        end = min(waveform.size, last_audible + guard_samples + 1)
        available_leading_guard = first_audible - start
        available_trailing_guard = end - last_audible - 1
        waveform = waveform[start:end]
        # Preserve any natural sub-threshold context, then supply the margin the model
        # omitted. This pins detected speech inside the edge fades instead of fading it.
        missing_leading_guard = guard_samples - available_leading_guard
        missing_trailing_guard = guard_samples - available_trailing_guard
        if missing_leading_guard or missing_trailing_guard:
            waveform = np.pad(
                waveform,
                (missing_leading_guard, missing_trailing_guard),
                mode="constant",
            )
        leading_guard_samples = guard_samples
        trailing_guard_samples = guard_samples

    peak = float(np.max(np.abs(waveform)))
    if peak <= 0:
        raise RuntimeError("The model returned silent audio.")
    waveform = waveform * (math.pow(10.0, -2.0 / 20.0) / peak)

    requested_fade_samples = max(0, int(round(sample_rate * EDGE_FADE_SECONDS)))
    fade_in_samples = min(requested_fade_samples, leading_guard_samples)
    if fade_in_samples > 1:
        fade_in = np.linspace(0.0, 1.0, fade_in_samples, dtype=np.float32)
        waveform[:fade_in_samples] *= fade_in
    fade_out_samples = min(requested_fade_samples, trailing_guard_samples)
    if fade_out_samples > 1:
        fade_out = np.linspace(1.0, 0.0, fade_out_samples, dtype=np.float32)
        waveform[-fade_out_samples:] *= fade_out
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
    output.mkdir(parents=True, exist_ok=True)
    if args.force:
        for previous_candidate in output.glob("host-*.wav"):
            if previous_candidate.is_file():
                previous_candidate.unlink()
        (output / "manifest.json").unlink(missing_ok=True)

    try:
        import numpy as np
        import soundfile as sf
        import torch
        import urllib3.util.connection as urllib3_connection
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer
    except Exception as error:
        raise RuntimeError(
            "The host foundry is not installed. Run services/setup-host-foundry.ps1."
        ) from error

    # Some Windows networks advertise IPv6 routes that never complete TLS handshakes.
    # Hugging Face uses urllib3 beneath its downloader, so prefer the working IPv4 route
    # unless a user explicitly opts back into dual-stack resolution.
    if os.name == "nt" and os.environ.get("YAW_HOST_FOUNDRY_ALLOW_IPV6") != "1":
        import socket

        urllib3_connection.allowed_gai_family = lambda: socket.AF_INET

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
        revision=MODEL_REVISION,
        torch_dtype=torch.float16,
        low_cpu_mem_usage=True,
    ).to(device)
    prompt_tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
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

    prompt_tokens = prompt_tokenizer(REFERENCE_SCRIPT, return_tensors="pt")
    prompt_ids = prompt_tokens.input_ids.to(device)
    prompt_attention_mask = prompt_tokens.attention_mask.to(device)
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
        description_tokens = description_tokenizer(direction, return_tensors="pt")
        description_ids = description_tokens.input_ids.to(device)
        description_attention_mask = description_tokens.attention_mask.to(device)
        with torch.inference_mode():
            generation = model.generate(
                input_ids=description_ids,
                attention_mask=description_attention_mask,
                prompt_input_ids=prompt_ids,
                prompt_attention_mask=prompt_attention_mask,
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
            "modelRevision": MODEL_REVISION,
            "parlerCodeRevision": PARLER_CODE_REVISION,
        },
        "referenceScript": REFERENCE_SCRIPT,
        "baseSeed": args.seed,
        "candidateCount": args.count,
        "candidates": candidates,
        "selectionPolicy": [
            "Reject any voice that resembles a recognizable real person.",
            "Reject broadcast bass, uniform stress, repeated falling cadence, sing-song "
            "pitch loops, generic commercial warmth, and stop-start sentence pauses.",
            "Judge identity, clarity, pacing, comic timing, consistency, and whether the "
            "sarcastic pivot sounds like the speaker's real opinion just leaked out.",
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
