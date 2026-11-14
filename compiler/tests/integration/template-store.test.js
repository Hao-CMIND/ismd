import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pug from '../../index.js';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pug-rust-phase3a-'));
  fs.writeFileSync(path.join(dir, 'header.pug'), 'header.site HeaderNav\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'footer.pug'), 'footer.site FooterCopy\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'base.pug'),
    [
      'doctype html',
      'html',
      '  head',
      '    block title',
      '      title Default',
      '  body',
      '    include header.pug',
      '    block content',
      '    include footer.pug',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'layout.pug'),
    [
      'extends base.pug',
      'append title',
      '  |  - App',
      'block content',
      '  main',
      '    block page',
      '',
    ].join('\n'),
    'utf8'
  );
  return dir;
}

test('createTemplateStore shares parsed layout/header/footer across pages and supports invalidation', () => {
  const dir = makeTempProject();
  try {
    const store = pug.createTemplateStore();
    for (let i = 1; i <= 10; i++) {
      const pagePath = path.join(dir, `page${i}.pug`);
      const src = `extends layout.pug\nblock page\n  p Page ${i} - #{title}\n`;
      const fn = pug.compile(src, {
        filename: pagePath,
        basedir: dir,
        templateStore: store,
      });
      const html = fn({ title: `T${i}` });
      assert.match(html, new RegExp(`<p>Page ${i} - T${i}</p>`));
      assert.match(html, /<header class="site">HeaderNav<\/header>/);
      assert.match(html, /<footer class="site">FooterCopy<\/footer>/);
      assert.equal(fn.dependencies.length, 4);
    }

    const s1 = store.stats();
    assert.equal(s1.sources, 4);
    assert.equal(s1.sourceMisses, 4);
    assert.equal(s1.sourceHits, 36);
    assert.equal(s1.parseHits, 36);

    // Updating a shared partial invalidates only affected cached entries cleanly.
    const headerPath = path.join(dir, 'header.pug');
    store.updateVirtualSource(headerPath, 'header.site UpdatedNav\n');
    const fnAfter = pug.compile('extends layout.pug\nblock page\n  p After\n', {
      filename: path.join(dir, 'page1.pug'),
      basedir: dir,
      templateStore: store,
    });
    const htmlAfter = fnAfter({ title: 'X' });
    assert.match(htmlAfter, /<header class="site">UpdatedNav<\/header>/);
    assert.doesNotMatch(htmlAfter, /HeaderNav/);

    // Invalidating from disk picks up disk edits cleanly.
    fs.writeFileSync(headerPath, 'header.site DiskNav\n', 'utf8');
    store.invalidatePath(headerPath);
    const fnDisk = pug.compile('extends layout.pug\nblock page\n  p Disk\n', {
      filename: path.join(dir, 'page2.pug'),
      basedir: dir,
      templateStore: store,
    });
    assert.match(fnDisk({ title: 'Y' }), /<header class="site">DiskNav<\/header>/);

    store.clear();
    assert.equal(store.stats().sources, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
