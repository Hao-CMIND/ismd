import { fileURLToPath } from 'node:url';
import { IsmdWebpackPlugin, IsmdRustPlugin } from './plugin.mjs';

export const loaderPath = fileURLToPath(new URL('./loader.mjs', import.meta.url));
IsmdWebpackPlugin.loader = loaderPath;
IsmdRustPlugin.loader = loaderPath;

export { IsmdWebpackPlugin, IsmdRustPlugin };
export default IsmdWebpackPlugin;
