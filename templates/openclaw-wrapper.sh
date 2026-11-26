#!/bin/sh
# openclaw, as installed in the openshell-workload-openclaw template.
#
# - OPENCLAW_CONFIG_PATH: the system config in /etc/openclaw. It lets OpenClaw's
#   web tools accept OpenShell's synthetic DNS answers (198.18.0.0/15, RFC 2544):
#   OpenShell resolves every host to that range so all traffic goes through its
#   policy proxy, and OpenClaw's SSRF guard blocks the range unless told it is a
#   trusted fake-IP proxy. All other private ranges stay blocked.
# - SQLITE_TMPDIR: SQLite tries /var/tmp first, which OpenShell's default
#   filesystem policy does not allow; use /tmp.
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/etc/openclaw/openclaw.json}"
export SQLITE_TMPDIR="${SQLITE_TMPDIR:-/tmp}"
exec /usr/lib/openclaw/bin/openclaw "$@"
