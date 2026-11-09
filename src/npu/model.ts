export function normalizeNpuModel(model: string | null | undefined): string | undefined {
  return model?.trim() || undefined;
}
