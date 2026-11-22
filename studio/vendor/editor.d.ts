// Hand-written types for editor.js (CodeMirror 6, bundled by scripts/vendor): only what the studio uses,
// with CodeMirror's names. Opaque values (extensions, effects, key bindings) are branded so they can't be mixed up.
declare const brand: unique symbol;

export type Extension = { readonly [brand]: "Extension" } | readonly Extension[];
export interface StateEffect { readonly [brand]: "StateEffect" }
export interface KeyBinding { readonly [brand]: "KeyBinding" }

export interface Text {
  readonly length: number;
  toString(): string;
}

export declare class EditorState {
  private constructor();
  readonly doc: Text;
  static create(config?: { doc?: string; extensions?: Extension }): EditorState;
}

export declare class Compartment {
  of(ext: Extension): Extension;
  reconfigure(content: Extension): StateEffect;
}

export interface Facet<Input> {
  of(value: Input): Extension;
}

export interface ViewUpdate {
  readonly docChanged: boolean;
  readonly state: EditorState;
}

export interface TransactionSpec {
  changes?: { from: number; to?: number; insert?: string };
  effects?: StateEffect | readonly StateEffect[];
}

export declare class EditorView {
  constructor(config?: { parent?: Element; state?: EditorState });
  readonly state: EditorState;
  readonly contentDOM: HTMLElement;
  dispatch(...specs: TransactionSpec[]): void;
  requestMeasure(): void;
  destroy(): void;
  static readonly contentAttributes: Facet<Record<string, string>>;
  static readonly updateListener: Facet<(update: ViewUpdate) => void>;
}

export declare const basicSetup: Extension;
export declare const keymap: Facet<readonly KeyBinding[]>;
export declare const indentWithTab: KeyBinding;
export declare const oneDark: Extension;
export declare function javascript(config?: { jsx?: boolean; typescript?: boolean }): Extension;
export declare function html(): Extension;
export declare function css(): Extension;
export declare function json(): Extension;
