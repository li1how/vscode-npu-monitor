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

export const window = {
  async showInformationMessage(message: string): Promise<undefined> {
    informationMessages.push(message);
    return undefined;
  },
  async showErrorMessage(message: string): Promise<undefined> {
    errorMessages.push(message);
    return undefined;
  },
};

export const commands = {
  async executeCommand(command: string): Promise<undefined> {
    executedCommands.push(command);
    return undefined;
  },
};

export function resetVscodeMock(): void {
  informationMessages.length = 0;
  errorMessages.length = 0;
  executedCommands.length = 0;
}
