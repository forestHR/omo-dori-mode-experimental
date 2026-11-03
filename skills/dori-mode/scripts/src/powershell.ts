// PowerShell recognizes ASCII and typographic single quotes as delimiters.
export const powershellLiteral = (value: string): string => `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;

// A string as PowerShell data, never as PowerShell text: base64 (whose letters mean nothing inside single quotes) decoded
// in the shell, so empty values, names like ProgramFiles(x86), ; $ ` and curly quotes cannot change the command.
export const powershellData = (value: string): string =>
  `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`;
