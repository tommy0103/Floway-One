// SQLite NOCASE folds only ASCII A-Z. Floway usernames are restricted to the
// same ASCII alphabet, so this is the repository identity used by in-memory
// behavior and import preflight while SQL continues to preserve display case.
// Ref: https://www.sqlite.org/datatype3.html#collating_sequences
export const sqliteNoCaseUsernameIdentity = (username: string): string =>
  username.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
