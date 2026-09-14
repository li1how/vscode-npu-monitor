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

export type MonitorNode = HostNode | DeviceNode | GroupNode | ContainerNode | StatusNode;
