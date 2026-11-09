import type * as vscode from 'vscode';

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

  public async fireAsync(event: T): Promise<void> {
    await Promise.all([...this.listeners].map(listener => listener(event)));
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
export const registeredCommands = new Map<string, (...args: any[]) => unknown>();
export const quickPicks: TestQuickPick<any>[] = [];
export const inputBoxRequests: unknown[] = [];
export const inputBoxValues: Array<string | undefined> = [];
export const quickPickRequests: Array<{ items: unknown[]; options: unknown }> = [];
export const openDialogResults: Array<Array<{ fsPath: string }> | undefined> = [];
export const outputChannels: TestOutputChannel[] = [];
export const treeViews: TestTreeView<any>[] = [];
export const progressReports: Array<{ increment?: number; message?: string }> = [];
export const progressRequests: unknown[] = [];
const progressCancellation = new EventEmitter<void>();
export const progressToken = { isCancellationRequested: false, onCancellationRequested: progressCancellation.event };
export const ProgressLocation = { Notification: 15 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const configurationChanges = new EventEmitter<vscode.ConfigurationChangeEvent>();

export function cancelProgress(): void {
  progressToken.isCancellationRequested = true;
  progressCancellation.fire();
}

export async function fireConfigurationChange(...sections: string[]): Promise<void> {
  await configurationChanges.fireAsync({ affectsConfiguration: section => sections.some(changed =>
    changed === section || changed.startsWith(section + '.') || section.startsWith(changed + '.')) });
}

export class TestOutputChannel {
  public lines: string[] = [];
  public shown = false;
  public disposed = false;
  public appendLine(value: string): void { this.lines.push(value); }
  public show(): void { this.shown = true; }
  public dispose(): void { this.disposed = true; }
}

export class TestTreeView<T> {
  public selection: readonly T[] = [];
  public message: string | undefined;
  public badge?: { value: number; tooltip: string };
  public disposed = false;
  public constructor(public readonly provider: vscode.TreeDataProvider<T>) {}
  public async reveal(): Promise<void> {}
  public dispose(): void { this.disposed = true; }
}

export class TestQuickPick<T extends { label: string }> {
  public title = '';
  public placeholder = '';
  public matchOnDescription = false;
  public matchOnDetail = false;
  public items: readonly T[] = [];
  public activeItems: readonly T[] = [];
  public selectedItems: readonly T[] = [];
  public disposed = false;
  public shown = false;
  private readonly acceptEmitter = new EventEmitter<void>();
  private readonly hideEmitter = new EventEmitter<void>();
  public readonly onDidAccept = this.acceptEmitter.event;
  public readonly onDidHide = this.hideEmitter.event;
  public show(): void { this.shown = true; }
  public hide(): void { this.hideEmitter.fire(); }
  public accept(): void { this.acceptEmitter.fire(); }
  public dispose(): void {
    this.disposed = true;
    this.acceptEmitter.dispose();
    this.hideEmitter.dispose();
  }
}

export const window = {
  quickPickAction: '',
  createOutputChannel(): TestOutputChannel {
    const output = new TestOutputChannel();
    outputChannels.push(output);
    return output;
  },
  createTreeView<T>(_id: string, options: { treeDataProvider: vscode.TreeDataProvider<T> }): TestTreeView<T> {
    const tree = new TestTreeView(options.treeDataProvider);
    treeViews.push(tree);
    return tree;
  },
  async withProgress<T>(options: unknown, task: (
    progress: { report: (value: { increment?: number; message?: string }) => void },
    token: typeof progressToken,
  ) => Thenable<T>): Promise<T> {
    progressRequests.push(options);
    return task({ report: value => progressReports.push(value) }, progressToken);
  },
  async showOpenDialog(): Promise<Array<{ fsPath: string }> | undefined> { return openDialogResults.shift(); },
  async showQuickPick<T extends { label: string; action?: string; filter?: string }>(items: T[], options?: unknown) {
    quickPickRequests.push({ items, options });
    return items.find(item => (item.action ?? item.filter ?? item.label) === window.quickPickAction);
  },
  createQuickPick<T extends { label: string }>(): TestQuickPick<T> {
    const picker = new TestQuickPick<T>();
    quickPicks.push(picker);
    return picker;
  },
  async showInputBox(options: unknown): Promise<string | undefined> {
    inputBoxRequests.push(options);
    return inputBoxValues.shift();
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
  onDidChangeConfiguration: configurationChanges.event,
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
  registerCommand(command: string, handler: (...args: any[]) => unknown): { dispose: () => void } {
    registeredCommands.set(command, handler);
    return { dispose: () => { registeredCommands.delete(command); } };
  },
  async getCommands(): Promise<string[]> {
    return [...availableCommands];
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    executedCommands.push(command);
    commandCalls.push({ command, args });
    if (commandFailures.has(command)) {
      throw commandFailures.get(command);
    }
    return registeredCommands.get(command)?.(...args);
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
  registeredCommands.clear();
  quickPicks.length = 0;
  inputBoxRequests.length = 0;
  inputBoxValues.length = 0;
  quickPickRequests.length = 0;
  openDialogResults.length = 0;
  outputChannels.length = 0;
  treeViews.length = 0;
  progressReports.length = 0;
  progressRequests.length = 0;
  progressToken.isCancellationRequested = false;
  progressCancellation.dispose();
  configurationChanges.dispose();
}
