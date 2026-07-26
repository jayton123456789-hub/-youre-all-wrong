from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
import random
import re
import sys
import traceback
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from uuid import uuid4

# PyTorch requires this to be present before CUDA is initialized when strict
# deterministic algorithms use cuBLAS.
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

PROTOCOL_VERSION = 1
MAXIMUM_CAST_CANDIDATES = 24
MAXIMUM_RENDER_JOBS = 4_000
MAXIMUM_TEXT_CHARACTERS = 4_000
PRIMARY_RENDER_ATTEMPTS = 1
MAXIMUM_RESCUE_ATTEMPTS = 8
MAXIMUM_RENDER_ATTEMPTS = PRIMARY_RENDER_ATTEMPTS + MAXIMUM_RESCUE_ATTEMPTS
FALLBACK_ACCEPTANCE_ATTEMPT = 7
MAXIMUM_FALLBACK_WORD_ERROR_RATE = 0.45
MINIMUM_FALLBACK_TOKEN_RATIO = 0.70
MAXIMUM_FALLBACK_TOKEN_RATIO = 1.30
RETRY_POLICY_REVISION = "yaw-qwen-best-safe-take-v3"
RENDER_POLICY_REVISION = "yaw-qwen-incremental-batch2-v1"
MODEL_MARKER_NAME = ".yaw-model.json"
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$", re.IGNORECASE)
TOKEN_PATTERN = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)
NUMBER_LITERAL_PATTERN = re.compile(
    r"(?<![a-z0-9])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![a-z0-9])",
    re.IGNORECASE,
)
STYLIZED_LETTER_RUN = re.compile(r"([a-z])\1{2,}", re.IGNORECASE)
ANSWER_LABEL_PREFIX = re.compile(
    r"^\s*([a-d])\s*(?:[.):\-]|[\u2013\u2014])(?:\s+|$)",
    re.IGNORECASE,
)
ANSWER_LABEL_ALIASES = {
    "a": frozenset(("a", "ay", "aye")),
    "b": frozenset(("b", "be", "bee")),
    "c": frozenset(("c", "see", "sea")),
    "d": frozenset(("d", "dee")),
}
SMALL_NUMBER_WORDS = (
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
)
TENS_NUMBER_WORDS = (
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
)
NUMBER_SCALES = (
    (1_000_000_000_000, "trillion"),
    (1_000_000_000, "billion"),
    (1_000_000, "million"),
    (1_000, "thousand"),
)
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
GIBIBYTE = 1024**3
# Windows WDDM can report slightly under the board's nominal 8 GiB capacity.
MINIMUM_CUDA_TOTAL_BYTES = 15 * GIBIBYTE // 2
MINIMUM_CUDA_FREE_FOR_ASR_BYTES = 2 * GIBIBYTE
# The pinned Qwen speech tokenizer emits 12.5 codec frames per second. Sizing each
# request from the same duration ceiling enforced by QA prevents a malformed seed
# from consuming the model-wide 2,048-token allowance (roughly 164 seconds).
QWEN_CODEC_TOKENS_PER_SECOND = 12.5
GENERATION_EOS_MARGIN_TOKENS = 32
MINIMUM_GENERATION_MAX_NEW_TOKENS = 64


class QwenVoiceError(RuntimeError):
    pass


class VoiceQualityReject(QwenVoiceError):
    """A generated take failed bounded audio/transcript QA and may be regenerated."""


class TranscriptQualityReject(VoiceQualityReject):
    """A structurally safe take disagreed with offline ASR."""

    def __init__(
        self,
        message: str,
        *,
        word_error_rate: float,
        expected_tokens: int,
        actual_tokens: int,
        fallback_eligible: bool,
    ) -> None:
        super().__init__(message)
        self.word_error_rate = word_error_rate
        self.expected_tokens = expected_tokens
        self.actual_tokens = actual_tokens
        self.fallback_eligible = fallback_eligible
        self.audio_metrics: AudioQaMetrics | None = None


@dataclass(frozen=True)
class AudioQaPolicy:
    revision: str
    silent_guard_ms: int
    maximum_word_error_rate: float
    maximum_edge_silence_ms: int
    maximum_full_scale_ratio: float


@dataclass(frozen=True)
class AudioQaMetrics:
    duration_ms: int
    spoken_duration_ms: int
    onset_ms: int
    trailing_silence_ms: int
    peak: float
    transcript_word_error_rate: float
    expected_tokens: int
    transcribed_tokens: int

    def json(self) -> dict[str, int | float]:
        return {
            "durationMs": self.duration_ms,
            "spokenDurationMs": self.spoken_duration_ms,
            "onsetMs": self.onset_ms,
            "trailingSilenceMs": self.trailing_silence_ms,
            "peak": round(self.peak, 6),
            "transcriptWordErrorRate": round(self.transcript_word_error_rate, 6),
            "expectedTokens": self.expected_tokens,
            "transcribedTokens": self.transcribed_tokens,
        }


