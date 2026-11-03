import hashlib
import json
import os
from pathlib import Path
import re
import zipfile

root = Path.home() / 'Downloads' / 'Hiraya-Studio-Conversations-2026-10-05'
summary = json.loads((root / 'EXPORT-SUMMARY.json').read_text(encoding='utf-8'))
messages = 0
complete = 0
ids = set()
index = []
with (root / 'ALL-CONVERSATIONS.json').open(encoding='utf-8') as f:
    first_line = f.readline().rstrip('\n')
    assert first_line.endswith('"conversations":[')
    metadata = json.loads(first_line + ']}')['metadata']
    assert metadata['page'] == summary['page']
    ended = False
    previous_ends_comma = None
    for line in f:
        text = line.rstrip('\n')
        if text == ']}':
            assert not previous_ends_comma
            ended = True
            assert not f.read().strip()
            break
        if ids:
            assert previous_ends_comma
        previous_ends_comma = text.endswith(',')
        if previous_ends_comma:
            text = text[:-1]
        c = json.loads(text)
        assert c['id'] not in ids
        ids.add(c['id'])
        raw = json.loads((root / 'raw' / 'messages' / (c['id'] + '.json')).read_text(encoding='utf-8'))
        assert len(c['messages']) == len(raw['messages']), c['id']
        expected = {m['id']: m for m in raw['messages']}
        assert len(expected) == len(raw['messages']), c['id']
        assert all(expected.get(m['id']) == m for m in c['messages']), c['id']
        assert len({m['id'] for m in c['messages']}) == len(c['messages']), c['id']
        messages += len(c['messages'])
        complete += int(c['complete'])
        index.append({'id': c['id'], 'contactNames': c['contactNames'], 'messageCount': len(c['messages'])})
    assert ended
assert len(ids) == summary['conversationCount']
assert messages == summary['messageCount']
assert complete == summary['completeConversations']
assert summary['messageFetchErrors'] == 0, 'Retry failed message histories before packaging'
assert complete == len(ids)
secret_pattern = re.compile(rb'EAA[A-Za-z0-9]{30,}|"access_token"\s*:|[?&]access_token=(?!REDACTED)[^&\s"<>]+')
files = sorted(p for p in root.rglob('*') if p.is_file())
assert not any(p.name.endswith('.tmp') for p in files)
for p in files:
    if p.suffix in {'.json', '.txt'}:
        with p.open('rb') as f:
            carry = b''
            while chunk := f.read(1024 * 1024):
                data = carry + chunk
                assert not secret_pattern.search(data), f'Credential pattern detected in {p.name}'
                carry = data[-512:]
index.sort(key=lambda c: ' / '.join(c['contactNames']).casefold())
with (root / 'CONVERSATION-INDEX.txt').open('w', encoding='utf-8') as f:
    f.write(f"{summary['page']['name']} — alphabetical conversation index\n\n")
    for c in index:
        f.write(f"{' / '.join(c['contactNames']) or 'Unnamed'} | {c['messageCount']} messages | {c['id']}\n")
del index
def sha256(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()
verification = {'conversations': summary['conversationCount'], 'messages': messages,
                'completeConversations': complete, 'verifiedAgainstRawMessageFiles': True,
                'duplicateConversationIds': 0, 'duplicateMessageIdsWithinConversations': 0,
                'messageFetchErrors': 0, 'contactLookupErrors': summary['contactLookupErrors'],
                'credentialPatternScanPassed': True,
                'sha256': {name: sha256(root / name) for name in ['ALL-CONVERSATIONS.txt', 'ALL-CONVERSATIONS.json']}}
(root / 'VERIFICATION.json').write_text(json.dumps(verification, indent=2), encoding='utf-8')
archive = root.parent / (root.name + '.zip')
temporary = archive.with_suffix('.zip.partial')
with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file():
            z.write(p, arcname=str(Path(root.name) / p.relative_to(root)))
with zipfile.ZipFile(temporary) as z:
    assert z.testzip() is None, 'ZIP integrity check failed'
    archive_files = len(z.infolist())
os.replace(temporary, archive)
(root.parent / (root.name + '-SHA256.txt')).write_text(sha256(archive) + '  ' + archive.name + '\n', encoding='utf-8')
print(json.dumps({'archive': str(archive), 'archiveBytes': archive.stat().st_size,
                  'archiveFiles': archive_files, **verification}, indent=2))
