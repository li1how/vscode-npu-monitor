import * as vscode from 'vscode';

import { activate as activateExtension, deactivate } from '../../src/extension.js';
import { CAPTURE_TIME } from './fixtures.js';

// Freeze only the isolated Extension Host's clock, not the UI automation clock.
Date.now = () => CAPTURE_TIME;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await activateExtension(context);
  await vscode.commands.executeCommand('workbench.view.extension.npuMonitor');
}

export { deactivate };
