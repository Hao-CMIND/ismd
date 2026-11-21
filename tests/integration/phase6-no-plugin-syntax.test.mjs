import test from 'node:test';
import assert from 'node:assert/strict';
import ismd, { createCompiler } from '../../index.mjs';
import { nativePluginPath } from '../../../ismd-filters/index.mjs';

test('Phase 6.1: Case 1 - p :sass treated as plain text in tag without plugin', () => {
  const html = ismd.render('p :sass');
  assert.equal(html.trim(), '<p>:sass</p>');
});

test('Phase 6.1: Case 2 - p with indented :sass fails with generic syntax error', () => {
  assert.throws(() => {
    ismd.render('p\n  :sass');
  }, (err) => {
    assert.equal(err.code, 'ISMD:UNEXPECTED_TEXT');
    assert(err.message.includes('unexpected text'));
    // Must NOT contain filter-specific wording
    assert(!err.message.toLowerCase().includes('filter'));
    return true;
  });
});

test('Phase 6.1: Case 3 - :sass alone fails with generic syntax error without plugin', () => {
  assert.throws(() => {
    ismd.render(':sass\n  hello');
  }, (err) => {
    assert.equal(err.code, 'ISMD:UNEXPECTED_TEXT');
    assert(err.message.includes('unexpected text'));
    assert(!err.message.toLowerCase().includes('filter'));
    return true;
  });
});

test('Phase 6.1: Case 4 - Block expansion p: span hello works normally', () => {
  const html = ismd.render('p: span hello');
  assert.equal(html.trim(), '<p><span>hello</span></p>');
});

test('Phase 6.1: Case 5 - Standard tag text p Hello works normally', () => {
  const html = ismd.render('p Hello');
  assert.equal(html.trim(), '<p>Hello</p>');
});

test('Phase 6.1: Case 6 - Pipeless text p. with :sass retains literal raw text', () => {
  const html = ismd.render('p.\n  :sass\n  some lines');
  assert.equal(html.trim(), '<p>:sass\nsome lines</p>');
});

test('Phase 6.1: Compiler Instance Isolation - Plugin does not leak to other compiler instances', () => {
  const pluginPath = nativePluginPath();

  // Instance A: with plugin
  const compilerA = createCompiler({ plugins: [pluginPath] });
  compilerA.updateFiles({ 'a.pug': ':uppercase\n  hello from a' });
  const resA = compilerA.compileBatch(['a.pug']);
  assert.equal(resA[0].ok, true);
  assert(resA[0].fn().includes('HELLO FROM A'));

  // Instance B: without plugin
  const compilerB = createCompiler({});
  compilerB.updateFiles({ 'b.pug': ':uppercase\n  hello from b' });
  let threw = false;
  try {
    compilerB.compileBatch(['b.pug']);
  } catch (err) {
    threw = true;
    assert.equal(err.code, 'ISMD:UNEXPECTED_TEXT');
  }
  assert.equal(threw, true, 'Instance B must reject :uppercase as unexpected text');

  compilerA.dispose();
  compilerB.dispose();
});
