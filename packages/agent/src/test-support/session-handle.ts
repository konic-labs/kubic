// The shape of the session store's handle the lane boots over: its storage,
// its metadata, and the adopt and release pair.
import type { Context, Storage } from '../pi-boundary.js';

// The handle, built directly (its type does not exist yet): storage,
// metadata and an idempotent release. The boot must treat release as the
// caller's job and only close the harness.
export type TestSession = {
  id: string;
  dir: string;
  storage: Storage;
  meta: { cwd: string; createdAt: string };
  adopt(): Storage;
  release(context: Context): Promise<void>;
};
