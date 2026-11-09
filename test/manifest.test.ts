import { readFileSync, readdirSync } from 'node:fs';

import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';

import manifest from '../package.json';
import english from '../package.nls.json';
import chinese from '../package.nls.zh-cn.json';
import translations from '../l10n/bundle.l10n.zh-cn.json';
import { getSettings } from '../src/settings.js';
import { resetVscodeMock } from './mocks/vscode.js';

const title = manifest.contributes.menus['view/title'];
const context = manifest.contributes.menus['view/item/context'];

beforeEach(resetVscodeMock);

describe('manifest and localization contracts', () => {
  it('keeps every manifest string translated in both languages', () => {
    const keys = [...new Set([...JSON.stringify(manifest).matchAll(/%([^%\n]+)%/g)].map(match => match[1]))].sort();
    expect(Object.keys(english).sort()).toEqual(keys);
    expect(Object.keys(chinese).sort()).toEqual(keys);
    for (const strings of [english, chinese]) {
      expect(Object.values(strings).every(value => value.trim().length > 0)).toBe(true);
    }
  });

  it('keeps runtime translations and their placeholders in sync with source messages', () => {
    const messages = new Set<string>();
    for (const file of readdirSync('src', { recursive: true }).filter(file => String(file).endsWith('.ts'))) {
      const filename = 'src/' + file;
      const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.l10n.t') {
          const message = node.arguments[0];
          if (message && ts.isStringLiteralLike(message)) messages.add(message.text);
          else throw new Error('Use a literal translation key in ' + filename);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(messages.size).toBeGreaterThan(0);
    expect(Object.keys(translations).sort()).toEqual([...messages].sort());
    const placeholders = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();
    for (const [message, translation] of Object.entries(translations)) {
      expect(translation.trim().length, message).toBeGreaterThan(0);
      expect(placeholders(translation), message).toEqual(placeholders(message));
    }
  });

  it('matches runtime defaults to contributed settings', () => {
    const names: Record<string, string> = {
      devContainersEnabled: 'devContainers.enabled',
      devContainersTimeoutSeconds: 'devContainers.timeoutSeconds',
      containerFilterMode: 'containers.filterMode',
      containerWorkspacePaths: 'containers.workspacePaths',
      containerWorkspaceFile: 'containers.workspaceFile',
    };
    const properties: Record<string, { default: unknown }> = manifest.contributes.configuration.properties;
    const { remoteSshConfigFile, ...settings } = getSettings();
    expect(remoteSshConfigFile).toBe('');
    for (const [key, value] of Object.entries(settings)) {
      expect(value, key).toEqual(properties['npuMonitor.' + (names[key] ?? key)]!.default);
    }
  });

  it('keeps host discovery in the title and scanning, subscriptions and history beside each host', () => {
    const group = (items: ReadonlyArray<{ command: string; group: string }>, command: string) =>
      items.find(item => item.command === 'npuMonitor.' + command)?.group;
    for (const [command, expected] of [
      ['scanAll', 'navigation@1'], ['findHost', 'navigation@2'], ['filterHosts', 'navigation@3'],
      ['clearHostFilter', 'navigation@4'], ['reloadConfig', '2_actions@3'], ['selectSshConfig', '2_actions@2'],
    ]) expect(group(title, command!)).toBe(expected);
    expect(group(title, 'openSettings')).not.toMatch(/^navigation/);
    expect(manifest.contributes.commands.some(item => item.command === 'npuMonitor.chooseIdleHost')).toBe(false);
    for (const [command, expected] of [
      ['scanHost', 'inline@1'], ['subscribeHost', 'inline@2'], ['unsubscribeHost', 'inline@2'],
      ['showIdleHistory', 'inline@3'], ['openSshTerminal', '2_open@2'], ['openSshWindow', '2_open@1'],
    ]) expect(group(context, command!)).toBe(expected);
    for (const command of ['favoriteHost', 'editHostNote']) expect(group(context, command)).not.toMatch(/^inline/);
    expect(title.find(item => item.command === 'npuMonitor.clearHostFilter')!.when)
      .toContain('npuMonitor.hostFilterActive');
    for (const [command, value] of [
      ['subscribeHost', 'npuHostUnsubscribedFavorite'], ['unsubscribeHost', 'npuHostSubscribedFavorite'],
    ]) {
      const when = context.find(item => item.command === 'npuMonitor.' + command)!.when;
      const expression = when.match(/viewItem =~ \/(.+)\//)![1]!;
      expect(new RegExp(expression).test(value!)).toBe(true);
    }
  });

  it('keeps host copying in its context menu and container summaries on the inline button', () => {
    expect(context.filter(item => item.command === 'npuMonitor.copyHostInfo')).toEqual([{
      command: 'npuMonitor.copyHostInfo',
      when: 'view == npuMonitor.hosts && viewItem =~ /^npuHost/',
      group: '3_copy@1',
    }]);
    expect(context.filter(item => item.command.startsWith('npuMonitor.copyContainer'))).toEqual([
      { command: 'npuMonitor.copyContainerSummary', group: 'inline@2',
        when: 'view == npuMonitor.hosts && viewItem =~ /^npuDevContainer/' },
      { command: 'npuMonitor.copyContainerInfo', group: '3_copy@1',
        when: 'view == npuMonitor.hosts && viewItem =~ /^npuDevContainer/' },
    ]);
    for (const command of ['copyHostInfo', 'copyContainerSummary', 'copyContainerInfo']) {
      expect(manifest.contributes.commands).toContainEqual({ command: 'npuMonitor.' + command,
        title: '%command.' + command + '%', icon: '$(copy)' });
    }
    expect(english['command.copyHostInfo']).toBe('Copy Host Information');
    expect(chinese['command.copyHostInfo']).toBe('复制主机信息');
    expect(chinese['command.copyContainerSummary']).toBe('复制精简信息');
    expect(chinese['command.copyContainerInfo']).toBe('复制完整信息');
  });
});