@dataclass(frozen=True)
class QaRejection:
    reason: str
    fallback_eligible: bool = False
    transcript: str | None = None
    metrics: AudioQaMetrics | None = None
    wave_sha256: str | None = None


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_hash(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return sha256_bytes(encoded)


def stable_seed(base_seed: int, *parts: str) -> int:
    if base_seed < 0 or base_seed > 2_147_483_647:
        raise QwenVoiceError("baseSeed must be between 0 and 2147483647.")
    digest = hashlib.sha256()
    digest.update(str(base_seed).encode("ascii"))
    for part in parts:
        digest.update(b"\0")
        digest.update(part.encode("utf-8"))
    return int.from_bytes(digest.digest()[:8], "big") % 2_147_483_647


def stable_render_batch_seed(
    base_seed: int, reference_hash: str, jobs: list[dict[str, Any]]
) -> int:
    if not jobs:
        raise QwenVoiceError("Cannot seed an empty render batch.")
    if len(jobs) == 1:
        return int(jobs[0]["seed"])
    identities = [
        f'{job["cacheKey"]}:{int(job["seed"])}'
        for job in jobs
    ]
    return stable_seed(
        base_seed,
        reference_hash,
        "qwen-render-batch-v1",
        *identities,
    )


def stable_retry_seed(
    base_seed: int,
    reference_hash: str,
    cache_key: str,
    cue_id: str,
    attempt: int,
    *,
    lifetime_attempt: int | None = None,
    profile: str = "approved-default",
) -> int:
    if attempt < 2 or attempt > MAXIMUM_RENDER_ATTEMPTS:
        raise QwenVoiceError("Render retry attempt is outside the supported range.")
    ordinal = attempt if lifetime_attempt is None else lifetime_attempt
    if ordinal < attempt:
        raise QwenVoiceError("Render retry lifetime attempt is invalid.")
    return stable_seed(
        base_seed,
        reference_hash,
        cache_key,
        cue_id,
        RETRY_POLICY_REVISION,
        str(attempt),
        str(ordinal),
        profile,
    )


def concise_exception(error: BaseException, maximum_characters: int = 240) -> str:
    message = " ".join(str(error).split()) or type(error).__name__
    if len(message) <= maximum_characters:
        return message
    return f"{message[: maximum_characters - 3].rstrip()}..."


def seed_everything(seed: int, torch: Any, np: Any) -> None:
    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    # A future backend must fail instead of quietly making an audition irreproducible.
    torch.use_deterministic_algorithms(True, warn_only=False)


def integer_spoken_tokens(value: int) -> list[str]:
    if value < 0:
        raise QwenVoiceError("Numeric transcript normalization requires a nonnegative value.")
    if value < 20:
        return [SMALL_NUMBER_WORDS[value]]
    if value < 100:
        tens, remainder = divmod(value, 10)
        return [TENS_NUMBER_WORDS[tens], *(
            [] if remainder == 0 else [SMALL_NUMBER_WORDS[remainder]]
        )]
    if value < 1_000:
        hundreds, remainder = divmod(value, 100)
        return [
            SMALL_NUMBER_WORDS[hundreds],
            "hundred",
            *(integer_spoken_tokens(remainder) if remainder else []),
        ]
    for scale, name in NUMBER_SCALES:
        if value >= scale:
            leading, remainder = divmod(value, scale)
            return [
                *integer_spoken_tokens(leading),
                name,
                *(integer_spoken_tokens(remainder) if remainder else []),
            ]
    # Extremely large literals remain deterministic without pretending that a
    # partial scale table is a faithful reading.
    return [SMALL_NUMBER_WORDS[int(digit)] for digit in str(value)]


def spoken_number_literal(match: re.Match[str]) -> str:
    integer_digits = match.group(1).replace(",", "")
    fractional_digits = match.group(2)
    spoken = integer_spoken_tokens(int(integer_digits))
    if fractional_digits is not None:
        spoken.extend(("point", *(SMALL_NUMBER_WORDS[int(digit)] for digit in fractional_digits)))
    return " ".join(spoken)


def transcript_tokens(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text).lower()
    normalized = NUMBER_LITERAL_PATTERN.sub(spoken_number_literal, normalized)
    # Three or more repeated letters are performance spelling ("WROOOONG"), not
    # additional spoken phonemes. Ordinary doubles such as "book" stay untouched.
    normalized = STYLIZED_LETTER_RUN.sub(r"\1", normalized)
    return TOKEN_PATTERN.findall(normalized)


def maximum_spoken_duration_ms(expected_word_count: int) -> int:
    if expected_word_count < 1:
        raise QwenVoiceError("Expected transcript has no spoken tokens.")
    return min(90_000, max(2_000, expected_word_count * 1_600))


def transcript_sized_max_new_tokens(
    expected_text: str,
    approved_max_new_tokens: int,
    policy: AudioQaPolicy,
) -> int:
    if approved_max_new_tokens < MINIMUM_GENERATION_MAX_NEW_TOKENS:
        raise QwenVoiceError("Approved max_new_tokens is below the safe minimum.")
    expected_word_count = len(transcript_tokens(expected_text))
    maximum_spoken_ms = maximum_spoken_duration_ms(expected_word_count)
    # Qwen's generated codec stream can contain model-created silence before and
    # after speech. The protected guards are added later, so only the remaining
    # QA-permitted edge silence consumes generation tokens here.
    model_edge_silence_ms = max(
        0, policy.maximum_edge_silence_ms - policy.silent_guard_ms
    )
    maximum_generated_ms = maximum_spoken_ms + (model_edge_silence_ms * 2)
    speech_tokens = math.ceil(
        maximum_generated_ms * QWEN_CODEC_TOKENS_PER_SECOND / 1_000
    )
    bounded_tokens = max(
        MINIMUM_GENERATION_MAX_NEW_TOKENS,
        speech_tokens + GENERATION_EOS_MARGIN_TOKENS,
    )
    return min(approved_max_new_tokens, bounded_tokens)


def batch_sized_max_new_tokens(
    batch: list[dict[str, Any]],
    approved_max_new_tokens: int,
    policy: AudioQaPolicy,
) -> int:
    if not batch:
        raise QwenVoiceError("Cannot size generation for an empty render batch.")
    return max(
        transcript_sized_max_new_tokens(
            str(job["qaTranscript"]), approved_max_new_tokens, policy
        )
        for job in batch
    )


def transcript_bounded_generation_settings(
    generation_settings: dict[str, Any],
    batch: list[dict[str, Any]],
    policy: AudioQaPolicy,
) -> dict[str, Any]:
    settings = dict(generation_settings)
    settings["max_new_tokens"] = batch_sized_max_new_tokens(
        batch, int(generation_settings["max_new_tokens"]), policy
    )
    return settings


def edit_distance(expected: list[str], actual: list[str]) -> int:
    previous = list(range(len(actual) + 1))
    for expected_index, expected_token in enumerate(expected, start=1):
        current = [expected_index]
        for actual_index, actual_token in enumerate(actual, start=1):
            substitution = previous[actual_index - 1] + (
                expected_token != actual_token
            )
            current.append(
                min(
                    current[-1] + 1,
                    previous[actual_index] + 1,
                    substitution,
                )
            )
        previous = current
    return previous[-1]


def transcript_qa(
    expected_text: str, transcribed_text: str, maximum_word_error_rate: float
) -> tuple[float, int, int]:
    expected = transcript_tokens(expected_text)
    actual = transcript_tokens(transcribed_text)
    if not expected:
        raise QwenVoiceError("Expected transcript has no spoken tokens.")
    if not actual:
        raise VoiceQualityReject("Offline ASR returned an empty transcript.")
    label_match = ANSWER_LABEL_PREFIX.match(
        unicodedata.normalize("NFKC", expected_text)
    )
    if label_match:
        label = label_match.group(1).lower()
        # Whisper normally spells spoken answer labels as their homophones ("be",
        # "see", "dee"). Canonicalize only the first token and only when the
        # authored expected transcript contains an explicit A-D label delimiter.
        # Normal prose beginning with "a" or "be" does not receive this exception.
        expected[0] = label
        if (
            len(actual) >= len(expected)
            and actual[0] in ANSWER_LABEL_ALIASES[label]
        ):
            actual[0] = label
    word_error_rate = edit_distance(expected, actual) / len(expected)
    token_ratio = len(actual) / len(expected)
    fallback_eligible = (
        word_error_rate <= MAXIMUM_FALLBACK_WORD_ERROR_RATE
        and MINIMUM_FALLBACK_TOKEN_RATIO
        <= token_ratio
        <= MAXIMUM_FALLBACK_TOKEN_RATIO
    )
    if actual[0] != expected[0]:
        raise TranscriptQualityReject(
            f'Offline ASR heard first word "{actual[0]}", expected "{expected[0]}".',
            word_error_rate=word_error_rate,
            expected_tokens=len(expected),
            actual_tokens=len(actual),
            fallback_eligible=fallback_eligible,
        )
    if len(expected) > 1 and actual[-1] != expected[-1]:
        raise TranscriptQualityReject(
            f'Offline ASR heard final word "{actual[-1]}", expected "{expected[-1]}".',
            word_error_rate=word_error_rate,
            expected_tokens=len(expected),
            actual_tokens=len(actual),
            fallback_eligible=fallback_eligible,
        )
    if word_error_rate > maximum_word_error_rate:
        raise TranscriptQualityReject(
            "Offline transcript QA failed: "
            f"word error rate {word_error_rate:.3f} exceeds "
            f"{maximum_word_error_rate:.3f}.",
            word_error_rate=word_error_rate,
            expected_tokens=len(expected),
            actual_tokens=len(actual),
            fallback_eligible=fallback_eligible,
        )
    return word_error_rate, len(expected), len(actual)


def audio_duration_ms(sample_count: int, sample_rate: int) -> int:
    if sample_count < 1 or sample_rate < 1:
        raise QwenVoiceError("Audio duration requires positive samples and sample rate.")
    # JavaScript Math.round semantics match EpisodeVoicePreflight's WAVE parser.
    return max(1, int(math.floor(sample_count * 1_000 / sample_rate + 0.5)))


def guarded_waveform(audio: Any, sample_rate: int, np: Any, guard_ms: int) -> Any:
    waveform = np.asarray(audio, dtype=np.float32)
    if waveform.ndim == 2 and 1 in waveform.shape:
        waveform = waveform.reshape(-1)
    if waveform.ndim != 1 or waveform.size == 0:
        raise VoiceQualityReject("Qwen returned empty or non-mono audio.")
    if not np.isfinite(waveform).all():
        raise VoiceQualityReject("Qwen returned NaN or infinite audio samples.")
    if sample_rate < 8_000 or sample_rate > 192_000:
        raise VoiceQualityReject(
            f"Qwen returned unsupported sample rate {sample_rate}."
        )
    raw_peak = float(np.max(np.abs(waveform)))
    if raw_peak < 0.005:
        raise VoiceQualityReject("Qwen returned silent or unusably quiet audio.")
    if raw_peak > 1.0:
        raise VoiceQualityReject(
            f"Qwen returned samples at {raw_peak:.4f} full scale; refusing PCM clipping."
        )
    if guard_ms < 200:
        raise QwenVoiceError("The Qwen pipeline requires at least 200 ms edge guards.")
    guard_samples = int(math.ceil(sample_rate * guard_ms / 1_000))
    silence = np.zeros(guard_samples, dtype=np.float32)
    # Deliberately no trim, fade, normalization, or tempo transform. The model's first
    # and final phonemes stay untouched, with literal zeros added outside them.
    return np.concatenate((silence, waveform, silence))


def waveform_qa(
    guarded: Any,
    sample_rate: int,
    expected_text: str,
    transcribed_text: str,
    policy: AudioQaPolicy,
    np: Any,
) -> AudioQaMetrics:
    waveform = np.asarray(guarded, dtype=np.float32).reshape(-1)
    if waveform.size == 0 or not np.isfinite(waveform).all():
        raise VoiceQualityReject("Audio QA received empty or invalid samples.")
    guard_samples = int(math.ceil(sample_rate * policy.silent_guard_ms / 1_000))
    if waveform.size <= guard_samples * 2:
        raise VoiceQualityReject("Audio contains guards but no body.")
    if np.any(waveform[:guard_samples] != 0.0):
        raise VoiceQualityReject("Leading guard is not true digital silence.")
    if np.any(waveform[-guard_samples:] != 0.0):
        raise VoiceQualityReject("Trailing guard is not true digital silence.")

    peak = float(np.max(np.abs(waveform)))
    if peak < 0.005:
        raise VoiceQualityReject("Audio is silent or too quiet for reliable playback.")
    if peak > 1.0:
        raise VoiceQualityReject("Audio exceeds the WAV full-scale range.")
    full_scale_ratio = float(np.count_nonzero(np.abs(waveform) >= 0.999) / waveform.size)
    if full_scale_ratio > policy.maximum_full_scale_ratio:
        raise VoiceQualityReject(
            "Audio has excessive full-scale samples "
            f"({full_scale_ratio:.4%}); likely clipped."
        )
    audible_threshold = max(0.0001, peak * 0.005)
    audible = np.flatnonzero(np.abs(waveform) >= audible_threshold)
    if audible.size == 0:
        raise VoiceQualityReject("Audio contains no detectable speech.")

    onset_ms = int(round(int(audible[0]) * 1_000 / sample_rate))
    trailing_silence_ms = int(
        round((waveform.size - 1 - int(audible[-1])) * 1_000 / sample_rate)
    )
    if onset_ms < policy.silent_guard_ms:
        raise VoiceQualityReject("Speech intrudes into the protected leading guard.")
    if trailing_silence_ms < policy.silent_guard_ms:
        raise VoiceQualityReject("Speech intrudes into the protected trailing guard.")
    if onset_ms > policy.maximum_edge_silence_ms:
        raise VoiceQualityReject(
            f"Speech starts after {onset_ms} ms; likely a stalled or malformed render."
        )
    if trailing_silence_ms > policy.maximum_edge_silence_ms:
        raise VoiceQualityReject(
            "Audio leaves "
            f"{trailing_silence_ms} ms after speech; likely a malformed render."
        )

    duration_ms = audio_duration_ms(int(waveform.size), sample_rate)
    spoken_duration_ms = int(
        round((int(audible[-1]) - int(audible[0]) + 1) * 1_000 / sample_rate)
    )
    expected_count = len(transcript_tokens(expected_text))
    minimum_spoken_ms = max(180, expected_count * 85)
    maximum_spoken_ms = maximum_spoken_duration_ms(expected_count)
    if spoken_duration_ms < minimum_spoken_ms:
        raise VoiceQualityReject(
            f"Speech is only {spoken_duration_ms} ms for {expected_count} expected words."
        )
    if spoken_duration_ms > maximum_spoken_ms:
        raise VoiceQualityReject(
            f"Speech is {spoken_duration_ms} ms for {expected_count} expected words."
        )

    try:
        word_error_rate, expected_tokens, actual_tokens = transcript_qa(
            expected_text,
            transcribed_text,
            policy.maximum_word_error_rate,
        )
    except TranscriptQualityReject as error:
        error.audio_metrics = AudioQaMetrics(
            duration_ms=duration_ms,
            spoken_duration_ms=spoken_duration_ms,
            onset_ms=onset_ms,
            trailing_silence_ms=trailing_silence_ms,
            peak=peak,
            transcript_word_error_rate=error.word_error_rate,
            expected_tokens=error.expected_tokens,
            transcribed_tokens=error.actual_tokens,
        )
        raise
    return AudioQaMetrics(
        duration_ms=duration_ms,
        spoken_duration_ms=spoken_duration_ms,
        onset_ms=onset_ms,
        trailing_silence_ms=trailing_silence_ms,
        peak=peak,
        transcript_word_error_rate=word_error_rate,
        expected_tokens=expected_tokens,
        transcribed_tokens=actual_tokens,
    )


def generation_kwargs(config: dict[str, Any]) -> dict[str, Any]:
    required = {
        "doSample": bool,
        "topK": int,
        "topP": (int, float),
        "temperature": (int, float),
        "repetitionPenalty": (int, float),
        "subtalkerDoSample": bool,
        "subtalkerTopK": int,
        "subtalkerTopP": (int, float),
        "subtalkerTemperature": (int, float),
        "maxNewTokens": int,
    }
    for name, expected_type in required.items():
        if name not in config or not isinstance(config[name], expected_type):
            raise QwenVoiceError(f"generation.{name} is missing or invalid.")
    if not 1 <= int(config["topK"]) <= 1_000:
        raise QwenVoiceError("generation.topK is out of range.")
    if not 0 < float(config["topP"]) <= 1:
        raise QwenVoiceError("generation.topP is out of range.")
    if not 0.05 <= float(config["temperature"]) <= 2:
        raise QwenVoiceError("generation.temperature is out of range.")
    if not 64 <= int(config["maxNewTokens"]) <= 4_096:
        raise QwenVoiceError("generation.maxNewTokens is out of range.")
    return {
        "do_sample": bool(config["doSample"]),
        "top_k": int(config["topK"]),
        "top_p": float(config["topP"]),
        "temperature": float(config["temperature"]),
        "repetition_penalty": float(config["repetitionPenalty"]),
        "subtalker_dosample": bool(config["subtalkerDoSample"]),
        "subtalker_top_k": int(config["subtalkerTopK"]),
        "subtalker_top_p": float(config["subtalkerTopP"]),
        "subtalker_temperature": float(config["subtalkerTemperature"]),
        "max_new_tokens": int(config["maxNewTokens"]),
    }


RESCUE_PROFILE_SPECS: tuple[tuple[str, float, int, float, float], ...] = (
    ("rescue-reseed", 1.00, 50, 1.00, 1.05),
    ("rescue-clarity-light", 0.94, 46, 0.98, 1.05),
    ("rescue-clarity-medium", 0.88, 42, 0.96, 1.05),
    ("rescue-clarity-focused", 0.82, 36, 0.94, 1.06),
    ("rescue-precision-light", 0.76, 32, 0.92, 1.06),
    ("rescue-precision-medium", 0.70, 28, 0.90, 1.07),
    ("rescue-precision-focused", 0.64, 24, 0.88, 1.08),
    ("rescue-steady", 0.60, 20, 0.86, 1.08),
)


def rescue_generation_profile(
    approved_generation: dict[str, Any], rescue_index: int
) -> tuple[str, dict[str, Any]]:
    if rescue_index < 1 or rescue_index > len(RESCUE_PROFILE_SPECS):
        raise QwenVoiceError("Rescue generation profile is outside the supported range.")
    name, temperature_scale, top_k_cap, top_p_cap, penalty_floor = (
        RESCUE_PROFILE_SPECS[rescue_index - 1]
    )
    settings = dict(approved_generation)
    # Rescue never alters the approved reference, timing, waveform, transcript-sized
    # token ceiling, or GPU batch size. It only makes the existing sampler
    # progressively less volatile for a cue whose prior takes could not pass the same
    # strict QA contract.
    settings["temperature"] = max(
        0.05, float(approved_generation["temperature"]) * temperature_scale
    )
    settings["subtalker_temperature"] = max(
        0.05,
        float(approved_generation["subtalker_temperature"]) * temperature_scale,
    )
    settings["top_k"] = min(int(approved_generation["top_k"]), top_k_cap)
    settings["subtalker_top_k"] = min(
        int(approved_generation["subtalker_top_k"]), top_k_cap
    )
    settings["top_p"] = min(float(approved_generation["top_p"]), top_p_cap)
    settings["subtalker_top_p"] = min(
        float(approved_generation["subtalker_top_p"]), top_p_cap
    )
    settings["repetition_penalty"] = max(
        float(approved_generation["repetition_penalty"]), penalty_floor
    )
    return name, settings


def runtime_contract(path: Path) -> tuple[dict[str, Any], AudioQaPolicy]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise QwenVoiceError(f"Qwen runtime contract is unreadable: {error}") from error
    if manifest.get("schemaVersion") != 1:
        raise QwenVoiceError("Unsupported Qwen runtime contract.")
    models = manifest.get("models")
    if not isinstance(models, dict):
        raise QwenVoiceError("Qwen runtime contract has no model pins.")
    for name in ("voiceDesign", "base", "asr"):
        model = models.get(name)
        if (
            not isinstance(model, dict)
            or not isinstance(model.get("repository"), str)
            or not re.fullmatch(r"[a-f0-9]{40}", str(model.get("revision", "")))
        ):
            raise QwenVoiceError(f"Qwen runtime model pin {name} is invalid.")
    qa = manifest.get("qa")
    if not isinstance(qa, dict):
        raise QwenVoiceError("Qwen runtime contract has no QA policy.")
    policy = AudioQaPolicy(
        revision=str(qa["policyRevision"]),
        silent_guard_ms=int(qa["silentGuardMs"]),
        maximum_word_error_rate=float(qa["maximumWordErrorRate"]),
        maximum_edge_silence_ms=int(qa["maximumEdgeSilenceMs"]),
        maximum_full_scale_ratio=float(qa["maximumFullScaleRatio"]),
    )
    if (
        policy.silent_guard_ms < 200
        or not 0 <= policy.maximum_word_error_rate <= 0.5
        or policy.maximum_edge_silence_ms < policy.silent_guard_ms
        or not 0 <= policy.maximum_full_scale_ratio <= 0.05
    ):
        raise QwenVoiceError("Qwen runtime QA policy is invalid.")
    return manifest, policy


def verify_local_model(
    model_path_value: str, expected: dict[str, Any], label: str
) -> Path:
    model_path = Path(model_path_value).resolve()
    marker_path = model_path / MODEL_MARKER_NAME
    if not model_path.is_dir() or not marker_path.is_file():
        raise QwenVoiceError(
            f"{label} is not an installed, revision-verified local model directory."
        )
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8-sig"))
    except Exception as error:
        raise QwenVoiceError(f"{label} model marker is invalid: {error}") from error
    if (
        marker.get("repository") != expected["repository"]
        or marker.get("revision") != expected["revision"]
    ):
        raise QwenVoiceError(f"{label} does not match the pinned model revision.")
    return model_path


def validate_safe_id(value: Any, label: str) -> str:
    identifier = str(value)
    if not SAFE_ID.fullmatch(identifier):
        raise QwenVoiceError(f"{label} must be a safe identifier.")
    return identifier


def validate_text(value: Any, label: str) -> str:
    text = str(value).strip()
    if not text or len(text) > MAXIMUM_TEXT_CHARACTERS or "\0" in text:
        raise QwenVoiceError(f"{label} is empty or too long.")
    return text


def load_qwen_model(model_path: Path, torch: Any) -> Any:
    from qwen_tts import Qwen3TTSModel

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    return Qwen3TTSModel.from_pretrained(
        str(model_path),
        device_map=device,
        dtype=dtype,
        attn_implementation="sdpa",
        local_files_only=True,
    )


def collect_released_models(torch: Any) -> None:
    # Callers must first clear every model/prompt reference they own.
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def cuda_memory(torch: Any) -> tuple[int, int] | None:
    if not torch.cuda.is_available():
        return None
    try:
        free_bytes, total_bytes = torch.cuda.mem_get_info(0)
        return int(free_bytes), int(total_bytes)
    except Exception:
        return None


def preferred_asr_device(torch: Any) -> str:
    memory = cuda_memory(torch)
    if memory is None:
        return "cpu"
    free_bytes, total_bytes = memory
    if (
        total_bytes >= MINIMUM_CUDA_TOTAL_BYTES
        and free_bytes >= MINIMUM_CUDA_FREE_FOR_ASR_BYTES
    ):
        return "cuda:0"
    return "cpu"


def preferred_render_batch_size(torch: Any) -> int:
    memory = cuda_memory(torch)
    if memory is None:
        return 1
    _free_bytes, total_bytes = memory
    # Batch two was measured against the longest real episode lines with the
    # approved Voice 2 prompt and Whisper resident on an 8 GiB RTX 3060 Ti.
    # Runtime OOM handling below splits back to singleton generation safely.
    if total_bytes >= MINIMUM_CUDA_TOTAL_BYTES:
        return 2
    return 1


def is_cuda_out_of_memory(error: BaseException, torch: Any) -> bool:
    out_of_memory_type = getattr(getattr(torch, "cuda", None), "OutOfMemoryError", ())
    if isinstance(out_of_memory_type, type) and isinstance(error, out_of_memory_type):
        return True
    message = str(error).lower()
    return "cuda" in message and "out of memory" in message


def local_whisper_transcriber(
    model_path: Path, torch: Any, device: str = "auto"
) -> Callable[[Path], str]:
    import soundfile as sf
    from transformers import (
        AutoModelForSpeechSeq2Seq,
        AutoProcessor,
        pipeline,
    )

    selected_device = (
        preferred_asr_device(torch) if device == "auto" else device
    )
    if selected_device not in {"cpu", "cuda:0"}:
        raise QwenVoiceError("Offline ASR device must be cpu, cuda:0, or auto.")
    if selected_device == "cuda:0" and not torch.cuda.is_available():
        raise QwenVoiceError("Offline ASR requested CUDA, but CUDA is unavailable.")
    use_cuda = selected_device == "cuda:0"
    dtype = torch.float16 if use_cuda else torch.float32
    processor = AutoProcessor.from_pretrained(str(model_path), local_files_only=True)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        str(model_path),
        local_files_only=True,
        torch_dtype=dtype,
        use_safetensors=True,
    )
    if use_cuda:
        model.to("cuda:0")
    recognizer = pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=processor.tokenizer,
        feature_extractor=processor.feature_extractor,
        torch_dtype=dtype,
        device=0 if use_cuda else -1,
    )

    def transcribe(path: Path) -> str:
        audio, sample_rate = sf.read(
            str(path), dtype="float32", always_2d=False
        )
        if getattr(audio, "ndim", 1) == 2:
            if audio.shape[1] != 1:
                raise VoiceQualityReject(
                    f"Offline ASR received multichannel audio for {path.name}."
                )
            audio = audio[:, 0]
        result = recognizer(
            {"raw": audio, "sampling_rate": int(sample_rate)},
            return_timestamps=False,
        )
        text = result.get("text") if isinstance(result, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise VoiceQualityReject(
                f"Offline ASR returned no text for {path.name}."
            )
        return text.strip()

    return transcribe


def load_render_transcriber(
    model_path: Path, torch: Any
) -> tuple[Callable[[Path], str], str]:
    selected_device = preferred_asr_device(torch)
    emit(
        {
            "type": "qwen-stage",
            "stage": "loading-offline-transcript-qa",
            "device": selected_device,
        }
    )
    if selected_device == "cuda:0":
        failure: BaseException | None = None
        try:
            return local_whisper_transcriber(
                model_path, torch, device=selected_device
            ), selected_device
        except BaseException as error:
            if not is_cuda_out_of_memory(error, torch):
                raise
            failure = error
        collect_released_models(torch)
        emit(
            {
                "type": "qwen-stage",
                "stage": "offline-transcript-qa-fallback",
                "from": "cuda:0",
                "to": "cpu",
                "reason": str(failure),
            }
        )
    return local_whisper_transcriber(model_path, torch, device="cpu"), "cpu"


def write_guarded_wave(path: Path, waveform: Any, sample_rate: int, sf: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), waveform, sample_rate, format="WAV", subtype="PCM_16")


