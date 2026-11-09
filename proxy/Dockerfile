# The egress proxy's image (DESIGN.md "The box", Network): mitmproxy, pinned by digest, with banda's policy addon. The
# daemon builds it from this folder and tags it by the hash of its files, like the box's image.
FROM mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f
COPY policy.py state.py addon.py ctl.py start.py /banda/
# the volumes and the tmpfs start from these, so whatever uid the proxy runs as can write them
RUN mkdir -m 1777 /ca /trust /state /kept
ENV PYTHONPATH=/banda PYTHONDONTWRITEBYTECODE=1 HOME=/state
WORKDIR /banda
ENTRYPOINT ["python3", "/banda/start.py"]
