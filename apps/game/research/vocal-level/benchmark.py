"""Benchmark local separators and package aligned audio for the Electron demo."""

import argparse
import json
import logging
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

import mlx.core as mx
import numpy as np
from mlx_audio_separator import Separator

RATE = 44100
MODELS = {
    "demucs": ("htdemucs.yaml", "vocals"),
    "demucs-vocals-ft": ("04573f0d", "vocals"),
    "mdx": ("UVR-MDX-NET-Inst_HQ_3.onnx", "instrumental"),
    "roformer": ("model_bs_roformer_ep_317_sdr_12.9755.ckpt", "vocals"),
}


def ffmpeg(*args, data=None):
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
        input=data, stdout=subprocess.PIPE, check=True,
    ).stdout


def decode(path, stream=0):
    return np.frombuffer(
        ffmpeg("-i", path, "-map", f"0:a:{stream}", "-ac", 2, "-ar", RATE,
               "-f", "f32le", "-"),
        dtype="<f4",
    ).reshape(-1, 2)


def write_wave(path, samples):
    ffmpeg("-f", "f32le", "-ar", RATE, "-ac", 2, "-i", "-", "-c:a",
           "pcm_f32le", path, data=samples.astype("<f4").tobytes())


def write_pack(path, mix, backing):
    peak = max(float(np.max(np.abs(mix))), float(np.max(np.abs(backing))))
    scale = 1.0 if peak <= 1.0 else 0.999 / peak
    samples = np.concatenate([mix, backing], axis=1) * scale
    ffmpeg("-f", "f32le", "-ar", RATE, "-ch_layout", "quad", "-i", "-", "-c:a",
           "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", 24, path,
           data=samples.astype("<f4").tobytes())
    return scale


def snr(reference, error):
    energy = np.sum(reference.astype("float64") ** 2)
    noise = np.sum(error.astype("float64") ** 2)
    return float(10 * np.log10(energy / max(noise, 1e-30)))


def quality(mix, vocal, estimate):
    backing = mix - vocal
    # Fit both true sources together. A vocal-only projection biases leakage
    # measurements when the backing and vocal references are correlated.
    sources = np.column_stack([backing.ravel(), vocal.ravel()])
    weights = np.linalg.lstsq(sources, estimate.ravel(), rcond=None)[0]
    return {
        "backing_sdr_db": snr(backing, estimate - backing),
        "vocal_attenuation_db": float(-20 * np.log10(max(abs(weights[1]), 1e-15))),
        "backing_gain_db": float(20 * np.log10(max(abs(weights[0]), 1e-15))),
    }


def load_model(filename, stem, output, work):
    if filename == "04573f0d":
        import torch
        import mlx_audio_io
        from mlx_audio_separator.demucs_mlx.apply_mlx import apply_model
        from mlx_audio_separator.demucs_mlx.mlx_convert import convert_single_model
        from mlx_audio_separator.demucs_mlx.secure_demucs import get_restricted_demucs_model

        # Meta's official FT ensemble assigns the entire vocal weight to this checkpoint.
        torch.hub.set_dir(str(work / "torch"))
        model = convert_single_model(get_restricted_demucs_model(filename), verbose=False)
        model.eval()
        mx.eval(model.parameters())
        vocal_index = model.sources.index(stem)

        def separate(path):
            source, _ = mlx_audio_io.load(str(path), sr=RATE, layout="channels_first")
            estimated = apply_model(model, source[None], seed=0)
            result = output / "vocals.wav"
            write_wave(result, np.asarray(estimated[0, vocal_index].T))
            return result

        return separate

    separator = Separator(
        log_level=logging.WARNING, model_file_dir=str(work / "models"),
        output_dir=str(output), output_format="WAV", output_single_stem=stem,
        normalization_threshold=1.0, demucs_params={"shifts": 1, "seed": 0},
    )
    separator.load_model(filename)

    def separate(path):
        (result,) = separator.separate(str(path))
        return Path(result)

    return separate


def run(args):
    args.work.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=args.work) as directory:
        prepare_and_run(args, Path(directory))


def prepare_and_run(args, directory):
    prepared = []
    for source in args.inputs:
        mix = decode(source)
        path = directory / f"{source.stem}-input.wav"
        write_wave(path, mix)
        prepared.append((source, path))

    for model in args.model:
        filename, stem = MODELS[model]
        output = args.work / model
        output.mkdir(exist_ok=True)
        started = perf_counter()
        with redirect_stdout(sys.stderr):
            separate = load_model(filename, stem, output, args.work)
        print(json.dumps({"model": model, "load_s": perf_counter() - started}), flush=True)
        for source, path in prepared:
            mix = decode(path)
            for repeat in range(args.repeats):
                mx.reset_peak_memory()
                started = perf_counter()
                result = separate(path)
                elapsed = perf_counter() - started
                peak = mx.get_peak_memory()
                estimate = decode(result)
                if estimate.shape != mix.shape or not np.isfinite(estimate).all():
                    raise ValueError(f"Invalid stem from {model} for {source}")
                backing = mix - estimate if stem == "vocals" else estimate
                report = {
                    "model": model, "track": source.stem, "repeat": repeat + 1,
                    "audio_s": len(mix) / RATE, "separate_s": elapsed,
                    "x_realtime": len(mix) / RATE / elapsed, "mlx_peak_bytes": peak,
                    "est_peak": float(np.max(np.abs(estimate))),
                }
                if source.name.endswith(".stem.mp4"):
                    report.update(quality(mix, decode(source, 4), backing))
                if args.reference_vocals:
                    vocal = decode(args.reference_vocals)
                    start = round(args.reference_start * RATE)
                    section = slice(start, start + len(vocal))
                    report.update(quality(mix[section], vocal, backing[section]))
                if args.pack and repeat == args.repeats - 1:
                    out = output / f"{source.stem}.flac"
                    started = perf_counter()
                    report.update(pack_gain=write_pack(out, mix, backing),
                                  pack_s=perf_counter() - started, pack_bytes=out.stat().st_size)
                print(json.dumps(report), flush=True)
                result.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--model", choices=MODELS, action="append")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--pack", action="store_true")
    parser.add_argument("--reference-vocals", type=Path)
    parser.add_argument("--reference-start", type=float, default=150)
    arguments = parser.parse_args()
    if arguments.repeats < 1:
        parser.error("--repeats must be positive")
    if len(set(p.stem for p in arguments.inputs)) != len(arguments.inputs):
        parser.error("Each input must have a different filename stem")
    if arguments.reference_vocals and len(arguments.inputs) != 1:
        parser.error("--reference-vocals applies to a single input")
    arguments.model = arguments.model or ["demucs-vocals-ft"]
    run(arguments)
