# @ttym/cli

The control plane and the compatibility boundary. Bundled by esbuild into
`dist/ttym`; `attach` is a full TUI viewer, every other verb is a scriptable
HTTP client with a contract: exit codes 0/1/2/3/4/5 (success / failure /
usage / unresolved target / no server / version mismatch), global flags
anywhere on the line, `--` passthrough.

Verbs live in one module each: lifecycle, attach, addresses, workspace,
sessions (send/screen/await/commands/output), agent hooks, map summarizer.
`contract.test.ts` pins the promises; `e2e.test.ts` drives a real server.

Run `ttym` with no arguments for the full verb list, or see the root README.
