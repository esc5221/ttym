/**
 * Domain rules the server and the clients must agree on.
 *
 * Layout mutation lives here rather than in the server because the clients
 * split and close panes too — a second copy of these rules is how the two ends
 * drift apart, which is exactly what flattened every production layout.
 */
export * from './workspace-domain.js';
export * from './layout-tree.js';
