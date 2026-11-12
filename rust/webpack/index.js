import { fileURLToPath } from 'node:url';
import { PugRustPlugin } from './plugin.js';

export const loaderPath = fileURLToPath(new URL('./loader.js', import.meta.url));
export { PugRustPlugin };
export default PugRustPlugin;
