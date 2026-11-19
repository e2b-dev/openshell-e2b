#!/usr/bin/env python3
"""Run one task's supervisor and its two authenticated tunnels in supervisor VM A.

Only an allowlisted environment reaches subprocesses. If any child exits,
terminate all of them; OpenShell's worker channel then fails closed.
"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

STATE = Path('/run/openshell-task')
BIN = '/opt/openshell'
children = []


def stop(*_):
    raise SystemExit(1)


def start(name, args, env):
    with (STATE / (name + '.log')).open('ab') as log:
        child = subprocess.Popen(args, env=env, stdout=log, stderr=log)
    children.append((name, child))
    (STATE / (name + '.pid')).write_text(str(child.pid))
    return child


def wstunnel(name, spec, forward):
    # One authenticated WebSocket tunnel through E2B's port proxy. No E2B
    # management credential is installed in this VM.
    return start(name, [BIN + '/wstunnel', 'client', *forward,
        '--http-upgrade-path-prefix', spec['path'],
        '-H', 'e2b-traffic-access-token: ' + spec['token'],
        '--websocket-ping-frequency', '10s', '--tls-verify-certificate',
        'wss://' + spec['host']], {'PATH': '/usr/bin:/bin', 'NO_COLOR': 'true'})


def wait_listening(port, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if any(p.poll() is not None for _, p in children):
            raise RuntimeError('a process exited during startup')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                return
        except OSError:
            time.sleep(.2)
    raise RuntimeError(f'nothing listening on 127.0.0.1:{port}')


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    (STATE / 'launcher.pid').write_text(str(os.getpid()))
    config = json.loads((STATE / 'config.json').read_text())
    worker = config['worker']
    listen_host, listen_port = worker['listen'].rsplit(':', 1)

    # 1. Gateway: a local port here that reaches the gateway in the control VM.
    wstunnel('gateway-tunnel', config['gateway'],
        ['-L', 'tcp://127.0.0.1:17670:127.0.0.1:17670'])
    wait_listening(17670)

    # 2. The supervisor. It connects to the gateway and listens on
    #    listen_port for the worker's runtime (runtime-initiated transport).
    start('supervisor', [BIN + '/openshell-supervisor',
        '--backend-descriptor-file', str(STATE / 'runtime-descriptor.json'),
        '--auth-bundle-file', str(STATE / 'auth.json'), '--workdir', '/sandbox'],
        config['environment'])
    wait_listening(int(listen_port))

    # 3. Worker: a reverse tunnel. The wstunnel server in the worker VM
    #    listens on the runtime's control socket and carries each connection
    #    back here to the supervisor. This VM opens the connection, so the
    #    worker VM needs no outbound network.
    wstunnel('worker-tunnel', worker,
        ['-R', f"unix://{worker['socket']}:{listen_host}:{listen_port}"])

    time.sleep(2)
    while True:
        for name, child in children:
            if child.poll() is not None:
                raise RuntimeError(f'{name} exited ({child.returncode})')
        (STATE / 'ready').touch()
        time.sleep(.5)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        (STATE / 'failed').write_text(str(error))
        raise
    finally:
        (STATE / 'ready').unlink(missing_ok=True)
        for _, child in children:
            if child.poll() is None:
                child.terminate()
        for _, child in children:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
