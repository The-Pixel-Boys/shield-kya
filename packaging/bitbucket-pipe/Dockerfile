FROM node:24-alpine

RUN apk add --no-cache bash

# Pipelines mounts the repository at /opt/atlassian/pipelines/agent/build.
# Run as root so the pipe can write KYA reports back to the workspace.
USER root

WORKDIR /pipe

COPY run.sh /pipe/run.sh
RUN chmod +x /pipe/run.sh

ENTRYPOINT ["/pipe/run.sh"]
