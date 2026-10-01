#!/usr/bin/env python3
"""Build src/demo/fixtures.json from API responses recorded with RECORD_FIXTURES (JSONL).

Usage: python3 scripts/build-demo-fixtures.py <recorded.jsonl> <YYYY-MM-DD recording date>
Keeps the FIRST response per (method, url) so list screens show the pristine seed data, and the
owner's session for sign-in. Signed blob URLs are dropped (they expire and need the real API).
"""
import json
import re
import sys

src, recorded_date = sys.argv[1], sys.argv[2]
responses = {}
owner_login = None
for line in open(src, encoding='utf-8'):
    r = json.loads(line)
    key = f"{r['method']} {r['url']}"
    body = json.loads(r['body']) if r['body'] else None
    if r['method'] == 'POST' and r['url'] == '/v1/auth/login':
        if owner_login is None and body and body.get('status') == 'authenticated':
            owner_login = body
        continue
    if r['method'] == 'POST' and r['url'] == '/v1/auth/refresh':
        continue
    if key in responses:
        continue
    if r['url'] == '/v1/me' and body and body.get('staff', {}).get('role_key') != 'owner':
        continue
    responses[key] = body

if owner_login:
    responses['POST /v1/auth/login'] = owner_login

text = json.dumps({'recordedDate': recorded_date, 'responses': responses}, ensure_ascii=False, separators=(',', ':'))
# expiring signed URLs to the dev API host are useless in the static demo
text = re.sub(r'http://localhost:\d+/v1/files/blob/[^"]+', '', text)
open('src/demo/fixtures.json', 'w', encoding='utf-8').write(text)
print(f'{len(responses)} responses, {len(text) // 1024} KB')
