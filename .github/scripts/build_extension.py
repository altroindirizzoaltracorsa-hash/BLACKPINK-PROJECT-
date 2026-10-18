#!/usr/bin/env python3
"""Build the two Vote Counter zips the site offers for download.

    python3 .github/scripts/build_extension.py          # build at the current version
    python3 .github/scripts/build_extension.py 1.9.0    # bump both manifests, then build

The zips were hand-made before this existed, which is a quiet way to ship a
download that does not match the source: every file is copied by hand, and the
one nobody remembered is the one that changed. Here the source directory is the
only input.

Two zips, one tree. The difference is the manifest: Chromium desktop takes the
MV3 one, and the Android browsers that still run extensions (Edge Canary,
Quetta) inherited Kiwi's MV2 engine, so theirs is manifest-mv2.json renamed to
manifest.json. Everything else is byte-identical, which is the point — one
background.js, not two that drift.
"""
import json
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'vote-extension'
MV3 = SRC / 'manifest.json'
MV2 = SRC / 'manifest-mv2.json'

# Everything in the extension except the manifests, which are placed per target.
FILES = ['background.js', 'panel.js', 'popup.html', 'popup.js', 'bu-link.js',
         'assets/heart.png', 'assets/lightstick.png']


def set_version(path: pathlib.Path, version: str) -> None:
    """Rewrite just the version line, leaving the rest of the file untouched.

    Deliberately not json.dump: these manifests are hand-maintained and
    comment-free but carefully ordered, and round-tripping them through a JSON
    writer would reformat the whole file and bury the one-line change in a
    diff nobody can read.
    """
    text = path.read_text(encoding='utf-8')
    before = json.loads(text)['version']
    out, done = [], False
    for line in text.split('\n'):
        if not done and line.lstrip().startswith('"version"'):
            indent = line[:len(line) - len(line.lstrip())]
            comma = ',' if line.rstrip().endswith(',') else ''
            out.append(f'{indent}"version": "{version}"{comma}')
            done = True
        else:
            out.append(line)
    if not done:
        raise SystemExit(f'no "version" line in {path.name}')
    path.write_text('\n'.join(out), encoding='utf-8')
    print(f'  {path.name}: {before} → {version}')


def build(target: str, manifest: pathlib.Path, version: str) -> pathlib.Path:
    out = ROOT / f'vote-extension-v{version}-{target}.zip'
    # Fixed timestamps and sorted order: a rebuild that changed nothing should
    # produce the same bytes, so a diff on these files means the source moved.
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo('manifest.json', date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, manifest.read_text(encoding='utf-8'))
        for rel in FILES:
            src = SRC / rel
            if not src.exists():
                raise SystemExit(f'missing {rel} — the extension source is incomplete')
            info = zipfile.ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, src.read_bytes())
    print(f'  {out.name}  ({out.stat().st_size:,} bytes)')
    return out


def main() -> None:
    if len(sys.argv) > 1:
        version = sys.argv[1]
        if not all(p.isdigit() for p in version.split('.')) or version.count('.') != 2:
            raise SystemExit(f'version should look like 1.9.0, got {version!r}')
        print('Bumping:')
        set_version(MV3, version)
        set_version(MV2, version)
    else:
        version = json.loads(MV3.read_text(encoding='utf-8'))['version']

    mv2v = json.loads(MV2.read_text(encoding='utf-8'))['version']
    if mv2v != version:
        raise SystemExit(f'the manifests disagree: MV3 {version}, MV2 {mv2v}')

    print(f'Building v{version}:')
    build('chrome', MV3, version)
    build('android', MV2, version)
    print(f'\nNow update the version the site offers — index.html and collabs.html '
          f'both name it. test_extension_release.mjs checks they agree.')


if __name__ == '__main__':
    main()
