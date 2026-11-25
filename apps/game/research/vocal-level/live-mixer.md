# Live vocal and microphone mixing

The game finds a prepared mix beside a chart's audio. For `Song.mp3`, the
sidecar is `Song.mp3.tuneperfect-mix.flac`. The preparer writes it atomically.
The chart and original audio can stay as they are. The game ignores a sidecar
older than its source and falls back to the existing audio if decoding fails.

In a round, **Left/Right** selects an active microphone or **Original vocals**.
**Up/Down** changes the selected level in 5% steps. The panel also offers mouse
buttons and recedes after a few seconds. The small mixer button opens it again.
Microphone faders control the monitoring mix beneath the existing microphone
playback master. The game stores microphone levels by slot and original vocal
level in global settings. The vocal fader becomes available when a local
prepared track is ready.

The sidecar stores original L/R and backing L/R in a single four-channel
FLAC, at 24 bits per sample by default. The game ramps complementary stereo gains over 25 ms on the existing
media element. Seeking, scoring, video sync, ReplayGain and fades use the same
clock and master gain. The preparer preserves the source sample rate, restores
the model output to the original frame count and applies shared headroom only
when needed.

## Quality on the M4 Air

I compared the two new candidates with the same 13 MUSDB18 excerpts used in
the initial Viperx evaluation. The models ran at their respective native
sample rates. The backing SDR and vocal attenuation use the method described
in the [original evaluation](README.md).

| Local candidate                      | Median backing SDR | Median vocal attenuation |
| ------------------------------------ | -----------------: | -----------------------: |
| SubRoFormer perceptual FP16, Core ML |           15.74 dB |                 29.14 dB |
| Becruily Mel-Band RoFormer Deux, MLX |           15.74 dB |                 22.18 dB |
| Viperx BS-RoFormer 317, MLX          |           15.37 dB |                 26.98 dB |
| HTDemucs FT vocal specialist, MLX    |           12.70 dB |                 19.15 dB |

SubRoFormer is the quality choice for this set because the backing score tied
Deux at the displayed precision and SubRoFormer left less vocal in the backing.
Comparisons on individual mixes can differ. MVSep's leaderboard reports its
own fine-tuned entries and hosted ensembles. The comparison here uses the
checkpoint released by the SubRoFormer authors and run on this laptop.
[SubRoFormer paper and official runtime](https://github.com/ArchiMickey/SubRoformer),
[checkpoint repository](https://huggingface.co/archimickey/SubRoformer),
[MVSep instrumental leaderboard](https://mvsep.com/quality_checker/multisong_leaderboard?sort=instrum).

## Prepare more songs

Use Python 3.12 with FFmpeg and `uv`. From the repository root:

```sh
mkdir -p .tmp/vocal-research
uv venv --python 3.12 .tmp/vocal-research/venv
uv pip install --python .tmp/vocal-research/venv/bin/python \
  'git+https://github.com/ArchiMickey/SubRoformer.git@bf4e35aff7905c8cd43b8d7365ffd1bcc7d1df02'

export HF_HUB_CACHE="$PWD/.tmp/vocal-research/hub"
songs="$HOME/Library/Mobile Documents/com~apple~CloudDocs/songs"
.tmp/vocal-research/venv/bin/python apps/game/scripts/prepare-vocal-mix.py \
  "$songs/Lukas Graham - 7 Years/Lukas Graham - 7 Years.m4a" \
  "$songs/Vance Joy - Riptide/Vance Joy - Riptide.mp3"
```

Pass `--library "$songs"` in place of the two paths to prepare the chart audio
throughout the library. The command reuses the loaded model across songs and
skips fresh sidecars. It can be stopped and rerun to continue. Use `--bits 16`
for smaller packs. Pass `--force` to replace a fresh sidecar. Local audio is
processed on-device. The first run fetches the model weights. The batch needs
room for a sidecar beside each song, including space in iCloud for this library.

## Prepared songs

| Song    | Backend     | Sample frames | Sidecar size |
| ------- | ----------- | ------------: | -----------: |
| 7 Years | Core ML     |    10,551,296 |      86.3 MB |
| Riptide | PyTorch MPS |     9,794,177 |      81.6 MB |

Both use the official perceptually fine-tuned SubRoFormer checkpoint at FP16
inference precision. The original pair in each sidecar matched the source
PCM after applying its common gain to within `1.2e-7` full scale. **7 Years**
uses 1.5 dB of shared headroom because the decoded peaks exceed full scale.
**Riptide** uses unity gain. The two local separation runs overlapped and took
roughly 31 and 19 minutes respectively.

The library scan found 369 unique chart audio files. At the two finished
sidecars' mean size, the full library extrapolates to about 31 GB at 24 bits.
Actual storage varies with song duration and compressibility.

The Electron playground exercised the production round screen with simulated
singers. A two-player 7 Years round changed the original/backing gains from
`1 / 0` to `0.9 / 0.1` while the same media source advanced without a seek or
waiting event. The keyboard handler selected both microphone slots and saved
their levels. A fresh renderer opened Riptide with 90% vocals and the saved
95% Mic 1 level. The solo round showed one mic. A separate native regression
test fed independent sample streams into the two monitoring channels and
verified that each fader changed its own signal.
