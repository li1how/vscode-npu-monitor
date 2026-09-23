type Listener<T> = (event: T) => unknown;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  public readonly event = (listener: Listener<T>): { dispose: () => void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public fire(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

export class TreeItem {
  public description?: string;
  public iconPath?: unknown;
  public contextValue?: string;
  public id?: string;
  public tooltip?: unknown;

  public constructor(
    public readonly label: string,
    public readonly collapsibleState?: number,
  ) {}
}

export class ThemeIcon {
  public constructor(
    public readonly id: string,
    public readonly color?: unknown,
  ) {}
}

export class ThemeColor {
  public constructor(public readonly id: string) {}
}

export class MarkdownString {
  public value = '';

  public appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }

  public appendText(text: string): this {
    this.value += text.replace(/[\\`*_{}[\]()<>#+.!|]/g, '\\$&');
    return this;
  }
}

export const clipboardWrites: string[] = [];
export const clipboardFailures: unknown[] = [];
export const env = {
  language: 'en',
  remoteName: 'wsl',
  clipboard: {
    async writeText(value: string): Promise<void> {
      if (clipboardFailures.length) throw clipboardFailures.shift();
      clipboardWrites.push(value);
    },
  },
};

export const l10n = {
  t(template: string, ...values: unknown[]): string {
    return template.replace(/\{(\d+)\}/g, (_match, index: string) =>
      String(values[Number(index)] ?? ''),
    );
  },
};

export const informationMessages: string[] = [];
export const errorMessages: string[] = [];
export const executedCommands: string[] = [];
export const commandCalls: Array<{ command: string; args: unknown[] }> = [];
export const availableCommands = [
  'remote-containers.attachToRunningContainer', 'opensshremotes.openEmptyWindow',
];
export const commandFailures = new Map<string, unknown>();
export const configurationValues = new Map<string, unknown>();
export const createdTerminals: Array<{
  options: unknown;
  shown: boolean;
}> = [];
export const terminalFailures: unknown[] = [];

export const window = {
  quickPickAction: '',
  async showQuickPick(items: Array<{ label: string; action: string }>) {
    return items.find(item => item.action === window.quickPickAction);
  },
  createTerminal(options: unknown): { show: () => void } {
    if (terminalFailures.length > 0) {
      throw terminalFailures.shift();
    }
    const terminal = { options, shown: false };
    createdTerminals.push(terminal);
    return {
      show(): void {
        terminal.shown = true;
      },
    };
  },
  async showInformationMessage(message: string): Promise<undefined> {
    informationMessages.push(message);
    return undefined;
  },
  async showErrorMessage(message: string): Promise<undefined> {
    errorMessages.push(message);
    return undefined;
  },
};

export const workspace = {
  getConfiguration(section: string): {
    get: <T>(key: string, defaultValue?: T) => T | undefined;
    update: (key: string, value: unknown) => Promise<void>;
  } {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const fullKey = section + '.' + key;
        return (configurationValues.has(fullKey)
          ? configurationValues.get(fullKey)
          : defaultValue) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        configurationValues.set(section + '.' + key, value);
      },
    };
  },
};

export const commands = {
  async getCommands(): Promise<string[]> {
    return [...availableCommands];
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<undefined> {
    executedCommands.push(command);
    commandCalls.push({ command, args });
    if (commandFailures.has(command)) {
      throw commandFailures.get(command);
    }
    return undefined;
  },
};

export const Uri = {
  from(components: { scheme: string; authority: string; path: string }): typeof components {
    return { ...components };
  },
};

export function resetVscodeMock(): void {
  window.quickPickAction = '';
  clipboardWrites.length = 0;
  clipboardFailures.length = 0;
  informationMessages.length = 0;
  errorMessages.length = 0;
  executedCommands.length = 0;
  commandCalls.length = 0;
  availableCommands.splice(0, availableCommands.length,
    'remote-containers.attachToRunningContainer', 'opensshremotes.openEmptyWindow');
  commandFailures.clear();
  configurationValues.clear();
  createdTerminals.length = 0;
  terminalFailures.length = 0;
}
