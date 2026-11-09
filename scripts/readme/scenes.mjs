import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import path from 'node:path';
import sharp from 'sharp';

export const ASSETS = ['host-search-and-filter.gif', 'monitoring.png', 'idle-history.png'];

export async function captureScenes(window, output) {
  window.setDefaultTimeout(15000);
  await window.setViewportSize({ width: 1600, height: 820 });
  const clip = { x: 48, y: 30, width: 1100, height: 550 };
  const frames = [];
  const delays = [];
  const row = alias => window.getByRole('treeitem').filter({ hasText: alias });
  const command = async label => {
    await window.keyboard.press('F1');
    await window.locator('.quick-input-widget input').fill('>' + label);
    await window.keyboard.press('Enter');
  };
  const expand = async (alias, expanded) => {
    const item = row(alias);
    if (await item.getAttribute('aria-expanded') !== String(expanded)) {
      await item.locator('.monaco-tl-twistie').click();
      await window.locator(`[role="treeitem"][aria-expanded="${expanded}"]`)
        .filter({ hasText: alias }).waitFor();
    }
  };
  const resizeSidebar = async right => {
    const box = await window.locator('.part.sidebar').boundingBox();
    await window.mouse.move(box.x + box.width, 650);
    await window.mouse.down();
    await window.mouse.move(right, 650, { steps: 15 });
    await window.mouse.up();
  };
  const settle = async () => {
    await window.mouse.move(1550, 780);
    // Allow workbench layout and its hover/selection animations to settle.
    await window.waitForTimeout(350);
  };
  const frame = async (name, delay) => {
    await settle();
    const png = await window.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    frames.push(await sharp(png).ensureAlpha().raw().toBuffer());
    delays.push(delay);
    console.log('Captured ' + name);
  };

  await row('ascend-a3-01').waitFor();
  await resizeSidebar(1148);
  await frame('hosts', 1700);
  await expand('ascend-a3-01', true);
  await row('NPU 7').waitFor();
  await frame('devices', 2500);
  await row('vllm-ascend-dev').click();
  await row('vllm-ascend-dev').hover();
  await window.waitForTimeout(150);
  await window.screenshot({ path: path.join(output, 'monitoring.png'), clip: { ...clip, height: 480 }, animations: 'disabled', caret: 'hide' });

  await command('NPU Monitor: Filter Hosts');
  const idleFilter = window.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Hosts with idle NPUs' });
  await idleFilter.waitFor();
  await frame('choose-filter', 1400);
  await idleFilter.click();
  await window.getByText('Hosts with idle NPUs · 3 / 4 hosts', { exact: true }).waitFor();
  assert.equal(await row('ascend-a5-01').count(), 0, 'Busy host must be hidden by the idle filter');
  await frame('idle-filter', 2100);

  await command('NPU Monitor: Find Host');
  const input = window.locator('.quick-input-widget input');
  await input.fill('ascend');
  await frame('search-all', 700);
  await input.fill('ascend-a5');
  await frame('search', 1700);
  await window.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'ascend-a5-01' }).click();
  await window.getByText('All hosts · 4 / 4 hosts', { exact: true }).waitFor();
  await row('ascend-a5-01').waitFor();
  await expand('ascend-a3-01', false);
  await expand('ascend-a5-01', true);
  await frame('reveal', 2100);

  await resizeSidebar(500);
  await command('NPU Monitor: Show Idle History');
  await window.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'ascend-a3-01' }).click();
  await window.getByRole('tab').filter({ hasText: 'Idle history: ascend-a3-01' }).waitFor();
  const history = window.frameLocator('iframe.webview').frameLocator('iframe#active-frame');
  await history.getByRole('heading', { name: 'Idle history: ascend-a3-01', exact: true }).waitFor();
  assert.equal(await history.locator('.row').count(), 16, 'History must contain eight cards across two days');
  await settle();
  await window.screenshot({ path: path.join(output, 'idle-history.png'), clip: { x: 500, y: 30, width: 1100, height: 700 }, animations: 'disabled', caret: 'hide' });

  await sharp(Buffer.concat(frames), {
    raw: { width: clip.width, height: clip.height * frames.length, channels: 4, pageHeight: clip.height },
  }).gif({ delay: delays, loop: 0, effort: 7, colours: 128 })
    .toFile(path.join(output, ASSETS[0]));
  for (const asset of ASSETS) {
    const metadata = await sharp(path.join(output, asset), { animated: true }).metadata();
    assert.equal(metadata.width, 1100, asset);
    if (asset.endsWith('.gif')) assert.equal(metadata.pages, frames.length, 'GIF frame count');
  }
}
