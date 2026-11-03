export type Ran = { readonly code: number; readonly out: string; readonly err: string };
// env: variables set for this one command on top of the process environment; an undefined value removes the variable
// preserveOutput: stdout as printed, not trimmed (git status -z starts with a status column that may be a space)
export type RunOptions = { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string | undefined>>; readonly preserveOutput?: boolean };
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

// aoe and tmux can start the tmux server, and every pane it opens later inherits the server's environment: a Dori's
// variables (token, inbox, lead) handed to them would make every session, another Dori's included, run as this one.
// herdr's panes take the herdr server's environment too, so herdr gets the same.
export const childEnv = (argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> =>
  ["aoe", "tmux", "herdr"].includes(argv[0]?.split("/").pop() ?? "") ? Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("DORI_"))) : { ...env };

export const run: Runner = async (argv, opts = {}) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    // env: process.env explicitly, or Bun hands the child its start-up environment without what loadEnvFile added from dori.env
    const env = Object.fromEntries(Object.entries(childEnv(argv, opts.env ? { ...process.env, ...opts.env } : process.env)).filter(([, v]) => v !== undefined));
    p = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", env, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}) });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code: p.signalCode ? 124 : code, out: opts.preserveOutput ? out : out.trim(), err: (p.signalCode ? `killed by ${p.signalCode} (timeout)` : err).trim() };
};

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();
