import { closeSync, fsyncSync, openSync } from 'node:fs';

export function syncDirectory(directory, {
  platform = process.platform,
  open = openSync,
  fsync = fsyncSync,
  close = closeSync
} = {}) {
  if (platform === 'win32') {
    return { supported: false, reason: 'Node.js does not expose a portable Windows directory-handle flush.' };
  }
  const descriptor = open(directory, 'r');
  try {
    fsync(descriptor);
  } finally {
    close(descriptor);
  }
  return { supported: true };
}