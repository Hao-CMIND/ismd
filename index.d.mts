export interface Options {
  filename?: string;
  basedir?: string;
  doctype?: string;
  pretty?: boolean | string;
  self?: boolean;
  debug?: boolean;
  compileDebug?: boolean;
  includeSources?: boolean;
  globals?: string[];
  cache?: boolean;
  inlineRuntimeFunctions?: boolean;
  name?: string;
  module?: boolean;
  plugins?: any[];
  templateStore?: any;
}

export type LocalsObject = Record<string, any>;
export type compileTemplate = (locals?: LocalsObject) => string;

export type BatchEntry =
  | string
  | {
      id?: string;
      filename?: string;
      source?: string;
      options?: Options;
    };

export interface BatchResult {
  id: string;
  ok: boolean;
  fn?: compileTemplate & { dependencies: string[] };
  body?: string;
  dependencies: string[];
  cacheHit: boolean;
  error?: Error;
}

export interface CompilerSession {
  readonly isDisposed: boolean;
  updateFiles(files: Record<string, string> | Array<{ path: string; source: string }>): void;
  invalidateFiles(paths: string | string[]): void;
  removeFiles(paths: string | string[]): any;
  getAffectedEntries(): string[];
  compileAffected(opts?: { parallel?: boolean | number; parallelThreshold?: number; throwOnError?: boolean }): BatchResult[];
  compileEntries(entries: BatchEntry[], opts?: { parallel?: boolean | number; parallelThreshold?: number; throwOnError?: boolean }): BatchResult[];
  compileBatch(entries: BatchEntry[], opts?: { parallel?: boolean | number; parallelThreshold?: number; throwOnError?: boolean }): BatchResult[];
  stats(): Record<string, any>;
  clear(): void;
  dispose(): void;
  [Symbol.dispose]?(): void;
}

export declare const name: 'Pug';
export declare const cache: Record<string, compileTemplate | string>;
export declare const runtime: Record<string, (...args: any[]) => any>;

export declare function compile(template: string, options?: Options): compileTemplate & { dependencies: string[] };
export declare function compileFile(path: string, options?: Options): compileTemplate & { dependencies: string[] };
export declare function render(template: string, options?: Options & LocalsObject): string;
export declare function render<T = void>(template: string, options: Options & LocalsObject, callback: (err: Error | null, html?: string) => T): T;
export declare function render<T = void>(template: string, callback: (err: Error | null, html?: string) => T): T;
export declare function renderFile(path: string, options?: Options & LocalsObject): string;
export declare function renderFile<T = void>(path: string, options: Options & LocalsObject, callback: (err: Error | null, html?: string) => T): T;
export declare function renderFile<T = void>(path: string, callback: (err: Error | null, html?: string) => T): T;
export declare function __express(path: string, options: Options & LocalsObject, callback: (err: Error | null, html?: string) => void): void;

export declare function createCompiler(defaults?: Options): CompilerSession;
export declare function compileBatch(entries: BatchEntry[], defaults?: Options, compileOpts?: { parallel?: boolean | number; parallelThreshold?: number; throwOnError?: boolean }): BatchResult[];
export declare function createTemplateStore(): any;
export declare function clearDefaultTemplateStore(): void;
export declare function defaultTemplateStoreStats(): Record<string, any>;

export declare function lex(str: string, options?: Options): any[];
export declare function parse(tokens: any[], options?: Options): any;
export declare function walk(ast: any, before?: (node: any, replace?: (n: any) => void) => boolean | void, after?: (node: any, replace?: (n: any) => void) => boolean | void, options?: any): any;
export declare function stripComments(tokens: any[], options?: Options): any[];
export declare function resolveNativePluginPath(plugin: string | { nativePath?: string; path?: string }): string | null;
export declare function resolveNativePlugins(plugins: any[]): string[];
export declare function getLastProfileJson(): string | null;

declare const ismd: {
  name: typeof name;
  cache: typeof cache;
  runtime: typeof runtime;
  compile: typeof compile;
  compileFile: typeof compileFile;
  render: typeof render;
  renderFile: typeof renderFile;
  __express: typeof __express;
  createCompiler: typeof createCompiler;
  compileBatch: typeof compileBatch;
  createTemplateStore: typeof createTemplateStore;
  clearDefaultTemplateStore: typeof clearDefaultTemplateStore;
  defaultTemplateStoreStats: typeof defaultTemplateStoreStats;
  lex: typeof lex;
  parse: typeof parse;
  walk: typeof walk;
  stripComments: typeof stripComments;
  resolveNativePluginPath: typeof resolveNativePluginPath;
  resolveNativePlugins: typeof resolveNativePlugins;
  getLastProfileJson: typeof getLastProfileJson;
};

export default ismd;
