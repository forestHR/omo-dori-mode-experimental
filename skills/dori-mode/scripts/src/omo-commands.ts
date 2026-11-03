import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The /names omo runs through its prompt path besides its own commands (senpi core/agent-session.js
// _rejectUnknownCommand resolves extension commands, prompt templates and skill:<name>; a built-in reaching that path is
// refused as interactive-only, so built-ins are judged on the whole text by isOmoCommand instead). Read off disk where
// omo finds them: templates in the agent directory's prompts, skills in its skills and ~/.agents/skills. A name found
// nowhere here (another extension's command, a project's own .senpi/skills or prompts) counts as unknown: dori type then
// presses no key, so a missing name costs a NOT_SUBMITTED, never a text sent as a message.
const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export const promptCommandNames = (agentDir: string, home: string = homedir()): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const file of entries(join(agentDir, "prompts"))) if (file.endsWith(".md")) out.add(file.slice(0, -3));
  for (const root of [join(agentDir, "skills"), join(home, ".agents", "skills")])
    for (const entry of entries(root)) {
      if (entry.endsWith(".md")) out.add(`skill:${entry.slice(0, -3)}`);
      else if (existsSync(join(root, entry, "SKILL.md"))) out.add(`skill:${entry}`);
    }
  return out;
};

// omo's agent directory holds its sessions directory (dori's config.sessionsDir)
export const agentDirOf = (sessionsDir: string): string => dirname(sessionsDir);
