/** Only host-owned presentation variables may cross the embedding message. */
const hostProperties = new Set([
  '--embed-bg', '--embed-panel', '--embed-surface', '--embed-border', '--embed-text',
  '--embed-muted', '--embed-subtle', '--embed-hover', '--embed-active', '--embed-accent',
  '--embed-primary', '--embed-primary-text', '--embed-radius', '--embed-control-radius', '--embed-font',
]);

/** Read the explicit presentation allowlist without accepting arbitrary inline styles. */
export function readHostTheme(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => hostProperties.has(key) && typeof item === 'string' && item.trim()));
}
