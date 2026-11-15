import assert from 'node:assert';
import { createRequire } from 'node:module';
import pug from '../../index.js';
import { nativePluginPath } from '../../../filters/index.js';

const require = createRequire(import.meta.url);

function testPugErrorSuite() {
  const error = pug._error;

  // 1. with a source and a filename
  let err = error('MY_CODE', 'My message', {
    line: 3,
    filename: 'myfile',
    src: 'foo\nbar\nbaz\nbash\nbing',
  });
  assert(err instanceof Error);
  assert.strictEqual(
    err.message,
    'myfile:3\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message'
  );
  assert.strictEqual(err.code, 'PUG:MY_CODE');
  assert.strictEqual(err.msg, 'My message');
  assert.strictEqual(err.line, 3);
  assert.strictEqual(err.filename, 'myfile');
  assert.strictEqual(err.src, 'foo\nbar\nbaz\nbash\nbing');
  assert.deepStrictEqual(err.toJSON(), {
    code: 'PUG:MY_CODE',
    msg: 'My message',
    line: 3,
    column: undefined,
    filename: 'myfile',
  });

  // 2. with a source and no filename
  err = error('MY_CODE', 'My message', {
    line: 3,
    src: 'foo\nbar\nbaz\nbash\nbing',
  });
  assert.strictEqual(
    err.message,
    'Pug:3\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message'
  );
  assert.strictEqual(err.filename, undefined);

  // 3. without source
  err = error('MY_CODE', 'My message', { line: 3, filename: 'myfile' });
  assert.strictEqual(err.message, 'myfile:3\n\nMy message');
  assert.strictEqual(err.src, undefined);

  err = error('MY_CODE', 'My message', { line: 3 });
  assert.strictEqual(err.message, 'Pug:3\n\nMy message');

  // 4. with column
  err = error('MY_CODE', 'My message', {
    line: 3,
    column: 2,
    filename: 'myfile',
    src: 'foo\nbar\nbaz\nbash\nbing',
  });
  assert.strictEqual(
    err.message,
    'myfile:3:2\n    1| foo\n    2| bar\n  > 3| baz\n--------^\n    4| bash\n    5| bing\n\nMy message'
  );

  err = error('MY_CODE', 'My message', { line: 3, column: 1 });
  assert.strictEqual(err.message, 'Pug:3:1\n\nMy message');

  // 5. invalid information
  err = error('MY_CODE', 'My message', {
    line: 3,
    column: -1,
    src: 'foo\nbar\nbaz\nbash\nbing',
  });
  assert.strictEqual(
    err.message,
    'Pug:3:-1\n    1| foo\n    2| bar\n  > 3| baz\n    4| bash\n    5| bing\n\nMy message'
  );

  for (const line of [0, 6]) {
    err = error('MY_CODE', 'My message', {
      line,
      src: 'foo\nbar\nbaz\nbash\nbing',
    });
    assert.strictEqual(err.message, 'Pug:' + line + '\n\nMy message');
  }
}

