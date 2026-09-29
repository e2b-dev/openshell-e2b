#!/bin/sh
# launch-sandbox.sh: start openshell-sandbox inside the "outer fence".
#
# Runs as root inside the agent's E2B sandbox. Called by the driver after it
# has written /.openshell/channel/sandbox/{bootstrap.json,server.crt,server.key}.
#
#   E2B sandbox (root namespace, has internet)
#   └── network namespace "os"          ← only a loopback interface: no route out
#       └── PID namespace               ← openshell-sandbox is PID 1, sees nothing else
#           └── openshell-sandbox       ← uid/gid 1500, zero capabilities, no_new_privs
#               └── the agent           ← all its network traffic goes to the supervisor
#
# This mirrors what Docker gives NVIDIA's Docker driver (--network none,
# --cap-drop ALL, no-new-privileges), built by hand because E2B is a VM, not Docker.
set -eu

NETNS=os
UID_GID=1500
BOOTSTRAP=/.openshell/channel/sandbox/bootstrap.json

# 1. A network namespace with nothing in it but loopback.
ip netns add "$NETNS" 2>/dev/null || true
ip -n "$NETNS" link set lo up

# 2. Refuse to continue if anything other than loopback is in there.
#    (The driver reports this fact to OpenShell as its "outer fence" evidence.)
ifaces=$(ip -n "$NETNS" -o link show | awk -F': ' '{print $2}' | tr '\n' ' ')
[ "$ifaces" = "lo " ] || { echo "fence check failed: interfaces='$ifaces'" >&2; exit 1; }

# 3. OpenShell's DNS relay binds port 53 as an unprivileged user. This setting
#    is per network namespace, so it only affects the fenced namespace.
ip netns exec "$NETNS" sh -c 'echo 0 > /proc/sys/net/ipv4/ip_unprivileged_port_start'

# 4. DNS: point the agent at OpenShell's policy DNS relay (127.0.0.53), as
#    NVIDIA's Docker/Podman/Kubernetes drivers do. `ip netns exec os` overlays
#    files from /etc/netns/os/ onto /etc/ for processes in the namespace only,
#    so the rest of the box keeps its normal resolver.
mkdir -p /etc/netns/"$NETNS"
echo "nameserver 127.0.0.53" > /etc/netns/"$NETNS"/resolv.conf

# 5. A memory-backed folder where the runtime publishes the supervisor's HTTPS
#    interception CA for the agent. Docker/Podman mount a tmpfs here; we do the
#    same. The capability-free runtime can't create it itself, so root prepares
#    it and hands it to uid 1500.
mkdir -p /run/openshell-supervisor-ca
mountpoint -q /run/openshell-supervisor-ca || mount -t tmpfs -o size=4m,mode=0755 tmpfs /run/openshell-supervisor-ca
chown "$UID_GID:$UID_GID" /run/openshell-supervisor-ca

# 6. Enter the namespace, start a fresh PID namespace, drop to 1500 with no
#    capabilities at all, and exec the OpenShell runtime.
exec ip netns exec "$NETNS" \
  unshare --pid --fork --mount-proc \
  setpriv --reuid="$UID_GID" --regid="$UID_GID" --clear-groups \
          --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs \
  /opt/openshell/openshell-sandbox --bootstrap "$BOOTSTRAP"
