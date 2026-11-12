import { createRequire } from 'node:module';
import { PugRustPlugin } from './plugin.js';

const require = createRequire(import.meta.url);
export const loaderPath = require.resolve('./loader.cjs');
export { PugRustPlugin };
export default PugRustPlugin;
