import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// dori-superagent issue #48 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/48
// The real install.sh over a clone of a local upstream; a stub bun stands in for bun install and bun link.
const script = resolve(import.meta.dir, "../../../../install.sh");
const gitEnv = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, ...argv: string[]): string => {
  const r = Bun.spawnSync(["git", ...argv], { cwd, env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "dori-install-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  const src = join(root, "src");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const file = "skills/dori-mode/scripts/src/cli.ts";
  mkdirSync(join(upstream, "skills/dori-mode/scripts/src"), { recursive: true });
  mkdirSync(join(upstream, "skills/dori-mode/references"), { recursive: true });
  writeFileSync(join(upstream, file), "v1\n");
  writeFileSync(join(upstream, "skills/dori-mode/references/config.example.json"), "{}\n");
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "v1");
  git(root, "clone", "-q", upstream, src);
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "bun"), 0o755);
  const commitUpstream = (text: string) => {
    writeFileSync(join(upstream, file), text);
    git(upstream, "commit", "-qam", text.trim());
  };
  const install = (env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bash", script], { env: { ...gitEnv, HOME: home, DORI_REPO: upstream, DORI_SRC: src, SKILLS_DIR: join(home, "skills"), PATH: `${bin}:${gitEnv.PATH}`, ...env } });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  return { upstream, src, file, commitUpstream, install };
};

test("install.sh over a clean checkout pulls upstream", () => {
  const { upstream, src, commitUpstream, install } = setup();
  commitUpstream("v2\n");
  expect(install().code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

test("a local edit in the way of the pull stops install.sh with the checkout, the file and both ways on", () => {
  const { src, file, commitUpstream, install } = setup();
  commitUpstream("v2\n");
  writeFileSync(join(src, file), "patched\n");
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain(`could not update ${src}`);
  expect(r.err).toContain(` M ${file}`);
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(r.err).toContain(`git -C "${src}" fetch && git -C "${src}" reset --hard '@{u}'`);
  expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
});

test("a local commit upstream lacks stops install.sh with that commit listed; DORI_NO_PULL=1 then installs without updating", () => {
  const { src, file, commitUpstream, install } = setup();
  writeFileSync(join(src, "local.txt"), "mine\n");
  git(src, "add", "local.txt");
  git(src, "commit", "-qm", "my local commit");
  const mine = git(src, "rev-parse", "HEAD");
  commitUpstream("v2\n");
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain("Local commits upstream lacks:");
  expect(r.err).toContain("my local commit");
  expect(git(src, "rev-parse", "HEAD")).toBe(mine);
  expect(install({ DORI_NO_PULL: "1" }).code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(mine);
  expect(readFileSync(join(src, file), "utf8")).toBe("v1\n");
});

test("a pull that fails with nothing local to list still gives both ways on, and says git's message is the reason", () => {
  const { src, commitUpstream, install } = setup();
  commitUpstream("v2\n");
  writeFileSync(join(src, ".git/index.lock"), "");
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain(`could not update ${src} with git pull --ff-only; git's message above says why.`);
  expect(r.err).not.toContain("Local changes in that checkout");
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(r.err).toContain("If local work there is in the way");
});

test("an edit hidden from git status (assume-unchanged) still gets the way to install the checkout as it is", () => {
  const { src, file, commitUpstream, install } = setup();
  git(src, "update-index", "--assume-unchanged", file);
  writeFileSync(join(src, file), "patched\n");
  commitUpstream("v2\n");
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
});

test("a checkout's pull.autostash, merge.autostash or pull.twohead=ours does not turn the update into a stash pop or a merge commit", () => {
  for (const key of ["pull.autostash", "merge.autostash"]) {
    const { src, file, commitUpstream, install } = setup();
    git(src, "config", key, "true");
    writeFileSync(join(src, file), "patched\n");
    commitUpstream("v2\n");
    const before = git(src, "rev-parse", "HEAD");
    const r = install();
    expect([key, r.code]).toEqual([key, 1]);
    expect(r.err).toContain("DORI_NO_PULL=1");
    expect(git(src, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
  }
  const { upstream, src, file, commitUpstream, install } = setup();
  git(src, "config", "merge.autostash", "true");
  git(src, "config", "pull.twohead", "ours");
  writeFileSync(join(src, file), "patched\n");
  commitUpstream("v2\n");
  const stashed = install();
  expect(stashed.code).toBe(1);
  expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
  git(src, "checkout", "-q", "--", file);
  expect(install().code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

test("an upstream rename of a locally edited file lists the edit; an upstream branch that is gone stops the install", () => {
  const { upstream, src, file, install } = setup();
  git(upstream, "mv", file, `${file}.moved`);
  git(upstream, "commit", "-qm", "move");
  writeFileSync(join(src, file), "patched\n");
  const renamed = install();
  expect(renamed.code).toBe(1);
  expect(renamed.err).toContain(` M ${file}`);
  expect(renamed.err).toContain("DORI_NO_PULL=1");
  git(src, "checkout", "-q", "--", file);
  git(upstream, "checkout", "-q", "-b", "other");
  git(upstream, "branch", "-q", "-D", "main");
  const before = git(src, "rev-parse", "HEAD");
  const gone = install();
  expect(gone.code).toBe(1);
  expect(gone.err).toContain(`could not update ${src}`);
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
});

test("an untracked file in the way is listed even when the checkout hides untracked files from git status", () => {
  const { upstream, src, install } = setup();
  git(src, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(upstream, "new.txt"), "theirs\n");
  git(upstream, "add", "new.txt");
  git(upstream, "commit", "-qm", "add new.txt");
  writeFileSync(join(src, "new.txt"), "mine\n");
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain("?? new.txt");
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(readFileSync(join(src, "new.txt"), "utf8")).toBe("mine\n");
});

test("DORI_NO_PULL=1 installs the checkout as it is, local edit and all", () => {
  const { src, file, commitUpstream, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  commitUpstream("v2\n");
  writeFileSync(join(src, file), "patched\n");
  const r = install({ DORI_NO_PULL: "1" });
  expect(r.code).toBe(0);
  expect(r.err).toContain("DORI_NO_PULL=1: installing");
  expect(git(src, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
});

// dori-superagent PR #85 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/pull/85
test("DORI_NO_PULL=true and DORI_NO_PULL=yes install the checkout as it is like DORI_NO_PULL=1; DORI_NO_PULL=0 still pulls", () => {
  const { upstream, src, commitUpstream, install } = setup();
  const before = git(src, "rev-parse", "HEAD");
  commitUpstream("v2\n");
  for (const value of ["true", "yes"]) {
    const r = install({ DORI_NO_PULL: value });
    expect(r.code).toBe(0);
    expect(r.err).toContain(`DORI_NO_PULL=${value}: installing`);
    expect(git(src, "rev-parse", "HEAD")).toBe(before);
  }
  expect(install({ DORI_NO_PULL: "0" }).code).toBe(0);
  expect(git(src, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
});

// dori-superagent PR #85 (MIT): https://github.com/sisyphuslabs/dori-superagent/pull/85
test("a branch with no upstream gets git's reason and the way to install as it is, never a reset to an upstream it lacks", () => {
  const { src, file, install } = setup();
  writeFileSync(join(src, file), "patched\n");
  git(src, "branch", "--unset-upstream");
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain("git's message above says why");
  expect(r.err).toContain("DORI_NO_PULL=1");
  expect(r.err).not.toContain("reset --hard");
  expect(readFileSync(join(src, file), "utf8")).toBe("patched\n");
});
