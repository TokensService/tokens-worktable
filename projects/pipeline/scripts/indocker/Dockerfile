FROM docker:27.5.1-dind

RUN apk add --no-cache bash curl git python3
COPY entrypoint.sh /usr/local/bin/vllm-indocker-entrypoint
RUN chmod 0755 /usr/local/bin/vllm-indocker-entrypoint
ENTRYPOINT ["/usr/local/bin/vllm-indocker-entrypoint"]