function testMinimalRenderAndDynamicLocals() {
  // 1. Minimal static render
  assert.strictEqual(pug.render('p Hello'), '<p>Hello</p>');
  assert.strictEqual(
    pug.render('div.greeting\n  p Hello\n  span World'),
    '<div class="greeting"><p>Hello</p><span>World</span></div>'
  );

  // 2. Function-valued locals & live JS object (non-JSON serialized)
  assert.strictEqual(
    pug.render('p= fn()', { fn: () => 'ok' }),
    '<p>ok</p>'
  );
  assert.strictEqual(
    pug.render('p= fn()', { fn: () => '<script>' }),
    '<p>&lt;script&gt;</p>'
  );
  assert.strictEqual(
    pug.render('p!= fn()', { fn: () => '<b>bold</b>' }),
    '<p><b>bold</b></p>'
  );

  // 3. Prototype chain + getter side effects on locals
  let getterCalls = 0;
  const proto = {
    inheritedFn() {
      return 'from-proto';
    },
  };
  const locals = Object.create(proto);
  Object.defineProperty(locals, 'liveProp', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'live-' + getterCalls;
    },
  });
  assert.strictEqual(pug.render('p= inheritedFn()', locals), '<p>from-proto</p>');
  assert.strictEqual(pug.render('p= liveProp', locals), '<p>live-1</p>');
  assert.strictEqual(getterCalls, 1);

  // 4. `self: true` mode
  const selfFn = pug.compile('.bar= self.foo', { self: true });
  assert.strictEqual(selfFn({ foo: 'baz' }), '<div class="bar">baz</div>');

  // 5. `compileClient` with `inlineRuntimeFunctions: true` and `false` + `module: true`
  const clientCode = pug.compileClient('.bar= self.foo', {
    self: true,
    module: true,
    inlineRuntimeFunctions: true,
  });
  assert(clientCode.includes('function pug_escape('));
  assert(clientCode.includes('module.exports = template;'));
}

async function testSynchronousHostCallbacksAndReentrancy() {
  const order = [];

  const plugin = {
    preLex(str) {
      order.push('preLex');
      // Re-entrant call inside preLex!
      const nested = pug.render('b Inner');
      assert.strictEqual(nested, '<b>Inner</b>');
      return str.replace('ORIGINAL', 'REPLACED');
    },
    postLex(tokens) {
      order.push('postLex');
      return tokens;
    },
    preParse(tokens) {
      order.push('preParse');
      return tokens;
    },
    postParse(ast) {
      order.push('postParse');
      return ast;
    },
    preLoad(ast) {
      order.push('preLoad');
      return ast;
    },
    postLoad(ast) {
      order.push('postLoad');
      return ast;
    },
    preTransform(ast) {
      order.push('preTransform');
      return ast;
    },
    postTransform(ast) {
      order.push('postTransform');
      return ast;
    },
    preLink(ast) {
      order.push('preLink');
      return ast;
    },
    postLink(ast) {
      order.push('postLink');
      return ast;
    },
    preCodeGen(ast) {
      order.push('preCodeGen');
      return ast;
    },
    postCodeGen(js) {
      order.push('postCodeGen');
      return js;
    },
  };

  const html = pug.render('p ORIGINAL\n:uppercase\n  hello', {
    plugins: [plugin, nativePluginPath()],
  });
  assert.strictEqual(html, '<p>REPLACED</p>HELLO');
  assert.deepStrictEqual(order, [
    'preLex',
    'postLex',
    'preParse',
    'postParse',
    'preLoad',
    'postLoad',
    'preTransform',
    'postTransform',
    'preLink',
    'postLink',
    'preCodeGen',
    'postCodeGen',
  ]);

  // Verify JS Error thrown in plugin propagates with identity preserved
  const sentinelError = new TypeError('Custom plugin failure');
  sentinelError.customCode = 'ERR_CUSTOM_PLUGIN';
  let caught = null;
  try {
    pug.render('p Hello', {
      plugins: [
        {
          preLex() {
            throw sentinelError;
          },
        },
      ],
    });
  } catch (err) {
    caught = err;
  }
  assert.strictEqual(caught, sentinelError);
  assert.strictEqual(caught.customCode, 'ERR_CUSTOM_PLUGIN');

  // Verify register.js attaches require.extensions['.pug']
  await import('../../register.js');
  assert.strictEqual(typeof require.extensions['.pug'], 'function');
}

async function main() {
  testPugErrorSuite();
  testMinimalRenderAndDynamicLocals();
  await testSynchronousHostCallbacksAndReentrancy();
  console.log(
    'PASS tests/integration/step1-skeleton.test.js (pug-error + render("p Hello") + fn() locals + sync host hooks + re-entrancy + register.js verified)'
  );
}

main();
