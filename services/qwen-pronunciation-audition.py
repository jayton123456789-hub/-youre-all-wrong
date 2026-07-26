from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_PHRASES = (
    (
        "minecraft-middle",
        "After work, we loaded Minecraft and immediately argued about who stole the diamonds.",
    ),
    (
        "mixed-game-list",
        "Tonight's warm-up includes Rocket League, Borderlands, Fortnite, and one deeply suspicious round of Minecraft.",
    ),
    (
        "rocket-league-middle",
        "Nobody opens Rocket League expecting a calm and emotionally responsible evening.",
    ),
    (
        "borderlands-middle",
        "Our legal department played Borderlands and now every contract contains a loot table.",
    ),
    (
        "fortnite-middle",
        "The committee selected Fortnite because apparently dancing is now a building permit.",
    ),
    (
        "minecraft-second-context",
        "Jordan quit Borderlands to play Minecraft, then blamed Rocket League for ruining his sleep schedule.",
    ),
)

GENERATION_CONFIG = {
    "doSample": True,
    "topK": 50,
    "topP": 1.0,
    "temperature": 0.9,
    "repetitionPenalty": 1.05,
    "subtalkerDoSample": True,
    "subtalkerTopK": 50,
    "subtalkerTopP": 1.0,
    "subtalkerTemperature": 0.9,
    "maxNewTokens": 2_048,
}


def load_worker() -> Any:
    worker_path = Path(__file__).with_name("qwen-voice-worker.py")
    spec = importlib.util.spec_from_file_location(
        "yaw_qwen_pronunciation_worker", worker_path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the pinned Qwen voice worker.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--runtime-manifest", required=True)
    parser.add_argument("--approval", required=True)
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--asr-model", required=True)
    args = parser.parse_args()

    output_directory = Path(args.output_directory).resolve()
    output_directory.mkdir(parents=True, exist_ok=False)

    worker = load_worker()
    contract, policy = worker.runtime_contract(Path(args.runtime_manifest).resolve())

    import numpy as np
    import soundfile as sf
    import torch

    base_path = worker.verify_local_model(
        args.base_model, contract["models"]["base"], "Base"
    )
    asr_path = worker.verify_local_model(
        args.asr_model, contract["models"]["asr"], "ASR"
    )
    reference_path, reference_text, reference_hash, _approval = (
        worker.approved_reference(args.approval)
    )
    generation = worker.generation_kwargs(GENERATION_CONFIG)

    model = worker.load_qwen_model(base_path, torch)
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(reference_path),
        ref_text=reference_text,
        x_vector_only_mode=False,
    )
    transcribe, asr_device = worker.load_render_transcriber(asr_path, torch)

    results: list[dict[str, Any]] = []
    for index in range(0, len(DEFAULT_PHRASES), 2):
        batch = DEFAULT_PHRASES[index : index + 2]
        batch_jobs = [
            {"qaTranscript": text, "text": text, "language": "English"}
            for _identifier, text in batch
        ]
        settings = worker.transcript_bounded_generation_settings(
            generation, batch_jobs, policy
        )
        seed = worker.stable_seed(
            1_730_324_455,
            reference_hash,
            "pronunciation-audition-v1",
            str(index // 2),
            *(text for _identifier, text in batch),
        )
        worker.seed_everything(seed, torch, np)
        waves, sample_rate = model.generate_voice_clone(
            text=[text for _identifier, text in batch],
            language=["English"] * len(batch),
            voice_clone_prompt=prompt,
            non_streaming_mode=True,
            **settings,
        )
        if not isinstance(waves, list) or len(waves) != len(batch):
            raise RuntimeError("Qwen returned an unexpected audition batch.")

        for offset, ((identifier, expected), raw_wave) in enumerate(zip(batch, waves)):
            output_path = output_directory / f"{index + offset + 1:02d}-{identifier}.wav"
            guarded = worker.guarded_waveform(
                raw_wave,
                int(sample_rate),
                np,
                policy.silent_guard_ms,
            )
            worker.write_guarded_wave(output_path, guarded, int(sample_rate), sf)
            heard = transcribe(output_path)
            expected_tokens = worker.transcript_tokens(expected)
            heard_tokens = worker.transcript_tokens(heard)
            distance = worker.edit_distance(expected_tokens, heard_tokens)
            word_error_rate = distance / len(expected_tokens)
            results.append(
                {
                    "clip": output_path.name,
                    "script": expected,
                    "whisperRaw": heard,
                    "expectedNormalized": " ".join(expected_tokens),
                    "whisperNormalized": " ".join(heard_tokens),
                    "wordErrorRate": round(word_error_rate, 6),
                    "exactNormalizedMatch": expected_tokens == heard_tokens,
                    "seed": seed,
                    "maxNewTokens": settings["max_new_tokens"],
                }
            )

    report = {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "voice": "original-host-v1 / approved Voice 2",
        "referenceSha256": reference_hash,
        "generator": "Qwen3-TTS 0.6B Base",
        "listener": "Whisper small.en",
        "asrDevice": asr_device,
        "clips": results,
    }
    (output_directory / "pronunciation-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    text_lines = [
        "YOU'RE ALL WRONG! — VOICE 2 PRONUNCIATION AUDITION",
        f"Generated: {report['createdAt']}",
        f"Generator: {report['generator']}",
        f"Listener: {report['listener']} ({asr_device})",
        f"Reference SHA-256: {reference_hash}",
        "",
    ]
    for position, result in enumerate(results, start=1):
        text_lines.extend(
            (
                f"{position}. {result['clip']}",
                f"SCRIPT:  {result['script']}",
                f"WHISPER: {result['whisperRaw']}",
                f"NORMALIZED SCRIPT:  {result['expectedNormalized']}",
                f"NORMALIZED WHISPER: {result['whisperNormalized']}",
                f"WORD ERROR RATE: {result['wordErrorRate']:.3f}",
                f"EXACT NORMALIZED MATCH: {'YES' if result['exactNormalizedMatch'] else 'NO'}",
                "",
            )
        )
    (output_directory / "pronunciation-report.txt").write_text(
        "\n".join(text_lines),
        encoding="utf-8",
    )
    print(str(output_directory), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
