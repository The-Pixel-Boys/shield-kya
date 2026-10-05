FROM node:24-alpine

RUN apk add --no-cache bash

WORKDIR /pipe

COPY run.sh /pipe/run.sh
RUN chmod +x /pipe/run.sh

ENTRYPOINT ["/pipe/run.sh"]
