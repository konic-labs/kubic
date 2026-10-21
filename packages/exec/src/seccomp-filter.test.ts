// The Unix-socket seccomp filter, run through a small classic-BPF interpreter
// over hand-built `struct seccomp_data` records: which calls it refuses, on
// each ABI an x64 or arm64 process can use.

import { describe, expect, it } from 'vitest';
import { unixSocketFilter } from './seccomp-filter.js';

const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;

// Runs `program` over one call: the number, the architecture and the first
// argument, as the kernel lays them out.
function verdict(
  program: Uint8Array,
  call: { nr: number; arch: number; arg0: number },
): number {
  const data = new DataView(new ArrayBuffer(64));
  data.setUint32(0, call.nr >>> 0, true);
  data.setUint32(4, call.arch >>> 0, true);
  data.setUint32(16, call.arg0 >>> 0, true);
  const code = new DataView(program.buffer);
  let accumulator = 0;
  for (let pc = 0; pc < program.length / 8; pc++) {
    const op = code.getUint16(pc * 8, true);
    const jt = code.getUint8(pc * 8 + 2);
    const jf = code.getUint8(pc * 8 + 3);
    const k = code.getUint32(pc * 8 + 4, true);
    if (op === 0x20) accumulator = data.getUint32(k, true);
    else if (op === 0x54) accumulator = (accumulator & k) >>> 0;
    else if (op === 0x15) pc += accumulator === k ? jt : jf;
    else if (op === 0x06) return k;
    else throw new Error(`unexpected instruction ${op.toString(16)}`);
  }
  throw new Error('the program fell off its end');
}

const X86_64 = 0xc000003e;
const I386 = 0x40000003;
const AARCH64 = 0xc00000b7;
const ARM = 0x40000028;
const AF_UNIX = 1;
const AF_INET = 2;

describe('unixSocketFilter', () => {
  it('refuses a Unix socket on x64, x32 and i386, and nothing else', () => {
    const program = unixSocketFilter('x64') as Uint8Array;
    const run = (nr: number, arch: number, arg0: number) =>
      verdict(program, { nr, arch, arg0 });
    expect(run(41, X86_64, AF_UNIX)).toBe(EPERM);
    expect(run(41, X86_64, AF_INET)).toBe(ALLOW);
    // socketpair, connect and read stay open.
    expect(run(53, X86_64, AF_UNIX)).toBe(ALLOW);
    expect(run(42, X86_64, 3)).toBe(ALLOW);
    expect(run(0, X86_64, AF_UNIX)).toBe(ALLOW);
    // x32: the same number with bit 30 set.
    expect(run(41 | 0x40000000, X86_64, AF_UNIX)).toBe(EPERM);
    // i386: socket(), and socketcall's socket() whose domain it cannot see.
    expect(run(359, I386, AF_UNIX)).toBe(EPERM);
    expect(run(359, I386, AF_INET)).toBe(ALLOW);
    expect(run(102, I386, 1)).toBe(EPERM);
    expect(run(102, I386, 3)).toBe(ALLOW);
    // io_uring, whose requests seccomp never sees.
    expect(run(425, X86_64, 0)).toBe(EPERM);
    expect(run(425, I386, 0)).toBe(EPERM);
    // A foreign architecture is let through.
    expect(run(41, AARCH64, AF_UNIX)).toBe(ALLOW);
  });

  it('refuses a Unix socket on arm64 and arm', () => {
    const program = unixSocketFilter('arm64') as Uint8Array;
    const run = (nr: number, arch: number, arg0: number) =>
      verdict(program, { nr, arch, arg0 });
    expect(run(198, AARCH64, AF_UNIX)).toBe(EPERM);
    expect(run(198, AARCH64, AF_INET)).toBe(ALLOW);
    expect(run(199, AARCH64, AF_UNIX)).toBe(ALLOW);
    expect(run(281, ARM, AF_UNIX)).toBe(EPERM);
    expect(run(425, AARCH64, 0)).toBe(EPERM);
    expect(run(41, X86_64, AF_UNIX)).toBe(ALLOW);
  });

  it('has no filter for another architecture', () => {
    expect(unixSocketFilter('ia32')).toBeUndefined();
    expect(unixSocketFilter('ppc64')).toBeUndefined();
  });
});
