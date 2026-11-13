#!/bin/sh
# Vercel's ignored build step for banda.rocks (vercel.json). Vercel reads exactly two answers: 0 skips the deploy,
# 1 builds it, and any other status fails the deployment. So only an empty diff against the last deployed commit
# skips; anything else, an empty, unknown or unfetched previous commit included (git diff exits 128), answers 1.
# It skips only when nothing the site is built from changed: the page, the app's components and fixtures its
# showcase draws, and what they import. The list lives here, not in vercel.json, which caps the command at 256
# characters.
git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- \
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
	scripts/vercel-ignore.sh && exit 0
exit 1
