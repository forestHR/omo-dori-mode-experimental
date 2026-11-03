// PowerShell recognizes ASCII and typographic single quotes as delimiters.
export const powershellLiteral = (value: string): string => `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
