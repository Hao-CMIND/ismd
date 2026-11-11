export interface Options {
  filename?: string;
  basedir?: string;
  doctype?: string;
  pretty?: boolean | string;
  filters?: Record<string, (text: string, options: Record<string, any>) => string>;
  filterOptions?: Record<string, Record<string, any>>;
  filterAliases?: Record<string, string>;
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
}

export type LocalsObject = Record<string, any>;
export type compileTemplate = (locals?: LocalsObject) => string;

export declare const name: 'Pug';
export declare const cache: Record<string, compileTemplate | string>;
export declare const filters: Record<string, (text: string, options: Record<string, any>) => string>;
export declare const runtime: Record<string, (...args: any[]) => any>;

export declare function compile(template: string, options?: Options): compileTemplate & { dependencies: string[] };
export declare function compileFile(path: string, options?: Options): compileTemplate & { dependencies: string[] };
export declare function compileClient(template: string, options?: Options): string;
export declare function compileClientWithDependenciesTracked(template: string, options?: Options): { body: string; dependencies: string[] };
export declare function compileFileClient(path: string, options?: Options): string;
export declare function render(template: string, options?: Options & LocalsObject): string;
export declare function render<T = void>(template: string, options: Options & LocalsObject, callback: (err: Error | null, html?: string) => T): T;
export declare function render<T = void>(template: string, callback: (err: Error | null, html?: string) => T): T;
export declare function renderFile(path: string, options?: Options & LocalsObject): string;
export declare function renderFile<T = void>(path: string, options: Options & LocalsObject, callback: (err: Error | null, html?: string) => T): T;
export declare function renderFile<T = void>(path: string, callback: (err: Error | null, html?: string) => T): T;
export declare function __express(path: string, options: Options & LocalsObject, callback: (err: Error | null, html?: string) => void): void;

declare const pug: {
  name: typeof name;
  cache: typeof cache;
  filters: typeof filters;
  runtime: typeof runtime;
  compile: typeof compile;
  compileFile: typeof compileFile;
  compileClient: typeof compileClient;
  compileClientWithDependenciesTracked: typeof compileClientWithDependenciesTracked;
  compileFileClient: typeof compileFileClient;
  render: typeof render;
  renderFile: typeof renderFile;
  __express: typeof __express;
};

export default pug;
