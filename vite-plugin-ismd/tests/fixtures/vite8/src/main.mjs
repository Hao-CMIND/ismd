import indexHtml from './pages/index.pug';
import aboutHtml from './pages/about.pug';
import queryHtml from './pages/query.pug?import';

globalThis.__ISMD_OUT__ = { indexHtml, aboutHtml, queryHtml };
console.log(globalThis.__ISMD_OUT__);
