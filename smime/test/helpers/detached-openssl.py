"""Focused offline oracle; stdin contains synthetic test data, stdout booleans only."""
import base64
import email
import email.policy
import json
import os
import re
import subprocess
import sys


def extract(raw):
    message = email.message_from_bytes(raw, policy=email.policy.default)
    boundary = message.get_boundary().encode('ascii')
    markers = list(re.finditer(
        rb'(?m)^--' + re.escape(boundary) + rb'(--)?[ \t]*\r\n', raw,
    ))
    # Exclude exactly the CRLF belonging to the following outer delimiter.
    gap = raw[markers[0].end():markers[1].start()]
    entity = gap[:-2]
    signature = message.get_payload()[1].get_payload(decode=True)
    return message, entity, signature, gap


def smime(raw):
    return subprocess.run(
        ['openssl', 'smime', '-verify', '-binary', '-noverify'], input=raw,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    ).returncode == 0


def cms(signature, entity):
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, entity)
        os.close(write_fd)
        write_fd = None
        return subprocess.run(
            ['openssl', 'cms', '-verify', '-binary', '-noverify', '-inform', 'DER',
             '-content', '/dev/fd/' + str(read_fd)],
            input=signature, pass_fds=(read_fd,), stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, check=False,
        ).returncode == 0
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)


raw = base64.b64decode(json.load(sys.stdin)['message'])
message, entity, signature, gap = extract(raw)
serialized = message.as_bytes(policy=email.policy.SMTP)
_, next_entity, next_signature, _ = extract(serialized)
print(json.dumps({
    'smime': smime(raw),
    'cms': cms(signature, entity),
    'parsedWithoutDefects': not any(part.defects for part in message.walk()),
    # One signed CRLF plus one framing CRLF; no unintended third pair.
    'framing': gap.endswith(b'\r\n\r\n') and not gap.endswith(b'\r\n\r\n\r\n'),
    'entityRoundTrip': next_entity == entity,
    'signatureRoundTrip': next_signature == signature,
    'roundTripSmime': smime(serialized),
    'roundTripCms': cms(next_signature, next_entity),
    'rejectMissingSignedCrlf': not cms(signature, entity[:-2]),
    'rejectExtraSignedCrlf': not cms(signature, entity + b'\r\n'),
}))
