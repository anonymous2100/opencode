import { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import type { LocalProject } from "@/shell/state/layout"
import { pathKey } from "@/workspaces/path-key"
import type { InboxEntry } from "./inbox-model"

/** The recent sessions one project shows before its rows fold behind "Show more". */
export const PROJECT_SESSION_LIMIT = 6

export type ProjectSessionGroup = {
  key: string
  server: ServerConnection.Key
  conn: ServerConnection.Any
  ctx: ServerCtx
  project: LocalProject
  sessions: InboxEntry[]
  /** The newest session update in the group; empty groups sort after active ones. */
  updated: number
}

/** Keys a project's collapsed and expanded state within one server. */
export function projectSessionKey(server: ServerConnection.Key, worktree: string) {
  return `${server}\0${pathKey(worktree)}`
}

/**
 * Groups root sessions by project, in the order the sidebar shows them: projects with the newest activity first, then
 * projects without sessions in the order the server lists the client's used projects. A session whose directory is not
 * an added project still gets a group so its row stays reachable.
 */
export function buildProjectSessionGroups(input: {
  connections: readonly { conn: ServerConnection.Any; ctx: ServerCtx }[]
  entries: readonly InboxEntry[]
}): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup & { order: number }>()
  let order = 0

  const group = (entry: {
    server: ServerConnection.Key
    conn: ServerConnection.Any
    ctx: ServerCtx
    project: LocalProject
  }) => {
    const key = projectSessionKey(entry.server, entry.project.worktree)
    const found = groups.get(key)

    if (found) return found
    const created = { ...entry, key, sessions: [], updated: 0, order: order++ }

    groups.set(key, created)

    return created
  }

  for (const connection of input.connections) {
    const server = ServerConnection.key(connection.conn)

    for (const project of connection.ctx.projects.used())
      group({ server, conn: connection.conn, ctx: connection.ctx, project })
  }

  for (const entry of input.entries) {
    const project = entry.ctx.projects.forSession(entry.session) ?? {
      id: entry.session.projectID,
      worktree: entry.session.location.directory,
    }

    const found = group({ server: entry.server, conn: entry.conn, ctx: entry.ctx, project })

    found.sessions.push(entry)
    found.updated = Math.max(found.updated, entry.session.time.updated)
  }

  return [...groups.values()]
    .sort((a, b) => b.updated - a.updated || a.order - b.order)
    .map(({ order: _order, ...found }) => found)
}
