import hashlib
import io
import json
import pathlib
import runpy
import tarfile
import tempfile
import unittest

consumer = runpy.run_path(str(pathlib.Path(__file__).with_name('verify-public-delivery-consumer.py')))


class ConsumerBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='banda-public-consumer-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.target = self.root / 'extracted'
        self.target.mkdir()
        self.archive = self.root / 'fixture.tar.gz'

    def write_archive(self, records):
        with tarfile.open(self.archive, 'w:gz') as stream:
            for name, kind, body in records:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = len(body)
                if kind == tarfile.SYMTYPE:
                    member.linkname = '../outside'
                stream.addfile(member, io.BytesIO(body))

    def extract(self, max_members=3, max_bytes=1024):
        return consumer['extract_regular'](self.archive, self.target, max_members, max_bytes)

    def test_regular_files_are_extracted_without_execution(self):
        self.write_archive([('nested/verify.mjs', tarfile.REGTYPE, b'throw Error("inert")')])
        self.assertEqual(self.extract(), {'nested/verify.mjs'})
        self.assertEqual((self.target / 'nested/verify.mjs').read_bytes(), b'throw Error("inert")')

    def test_paths_cannot_escape_fresh_output(self):
        for name in ['../outside', '/tmp/outside', './outside', 'nested//outside', 'nested/../outside']:
            with self.subTest(name=name):
                self.write_archive([(name, tarfile.REGTYPE, b'inert')])
                with self.assertRaises(AssertionError):
                    self.extract()
        self.assertEqual(list(self.target.iterdir()), [])

    def test_links_and_duplicate_members_are_refused(self):
        self.write_archive([('link', tarfile.SYMTYPE, b'')])
        with self.assertRaises(AssertionError):
            self.extract()
        self.write_archive([('same', tarfile.REGTYPE, b'first'), ('same', tarfile.REGTYPE, b'second')])
        with self.assertRaises(AssertionError):
            self.extract()
        self.assertEqual((self.target / 'same').read_bytes(), b'first')

    def test_extraction_bounds_are_enforced_before_writing(self):
        self.write_archive([('oversized', tarfile.REGTYPE, b'12345')])
        with self.assertRaises(AssertionError):
            self.extract(max_bytes=4)
        with self.assertRaises(AssertionError):
            self.extract(max_members=0)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_existing_output_is_preserved(self):
        (self.target / 'keep').write_bytes(b'owned')
        self.write_archive([('keep', tarfile.REGTYPE, b'replacement')])
        with self.assertRaises(FileExistsError):
            self.extract()
        self.assertEqual((self.target / 'keep').read_bytes(), b'owned')

    def test_asset_hash_and_symlink_checks(self):
        path = self.root / 'asset'
        path.write_bytes(b'accepted')
        record = {'bytes': 8, 'sha256': hashlib.sha256(b'accepted').hexdigest()}
        consumer['check_file'](path, record)
        link = self.root / 'symlink'
        link.symlink_to(path)
        with self.assertRaises(AssertionError):
            consumer['check_file'](link, record)
        path.write_bytes(b'replaced')
        with self.assertRaises(AssertionError):
            consumer['check_file'](path, record)

    def test_all_four_outer_notice_bindings_are_checked(self):
        delivery = {'sourceCommit': 'candidate', 'runtimeManifestSha256': 'runtime'}
        binding = {'candidateCommit': 'candidate', 'runtimeManifest': {'sha256': 'runtime'}}
        for name, field in consumer['NOTICE_BINDINGS'].items():
            body = json.dumps(binding).encode() if name == 'artifact-binding.json' else name.encode()
            (self.target / name).write_bytes(body)
            delivery[field] = hashlib.sha256(body).hexdigest()
        consumer['verify_notice_binding'](self.target, delivery)
        for name in consumer['NOTICE_BINDINGS']:
            with self.subTest(name=name):
                path = self.target / name
                original = path.read_bytes()
                path.write_bytes(b'changed')
                with self.assertRaises(AssertionError):
                    consumer['verify_notice_binding'](self.target, delivery)
                path.write_bytes(original)


if __name__ == '__main__':
    unittest.main()
