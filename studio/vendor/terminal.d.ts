// Hand-written types for terminal.js (xterm.js + its fit addon, bundled by scripts/vendor): only what the
// studio uses, with xterm's names.
export interface ITheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface ITerminalOptions {
  convertEol?: boolean;
  cursorBlink?: boolean;
  fontFamily?: string;
  fontSize?: number;
  screenReaderMode?: boolean;
  theme?: ITheme;
}

export interface IDisposable {
  dispose(): void;
}

export interface ITerminalAddon extends IDisposable {
  activate(terminal: Terminal): void;
}

export declare class Terminal {
  constructor(options?: ITerminalOptions);
  options: ITerminalOptions;
  readonly textarea: HTMLTextAreaElement | undefined;
  open(parent: HTMLElement): void;
  loadAddon(addon: ITerminalAddon): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  writeln(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): IDisposable;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}

export declare class FitAddon implements ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
  fit(): void;
}
