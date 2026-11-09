# The container box's image (DESIGN.md "The box"). The daemon builds it with pi-env's Linux daemon beside this file and
# tags it by the hash of both, so a change to either builds a new image and the box is made again on it. pi-env sits in
# the read-only root, where nothing in the box can replace the binary; it runs as the agent's uid, so a command can still
# trace it, and the daemon takes all it says as box-written data.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl git jq less libatomic1 nodejs npm procps python3 \
		ripgrep socat unzip xz-utils \
	&& rm -rf /var/lib/apt/lists/*
# Chromium for the browser (DESIGN.md "The box", The browser), pinned to one build from Debian's snapshot archive, which
# keeps every version, so the pin keeps building; certutil puts the egress proxy's authority in its trust store (NSS),
# and the fonts draw pages. It runs headless, started by the daemon over `docker exec` with DevTools on a pipe: no port.
RUN echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261030T000000Z bookworm-security main' \
		> /etc/apt/sources.list.d/chromium.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends chromium=156.0.8078.73-1~deb12u1 \
		chromium-common=156.0.8078.73-1~deb12u1 libnss3-tools fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
	&& rm -rf /var/lib/apt/lists/*
# mise, pinned and checked, installs toolchains on the /tools volume, so they outlive the box and are shared by every
# conversation; its shims come first on PATH.
RUN arch=$(dpkg --print-architecture) \
	&& case "$arch" in \
		arm64) asset=linux-arm64; sum=c7108d85a32ba17e4747d31d4a42f39f0c134f16211e204e8ef0a49d4f518fe1 ;; \
		amd64) asset=linux-x64; sum=6eb1b890e90818417ca34c90dbbd47881917d5cd199f31b63b062ea9c6b18d85 ;; \
		*) echo "no mise for $arch" >&2; exit 1 ;; \
	esac \
	&& curl -fsSL -o /usr/local/bin/mise "https://github.com/jdx/mise/releases/download/v2026.10.7/mise-v2026.10.7-$asset" \
	&& echo "$sum  /usr/local/bin/mise" | sha256sum -c - \
	&& chmod 755 /usr/local/bin/mise
# The volumes start from these directories, so whatever uid the box runs as can write them; the browser's is its own
# uid's alone, so nothing the agent runs reads its sessions, its cache or the pages it drew.
RUN git config --system user.name banda \
	&& git config --system user.email banda@box \
	&& git config --system safe.directory '*' \
	&& mkdir -m 1777 /workspace /work /tools \
	&& mkdir -m 0700 /browser && chown 65533:65533 /browser
COPY pi-env /usr/local/bin/pi-env
ENV HOME=/work LANG=C.UTF-8 SHELL=/bin/bash MISE_DATA_DIR=/tools/mise MISE_CACHE_DIR=/tools/cache \
	MISE_YES=1 PATH=/tools/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /workspace
CMD ["sleep", "infinity"]
