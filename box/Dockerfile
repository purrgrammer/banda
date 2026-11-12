# The native computer boots this stage. Agent software lives on /tools, installed without root.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS packages
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl libatomic1 socat xz-utils \
	&& rm -rf /var/lib/apt/lists/* \
	&& printf 'banda-bridge:x:65532:65532::/nonexistent:/usr/sbin/nologin\n' >> /etc/passwd \
	&& printf 'banda-bridge:x:65532:\n' >> /etc/group \
	&& mkdir -m 1777 /workspace /work /tools \
	&& mkdir -m 0700 /browser && chown 65533:65533 /browser
ENV HOME=/work LANG=C.UTF-8 SHELL=/bin/bash \
	XDG_CACHE_HOME=/tools/cache NPM_CONFIG_PREFIX=/tools PYTHONUSERBASE=/tools \
	PATH=/tools/bin:/work/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /workspace
CMD ["/bin/sleep", "infinity"]

# Browser dependencies are fetched only when the native backend first opens a browser.
FROM packages AS browser-packages
RUN echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261030T000000Z bookworm-security main' \
		> /etc/apt/sources.list.d/chromium.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends chromium=156.0.8078.73-1~deb12u1 \
		chromium-common=156.0.8078.73-1~deb12u1 jq libnss3-tools procps \
		fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
	&& rm -rf /var/lib/apt/lists/*

# Runtime binaries do not invalidate the cached distribution-package installation.
FROM packages AS boot
COPY pi-env /usr/local/bin/pi-env
COPY proxy-bridge.sh /banda/proxy-bridge.sh

FROM browser-packages AS browser
COPY pi-env /usr/local/bin/pi-env
COPY proxy-bridge.sh /banda/proxy-bridge.sh

# Docker mode includes its browser; its agent software follows the same /tools installation path.
FROM browser AS full
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git python3 \
	&& rm -rf /var/lib/apt/lists/* \
	&& git config --system user.name banda \
	&& git config --system user.email banda@box \
	&& git config --system safe.directory '*'
