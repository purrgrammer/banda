import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tarfile

SOURCE_COMMIT = '5bbeff2c8400ecb951b1b9b97bcb72250ce475fb'
DELIVERY_SHA256 = '1e90258494c11ef69f3094e0a494385fb9b5156a367adf3981cdfb64d3245bc5'
SOURCE_VERIFIER_SHA256 = '3b356ab89508297c82f0e87e4d9e60e774c74c53f6476f05f7a4db6b61503ced'
NOTICE_VERIFIER_SHA256 = '992f7665a947efb0089202fd969245400749c1b3cf44f77b29bb2557feae60d4'
NOTICE_BINDINGS = {
    'catalog.json': 'catalogSha256',
    'artifact-binding.json': 'artifactBindingSha256',
    'notice-payload.json': 'noticePayloadSha256',
    'SHA256SUMS': 'noticeEvidenceSha256sumsSha256',
}
NOTICE_TOTALS = {
    'verifiedSourceFiles': 920,
    'verifiedTextBlobs': 748,
    'verifiedArchiveMembers': 1697,
    'verifiedRawOrigins': 23,
}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def check_file(path, expected):
    assert path.is_file() and not path.is_symlink(), 'Expected regular file'
    assert path.stat().st_size == expected['bytes'], 'Asset size differs'
    assert digest(path) == expected['sha256'], 'Asset hash differs'


def extract_regular(archive, target, max_members, max_bytes):
    seen = set()
    total = 0
    with tarfile.open(archive, mode='r:gz') as stream:
        for member in stream:
            path = pathlib.PurePosixPath(member.name)
            assert member.name == path.as_posix(), 'Noncanonical archive path'
            assert not path.is_absolute() and all(p not in ('', '.', '..') for p in path.parts), 'Unsafe archive path'
            assert member.isfile() and member.name not in seen, 'Unexpected archive member'
            seen.add(member.name)
            total += member.size
            assert len(seen) <= max_members and total <= max_bytes, 'Archive exceeds accepted bounds'
            destination = target.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with stream.extractfile(member) as source, destination.open('xb') as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    assert chunk, 'Truncated archive member'
                    output.write(chunk)
                    remaining -= len(chunk)
    return seen


def verify_notice_binding(packet, delivery):
    for name, field in NOTICE_BINDINGS.items():
        assert digest(packet / name) == delivery[field], 'Recovered notice evidence differs from delivery'
    binding = json.loads((packet / 'artifact-binding.json').read_text())
    assert binding['candidateCommit'] == delivery['sourceCommit'], 'Notice candidate differs'
    assert binding['runtimeManifest']['sha256'] == delivery['runtimeManifestSha256'], 'Notice runtime differs'


def consume(download, out):
    scripts = pathlib.Path(__file__).resolve().parent
    assert download.is_absolute() and download.resolve() == download and download.parent == scripts
    assert out.is_absolute() and out.resolve() == out and out.parent == scripts and not out.exists()
    public = json.loads((download / 'result.json').read_text())
    assert public['passed'] and public['evidence'] == 'public-get' and public['unauthenticatedPublicGet']
    assert public['scope'] == 'full' and public['sourceCommit'] == SOURCE_COMMIT
    assert len(public['records']) == 15 and all(record['passed'] for record in public['records'])
    assets = download / 'assets'
    assert assets.is_dir() and not assets.is_symlink()
    assert digest(assets / 'computer-distribution.json') == DELIVERY_SHA256, 'Unaccepted delivery index'
    delivery = json.loads((assets / 'computer-distribution.json').read_text())
    assert delivery['sourceCommit'] == SOURCE_COMMIT
    out.mkdir(mode=0o700)
    (out / 'assets').mkdir()
    selected = {'source-shard': [], 'source-controls': [], 'notice-evidence': []}
    for record in delivery['assets']:
        if record['kind'] not in selected:
            continue
        name = record['file']
        assert pathlib.Path(name).name == name, 'Unsafe asset basename'
        source = assets / name
        check_file(source, record)
        assert source.stat().st_uid == os.getuid() and source.stat().st_mode & 0o222 == 0, 'Asset is not owned and read-only'
        target = out / ('assets' if record['kind'] == 'source-shard' else '') / name
        os.link(source, target)
        assert source.stat().st_ino == target.stat().st_ino and source.stat().st_dev == target.stat().st_dev
        selected[record['kind']].append(name)
    assert len(selected['source-shard']) == 6
    assert len(selected['source-controls']) == len(selected['notice-evidence']) == 1
    controls = extract_regular(out / selected['source-controls'][0], out, 7, 1024 * 1024)
    assert controls == {'INDEX.json', 'SHA256SUMS', 'README.md', 'selection.json', 'inputs.json', 'pack.mjs', 'verify.mjs'}
    assert digest(out / 'INDEX.json') == delivery['sourceIndexSha256'], 'Recovered source index differs from delivery'
    assert digest(out / 'verify.mjs') == SOURCE_VERIFIER_SHA256, 'Unaccepted source verifier'
    environment = {'PATH': os.environ['PATH']}
    with (out / 'source.log').open('x') as log:
        subprocess.run(['node', 'verify.mjs', '--extract', 'extracted'], cwd=out, env=environment,
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
    (out / 'extracted/materials').rename(out / 'sources')
    packet = out / 'distribution-packet'
    packet.mkdir()
    extract_regular(out / selected['notice-evidence'][0], packet, 789, 12 * 1024 * 1024)
    verify_notice_binding(packet, delivery)
    assert digest(packet / 'check-origins.py') == NOTICE_VERIFIER_SHA256, 'Unaccepted notice verifier'
    with (out / 'notices.log').open('x') as log:
        subprocess.run(['python3', 'distribution-packet/check-origins.py'], cwd=out, env=environment,
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
    source = json.loads((out / 'source.log').read_text())
    notices = json.loads((out / 'notices.log').read_text())
    assert source['candidate'] == SOURCE_COMMIT and source['recoveredAndRehashedInputs'] == 1144
    assert source['allSelectedInputsCovered'] and source['selectedInputs'] == 1144
    assert notices == NOTICE_TOTALS, 'Notice origin coverage differs'
    result = {
        'passed': True,
        'sourceCommit': SOURCE_COMMIT,
        'recoveredAndRehashedInputs': source['recoveredAndRehashedInputs'],
        'notices': notices,
        'sourceIndexSha256': delivery['sourceIndexSha256'],
        'runtimeManifestSha256': delivery['runtimeManifestSha256'],
        'verifiedNoticeBindings': {field: delivery[field] for field in NOTICE_BINDINGS.values()},
        'usedUnauthenticatedPublicDownloads': True,
        'executedAcceptedControlVerifiersOnly': True,
    }
    (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--delivery', required=True, type=pathlib.Path)
    parser.add_argument('--out', required=True, type=pathlib.Path)
    args = parser.parse_args()
    consume(args.delivery, args.out)
