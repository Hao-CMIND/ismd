import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {nativePluginPath} from '../index.mjs';
import ismd from '../../ismd/index.mjs';
test('optional package supplies only a native library path; JS transformers remain unloaded',()=>{
  const require=createRequire(import.meta.url);
  const plugins=[nativePluginPath()];
  assert.equal(ismd.render(':uppercase\n  package test',{plugins}),'PACKAGE TEST');
  assert.ok(!Object.keys(require.cache).some(p=>/[\/]node_modules[\/](jstransformer|resolve)[\/]/.test(p)));
});
test('unavailable native library is an error and never falls back to JS',()=>{
  assert.throws(()=>ismd.render(':uppercase\n  x',{plugins:['missing-native-plugin.dll']}),/Failed to load/);
});
