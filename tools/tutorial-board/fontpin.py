"""Fonts pinned to one google/fonts commit and verified against SHA-256 checksums.

fonts.json holds the commit and the expected hash of every file. Files are cached in
tools/tutorial-board/fonts/ (git-ignored); a cached or downloaded file whose hash does
not match stops the render instead of silently changing the typography.
"""
import hashlib, json, pathlib, re, urllib.parse, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
MANIFEST = HERE / 'fonts.json'
CACHE = HERE / 'fonts'


class FontChecksumError(RuntimeError):
    pass


def load_manifest(path=MANIFEST):
    manifest = json.loads(pathlib.Path(path).read_text())
    if not re.fullmatch(r'[0-9a-f]{40}', manifest.get('commit', '')):
        raise ValueError('fonts.json: commit must be a full 40-character google/fonts SHA')
    for entry in manifest['files']:
        if not re.fullmatch(r'[0-9a-f]{64}', entry.get('sha256', '')):
            raise ValueError(f"fonts.json: {entry.get('local')} needs a SHA-256 checksum")
        if pathlib.PurePath(entry['local']).name != entry['local']:
            raise ValueError(f"fonts.json: {entry['local']} must be a plain file name")
    return manifest


def url_for(manifest, entry):
    return manifest['source'].format(commit=manifest['commit'], family=urllib.parse.quote(entry['family']),
                                     file=urllib.parse.quote(entry['file']))


def verify(data, entry, origin):
    digest = hashlib.sha256(data).hexdigest()
    if digest != entry['sha256']:
        raise FontChecksumError(f"{entry['local']} from {origin}: SHA-256 {digest}, expected {entry['sha256']}. "
                                'Delete the cached file to download it again, or update fonts.json (see README).')
    return data


def download(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def ensure_fonts(cache=CACHE, manifest=None, fetch=download):
    """Return the cache folder once every pinned file is present and matches its checksum."""
    manifest = manifest or load_manifest()
    cache = pathlib.Path(cache); cache.mkdir(parents=True, exist_ok=True)
    for entry in manifest['files']:
        target = cache / entry['local']
        if target.exists():
            verify(target.read_bytes(), entry, target)
            continue
        url = url_for(manifest, entry)
        data = verify(fetch(url), entry, url)
        partial = target.with_name(target.name + '.part')
        partial.write_bytes(data); partial.replace(target)
    return cache