def read_wave(path: Path, sf: Any, np: Any) -> tuple[Any, int]:
    audio, sample_rate = sf.read(
        str(path), dtype="float32", always_2d=False
    )
    waveform = np.asarray(audio, dtype=np.float32)
    if waveform.ndim == 2:
        if waveform.shape[1] != 1:
            raise VoiceQualityReject(
                f"{path.name} unexpectedly contains multiple channels."
            )
        waveform = waveform[:, 0]
    return waveform, int(sample_rate)


def ensure_unused_destinations(paths: Iterable[Path]) -> None:
    for path in paths:
        if path.exists():
            raise QwenVoiceError(
                f'Refusing to overwrite existing voice output "{path}".'
            )


def voice_cache_receipt_path(wave_path: Path) -> Path:
    return Path(f"{wave_path}.json")


def voice_rescue_ledger_path(wave_path: Path) -> Path:
    return Path(f"{wave_path}.rescue.json")


def atomic_write_json(path: Path, payload: dict[str, Any], *, replace: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f".{path.name}.part-{os.getpid()}-{uuid4().hex}.tmp"
    )
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as target:
            json.dump(payload, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        if not replace and path.exists():
            raise QwenVoiceError(f'Refusing to overwrite JSON report "{path}".')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def load_rescue_ledger(
    path: Path, cache_key: str, cue_id: str
) -> dict[str, Any]:
    if not path.exists():
        return {
            "schemaVersion": 1,
            "cacheKey": cache_key,
            "cueId": cue_id,
            "attemptCount": 0,
            "failures": [],
        }
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise QwenVoiceError(
            f'Rescue ledger for cue "{cue_id}" is unreadable: {error}'
        ) from error
    failures = ledger.get("failures")
    attempt_count = ledger.get("attemptCount")
    if (
        ledger.get("schemaVersion") != 1
        or ledger.get("cacheKey") != cache_key
        or ledger.get("cueId") != cue_id
        or not isinstance(attempt_count, int)
        or attempt_count < 0
        or not isinstance(failures, list)
        or any(not isinstance(failure, dict) for failure in failures)
    ):
        raise QwenVoiceError(f'Rescue ledger for cue "{cue_id}" is invalid.')
    return ledger


def persist_rescue_failure(
    job: dict[str, Any],
    failure: dict[str, Any],
) -> None:
    ledger = job["rescueLedger"]
    ledger["attemptCount"] = int(failure["lifetimeAttempt"])
    prior = list(ledger.get("failures", []))
    prior.append(dict(failure))
    # Preserve enough durable context to avoid repeating known seeds without
    # allowing one pathological line to grow an unbounded user-data file.
    ledger["failures"] = prior[-32:]
    ledger["updatedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(job["rescueLedgerPath"], ledger, replace=True)


def publish_verified_cache_entry(
    temporary_wave: Path,
    output_path: Path,
    cache_key: str,
    wave_sha256: str,
    duration_ms: int,
) -> Path:
    if not SHA256_PATTERN.fullmatch(cache_key):
        raise QwenVoiceError("Verified cache entry has an invalid cache key.")
    if not SHA256_PATTERN.fullmatch(wave_sha256):
        raise QwenVoiceError("Verified cache entry has an invalid WAVE hash.")
    if duration_ms < 1:
        raise QwenVoiceError("Verified cache entry has an invalid duration.")
    receipt_path = voice_cache_receipt_path(output_path)
    ensure_unused_destinations((output_path, receipt_path))
    receipt_temporary = receipt_path.with_name(
        f".{receipt_path.name}.part-{os.getpid()}-{uuid4().hex}.tmp"
    )
    receipt = {
        "schemaVersion": 1,
        "cacheKey": cache_key,
        "waveSha256": wave_sha256,
        "durationMs": duration_ms,
    }
    try:
        with receipt_temporary.open("x", encoding="utf-8", newline="\n") as target:
            json.dump(receipt, target, ensure_ascii=False, separators=(",", ":"))
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        # The receipt is the commit marker. A crash between these two atomic renames
        # leaves a WAV without a receipt, which preflight rejects and safely rerenders.
        temporary_wave.replace(output_path)
        receipt_temporary.replace(receipt_path)
    finally:
        receipt_temporary.unlink(missing_ok=True)
    return receipt_path


def cast_original_host(
    manifest: dict[str, Any],
    contract: dict[str, Any],
    policy: AudioQaPolicy,
    np: Any,
    sf: Any,
    torch: Any,
) -> None:
    config_path = Path(str(manifest.get("castingConfigPath", ""))).resolve()
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise QwenVoiceError(f"Casting config is unreadable: {error}") from error
    if config.get("schemaVersion") != 1:
        raise QwenVoiceError("Unsupported Qwen casting config.")
    reference_text = validate_text(config.get("referenceText"), "referenceText")
    language = str(config.get("language", "English"))
    directions = config.get("directions")
    if not isinstance(directions, list) or not 1 <= len(directions) <= 24:
        raise QwenVoiceError("Casting config must contain 1-24 directions.")
    count = int(manifest.get("candidateCount", len(directions)))
    if count < 1 or count > min(MAXIMUM_CAST_CANDIDATES, len(directions)):
        raise QwenVoiceError("candidateCount is outside the configured range.")
    base_seed = int(config.get("baseSeed"))
    generation = generation_kwargs(dict(config.get("generation", {})))
    output = Path(str(manifest.get("outputDirectory", ""))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise QwenVoiceError("Casting output directory must be empty.")

    models = contract["models"]
    design_path = verify_local_model(
        str(manifest.get("voiceDesignModelPath", "")),
        models["voiceDesign"],
        "VoiceDesign",
    )
    asr_path = verify_local_model(
        str(manifest.get("asrModelPath", "")), models["asr"], "ASR"
    )
    model = load_qwen_model(design_path, torch)
    pending: list[dict[str, Any]] = []
    temporary_paths: list[Path] = []
    try:
        for index, raw_direction in enumerate(directions[:count]):
            candidate_id = f"qwen-host-{index + 1:02d}"
            direction = validate_text(raw_direction, f"directions[{index}]")
            seed = stable_seed(
                base_seed,
                str(config.get("castingRevision")),
                candidate_id,
                reference_text,
                direction,
            )
            temporary = output / f".{candidate_id}.part-{os.getpid()}.wav"
            destination = output / f"{candidate_id}.wav"
            temporary_paths.append(temporary)
            emit(
                {
                    "type": "qwen-stage",
                    "stage": "voice-design",
                    "candidateId": candidate_id,
                    "seed": seed,
                }
            )
            seed_everything(seed, torch, np)
            waves, sample_rate = model.generate_voice_design(
                text=reference_text,
                language=language,
                instruct=direction,
                non_streaming_mode=True,
                **generation,
            )
            if not isinstance(waves, list) or len(waves) != 1:
                raise QwenVoiceError(
                    f"{candidate_id} returned an unexpected output batch."
                )
            waveform = guarded_waveform(
                waves[0], int(sample_rate), np, policy.silent_guard_ms
            )
            write_guarded_wave(temporary, waveform, int(sample_rate), sf)
            pending.append(
                {
                    "id": candidate_id,
                    "file": destination.name,
                    "temporary": temporary,
                    "seed": seed,
                    "direction": direction,
                }
            )
        model = None
        collect_released_models(torch)

        emit({"type": "qwen-stage", "stage": "offline-transcript-qa"})
        transcribe = local_whisper_transcriber(asr_path, torch)
        candidates: list[dict[str, Any]] = []
        accepted_items: list[dict[str, Any]] = []
        rejected_candidates: list[dict[str, Any]] = []
        for item in pending:
            temporary = item["temporary"]
            try:
                transcript = transcribe(temporary)
                waveform, sample_rate = read_wave(temporary, sf, np)
                metrics = waveform_qa(
                    waveform,
                    sample_rate,
                    reference_text,
                    transcript,
                    policy,
                    np,
                )
                candidates.append(
                    {
                        "id": item["id"],
                        "file": item["file"],
                        "seed": item["seed"],
                        "direction": item["direction"],
                        "sha256": sha256_file(temporary),
                        "transcript": transcript,
                        "qa": metrics.json(),
                    }
                )
                accepted_items.append(item)
            except Exception as error:
                rejection = {
                    "id": item["id"],
                    "seed": item["seed"],
                    "direction": item["direction"],
                    "reason": str(error),
                }
                rejected_candidates.append(rejection)
                emit(
                    {
                        "type": "qwen-candidate-rejected",
                        "candidateId": item["id"],
                        "reason": str(error),
                    }
                )
                temporary.unlink(missing_ok=True)

        if not candidates:
            reasons = "; ".join(
                f'{item["id"]}: {item["reason"]}' for item in rejected_candidates
            )
            raise QwenVoiceError(
                "Every generated host candidate failed automatic audio QA. " + reasons
            )

        accepted_destinations = [
            output / str(item["file"]) for item in accepted_items
        ]
        ensure_unused_destinations(accepted_destinations)
        for item, destination in zip(accepted_items, accepted_destinations):
            item["temporary"].replace(destination)
        audition_manifest = {
            "schemaVersion": 1,
            "status": "audition-only",
            "approvedForGame": False,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "engine": "qwen3-tts",
            "workflow": "VoiceDesign-to-Base-clone-prompt",
            "castingConfigSha256": sha256_file(config_path),
            "runtime": {
                "qwenTts": contract["packages"]["qwenTts"],
                "voiceDesign": models["voiceDesign"],
                "base": models["base"],
                "asr": models["asr"],
            },
            "referenceText": reference_text,
            "language": language,
            "generation": config["generation"],
            "qaPolicyRevision": policy.revision,
            "candidates": candidates,
            "rejectedCandidates": rejected_candidates,
            "selectionPolicy": config.get("selectionPolicy", []),
        }
        manifest_path = output / "audition-manifest.json"
        manifest_path.write_text(
            json.dumps(audition_manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        emit(
            {
                "type": "qwen-complete",
                "operation": "cast",
                "candidateCount": len(candidates),
                "rejectedCount": len(rejected_candidates),
                "manifest": str(manifest_path),
                "approvedForGame": False,
            }
        )
    finally:
        if model is not None:
            model = None
            collect_released_models(torch)
        for temporary in temporary_paths:
            temporary.unlink(missing_ok=True)


def approved_reference(
    approval_path_value: Any,
) -> tuple[Path, str, str, dict[str, Any]]:
    approval_path = Path(str(approval_path_value)).resolve()
    try:
        approval = json.loads(approval_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise QwenVoiceError(f"Voice approval is unreadable: {error}") from error
    if (
        approval.get("schemaVersion") != 1
        or approval.get("status") != "approved"
        or approval.get("engine") != "qwen3-tts"
        or approval.get("syntheticOriginal") is not True
        or approval.get("approvedAsRendered") is not True
    ):
        raise QwenVoiceError(
            "Rendering requires an explicitly approved original Qwen voice."
        )
    reference = approval.get("reference")
    if not isinstance(reference, dict):
        raise QwenVoiceError("Voice approval has no reference.")
    reference_path = (approval_path.parent / str(reference.get("file", ""))).resolve()
    if not reference_path.is_file():
        raise QwenVoiceError("Approved Qwen reference WAV is missing.")
    expected_hash = str(reference.get("sha256", "")).lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
        raise QwenVoiceError("Approved Qwen reference hash is invalid.")
    actual_hash = sha256_file(reference_path)
    if actual_hash != expected_hash:
        raise QwenVoiceError("Approved Qwen reference failed its integrity check.")
    transcript = validate_text(reference.get("transcript"), "reference.transcript")
    return reference_path, transcript, actual_hash, approval


def render_episode(
    manifest: dict[str, Any],
    contract: dict[str, Any],
    policy: AudioQaPolicy,
    np: Any,
    sf: Any,
    torch: Any,
) -> None:
    if manifest.get("renderPolicyRevision") != RENDER_POLICY_REVISION:
        raise QwenVoiceError("Unsupported Qwen incremental render policy.")
    reference_path, reference_text, reference_hash, approval = approved_reference(
        manifest.get("voiceApprovalPath")
    )
    jobs = manifest.get("jobs")
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= MAXIMUM_RENDER_JOBS:
        raise QwenVoiceError("Render manifest must contain 1-4000 jobs.")
    base_seed = int(manifest.get("baseSeed", 0))
    generation = generation_kwargs(dict(manifest.get("generation", {})))
    report_path = Path(str(manifest.get("qaReportPath", ""))).resolve()
    if report_path.suffix.lower() != ".json" or report_path.exists():
        raise QwenVoiceError("qaReportPath must name a new JSON file.")
    failure_report_path = report_path.with_name(
        f"{report_path.stem}.failures.json"
    )
    if failure_report_path.exists():
        raise QwenVoiceError("Voice rescue failure report path is already occupied.")
    models = contract["models"]
    base_path = verify_local_model(
        str(manifest.get("baseModelPath", "")), models["base"], "Base"
    )
    asr_path = verify_local_model(
        str(manifest.get("asrModelPath", "")), models["asr"], "ASR"
    )

    normalized_jobs: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_outputs: set[Path] = set()
    seen_receipts: set[Path] = set()
    seen_ledgers: set[Path] = set()
    for index, raw_job in enumerate(jobs):
        if not isinstance(raw_job, dict):
            raise QwenVoiceError(f"jobs[{index}] is invalid.")
        cue_id = validate_safe_id(raw_job.get("cueId"), f"jobs[{index}].cueId")
        if cue_id in seen_ids:
            raise QwenVoiceError(f'Duplicate cueId "{cue_id}".')
        seen_ids.add(cue_id)
        cache_key = str(raw_job.get("cacheKey", "")).lower()
        if not SHA256_PATTERN.fullmatch(cache_key):
            raise QwenVoiceError(f"jobs[{index}].cacheKey is invalid.")
        text = validate_text(raw_job.get("text"), f"jobs[{index}].text")
        qa_transcript = validate_text(
            raw_job.get("qaTranscript", text),
            f"jobs[{index}].qaTranscript",
        )
        output_path = Path(str(raw_job.get("outputPath", ""))).resolve()
        if output_path.suffix.lower() != ".wav" or output_path in seen_outputs:
            raise QwenVoiceError(f"jobs[{index}].outputPath is invalid or duplicated.")
        seen_outputs.add(output_path)
        receipt_path = voice_cache_receipt_path(output_path)
        if receipt_path in seen_receipts:
            raise QwenVoiceError(f"jobs[{index}] repeats a cache receipt path.")
        seen_receipts.add(receipt_path)
        rescue_ledger_path = voice_rescue_ledger_path(output_path)
        if rescue_ledger_path in seen_ledgers:
            raise QwenVoiceError(f"jobs[{index}] repeats a rescue ledger path.")
        seen_ledgers.add(rescue_ledger_path)
        rescue_ledger = load_rescue_ledger(
            rescue_ledger_path, cache_key, cue_id
        )
        normalized_jobs.append(
            {
                "cueId": cue_id,
                "cacheKey": cache_key,
                "text": text,
                "qaTranscript": qa_transcript,
                "language": str(raw_job.get("language", "English")),
                "outputPath": output_path,
                "receiptPath": receipt_path,
                "rescueLedgerPath": rescue_ledger_path,
                "rescueLedger": rescue_ledger,
            }
        )
    ensure_unused_destinations((*seen_outputs, *seen_receipts))

    seeded_jobs = [
        {
            **job,
            "seed": stable_seed(
                base_seed,
                reference_hash,
                job["cueId"],
                job["text"],
                job["qaTranscript"],
                *(
                    ()
                    if int(job["rescueLedger"]["attemptCount"]) == 0
                    else (
                        RETRY_POLICY_REVISION,
                        str(int(job["rescueLedger"]["attemptCount"]) + 1),
                    )
                ),
            ),
            "priorAttemptCount": int(job["rescueLedger"]["attemptCount"]),
        }
        for job in normalized_jobs
    ]
    model = load_qwen_model(base_path, torch)
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(reference_path),
        ref_text=reference_text,
        x_vector_only_mode=False,
    )
    transcribe, asr_device = load_render_transcriber(asr_path, torch)
    render_batch_size = preferred_render_batch_size(torch)
    maximum_batch_size = render_batch_size
    emit(
        {
            "type": "qwen-stage",
            "stage": "incremental-render-ready",
            "asrDevice": asr_device,
            "batchSize": render_batch_size,
            "jobCount": len(seeded_jobs),
        }
    )
    reports: list[dict[str, Any]] = []
    temporary_paths: list[Path] = []

    def generate_render_items(
        batch: list[dict[str, Any]],
        generation_seed: int,
        attempt: int,
        generation_profile: str,
        generation_settings: dict[str, Any],
    ) -> list[dict[str, Any]]:
        seed_everything(generation_seed, torch, np)
        bounded_generation = transcript_bounded_generation_settings(
            generation_settings, batch, policy
        )
        waves, sample_rate = model.generate_voice_clone(
            text=(
                batch[0]["text"]
                if len(batch) == 1
                else [job["text"] for job in batch]
            ),
            language=(
                batch[0]["language"]
                if len(batch) == 1
                else [job["language"] for job in batch]
            ),
            voice_clone_prompt=prompt,
            non_streaming_mode=True,
            **bounded_generation,
        )
        if not isinstance(waves, list) or len(waves) != len(batch):
            raise QwenVoiceError("Qwen returned an unexpected render batch size.")
        generated: list[dict[str, Any]] = []
        for job, raw_wave in zip(batch, waves):
            destination: Path = job["outputPath"]
            temporary = destination.with_name(
                f".{destination.stem}.part-{os.getpid()}-{uuid4().hex}.wav"
            )
            temporary_paths.append(temporary)
            item = {
                **job,
                "temporary": temporary,
                "generationSeed": generation_seed,
                "generationProfile": generation_profile,
                "maxNewTokens": bounded_generation["max_new_tokens"],
                "batchSize": len(batch),
                "attempt": attempt,
                "lifetimeAttempt": int(job["priorAttemptCount"]) + attempt,
            }
            try:
                waveform = guarded_waveform(
                    raw_wave,
                    int(sample_rate),
                    np,
                    policy.silent_guard_ms,
                )
            except VoiceQualityReject as error:
                item["qualityReject"] = concise_exception(error)
                generated.append(item)
                continue
            # A write failure is infrastructure, not another interpretation of the
            # generated speech. It must escape immediately instead of entering rescue.
            write_guarded_wave(temporary, waveform, int(sample_rate), sf)
            generated.append(item)
        waves = None
        raw_wave = None
        waveform = None
        collect_released_models(torch)
        return generated

    def transcribe_with_fallback(path: Path) -> str:
        nonlocal transcribe, asr_device
        fallback_reason: str | None = None
        try:
            return transcribe(path)
        except BaseException as error:
            if (
                asr_device == "cuda:0"
                and is_cuda_out_of_memory(error, torch)
            ):
                fallback_reason = concise_exception(error)
            else:
                raise
        transcribe = None
        collect_released_models(torch)
        emit(
            {
                "type": "qwen-stage",
                "stage": "offline-transcript-qa-fallback",
                "from": "cuda:0",
                "to": "cpu",
                "reason": fallback_reason,
            }
        )
        transcribe = local_whisper_transcriber(asr_path, torch, device="cpu")
        asr_device = "cpu"
        return transcribe(path)

    def commit_take(
        item: dict[str, Any],
        transcript: str,
        metrics: AudioQaMetrics,
        wave_sha256: str,
        *,
        accepted_warning: str | None = None,
    ) -> None:
        temporary: Path = item["temporary"]
        # Publication errors are infrastructure failures, not alternate reads of the
        # same cue. Never retry or overwrite a destination after this point.
        publish_verified_cache_entry(
            temporary,
            item["outputPath"],
            item["cacheKey"],
            wave_sha256,
            metrics.duration_ms,
        )
        reports.append(
            {
                "cueId": item["cueId"],
                "cacheKey": item["cacheKey"],
                "seed": item["seed"],
                "generationSeed": item["generationSeed"],
                "generationProfile": item["generationProfile"],
                "maxNewTokens": item["maxNewTokens"],
                "batchSize": item["batchSize"],
                "attempt": item["attempt"],
                "lifetimeAttempt": item["lifetimeAttempt"],
                "sha256": wave_sha256,
                "transcript": transcript,
                "qa": metrics.json(),
                "qualityStatus": (
                    "accepted-with-warning" if accepted_warning else "passed"
                ),
                "qualityWarning": accepted_warning,
                "priorFailures": list(
                    item["rescueLedger"].get("failures", [])
                ),
            }
        )
        try:
            item["rescueLedgerPath"].unlink(missing_ok=True)
        except OSError as error:
            emit(
                {
                    "type": "qwen-stage",
                    "stage": "rescue-ledger-cleanup-warning",
                    "cueId": item["cueId"],
                    "reason": concise_exception(error),
                }
            )
        emit(
            {
                "type": "qwen-progress",
                "operation": "render",
                "stage": "quality-checked",
                "cueId": item["cueId"],
                "completed": len(reports),
                "total": len(seeded_jobs),
            }
        )

    def verify_and_commit(item: dict[str, Any]) -> QaRejection | None:
        temporary: Path = item["temporary"]
        if "qualityReject" in item:
            return QaRejection(reason=str(item["qualityReject"]))
        transcript: str | None = None
        try:
            transcript = transcribe_with_fallback(temporary)
            waveform, sample_rate = read_wave(temporary, sf, np)
            metrics = waveform_qa(
                waveform,
                sample_rate,
                item["qaTranscript"],
                transcript,
                policy,
                np,
            )
            wave_sha256 = sha256_file(temporary)
        except TranscriptQualityReject as error:
            return QaRejection(
                reason=concise_exception(error),
                fallback_eligible=error.fallback_eligible,
                transcript=transcript,
                metrics=error.audio_metrics,
                wave_sha256=(
                    sha256_file(temporary)
                    if error.fallback_eligible and error.audio_metrics is not None
                    else None
                ),
            )
        except VoiceQualityReject as error:
            return QaRejection(reason=concise_exception(error))

        commit_take(item, transcript, metrics, wave_sha256)
        return None

    def retain_best_candidate(
        deferred_item: dict[str, Any],
        generated_item: dict[str, Any],
        rejection: QaRejection,
    ) -> None:
        candidate = deferred_item.get("bestCandidate")
        candidate_wer = (
            float(candidate["rejection"].metrics.transcript_word_error_rate)
            if candidate is not None
            else math.inf
        )
        rejection_wer = (
            float(rejection.metrics.transcript_word_error_rate)
            if rejection.metrics is not None
            else math.inf
        )
        if (
            rejection.fallback_eligible
            and rejection.transcript is not None
            and rejection.metrics is not None
            and rejection.wave_sha256 is not None
            and rejection_wer < candidate_wer
        ):
            if candidate is not None:
                candidate["item"]["temporary"].unlink(missing_ok=True)
            deferred_item["bestCandidate"] = {
                "item": generated_item,
                "rejection": rejection,
            }
            return
        generated_item["temporary"].unlink(missing_ok=True)

    def accept_best_candidate(deferred_item: dict[str, Any]) -> bool:
        candidate = deferred_item.get("bestCandidate")
        if candidate is None:
            return False
        item = candidate["item"]
        rejection: QaRejection = candidate["rejection"]
        warning = (
            "Accepted the best structurally safe take after "
            f"{FALLBACK_ACCEPTANCE_ATTEMPT} attempts; offline transcript QA remained "
            f"uncertain ({rejection.reason})"
        )
        commit_take(
            item,
            str(rejection.transcript),
            rejection.metrics,
            str(rejection.wave_sha256),
            accepted_warning=warning,
        )
        deferred_item["status"] = "accepted-with-warning"
        deferred_item["recoveredAttempt"] = int(item["attempt"])
        deferred_item["recoveredProfile"] = str(item["generationProfile"])
        deferred_item["qualityWarning"] = warning
        return True

    generated_item_fields = {
        "temporary",
        "generationSeed",
        "generationProfile",
        "maxNewTokens",
        "batchSize",
        "attempt",
        "lifetimeAttempt",
        "qualityReject",
    }

    def render_job_from_item(item: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value
            for key, value in item.items()
            if key not in generated_item_fields
        }

    def record_quality_failure(
        job: dict[str, Any],
        *,
        attempt: int,
        generation_seed: int,
        profile: str,
        stage: str,
        reason: str,
    ) -> dict[str, Any]:
        failure = {
            "sessionAttempt": attempt,
            "lifetimeAttempt": int(job["priorAttemptCount"]) + attempt,
            "stage": stage,
            "profile": profile,
            "seed": generation_seed,
            "reason": reason,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        persist_rescue_failure(job, failure)
        return failure

    deferred: list[dict[str, Any]] = []
    rescued: list[dict[str, Any]] = []

    try:
        next_job_index = 0
        while next_job_index < len(seeded_jobs):
            batch = seeded_jobs[
                next_job_index : next_job_index + render_batch_size
            ]
            batch_seed = stable_render_batch_seed(
                base_seed, reference_hash, batch
            )
            emit(
                {
                    "type": "qwen-stage",
                    "stage": "base-voice-clone",
                    "cueIds": [job["cueId"] for job in batch],
                    "batchSize": len(batch),
                    "batchSeed": batch_seed,
                }
            )
            try:
                generated_items = generate_render_items(
                    batch,
                    batch_seed,
                    attempt=1,
                    generation_profile="approved-default",
                    generation_settings=generation,
                )
            except BaseException as error:
                if (
                    len(batch) > 1
                    and is_cuda_out_of_memory(error, torch)
                ):
                    render_batch_size = 1
                    collect_released_models(torch)
                    emit(
                        {
                            "type": "qwen-stage",
                            "stage": "render-batch-fallback",
                            "from": len(batch),
                            "to": 1,
                            "reason": str(error),
                        }
                    )
                    continue
                raise
            for item in generated_items:
                rejection = verify_and_commit(item)
                if rejection is not None:
                    job = render_job_from_item(item)
                    failure = record_quality_failure(
                        job,
                        attempt=1,
                        generation_seed=int(item["generationSeed"]),
                        profile=str(item["generationProfile"]),
                        stage="primary",
                        reason=rejection.reason,
                    )
                    deferred_item = {
                        "job": job,
                        "failures": [failure],
                        "status": "deferred",
                    }
                    retain_best_candidate(deferred_item, item, rejection)
                    deferred.append(deferred_item)
                    emit(
                        {
                            "type": "qwen-deferred",
                            "operation": "render",
                            "stage": "quality-deferred",
                            "cueId": job["cueId"],
                            "parkedCount": len(deferred),
                            "attempt": 1,
                            "maximumAttempts": MAXIMUM_RENDER_ATTEMPTS,
                            "profile": "approved-default",
                            "reason": rejection.reason,
                        }
                    )
            next_job_index += len(batch)

        if deferred:
            emit(
                {
                    "type": "qwen-rescue",
                    "operation": "render",
                    "stage": "started",
                    "parkedCount": len(deferred),
                    "rescueTotal": MAXIMUM_RESCUE_ATTEMPTS,
                    "maximumAttempts": MAXIMUM_RENDER_ATTEMPTS,
                }
            )

        active = list(deferred)
        for rescue_index in range(1, MAXIMUM_RESCUE_ATTEMPTS + 1):
            if not active:
                break
            profile, rescue_generation = rescue_generation_profile(
                generation, rescue_index
            )
            next_active: list[dict[str, Any]] = []
            for active_index, deferred_item in enumerate(active):
                job = deferred_item["job"]
                attempt = PRIMARY_RENDER_ATTEMPTS + rescue_index
                lifetime_attempt = int(job["priorAttemptCount"]) + attempt
                retry_seed = stable_retry_seed(
                    base_seed,
                    reference_hash,
                    job["cacheKey"],
                    job["cueId"],
                    attempt,
                    lifetime_attempt=lifetime_attempt,
                    profile=profile,
                )
                previous_reason = str(deferred_item["failures"][-1]["reason"])
                emit(
                    {
                        "type": "qwen-retry",
                        "operation": "render",
                        "stage": "quality-retry",
                        "cueId": job["cueId"],
                        "attempt": attempt,
                        "maximumAttempts": MAXIMUM_RENDER_ATTEMPTS,
                        "seed": retry_seed,
                        "reason": previous_reason,
                    }
                )
                emit(
                    {
                        "type": "qwen-rescue",
                        "operation": "render",
                        "stage": "attempt",
                        "cueId": job["cueId"],
                        "rescueIndex": rescue_index,
                        "rescueTotal": MAXIMUM_RESCUE_ATTEMPTS,
                        "attempt": attempt,
                        "maximumAttempts": MAXIMUM_RENDER_ATTEMPTS,
                        "profile": profile,
                        "seed": retry_seed,
                        "reason": previous_reason,
                    }
                )
                # Non-OOM model/runtime errors and any disk failure deliberately
                # propagate. Only a generated take rejected by VoiceQualityReject
                # is eligible to stay in this bounded rescue queue.
                retry_generated = generate_render_items(
                    [job],
                    retry_seed,
                    attempt=attempt,
                    generation_profile=profile,
                    generation_settings=rescue_generation,
                )[0]
                rejection = verify_and_commit(retry_generated)
                if rejection is None:
                    candidate = deferred_item.pop("bestCandidate", None)
                    if candidate is not None:
                        candidate["item"]["temporary"].unlink(missing_ok=True)
                    deferred_item["status"] = "recovered"
                    deferred_item["recoveredAttempt"] = attempt
                    deferred_item["recoveredProfile"] = profile
                    rescued.append(deferred_item)
                    remaining_parked = (
                        len(next_active) + len(active) - active_index - 1
                    )
                    emit(
                        {
                            "type": "qwen-rescue",
                            "operation": "render",
                            "stage": "recovered",
                            "cueId": job["cueId"],
                            "attempt": attempt,
                            "profile": profile,
                            "remainingParked": remaining_parked,
                        }
                    )
                    continue
                failure = record_quality_failure(
                    job,
                    attempt=attempt,
                    generation_seed=retry_seed,
                    profile=profile,
                    stage="rescue",
                    reason=rejection.reason,
                )
                deferred_item["failures"].append(failure)
                retain_best_candidate(
                    deferred_item,
                    retry_generated,
                    rejection,
                )
                if (
                    attempt >= FALLBACK_ACCEPTANCE_ATTEMPT
                    and accept_best_candidate(deferred_item)
                ):
                    rescued.append(deferred_item)
                    remaining_parked = (
                        len(next_active) + len(active) - active_index - 1
                    )
                    emit(
                        {
                            "type": "qwen-rescue",
                            "operation": "render",
                            "stage": "recovered",
                            "cueId": job["cueId"],
                            "attempt": attempt,
                            "profile": profile,
                            "remainingParked": remaining_parked,
                        }
                    )
                    continue
                next_active.append(deferred_item)
            active = next_active

        for exhausted in active:
            exhausted["status"] = "exhausted"
            emit(
                {
                    "type": "qwen-rescue",
                    "operation": "render",
                    "stage": "exhausted",
                    "cueId": exhausted["job"]["cueId"],
                    "attempts": len(exhausted["failures"]),
                    "lastReason": exhausted["failures"][-1]["reason"],
                }
            )
        if deferred:
            emit(
                {
                    "type": "qwen-rescue",
                    "operation": "render",
                    "stage": "complete",
                    "recoveredCount": len(rescued),
                    "failedCount": len(active),
                }
            )

        def deferred_summary(item: dict[str, Any]) -> dict[str, Any]:
            return {
                "cueId": item["job"]["cueId"],
                "cacheKey": item["job"]["cacheKey"],
                "status": item["status"],
                "recoveredAttempt": item.get("recoveredAttempt"),
                "recoveredProfile": item.get("recoveredProfile"),
                "failures": list(item["failures"]),
                "lifetimeFailures": list(
                    item["job"]["rescueLedger"].get("failures", [])
                ),
            }

        if active:
            failure_report = {
                "schemaVersion": 1,
                "status": "failed",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "engine": "qwen3-tts",
                "referenceSha256": reference_hash,
                "qaPolicyRevision": policy.revision,
                "retryPolicyRevision": RETRY_POLICY_REVISION,
                "maximumAttemptsPerCue": MAXIMUM_RENDER_ATTEMPTS,
                "passedJobs": reports,
                "deferredCues": [
                    deferred_summary(item) for item in deferred
                ],
                "failedCues": [
                    deferred_summary(item) for item in active
                ],
            }
            atomic_write_json(failure_report_path, failure_report, replace=False)
            compact = "; ".join(
                (
                    f'"{item["job"]["cueId"]}": '
                    f'{item["failures"][-1]["reason"]}'
                )
                for item in active[:8]
            )
            if len(active) > 8:
                compact += f"; plus {len(active) - 8} more"
            raise QwenVoiceError(
                f"Voice rescue exhausted for {len(active)} cue(s) after "
                f"{MAXIMUM_RENDER_ATTEMPTS} attempts each: {compact}. "
                f'Failure report: "{failure_report_path}".'
            )

        if len(reports) != len(seeded_jobs):
            raise QwenVoiceError("Voice render completed with missing QA receipts.")

        report = {
            "schemaVersion": 1,
            "status": (
                "passed-with-warnings"
                if any(
                    job.get("qualityStatus") == "accepted-with-warning"
                    for job in reports
                )
                else "passed"
            ),
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "engine": "qwen3-tts",
            "workflow": "VoiceDesign-to-reusable-Base-clone-prompt",
            "voiceApprovalSha256": canonical_json_hash(approval),
            "referenceSha256": reference_hash,
            "model": models["base"],
            "asr": models["asr"],
            "asrDevice": asr_device,
            "maximumRenderBatchSize": maximum_batch_size,
            "finalRenderBatchSize": render_batch_size,
            "qaPolicyRevision": policy.revision,
            "retryPolicyRevision": RETRY_POLICY_REVISION,
            "rescue": {
                "maximumAttemptsPerCue": MAXIMUM_RENDER_ATTEMPTS,
                "deferredCount": len(deferred),
                "recoveredCount": len(rescued),
                "acceptedWithWarningCount": sum(
                    item.get("status") == "accepted-with-warning"
                    for item in rescued
                ),
                "deferredCues": [
                    deferred_summary(item) for item in deferred
                ],
            },
            "jobs": reports,
        }
        atomic_write_json(report_path, report, replace=False)
        emit(
            {
                "type": "qwen-complete",
                "operation": "render",
                "cueCount": len(reports),
                "qaReport": str(report_path),
            }
        )
    finally:
        transcribe = None
        prompt = None
        model = None
        collect_released_models(torch)
        for temporary in temporary_paths:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise QwenVoiceError(f"Worker manifest is unreadable: {error}") from error
    if manifest.get("protocolVersion") != PROTOCOL_VERSION:
        raise QwenVoiceError("Unsupported Qwen worker protocol.")
    operation = manifest.get("operation")
    if operation not in {"cast", "render"}:
        raise QwenVoiceError("Qwen worker operation must be cast or render.")

    runtime_manifest_value = manifest.get("runtimeManifestPath")
    if runtime_manifest_value is None:
        runtime_manifest_path = Path(__file__).with_name(
            "qwen-runtime-manifest.json"
        )
    else:
        runtime_manifest_path = Path(str(runtime_manifest_value)).resolve()
    contract, policy = runtime_contract(runtime_manifest_path)
    try:
        import numpy as np
        import soundfile as sf
        import torch
        import transformers
        from qwen_tts import Qwen3TTSModel  # noqa: F401
    except Exception as error:
        raise QwenVoiceError(
            "The Qwen3-TTS runtime is incomplete. Run setup-qwen-tts.ps1."
        ) from error
    if str(transformers.__version__) != str(contract["packages"]["transformers"]):
        raise QwenVoiceError(
            "Transformers does not match the pinned Qwen runtime contract."
        )
    emit(
        {
            "type": "qwen-ready",
            "operation": operation,
            "device": (
                torch.cuda.get_device_name(0)
                if torch.cuda.is_available()
                else "cpu"
            ),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "qaPolicyRevision": policy.revision,
        }
    )
    if operation == "cast":
        cast_original_host(manifest, contract, policy, np, sf, torch)
    else:
        render_episode(manifest, contract, policy, np, sf, torch)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        try:
            emit(
                {
                    "type": "qwen-error",
                    "errorType": type(error).__name__,
                    "message": concise_exception(error, 1_800),
                }
            )
        except Exception:
            # The traceback remains the durable fallback if stdout is unavailable.
            pass
        raise SystemExit(1)
