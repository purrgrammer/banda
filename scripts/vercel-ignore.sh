#!/bin/sh
# Vercel's ignored build step for banda.rocks (vercel.json): exit 0 skips the deploy, any other status builds it.
# It skips only when nothing the site is built from changed since the last deployed commit: the page, the app's
# components and fixtures its showcase draws, and what they import. A missing or unknown previous commit makes
# git diff fail, and the site builds. The list lives here, not in vercel.json, which caps the command at 256 characters.
exec git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- \
	site \
	docs/screenshots \
	web/public/icon.svg \
	web/public/providers \
	web/public/connections \
	web/public/harnesses \
	web/src \
	src/core \
	shipped \
	package.json \
	package-lock.json \
	vercel.json \
	scripts/vercel-ignore.sh
