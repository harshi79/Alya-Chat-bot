/**
 * Silence only the "SQLite is an experimental feature" warning from node:sqlite.
 * Must be imported before node:sqlite is loaded (db.ts loads it lazily).
 */
const original = process.emitWarning.bind(process);
let installed = false;

export function installWarningFilter(): void {
  if (installed) return;
  installed = true;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

installWarningFilter();
