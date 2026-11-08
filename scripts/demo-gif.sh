#!/usr/bin/env bash
# Turns the frames that tests/e2e/readme-demo.spec.ts records into docs/media/demo.gif: the visitor
# on the left, the operator on the right, at the speed they were recorded. Needs ffmpeg.
#   scripts/demo-gif.sh <directory given to RECORD_DEMO>
set -euo pipefail

frames="${1:?Usage: scripts/demo-gif.sh <directory>}/frames"
out="docs/media/demo.gif"
# The GIF's width. The frames are 2x, so this keeps the text sharp after the scale.
width=1280
palette="$(mktemp --suffix=.png)"
trap 'rm -f "$palette"' EXIT

# One stream per page from its concat list, side by side, scaled once with a sharp filter.
inputs=(-f concat -safe 0 -i "$frames/visitor.txt" -f concat -safe 0 -i "$frames/operator.txt")
join="[0:v]scale=-2:1400:flags=lanczos[v];[1:v]scale=-2:1400:flags=lanczos[o];[v][o]hstack=inputs=2,fps=15,scale=$width:-2:flags=lanczos"

# A palette made from these frames, then the GIF with light dithering, which keeps flat UI colors
# clean and text edges free of noise.
ffmpeg -v error -y "${inputs[@]}" -filter_complex "$join,palettegen=stats_mode=diff:max_colors=256" "$palette"
ffmpeg -v error -y "${inputs[@]}" -i "$palette" -filter_complex \
  "$join[x];[x][2:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$out"
ls -l "$out"
