"""Prepare aligned original/backing FLAC sidecars for TunePerfect's local library."""

import argparse
import json
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from tempfile import NamedTemporaryFile

import numpy as np

SUFFIX = ".tuneperfect-mix.flac"


def ffmpeg(*args, data=None):
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *map(str, args)],
        input=data, stdout=subprocess.PIPE, check=True,
    ).stdout


def decode(path, rate, stream=0):
    return np.frombuffer(ffmpeg("-i", path, "-map", f"0:a:{stream}", "-ac", 2,
                               "-ar", rate, "-f", "f32le", "-"), dtype="<f4").reshape(-1, 2)


def sample_rate(path):
    return int(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=sample_rate", "-of", "csv=p=0", str(path),
    ]).strip())


def subroformer(backend):
    from subroformer.inference.engine import load_separator, resolve_amp_dtype, separate_audio

    coreml = backend == "coreml"
    model, config = load_separator(
        device="cpu" if coreml else "mps", backend="coreml" if coreml else "torch",
    )
    precision = None if coreml else resolve_amp_dtype(next(model.parameters()).device)

    def backing(mix):
        reported = 0

        def progress(offset, stems):
            nonlocal reported
            percent = min(100, (offset + len(stems["vocals"][0])) * 100 // len(mix))
            if percent >= reported + 10 or percent == 100:
                print(f"  separating {percent}%", file=sys.stderr, flush=True)
                reported = percent

        stems = separate_audio(model, mix.T.copy(), config, amp_dtype=precision, on_chunk=progress)
        return mix - stems["vocals"].T

    return int(config.audio.sample_rate), backing


def deux(weights):
    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten
    import torch
    import yaml
    from mlx_audio_separator.separator.models.roformer.loader import (
        _override_depth_from_weights, convert_torch_to_mlx_weights, create_mel_band_roformer_mlx,
    )

    config = yaml.safe_load((weights.parent / "config.yaml").read_text())
    state = torch.load(str(weights), map_location="cpu", weights_only=True)
    converted = convert_torch_to_mlx_weights(state)
    _override_depth_from_weights(config, set(converted))
    model = create_mel_band_roformer_mlx(config)
    if "final_norm.gamma" not in converted:
        model.final_norm = nn.Identity()
    for key in list(converted):
        if key.endswith("attn.to_q.weight"):
            prefix = key[:-len("to_q.weight")]
            converted[prefix + "to_qkv.weight"] = mx.concatenate(
                [converted.pop(prefix + name + ".weight") for name in ("to_q", "to_k", "to_v")],
                axis=0,
            )
    expected = dict(tree_flatten(model.parameters()))
    generated = {"freq_indices", "num_freqs_per_band", "num_bands_per_freq"}
    missing = expected.keys() - converted.keys() - generated
    wrong_shape = [key for key in expected.keys() & converted.keys()
                   if expected[key].shape != converted[key].shape]
    if missing or wrong_shape:
        raise ValueError(f"Incompatible MLX weights. Missing: {sorted(missing)}, shape: {sorted(wrong_shape)[:5]}")
    model.load_weights([(key, value) for key, value in converted.items() if key in expected], strict=False)
    model.eval()
    mx.eval(model.parameters())
    rate = config["audio"]["sample_rate"]
    chunk = config["audio"]["chunk_size"] / rate
    instrument = config["training"]["instruments"].index("Instrumental")

    def backing(mix):
        # Pad the boundaries so the overlap-add taper covers every original sample.
        pad = round(chunk * rate / 2)
        padded = mx.pad(mx.array(mix.T.copy()), [(0, 0), (pad, pad)])
        output = model.separate_audio_chunked(
            padded, sr=rate, chunk_seconds=chunk, overlap_seconds=chunk / 2,
        )
        return np.asarray(output[0, instrument, :, pad:pad + len(mix)].T)

    return rate, backing


def chart_audio(root):
    def normalized(text):
        return unicodedata.normalize("NFC", text).casefold()

    for chart in root.rglob("*.txt"):
        raw = chart.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("cp1252", errors="replace")
        headers = {}
        for line in text.splitlines():
            if not line.startswith("#"):
                break
            key, _, value = line.partition(":")
            if key.upper() in ("#AUDIO", "#MP3") and value.strip():
                headers[key.upper()] = value.strip()
        name = headers.get("#AUDIO") or headers.get("#MP3")
        if name is None:
            continue
        audio = next((path for path in chart.parent.iterdir()
                      if path.is_file() and not path.is_symlink() and normalized(path.name) == normalized(name)), None)
        if audio is not None:
            yield audio


def quality(mix, vocal, backing):
    target = mix - vocal
    design = np.column_stack((target.ravel(), vocal.ravel())).astype("float64")
    fitted = np.linalg.lstsq(design, backing.ravel(), rcond=None)[0]
    return {
        "backing_sdr_db": float(10 * np.log10(np.sum(target ** 2) / np.sum((backing - target) ** 2))),
        "vocal_attenuation_db": float(-20 * np.log10(max(abs(fitted[1]), 1e-15))),
        "backing_gain_db": float(20 * np.log10(max(abs(fitted[0]), 1e-15))),
    }


def pack(audio, output, model_rate, backing, source_stat, bits):
    rate = sample_rate(audio)
    mix = decode(audio, rate)
    if model_rate != rate:
        backing = np.frombuffer(ffmpeg("-f", "f32le", "-ar", model_rate, "-ac", 2,
                                       "-i", "-", "-ar", rate, "-f", "f32le", "-",
                                       data=backing.astype("<f4").tobytes()), dtype="<f4").reshape(-1, 2)
    if abs(len(backing) - len(mix)) > max(1, int(np.ceil(rate / model_rate))):
        raise ValueError("Resampled backing and original lengths differ")
    backing = np.pad(backing, ((0, max(0, len(mix) - len(backing))), (0, 0)))[:len(mix)]
    peak = max(float(np.max(np.abs(mix))), float(np.max(np.abs(backing))))
    gain = min(1.0, 0.999999 / max(peak, 1e-12))
    combined = np.column_stack((mix, backing)) * gain
    with NamedTemporaryFile(dir=output.parent, prefix=".tuneperfect-", suffix=".flac", delete=False) as handle:
        pending = Path(handle.name)
    try:
        ffmpeg("-f", "f32le", "-ar", rate, "-ch_layout", "quad", "-i", "-",
               "-c:a", "flac", "-sample_fmt", "s16" if bits == 16 else "s32",
               "-bits_per_raw_sample", bits,
               pending, data=combined.astype("<f4").tobytes())
        current = audio.stat()
        if (current.st_size, current.st_mtime_ns) != (source_stat.st_size, source_stat.st_mtime_ns):
            raise RuntimeError("Source audio changed during preparation")
        pending.replace(output)
    finally:
        pending.unlink(missing_ok=True)
    return {"file": str(output), "frames": len(mix), "rate": rate, "gain": gain, "bytes": output.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, nargs="*")
    parser.add_argument("--library", type=Path, action="append", default=[])
    parser.add_argument("--model", choices=("subroformer", "deux"), default="subroformer")
    parser.add_argument("--backend", choices=("coreml", "torch-mps"), default="coreml",
                        help="SubRoformer backend on Apple Silicon")
    parser.add_argument("--weights", type=Path, help="Deux .ckpt adjacent to the author's config.yaml")
    parser.add_argument("--bits", type=int, choices=(16, 24), default=24,
                        help="Sidecar PCM precision before lossless FLAC compression")
    parser.add_argument("--force", action="store_true", help="Rebuild existing sidecars")
    parser.add_argument("--evaluate", action="store_true", help="Score .stem.mp4 inputs without writing sidecars")
    args = parser.parse_args()
    if not args.audio and not args.library:
        parser.error("Pass audio files or a --library folder")
    if args.model == "deux" and (not args.weights or not args.weights.is_file()):
        parser.error("Deux requires --weights pointing to the downloaded checkpoint")
    paths = dict.fromkeys([*args.audio, *(audio for root in args.library for audio in chart_audio(root))])
    model = None
    failures = 0
    for audio in paths:
        try:
            source_stat = audio.stat()
            output = audio.with_name(audio.name + SUFFIX)
            if not args.evaluate and not args.force and output.is_file():
                existing = output.stat()
                if existing.st_size > 42 and existing.st_mtime_ns >= source_stat.st_mtime_ns:
                    print(json.dumps({"source": str(audio), "status": "ready"}), flush=True)
                    continue
            if model is None:
                model = subroformer(args.backend) if args.model == "subroformer" else deux(args.weights)
            rate, separate = model
            mix = decode(audio, rate)
            print(f"Preparing {audio.name}", file=sys.stderr, flush=True)
            started = time.perf_counter()
            backing = separate(mix)
            result = {"source": str(audio), "model": args.model, "seconds": time.perf_counter() - started}
            if backing.shape != mix.shape or not np.isfinite(backing).all():
                raise ValueError("Model output is not aligned finite stereo audio")
            if args.evaluate:
                result.update(quality(mix, decode(audio, rate, stream=4), backing))
            else:
                result.update(pack(audio, output, rate, backing, source_stat, args.bits))
            print(json.dumps(result), flush=True)
        except Exception as error:
            failures += 1
            print(f"{audio}: {error}", file=sys.stderr, flush=True)
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
