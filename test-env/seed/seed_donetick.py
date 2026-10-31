"""Seed the test Donetick: user alice, an access token and one chore.

    python seed/seed_donetick.py

Idempotent: sign-up is skipped when alice can log in, the access token in
.secrets/donetick.json is reused while it works, and the chore is looked up
by name.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import http, read_secret, wait_for, write_secret  # noqa: E402

BASE = os.environ.get('DONETICK_URL', 'http://localhost:18021')
API = BASE + '/api/v1'
EAPI = BASE + '/eapi/v1'
USER = 'alice'
EMAIL = 'alice@example.org'
PASSWORD = os.environ.get('DONETICK_ALICE_PASSWORD', 'alice-pass-123')
CHORE = 'Water the office plants'


def login():
    r = http('POST', f'{API}/auth/login', body={'username': USER, 'password': PASSWORD})
    return r.json().get('access_token') if r.status == 200 else None


def main():
    wait_for('Donetick', lambda: http('GET', f'{API}/health').status == 200)

    jwt = login()
    if not jwt:
        r = http('POST', f'{API}/auth/', body={'username': USER, 'email': EMAIL, 'password': PASSWORD, 'displayName': 'Alice'})
        if r.status not in (200, 201):
            sys.exit(f'donetick sign-up: {r.status} {r.text}')
        print('donetick: signed up alice')
        jwt = login()
        if not jwt:
            sys.exit('donetick: cannot log in after signing up')

    secret = read_secret('donetick') or {}
    token = secret.get('token')
    if not token or http('GET', f'{EAPI}/chore', headers={'secretkey': token}).status != 200:
        r = http('POST', f'{API}/users/tokens', headers={'Authorization': f'Bearer {jwt}'}, body={'name': 'bulwark-plugin-tests'})
        if r.status not in (200, 201):
            sys.exit(f'donetick token: {r.status} {r.text}')
        token = r.json()['res']['token']
        print('donetick: created access token')

    chores = http('GET', f'{EAPI}/chore', headers={'secretkey': token})
    if chores.status != 200:
        sys.exit(f'donetick list chores: {chores.status} {chores.text}')
    if not any(c.get('name') == CHORE for c in chores.json() or []):
        r = http('POST', f'{EAPI}/chore', headers={'secretkey': token},
                 body={'name': CHORE, 'description': 'Seeded chore', 'dueDate': '2026-10-22T15:00:00Z'})
        if r.status not in (200, 201):
            sys.exit(f'donetick chore: {r.status} {r.text}')
        print('donetick: created chore', CHORE)

    path = write_secret('donetick', {
        'url': BASE,
        'eapi': EAPI,
        'user': USER,
        'email': EMAIL,
        'password': PASSWORD,
        'token': token,
    })
    print(f'donetick: ok, token {token} (saved to {path})')


if __name__ == '__main__':
    main()
