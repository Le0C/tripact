// The tripact package version, surfaced by the CLI (`--version`) and the default MCP server
// identity. Kept as a hand-maintained constant rather than read from package.json so the kernel
// library never does I/O at import time (the pure-JS, no-network invariant).
export const TRIPACT_VERSION = "0.1.0";
