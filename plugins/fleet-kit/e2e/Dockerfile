# Throwaway bb for end-to-end checks of Fleet Kit. Nothing here touches the
# operator's own bb: the container has its own home, data dir, and ports.
FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

ARG BB_VERSION=0.48.1
# OpenCode 2 by default; --build-arg OPENCODE_PACKAGE=opencode-ai@1.19.5 checks
# the "Update OpenCode to 2.x" path.
ARG OPENCODE_PACKAGE=@opencode/cli@2.2.5
RUN userdel -r node && useradd -m -u 1601 -s /bin/bash tester
USER tester
WORKDIR /home/tester
RUN mkdir -p opt/bb opt/opencode \
 && cd opt/bb && npm install --no-fund --no-audit "bb-app@${BB_VERSION}" \
 && cd ../opencode && npm install --no-fund --no-audit "${OPENCODE_PACKAGE}"
ENV PATH=/home/tester/opt/bb/node_modules/.bin:/home/tester/opt/opencode/node_modules/.bin:$PATH

COPY --chown=tester:tester start.sh /home/tester/start.sh
CMD ["/bin/bash", "/home/tester/start.sh"]
