# Local vocal level for TunePerfect

See the [live mixer implementation and newer model comparison](live-mixer.md) for the in-game feature and library preparer.

## Recommendation

Prepare a backing mix once per song on the user's machine. At playback, stream a
single audio file containing the original stereo mix and its sample-aligned stereo
backing. The **Original vocals** slider blends the two pairs with complementary,
smoothed gains. Start at 100% for familiar playback, offer 25% as a practice preset,
and make 0% available for karaoke. A 25% setting applies −12 dB to the estimated
vocal difference. Any vocal leakage in the backing remains audible.

Use the **HTDemucs fine-tuned vocal checkpoint on MLX** as the Apple Silicon
starting point. Meta assigns all of the fine-tuned ensemble's vocal weight to this
single checkpoint. Run it in a helper process and keep the model warm across jobs. Prepare requested and queued tracks
first. Offer a resumable library batch for users who want every local song ready.
An uncached song starts with its existing audio. Take newly prepared audio into
use before a round starts.

The selected checkpoint processed the full 2:51 track in 10–12 seconds on the
M4 Air. Moving inference off the playback path makes the slider available
immediately after seeking and leaves the GPU available for the game. Streaming separation is technically possible when a
live input is the only source. Research distinguishes wall-clock throughput from
per-chunk latency and shows that even a 23 ms algorithmic-latency implementation
still has a substantial compute bill. TunePerfect has the whole local file
available to read ahead. [Streaming HTDemucs study](https://arxiv.org/abs/2609.35397),
[causal HS-TasNet](https://arxiv.org/abs/2402.17701).

## What ran on the M4 Air

Apple M4, 32 GiB, macOS 27.0.1, MLX 0.32.4, mlx-audio-separator 0.1.20.
Separation time includes decode of the canonical PCM input and the write for one
estimated stem. It excludes model load, canonicalization, and FLAC packing. The
first full-song pass includes runtime warmup. Peak memory is MLX's allocator
counter, which can include live model state. The benchmark used one worker.
Sustained throughput under game load remains to be measured.

The full track was **A Classic Education — NightOwl** (171.44 s). The timing comes
from two full passes per model, and the quality figures for that song use the
published reference vocal from 2:30–2:35. For a wider check, I took 13 clips from
the official MUSDB18 preview test folder by sorting filenames and selecting
indices 1, 5, 9, …, 49. All clips were about 6.80 s after decode. Its separately
encoded AAC mix and references limit the precision of the comparison.
[TorchAudio's full-song and reference assets](https://github.com/pytorch/audio/blob/main/examples/tutorials/hybrid_demucs_tutorial.py),
[SigSep's preview dataset and stream mapping](https://github.com/sigsep/sigsep-mus-db/blob/master/musdb/configs/mus.yaml),
[MUSDB18 audio provenance](https://sigsep.github.io/datasets/musdb.html).

| Model                        | Full song, pass 1 / 2 | Full song peak MLX | Excerpt median backing SDR | Excerpt median vocal attenuation | Excerpt median backing gain |
| ---------------------------- | --------------------: | -----------------: | -------------------------: | -------------------------------: | --------------------------: |
| HTDemucs FT vocal specialist |       10.24 / 11.47 s |           3.11 GiB |                   12.70 dB |                         19.15 dB |                    −0.28 dB |
| HTDemucs                     |       17.44 / 13.04 s |           3.19 GiB |                   12.42 dB |                         19.43 dB |                    −0.29 dB |
| UVR MDX-Net Inst HQ 3        |       35.81 / 33.65 s |           1.84 GiB |                   10.55 dB |                         23.86 dB |                    −1.99 dB |
| BS-RoFormer Viperx 317       |     114.71 / 136.40 s |           2.56 GiB |                   15.37 dB |                         26.98 dB |                    −0.26 dB |

[Per-track and playback measurements](results.json).

Backing SDR here is energy of the reference backing divided by the energy of
the sample error, expressed in decibels. The reference is the decoded mixture
minus the independently available vocal. Vocal attenuation and backing gain are
the two coefficients of a joint least-squares fit of the output against the
reference backing and vocal. A strong attenuation result can coexist with
audibly damaged instruments, so use SDR and backing gain alongside it. These
are local checks with a small sample and a different metric from published
BSS Eval scores. A center-cancellation baseline attenuated vocals by 23.28 dB
but reduced backing by 19.42 dB and scored 0.31 dB backing SDR. The unprocessed
mixture scored 3.38 dB backing SDR. On these clips HTDemucs' attenuation
ranged from 5.13 to 29.86 dB.
The full-song reference section scored 19.39 dB backing SDR and 19.03 dB attenuation
with the FT vocal specialist. BS-RoFormer scored 20.79 dB and 20.95 dB on that
section. A listening check on the user's library is the next quality gate.

### Model options

- **HTDemucs** has a published architecture, official Meta weights, and
  reproducible MLX inference. Its base checkpoint is roughly 84 MB in the
  original format. The fine-tuned version uses four specialist checkpoints and
  Meta reports a quality improvement at higher compute cost. The single
  vocal specialist uses one roughly 84 MB checkpoint and gives the same vocal
  output as the ensemble's vocal branch. The full ensemble attempt ran out of
  disk space during its four-model conversion. The table uses a direct
  conversion of the official vocal checkpoint `04573f0d`. The upstream
  repository is archived and carries MIT terms. Confirm the chosen model distribution and notices before
  bundling shipments.
  [HTDemucs paper](https://arxiv.org/abs/2211.08553),
  [Meta repository, model descriptions and license](https://github.com/facebookresearch/demucs),
  [official specialist checkpoint mapping](https://github.com/facebookresearch/demucs/blob/main/docs/training.md).
- **BS-RoFormer and Mel-Band RoFormer** are strong dedicated-vocal candidates.
  The BS-RoFormer architecture won the SDX23 music track in the authors'
  configuration. The Viperx community checkpoint is a separate model.
  Reported scores depend on the checkpoint and corpus. The upstream release
  publishes this weight file without stated terms. Keep it a
  local research comparison pending explicit checkpoint terms. It delivered the
  strongest median accompaniment and attenuation scores in this trial and cost
  about ten times as much time as the FT vocal specialist. A RoFormer with
  suitable checkpoint terms is a candidate for an optional quality mode. A
  dedicated karaoke model could preserve harmonies and backing singers.
  [BS-RoFormer paper](https://arxiv.org/abs/2309.02612),
  [Mel-Band RoFormer paper](https://arxiv.org/abs/2310.01809),
  [Viperx upstream release](https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models),
  [Viperx conversion provenance](https://huggingface.co/thepatch/bs-roformer-viperx-317-GGUF),
  [MVSep lead/backing benchmark](https://mvsep.com/algorithms/76?lang=en).
- **MDX-Net** is a smaller ONNX option. The checkpoint tested here estimates
  the instrumental directly. It removed more of the reference vocal on the
  median excerpt and also reduced the backing more. It was slower on this MLX
  path. Profile native ONNX providers on each OS before choosing it for a
  lower-memory worker. Core ML uses supported graph partitions, so model export
  alone gives no acceleration guarantee.
  [UVR model project](https://github.com/Anjok07/ultimatevocalremovergui),
  [ONNX Runtime Core ML provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html).
- **Runtime**. MLX and the Python wrapper are suitable for the external Mac
  experiment. For a distributed worker, evaluate stems.cpp with its native
  Metal/CPU/GPU backends and verified per-model conversion against the Python
  reference. A native helper also fits TunePerfect's separate Electron and Rust
  components. Keep the cache format independent of the inference engine.
  [Apple MLX](https://github.com/ml-explore/mlx),
  [MLX separator validation](https://github.com/ssmall256/mlx-audio-separator/blob/main/docs/release-validation.md),
  [stems.cpp releases](https://github.com/betweentwomidnights/stems.cpp/releases).
  SCNet and Band-SCNet are additional candidates for a lower-compute or
  streaming worker. They were outside the local test.
  [SCNet](https://arxiv.org/abs/2401.13276),
  [Band-SCNet](https://www.isca-archive.org/interspeech_2025/yang25d_interspeech.pdf).

## Playback proof and storage

For original PCM `M` and estimate `V`, generate backing `B = M − V`. Keep
relative levels when generating the backing. For a direct instrumental
checkpoint, use its time-aligned output as `B`. The player outputs
`g × M + (1 − g) × B` for the requested vocal amount `g`. For a residual-based
backing this is exactly `M − (1 − g) × V`. Use linear complementary gains so
material shared between the pairs holds its level. Apply ReplayGain, game volume
and fades at the shared output.

The demo uses the repository's Electron 44.4.5, its `app://` and `media://` scheme
registration, and the same `fileResponse` byte-range handler as gameplay. One
HTML audio element feeds a Web Audio channel splitter, two stereo gains with
25 ms ramps, and a stereo sum. There is a single decoder and one
`currentTime`. The source was 44.1 kHz and Web Audio ran at 48 kHz.
[Web Audio source, splitter and parameter semantics](https://www.w3.org/TR/webaudio/).

- **Deterministic tones.** Both backing channels measured approximately 0.2000
  at 100%, 50% and 0%. Both vocal test tones measured 0.1000, 0.0500 and less
  than 0.000001. A pause held the clock. A seek to 3.00 s resumed with the
  expected tones in each channel. The measured 10–90% gain transition was
  18.7 ms, consistent with the 25 ms full ramp at 128-sample measurement resolution.
- **Full song.** A worklet compared captured stereo samples with the corresponding
  source channels at 100%, 50% and 0%. The largest sampled error was
  `1.49e−8` full scale. The harness sought twice, played both sections and
  observed 11 byte-range requests for the specialist pack. Neither slider run triggered
  a seek or a waiting event.
- **Fidelity and size.** The recommended checkpoint's 24-bit quad FLAC was
  46.82 MB. Its decoded original pair matched all 7,560,512 source sample frames
  exactly at 100%. The base HTDemucs pack was 61.84 MB and used a shared
  −0.0095 dB gain to fit a peak in its backing. For the specialist pack,
  16-bit FLAC was 31.70 MB and had 82.2 dB SNR against the 24-bit pack.
  Four-channel 224 kb/s Opus was 5.28 MB. Both smaller encodes passed the
  full-song playback check. Opus changes the full-mix signal and needs its own
  listening check. A 24-bit original-plus-residual pack used 39.93 MB in a
  storage test and would need a subtraction stage in the playback graph.

At the specialist's measured size and second-pass speed, 1,000 three-minute
tracks extrapolate to about **49 GB and 3.3 hours of separation**, plus packing
and I/O. A 10 GB cache would fit roughly 200 tracks at that size. Actual size
depends on the recordings. Offer explicit batch preparation and a storage
limit. Start with 24-bit FLAC for the beta and consider 16-bit after a listening
comparison.

## TunePerfect integration

1. **Prepare.** Build a song preparation queue owned by Electron main. Resolve
   the source through the existing granted song directories and prefer a
   verified, sample-aligned authored backing when available. Otherwise run
   one background separator process, with cancel, progress and retry.
   Prioritize queued songs. Estimate disk use before starting a bulk job, and
   let the user raise the storage budget for a complete library. Run bulk work
   on mains power or between sessions.
2. **Cache.** Store generated assets in an app-managed cache separate from
   UltraStar folders. Key by audio content fingerprint, model and version,
   settings and format version. Two charts using the same audio can share an
   asset. Write to a temporary path, verify channel layout, duration, sample
   count and peaks, then publish atomically. Enforce a byte budget, pin files
   used by an active round and support clearing the cache. Preserve source
   sample rate where practical, resample the estimate to the canonical frame
   grid and account for source encoder delay. Prefer an opaque cache ID under
   the existing media protocol and retain range/CORS behavior.
3. **Play.** Pick the ready packed source before `SongPlayer` loads its media.
   Split its channels before the current master gain. Keep its existing
   `SongPlayerRef` and media clock for lyrics, skip/medley, scoring and video
   sync. Keep `START`, `END`, video gap and output-latency offsets in the same
   timeline. On a failed pack, fall back once to the normal source and hide
   the slider for the round. Out-of-sync authored instrumentals can keep the
   existing binary mode.
4. **Control.** Put **Original vocals** in the round's pause menu and retain the
   slider value while playing, with optional host shortcut controls. Keep the
   existing original/instrumental setting useful as a starting value. Use
   gamepad and keyboard navigation through existing actions. Restrict the
   slider to prepared local audio initially. `OnlineSongPlayer` uses a YouTube
   embed. Its decoded audio stays inside the embed.
5. **Release gate.** Test the team's real local songs with vocals, reverb,
   doubles and duets, at 25% and 0%, and listen for missing bass, drums, synths
   and cymbals. Run full rounds with mic scoring, Bluetooth compensation, long
   seek, medley, video offset and queue activity. Verify the quad FLAC path in
   the packaged Electron build on Windows and Linux. Measure thermal behavior
   during a batch and renderer/audio performance during rounds. This harness
   covered macOS playback outside a scored round.

The main touchpoints are
[SongPlayer](../../src/components/song-player.tsx),
[game clock and scoring](../../src/lib/game/game.tsx),
[round screen](../../src/screens/game/index.tsx),
[media protocol](../../electron/protocols/media.ts),
and [native song metadata](../../native/src/ultrastar/song.rs).

## Run the proof

The current workspace has a prepared NightOwl file under
`.tmp/vocal-research/demucs-vocals-ft/nightowl.flac`. From the repository root:

```sh
sh apps/game/research/vocal-level/demo.sh
sh apps/game/research/vocal-level/demo.sh --check
sh apps/game/research/vocal-level/demo.sh --check-song .tmp/vocal-research/demucs-vocals-ft/nightowl.flac
```

The first command opens the player. Press Play and move **Vocal level**. Run a
fresh separation on Apple Silicon with Bun dependencies installed, `uv`, and
FFmpeg:

```sh
mkdir -p .tmp/vocal-research
uv venv --python 3.12 .tmp/vocal-research/venv
uv pip install --python .tmp/vocal-research/venv/bin/python 'mlx-audio-separator[convert]==0.1.20'
curl -fL https://download.pytorch.org/torchaudio/tutorial-assets/hdemucs_mix.wav \
  -o .tmp/vocal-research/nightowl.wav
.tmp/vocal-research/venv/bin/python apps/game/research/vocal-level/benchmark.py \
  --work .tmp/vocal-research --model demucs-vocals-ft --repeats 2 --pack .tmp/vocal-research/nightowl.wav
sh apps/game/research/vocal-level/demo.sh
```

Pass a local audio file to the benchmark and use the resulting FLAC path as the
argument to `demo.sh`. For ground-truth measurements, pass
`--reference-vocals PATH --reference-start SECONDS` or pass official
`.stem.mp4` previews, which carry the vocal on audio stream 4. Model files are
downloaded to the work directory. The vocal specialist keeps its Torch
download cache there. The base Demucs wrapper uses its own MLX cache for
converted weights. The sample comes from the published noncommercial research
dataset.
[MedleyDB terms and attribution](https://medleydb.weebly.com/downloads.html).
