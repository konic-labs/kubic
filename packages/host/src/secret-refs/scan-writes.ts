// Data loss prevention at rest: a bridge wrapper that runs the secret scanner
// over every text a session writes — its transcript storage, the run's
// trajectory, its spans — so a secret a tool read is stored redacted. The
// change journal is left verbatim: it holds the content `kubic undo` puts
// back, and an undo must restore the file as it was, secret included.

import { scanSecrets } from '@kubic/core/secret-scan';
import type { FileBridge } from '@kubic/exec/file-bridge';

function journaled(path: string): boolean {
  return /(^|[/\\])journal([/\\]|$)/.test(path);
}

/**
 * `bridge` with its text writes scanned; `onFound` hears how many values each
 * write redacted.
 */
export function scanBridgeWrites(
  bridge: FileBridge,
  onFound: (found: number) => void = () => undefined,
): FileBridge {
  const scan = (
    path: string,
    content: string | Uint8Array,
  ): string | Uint8Array => {
    if (typeof content !== 'string' || journaled(path)) return content;
    const scanned = scanSecrets(content);
    if (scanned.found > 0) onFound(scanned.found);
    return scanned.text;
  };
  const durable = bridge.appendDurably?.bind(bridge);
  return {
    ...bridge,
    writeFile: (path, content, options) =>
      bridge.writeFile(path, scan(path, content), options),
    appendFile: (path, content, options) =>
      bridge.appendFile(path, scan(path, content), options),
    ...(durable === undefined
      ? {}
      : {
          appendDurably: (
            path: string,
            content: string | Uint8Array,
            options?: { mode?: number },
          ) => durable(path, scan(path, content), options),
        }),
  };
}
