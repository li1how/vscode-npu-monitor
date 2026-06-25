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

export const env = { remoteName: 'wsl' };

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
export const commandFailures = new Map<string, unknown>();
export const configurationValues = new Map<string, unknown>();
export const createdTerminals: Array<{
  options: unknown;
  shown: boolean;
}> = [];
export const terminalFailures: unknown[] = [];

export const window = {
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
  async executeCommand(command: string): Promise<undefined> {
    executedCommands.push(command);
    if (commandFailures.has(command)) {
      throw commandFailures.get(command);
    }
    return undefined;
  },
};

export function resetVscodeMock(): void {
  informationMessages.length = 0;
  errorMessages.length = 0;
  executedCommands.length = 0;
  commandFailures.clear();
  configurationValues.clear();
  createdTerminals.length = 0;
  terminalFailures.length = 0;
}
