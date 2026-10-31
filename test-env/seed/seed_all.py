"""Run every seed script in order and print a summary.

    python seed/seed_all.py [--with-ai]

Called by up.ps1 / up.sh after the containers are healthy. Every seed script
is idempotent, so this can be run again at any time.
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import HERE, SECRETS, read_secret  # noqa: E402

SEEDS = ['seed_mail.py', 'seed_caldav.py', 'seed_nextcloud.py', 'seed_paperless.py', 'seed_vikunja.py', 'seed_donetick.py']


def summary(with_ai):
    nc = read_secret('nextcloud') or {}
    pl = read_secret('paperless') or {}
    vk = read_secret('vikunja') or {}
    cd = read_secret('caldav') or {}
    dt = read_secret('donetick') or {}
    ol = read_secret('ollama') or {}
    rows = [
        ('Stalwart (JMAP, CalDAV)', 'http://localhost:18025',
         'alice|bob|carol@example.org / test-pass-123, SMTP submission localhost:11587'),
        ('  CalDAV task list', cd.get('taskList', '-'), 'alice@example.org / test-pass-123'),
        ('Nextcloud', nc.get('url', 'http://localhost:18080'),
         f'admin / {nc.get("admin", {}).get("password", "?")}, alice / {nc.get("password", "?")}, '
         f'app password {nc.get("appPassword", "?")}'),
        ('  Share link', nc.get('shareLink', '-'), nc.get('sharedFile', '')),
        ('Paperless-ngx', pl.get('url', 'http://localhost:18010'),
         f'admin / {pl.get("admin", {}).get("password", "?")}, token {pl.get("token", "?")}'),
        ('Vikunja', vk.get('url', 'http://localhost:18456'),
         f'alice / {vk.get("password", "?")}, token {vk.get("token", "?")}, project {vk.get("projectId", "?")}'),
        ('Donetick', dt.get('url', 'http://localhost:18021'),
         f'alice / {dt.get("password", "?")}, access token {dt.get("token", "?")}'),
        ('Mocks (AI, Todoist, tracking)', 'http://localhost:18099', 'keys in test-env/mocks/README.md'),
    ]
    if with_ai:
        rows.append(('Ollama', ol.get('openaiBaseUrl', 'http://localhost:11434/v1'),
                     f'model {ol.get("model", "?")}, any API key'))
    print('\nBulwark plugin test environment is up\n')
    width = max(len(r[0]) for r in rows)
    for name, url, creds in rows:
        print(f'  {name.ljust(width)}  {url}')
        if creds:
            print(f'  {"".ljust(width)}  {creds}')
    print(f'\nSecrets: {SECRETS}')
    print('Webmail proxy: PLUGIN_PROXY_PRIVATE_ORIGINS='
          'http://localhost:18025,http://localhost:18080,http://localhost:18010,http://localhost:18456,http://localhost:18021,http://localhost:18099'
          + (',http://localhost:11434' if with_ai else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--with-ai', action='store_true')
    args = ap.parse_args()
    seeds = SEEDS + (['seed_ollama.py'] if args.with_ai else [])
    for name in seeds:
        print(f'== {name}', flush=True)
        res = subprocess.run([sys.executable, str(HERE / name)])
        if res.returncode != 0:
            sys.exit(f'{name} failed with exit code {res.returncode}')
    summary(args.with_ai)


if __name__ == '__main__':
    main()
