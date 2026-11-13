#!/usr/bin/env python3
"""Run one task's supervisor and its two authenticated transports in sandbox A.

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


def tunnel(name, spec, port, destination):
    # No E2B management credential is installed in this VM.
    return start(name, [BIN + '/wstunnel', 'client', '-L',
        f'tcp://127.0.0.1:{port}:127.0.0.1:{destination}',
        '--http-upgrade-path-prefix', spec['path'],
        '-H', 'e2b-traffic-access-token: ' + spec['token'],
        '--websocket-ping-frequency', '10s', '--tls-verify-certificate',
        'wss://' + spec['host']], {'PATH': '/usr/bin:/bin', 'NO_COLOR': 'true'})


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    (STATE / 'launcher.pid').write_text(str(os.getpid()))
    config = json.loads((STATE / 'config.json').read_text())
    tunnel('worker-tunnel', config['worker'], 17000, 7000)
    tunnel('gateway-tunnel', config['gateway'], 17670, 17670)
    # A listener must exist before OpenShell tries to connect. The gateway
    # itself decides Ready only after the supervisor authenticates/admission.
    for port in (17000, 17670):
        for _ in range(100):
            if any(p.poll() is not None for _, p in children):
                raise RuntimeError('transport exited during startup')
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.2):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('transport did not start')
    start('supervisor', [BIN + '/openshell-supervisor',
        '--backend-descriptor-file', str(STATE / 'runtime-descriptor.json'),
        '--auth-bundle-file', str(STATE / 'auth.json'), '--workdir', '/sandbox'],
        config['environment'])
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
