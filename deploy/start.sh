#!/bin/sh
set -eu
mkdir -p /data
# An explicit endpoint enables Litestream's Tigris-specific signing behavior.
unset AWS_ENDPOINT_URL_S3
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /data/company.sqlite
exec litestream replicate -config /etc/litestream.yml -exec 'bun src/server/index.ts'
