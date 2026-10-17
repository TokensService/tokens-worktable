FROM docker:27.5.1-dind

ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine

RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories \
    && apk add --no-cache bash curl git python3 \
    && rm -rf /var/cache/apk/*
COPY entrypoint.sh /usr/local/bin/vllm-indocker-entrypoint
RUN chmod 0755 /usr/local/bin/vllm-indocker-entrypoint
ENTRYPOINT ["/usr/local/bin/vllm-indocker-entrypoint"]
