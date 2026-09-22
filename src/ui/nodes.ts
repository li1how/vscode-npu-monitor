import type { DevContainer, HostRecord, NpuDevice } from '../types.js';

export class HostNode {
  public constructor(public readonly record: HostRecord) {}
}

export class DeviceNode {
  public constructor(
    public readonly record: HostRecord,
    public readonly device: NpuDevice,
  ) {}
}

export class GroupNode {
  public constructor(public readonly record: HostRecord, public readonly kind: 'npu' | 'containers') {}
}

export class ContainerNode {
  public constructor(
    public readonly record: HostRecord,
    public readonly container: DevContainer,
    public readonly duplicateName = false,
  ) {}
}

export class StatusNode {
  public constructor(public readonly text: string) {}
}

export class McpNode {
  public constructor(public readonly state: string, public readonly tooltip: string) {}
}

export type MonitorNode = McpNode | HostNode | DeviceNode | GroupNode | ContainerNode | StatusNode;
