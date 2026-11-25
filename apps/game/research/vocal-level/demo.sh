#!/bin/sh
set -eu
research_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$research_dir/../../../.."
workspace_dir="$PWD/.tmp/vocal-research"
mkdir -p "$workspace_dir"
mode=
case "${1:-}" in
  --check)
    mode=--check
    audio="$workspace_dir/tones.flac"
    ffmpeg -hide_banner -loglevel error -y -f lavfi \
      -i 'aevalsrc=if(lt(t\,2)\,0.2*sin(2*PI*200*t)+0.1*sin(2*PI*500*t)\,0.2*sin(2*PI*900*t))|if(lt(t\,2)\,0.2*sin(2*PI*300*t)+0.1*sin(2*PI*700*t)\,0.2*sin(2*PI*1100*t))|if(lt(t\,2)\,0.2*sin(2*PI*200*t)\,0.2*sin(2*PI*900*t))|if(lt(t\,2)\,0.2*sin(2*PI*300*t)\,0.2*sin(2*PI*1100*t)):s=44100:d=5:c=quad' \
      -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 "$audio"
    ;;
  --check-song)
    mode=--check-song
    audio="${2:?Pass a four-channel FLAC from benchmark.py}"
    ;;
  *) audio="${1:-$workspace_dir/demucs-vocals-ft/nightowl.flac}" ;;
esac
if [ ! -f "$audio" ]; then
  echo "Audio file not found: $audio" >&2
  exit 1
fi
bun build "$research_dir/main.mjs" --target node --format cjs --external electron --outfile "$workspace_dir/demo.cjs"
unset ELECTRON_RUN_AS_NODE
exec node node_modules/electron/cli.js "$workspace_dir/demo.cjs" "$research_dir" "$audio" "$mode"
