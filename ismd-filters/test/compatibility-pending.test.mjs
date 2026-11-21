import test from 'node:test';
// Preserved inputs/assertions live beside this manifest in legacy/*.txt.
// TODO is deliberately reported separately from PASS: Phase 4 is not implemented here.
for (const name of [
  'Rust nested_filters_and_aliases_and_options_order: nested provider chain and option precedence',
  'Rust alias_chain_and_dynamic_option_errors_and_dependency_walk: alias and dynamic option diagnostics',
  'constant-folding Step 4B.1: constant provider options, undefined, invalid and unsupported expressions',
  'constant-folding Step 4B.2: include providers, raw bytes, renderBuffer/renderFile',
  'constant-folding Step 4B.4: historical filters*.ismd provider output compatibility',
  'constant-folding Step 4B.5: provider errors, alias cycle, exception/return-value contracts',
  'filters.test.js: Markdown lazy resolution, provider precedence, repeated transformer caching',
  'filter-separation.test.js: replacement for JS executor injection and disabled-provider policy',
  'attrs-codegen Step 5.4: provider option diagnostic distinctions',
]) test.todo(name);
