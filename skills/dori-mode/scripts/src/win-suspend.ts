// Windows has no SIGSTOP/SIGCONT. NtSuspendProcess/NtResumeProcess stop and resume every thread, using a handle opened
// with PROCESS_SUSPEND_RESUME. Keep handles as integers: a Windows HANDLE is not an FFI memory pointer.
import { dlopen, FFIType } from "bun:ffi";

const PROCESS_SUSPEND_RESUME = 0x0800;
type Native = { readonly open: (pid: number) => bigint; readonly suspend: (h: bigint) => number; readonly resume: (h: bigint) => number; readonly close: (h: bigint) => void };

let native: Native | undefined;
const load = (): Native => {
  if (native) return native;
  const k32 = dlopen("kernel32.dll", { OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 }, CloseHandle: { args: [FFIType.u64], returns: FFIType.bool } });
  const nt = dlopen("ntdll.dll", { NtSuspendProcess: { args: [FFIType.u64], returns: FFIType.i32 }, NtResumeProcess: { args: [FFIType.u64], returns: FFIType.i32 } });
  native = {
    open: (pid) => BigInt(k32.symbols.OpenProcess(PROCESS_SUSPEND_RESUME, false, pid)),
    suspend: (h) => nt.symbols.NtSuspendProcess(h),
    resume: (h) => nt.symbols.NtResumeProcess(h),
    close: (h) => void k32.symbols.CloseHandle(h),
  };
  return native;
};

export const winSignal = (pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean => {
  const n = load();
  const h = n.open(pid);
  if (!h) return false;
  try {
    return (sig === "SIGSTOP" ? n.suspend(h) : n.resume(h)) === 0;
  } finally {
    n.close(h);
  }
};
