import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const banned=/FilterNode|IncludeFilterNode|parse_filter|parse_include_filter|fn filter\s*\(|handle_filters|invoke_js_filter|pug_filters|FilterInvocation|FilterHost|FilterExecutor|eval_filter_constant|pre_filters|post_filters|Node::Filter|Node::IncludeFilter|filter_options|filter_aliases|has_filters|is_filtered/;
let checked=0;
for(const entry of fs.readdirSync(path.join(root,'crates'),{recursive:true,withFileTypes:true})){
  if(!entry.isFile() || !entry.name.endsWith('.rs'))continue;
  const p=path.join(entry.parentPath,entry.name);
  if(!p.includes(path.sep+'src'+path.sep))continue;
  const code=fs.readFileSync(p,'utf8').split('#[cfg(test)]')[0];
  assert.ok(!banned.test(code),'Legacy Core symbol in '+p);checked++;
}
const js=fs.readFileSync(path.join(root,'index.js'),'utf8');
assert.ok(!/handleFiltersSync|_handleFilters|makeFilterHostCallback|loadFilterAdapter|jstransformer|pug_filter_uppercase|filterOptions|filterAliases|filterExecutor|preFilters|postFilters/.test(js));
assert.ok(!fs.existsSync(path.join(root,'crates/pug_filters/src/lib.rs')));
console.log('Core audit PASS: '+checked+' production Rust source files and JS entry');
