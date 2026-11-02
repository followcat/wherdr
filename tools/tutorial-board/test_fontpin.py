"""Offline checks of the pinned-font checksum logic (no network)."""
import hashlib, json, pathlib, tempfile, unittest
from fontpin import FontChecksumError, ensure_fonts, load_manifest, url_for

GOOD = b'pinned font bytes'

def manifest(data=GOOD):
    return dict(source='https://example.invalid/{commit}/ofl/{family}/{file}', commit='a' * 40,
                files=[dict(family='inter', file='Inter[opsz,wght].ttf', local='inter.ttf',
                            sha256=hashlib.sha256(data).hexdigest())])


class FontPinTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(); self.cache = pathlib.Path(self.dir.name)
    def tearDown(self):
        self.dir.cleanup()

    def test_download_is_verified_and_cached(self):
        urls = []
        fetch = lambda url: urls.append(url) or GOOD
        ensure_fonts(self.cache, manifest(), fetch)
        self.assertEqual((self.cache / 'inter.ttf').read_bytes(), GOOD)
        self.assertEqual(urls, ['https://example.invalid/' + 'a' * 40 + '/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf'])
        ensure_fonts(self.cache, manifest(), fetch)  # cached and valid: no second download
        self.assertEqual(len(urls), 1)

    def test_tampered_download_fails_and_is_not_cached(self):
        with self.assertRaises(FontChecksumError):
            ensure_fonts(self.cache, manifest(), lambda url: b'changed upstream')
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_tampered_cache_fails(self):
        (self.cache / 'inter.ttf').write_bytes(b'corrupted')
        with self.assertRaises(FontChecksumError):
            ensure_fonts(self.cache, manifest(), lambda url: self.fail('must not download'))

    def test_repo_manifest_pins_a_commit_and_every_file(self):
        pinned = load_manifest()
        self.assertEqual(len(pinned['files']), 6)
        for entry in pinned['files']:
            self.assertIn('/' + pinned['commit'] + '/', url_for(pinned, entry))
            self.assertNotIn('/main/', url_for(pinned, entry))

    def test_moving_refs_and_missing_checksums_are_rejected(self):
        for change in [dict(commit='main'), dict(files=[dict(manifest()['files'][0], sha256='')]),
                       dict(files=[dict(manifest()['files'][0], local='../inter.ttf')])]:
            path = self.cache / 'fonts.json'
            path.write_text(json.dumps(dict(manifest(), **change)))
            with self.subTest(change=change), self.assertRaises(ValueError):
                load_manifest(path)

if __name__ == '__main__':
    unittest.main()
