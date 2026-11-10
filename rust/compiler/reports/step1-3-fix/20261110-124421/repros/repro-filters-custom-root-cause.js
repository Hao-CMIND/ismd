'use strict';
const rawPug = require('../../../../../../raw/compiler/packages/pug');
const rustPug = require('../../../../index.js');

const src = "html\n  body\n    :custom(opt='val' num=2)\n      Line 1";
rawPug.render(src, {
  filters: {
    custom(s, o) {
      console.log('RAW filter opts:', o, 'typeof num:', typeof o.num);
      return s;
    },
  },
});
rustPug.render(src, {
  filters: {
    custom(s, o) {
      console.log('RUST filter opts:', o, 'typeof num:', typeof o.num);
      return s;
    },
  },
});
