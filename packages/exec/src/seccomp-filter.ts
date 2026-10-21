// The seccomp filter bubblewrap loads into a sandboxed command whose network
// is closed: creating a Unix socket fails with EPERM, so the command cannot
// reach a local service outside the sandbox (the session bus, an SSH or GPG
// agent, the Docker daemon, a terminal multiplexer), as Seatbelt rules such a
// connection network on macOS. A socket pair, how a process talks to its own
// children, is not affected. io_uring is refused too: seccomp never sees the
// requests it carries.
//
// A classic BPF program over `struct seccomp_data` (the call number at 0, the
// architecture at 4, the first argument's low word at 16), for the host's
// architecture and its 32-bit compatibility one.

const LD_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const AND_K = 0x54; // BPF_ALU | BPF_AND | BPF_K
const JEQ_K = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const RET_K = 0x06; // BPF_RET | BPF_K
const ALLOW = 0x7fff0000; // SECCOMP_RET_ALLOW
const REFUSE = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
const NR = 0;
const ARCH = 4;
const ARG0 = 16;
const AF_UNIX = 1;
const SYS_SOCKET = 1; // socketcall's call number for socket()
const IO_URING_SETUP = 425; // the same number in every ABI below

interface Abi {
  readonly arch: number;
  readonly socket: number;
  readonly socketcall?: number;
  readonly mask?: number;
}

// The ABIs a process on this architecture can enter the kernel through.
const ABIS: Readonly<Record<string, readonly Abi[]>> = {
  x64: [
    // An x32 call sets bit 30 of the number; the mask folds it in.
    { arch: 0xc000003e, socket: 41, mask: 0xbfffffff },
    { arch: 0x40000003, socket: 359, socketcall: 102 },
  ],
  arm64: [
    { arch: 0xc00000b7, socket: 198 },
    { arch: 0x40000028, socket: 281 },
  ],
};

type Step =
  | { readonly label: string }
  | {
      readonly code: number;
      readonly k: number;
      readonly yes?: string;
    };

// Lays the steps out as `struct sock_filter` entries (little-endian, as on
// both architectures), resolving each jump to its label.
function assemble(steps: readonly Step[]): Uint8Array {
  const at = new Map<string, number>();
  const insns: Exclude<Step, { label: string }>[] = [];
  for (const step of steps) {
    if ('label' in step) at.set(step.label, insns.length);
    else insns.push(step);
  }
  const view = new DataView(new ArrayBuffer(insns.length * 8));
  insns.forEach((insn, index) => {
    const target = insn.yes === undefined ? undefined : at.get(insn.yes);
    view.setUint16(index * 8, insn.code, true);
    view.setUint8(index * 8 + 2, target === undefined ? 0 : target - index - 1);
    view.setUint8(index * 8 + 3, 0);
    view.setUint32(index * 8 + 4, insn.k >>> 0, true);
  });
  return new Uint8Array(view.buffer);
}

/** The filter for `arch` (`process.arch`), or undefined for another one. */
export function unixSocketFilter(
  arch: string = process.arch,
): Uint8Array | undefined {
  const abis = ABIS[arch];
  if (abis === undefined) return undefined;
  const steps: Step[] = [{ code: LD_ABS, k: ARCH }];
  abis.forEach((abi, index) => {
    steps.push({ code: JEQ_K, k: abi.arch, yes: `abi${index}` });
  });
  steps.push({ code: RET_K, k: ALLOW });
  abis.forEach((abi, index) => {
    steps.push({ label: `abi${index}` }, { code: LD_ABS, k: NR });
    if (abi.mask !== undefined) steps.push({ code: AND_K, k: abi.mask });
    steps.push(
      { code: JEQ_K, k: abi.socket, yes: 'domain' },
      { code: JEQ_K, k: IO_URING_SETUP, yes: 'refuse' },
    );
    if (abi.socketcall !== undefined) {
      steps.push({ code: JEQ_K, k: abi.socketcall, yes: 'socketcall' });
    }
    steps.push({ code: RET_K, k: ALLOW });
  });
  if (abis.some((abi) => abi.socketcall !== undefined)) {
    steps.push(
      { label: 'socketcall' },
      { code: LD_ABS, k: ARG0 },
      { code: JEQ_K, k: SYS_SOCKET, yes: 'refuse' },
      { code: RET_K, k: ALLOW },
    );
  }
  steps.push(
    { label: 'domain' },
    { code: LD_ABS, k: ARG0 },
    { code: JEQ_K, k: AF_UNIX, yes: 'refuse' },
    { code: RET_K, k: ALLOW },
    { label: 'refuse' },
    { code: RET_K, k: REFUSE },
  );
  return assemble(steps);
}
