#!/bin/sh
# Render every diagram in this folder to svg/ with the pinned PlantUML image, after regenerating and checking the
# state diagrams from ../model/transitions.json. Needs Docker and python3. Exits non-zero on any syntax error.
set -eu
cd "$(dirname "$0")"
IMAGE="plantuml/plantuml:1.2026.10@sha256:2cf2f097652701319e29b9e6a809e68d4ddb06fbeeb696705c097da8fa6d0507"
python3 -I gen_states.py
python3 -I gen_states.py --check
NAME="banda-uml-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
mkdir -p svg
set --
for f in *.puml; do set -- "$@" "/data/$f"; done
# -checkonly first: it reports every file with a syntax error and its line, without writing anything.
docker run --rm --name "$NAME-check" -v "$PWD":/data:ro "$IMAGE" \
  -checkonly "$@"
docker run --rm --name "$NAME" -e PLANTUML_LIMIT_SIZE=16384 -v "$PWD":/data "$IMAGE" \
  -tsvg -o /data/svg "$@"
ls svg
