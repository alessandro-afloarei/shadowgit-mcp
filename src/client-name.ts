import { AsyncLocalStorage } from 'node:async_hooks';
import { CLIENT_INFO_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// Trimmed because the session id is built from the name, so a blank one must not get through.
const ClientInfo = z.object({ name: z.string().trim(), title: z.string().trim().optional() });

/** The clients ShadowGit's setup lists, by the name each sends: the app shows them by the names people know. */
const KNOWN_CLIENTS = new Map([
  ['claude-code', 'Claude Code'],
  ['cursor-vscode', 'Cursor'],
  ['claude-ai', 'Claude Desktop'],
]);

/** A client as people know it: its own title, else the name ShadowGit's setup lists it by, else the name it sends. */
export const displayName = ({ name, title }: { name: string; title?: string }): string => title || KNOWN_CLIENTS.get(name) || name;

/** The calling client's name: from the request envelope on 2026-07-28, from the initialize handshake on 2025-11-25. */
export function clientName(server: McpServer, ctx: ServerContext): string {
  const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {};
  // Deprecated, but 2025-era connections carry no envelope, so it is their only source.
  const { data } = ClientInfo.safeParse(envelope[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion());
  return (data && displayName(data)) || 'AI assistant';
}

/** The client of the tool call running: every request it sends the app names it, so the app can say who is connected. */
export const callingClient = new AsyncLocalStorage<string>();

/**
 * A tool's handler run as its client's call, given the client's name: every tool registers through this or
 * asClientWithoutInput, so no request to the app leaves unnamed.
 */
export function asClient<A, R>(server: McpServer, handler: (args: A, client: string) => R): (args: A, ctx: ServerContext) => R {
  return (args, ctx) => {
    const client = clientName(server, ctx);
    return callingClient.run(client, () => handler(args, client));
  };
}

/** asClient for a tool without input, which the SDK calls with its context alone. */
export function asClientWithoutInput<R>(server: McpServer, handler: () => R): (ctx: ServerContext) => R {
  return (ctx) => callingClient.run(clientName(server, ctx), handler);
}
