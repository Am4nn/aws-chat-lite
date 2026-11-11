FROM python:3.12.16-slim-trixie AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --user-group --create-home sandbox \
 && mkdir /workspace \
 && chown sandbox:sandbox /workspace

# The base image's ENV includes GPG_KEY, and an image can't unset an inherited variable, so the filesystem is copied
# onto an empty image and only the variables the tools need are set again: code in the sandbox sees no key-like names.
FROM scratch
COPY --from=base / /
ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8
USER 1000:1000
WORKDIR /workspace
