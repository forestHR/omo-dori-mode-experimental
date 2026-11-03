import { win32 } from "node:path";

export const executableName = (path: string, platform: NodeJS.Platform = process.platform): string => {
  const name = win32.basename(path);
  return platform === "win32" ? name.toLowerCase() : name;
};

export const commandExecutable = (command: string): string => {
  const word = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return word?.[1] ?? word?.[2] ?? word?.[3] ?? "";
};

export const isOmoExecutable = (path: string, platform: NodeJS.Platform = process.platform): boolean =>
  /^omo(?:-windows-(?:x64|arm64))?(?:\.exe)?$/.test(executableName(path, platform));

export const isAgentCommand = (command: string): boolean =>
  isOmoExecutable(commandExecutable(command)) || /senpi[\\/]dist[\\/]bundle[\\/]cli\.js/i.test(command);
