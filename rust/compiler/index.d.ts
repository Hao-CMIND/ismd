export interface Options {
  filename?: string;
  basedir?: string;
  doctype?: string;
  pretty?: boolean | string;
  filters?: Record<string, (text: string, options: Record<string, any>) => string>;
  self?: boolean;
  debug?: boolean;
  compileDebug?: boolean;
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
export declare function render(template: string, options?: Options & LocalsObject, callback?: (err: Error | null, html?: string) => void): string;
export declare function render(template: string, callback: (err: Error | null, html?: string) => void): string;
export declare function renderFile(path: string, options?: Options & LocalsObject, callback?: (err: Error | null, html?: string) => void): string;
export declare function renderFile(path: string, callback: (err: Error | null, html?: string) => void): string;
export declare function __express(path: string, options: Options & LocalsObject, callback: (err: Error | null, html?: string) => void): void;
