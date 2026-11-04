import type { SessionInfo } from "@opencode/client/promise"
import { Key } from "@solid-primitives/keyed"
import { ActivityRing } from "@opencode/ui/activity-ring"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import {
  displayName,
  getProjectAvatarGenerated,
  getProjectAvatarSource,
  getProjectAvatarVariant,
  ProjectAvatar,
} from "@opencode/ui/project-avatar"
import { Tooltip } from "@opencode/ui/tooltip"
import { Schema } from "effect"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { useCommand } from "@/shell/commands/command"
import { homeProjectDirectories } from "@/shell/layout/helpers"
import { useSettingsSurface } from "@/settings/surface"
import { setSidebarUnread } from "@/shell/sidebar-peek"
import { useTabs } from "@/shell/tabs/tabs"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { type InboxEntry, type SessionInbox, createSessionInbox } from "./inbox-model"
import {
  buildProjectSessionGroups,
  projectSessionKey,
  PROJECT_SESSION_LIMIT,
  type ProjectSessionGroup,
} from "./projects-model"
import { nextSessionCommand, previousSessionCommand } from "./tab-strip"
import { sessionTabTitle } from "./tab-title"

const ProjectsSidebarState = Persistence.struct({
  collapsed: Persistence.record(Schema.Boolean),
  expanded: Persistence.record(Schema.Boolean),
})

/** The Projects interface mode: recent sessions grouped under the project that owns them. */
export function SidebarProjects() {
  const language = useLanguage()
  const servers = useServers()
  const global = useGlobal()
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const settings = useSettingsSurface()
  const inbox = createSessionInbox()

  const [state, setState] = persisted(Persist.global("sidebar.projects"), ProjectsSidebarState, {
    collapsed: {},
    expanded: {},
  })

  const connections = createMemo(() => servers.visible.map((conn) => ({ conn, ctx: global.ensureServerCtx(conn) })))

  const groups = createMemo(() => buildProjectSessionGroups({ connections: connections(), entries: inbox.entries() }))

  const [refreshing, setRefreshing] = createSignal(false)
  const picker = useDirectoryPicker()
  const anyExpanded = createMemo(() => groups().some((group) => !state.collapsed[group.key]))

  const refresh = async () => {
    if (refreshing()) return
    setRefreshing(true)
    await inbox.refresh().finally(() => setRefreshing(false))
  }

  const foldAll = () => {
    const collapse = anyExpanded()
    setState("collapsed", Object.fromEntries(groups().map((group) => [group.key, collapse])))
  }

  // A folder that is not a project yet becomes one when a draft opens there, so this starts a draft per chosen folder.
  const openProject = () => {
    const conn = inbox.entries().find(inbox.selected)?.conn ?? connections()[0]?.conn

    if (!conn) return
    picker({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        for (const directory of homeProjectDirectories(result))
          void tabs.newDraft({ server: ServerConnection.key(conn), directory })
      },
    })
  }

  // Rows the sidebar would walk: projects in list order, and only the sessions their fold currently shows.
  const selectedKey = createMemo(() => inbox.entries().find(inbox.selected)?.key)

  const visibleSessions = createMemo(() =>
    groups().flatMap((group) => {
      if (state.collapsed[group.key]) return []

      if (state.expanded[group.key]) return group.sessions

      const slice = group.sessions.slice(0, PROJECT_SESSION_LIMIT)
      const selected = selectedKey()

      if (!selected || slice.some((entry) => entry.key === selected)) return slice
      const entry = group.sessions.find((item) => item.key === selected)

      return entry ? [...slice, entry] : slice
    }),
  )

  const selectAdjacent = (offset: -1 | 1, include?: (entry: InboxEntry) => boolean) => {
    const all = visibleSessions()
    const list = include ? all.filter(include) : all

    if (list.length === 0) return
    const current = inbox.entries().find(inbox.selected)
    const found = current ? list.findIndex((entry) => entry.key === current.key) : -1
    // Without a current row in this list, step in from the end it points away from.
    const index = found === -1 ? (offset === 1 ? -1 : 0) : found
    const next = list[(index + offset + list.length) % list.length]

    if (next) inbox.open(next)
  }

  const unseen = (entry: InboxEntry) =>
    entry.status === "approval" || entry.status === "input" || entry.status === "failed" || entry.status === "done"

  command.register("project-sidebar", () => [
    {
      ...previousSessionCommand,
      category: language.t("command.category.session"),
      title: language.t("command.session.previous"),
      onSelect: () => selectAdjacent(-1),
    },
    {
      ...nextSessionCommand,
      category: language.t("command.category.session"),
      title: language.t("command.session.next"),
      onSelect: () => selectAdjacent(1),
    },
    {
      id: "session.previous.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous.unseen"),
      keybind: "shift+alt+arrowup",
      onSelect: () => selectAdjacent(-1, unseen),
    },
    {
      id: "session.next.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.next.unseen"),
      keybind: "shift+alt+arrowdown",
      onSelect: () => selectAdjacent(1, unseen),
    },
  ])

  // Tells the closed sidebar's toggle whether a row here holds an unread result or a pending request.
  createEffect(() => {
    setSidebarUnread(inbox.entries().some((entry) => !inbox.selected(entry) && unseen(entry)))
    onCleanup(() => setSidebarUnread(false))
  })

  // Opening a session from elsewhere can land in a folded project, so reveal its row before scrolling to it. Only a
  // selection change expands the group; collapsing the selected project by hand stays collapsed.
  createEffect((previous: string | undefined) => {
    const key = selectedKey()

    if (!key || key === previous) return key
    const selected = inbox.entries().find(inbox.selected)

    if (!selected) return key
    const groupKey = projectKey(selected)

    if (untrack(() => state.collapsed[groupKey])) setState("collapsed", groupKey, false)

    return key
  }, undefined)

  let root!: HTMLDivElement

  createEffect(() => {
    const key = selectedKey()

    if (!key) return

    const frame = requestAnimationFrame(() => {
      // Entry keys join the server and session with a NUL; encode it so the attribute survives the DOM.
      const encoded = encodeURIComponent(key)
      const row = [...root.querySelectorAll<HTMLElement>("[data-entry-key]")].find(
        (element) => element.dataset.entryKey === encoded,
      )

      row?.scrollIntoView({ block: "nearest" })
    })

    onCleanup(() => cancelAnimationFrame(frame))
  })

  // A session's parent (subagent) view still selects its root row.
  function projectKey(entry: InboxEntry) {
    const project = entry.ctx.projects.forSession(entry.session)

    return projectSessionKey(entry.server, project?.worktree ?? entry.session.location.directory)
  }

  const openProjectSession = (group: ProjectSessionGroup) => {
    group.ctx.projects.touch(group.project.worktree)
    void tabs.newDraft({ server: group.server, directory: group.project.worktree })
  }

  return (
    <div ref={root} data-slot="sidebar-projects" class="flex min-h-0 flex-1 flex-col">
      <div data-slot="sidebar-projects-heading" class="flex h-7 shrink-0 items-center gap-0.5 ps-2 pe-0.5">
        <span class="min-w-0 flex-1 truncate text-[12px] leading-4 font-medium text-v2-text-text-muted">
          {language.t("sidebar.projects.title")}
        </span>
        <Tooltip placement="bottom" value={language.t("sidebar.projects.refresh")}>
          <IconButton
            data-action="sidebar-projects-refresh"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="refresh" class={refreshing() ? "animate-spin motion-reduce:animate-none" : undefined} />}
            aria-label={language.t("sidebar.projects.refresh")}
            onClick={() => void refresh()}
          />
        </Tooltip>
        <Tooltip
          placement="bottom"
          value={language.t(anyExpanded() ? "sidebar.projects.foldAll" : "sidebar.projects.unfoldAll")}
        >
          <IconButton
            data-action="sidebar-projects-fold"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="chevron-down" class={anyExpanded() ? "rotate-180" : undefined} />}
            aria-label={language.t(anyExpanded() ? "sidebar.projects.foldAll" : "sidebar.projects.unfoldAll")}
            onClick={foldAll}
          />
        </Tooltip>
        <Tooltip placement="bottom" value={language.t("command.project.open")}>
          <IconButton
            data-action="sidebar-projects-open"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="folder-add-left" />}
            aria-label={language.t("command.project.open")}
            onClick={openProject}
          />
        </Tooltip>
      </div>
      <div
        data-slot="sidebar-projects-scroll"
        data-scrollable
        class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2 no-scrollbar"
      >
        <Show
          when={!inbox.loading() || groups().length > 0}
          fallback={
            <div class="flex shrink-0 flex-col gap-1 px-1.5 py-2" aria-hidden="true">
              <For each={[56, 42, 64]}>
                {(width) => (
                  <span class="h-2 rounded-full bg-v2-background-bg-layer-02" style={{ width: `${width}%` }} />
                )}
              </For>
            </div>
          }
        >
          <Show when={groups().length > 0} fallback={<EmptyProjects />}>
            {/* Projects keep their rows and local menu state while session updates reorder the list. */}
            <Key each={groups()} by={(group) => group.key}>
              {(group) => (
                <ProjectSection
                  group={group()}
                  collapsed={!!state.collapsed[group().key]}
                  expanded={!!state.expanded[group().key]}
                  selectedKey={selectedKey()}
                  active={group().sessions.some((entry) => entry.key === selectedKey())}
                  onToggle={() => setState("collapsed", group().key, !state.collapsed[group().key])}
                  onShowMore={() => setState("expanded", group().key, true)}
                  onShowLess={() => setState("expanded", group().key, false)}
                  onNewSession={() => openProjectSession(group())}
                  onEdit={() => settings.openProject({ server: group().server, project: group().project.worktree })}
                  onClearNotifications={() => {
                    for (const directory of [group().project.worktree, ...(group().project.sandboxes ?? [])])
                      group().ctx.notification.project.markViewed(directory)
                  }}
                  onOpen={(entry) => inbox.open(entry)}
                  onArchive={(entry) => void inbox.archive(entry)}
                  onDelete={(entry) => dialog.show(() => <DeleteDialog entry={entry} inbox={inbox} />)}
                  now={inbox.now()}
                  language={language}
                  servers={servers}
                />
              )}
            </Key>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function EmptyProjects() {
  const language = useLanguage()

  return (
    <div class="px-1.5 py-2 text-[13px] leading-4 text-v2-text-text-faint">{language.t("sidebar.projects.empty")}</div>
  )
}

type Language = ReturnType<typeof useLanguage>

type Servers = ReturnType<typeof useServers>

function ProjectSection(props: {
  group: ProjectSessionGroup
  collapsed: boolean
  expanded: boolean
  active: boolean
  selectedKey: string | undefined
  now: number
  language: Language
  servers: Servers
  onToggle: () => void
  onShowMore: () => void
  onShowLess: () => void
  onNewSession: () => void
  onEdit: () => void
  onClearNotifications: () => void
  onOpen: (entry: InboxEntry) => void
  onArchive: (entry: InboxEntry) => void
  onDelete: (entry: InboxEntry) => void
}) {
  const name = createMemo(() => displayName(props.group.project))
  const count = createMemo(() => props.group.sessions.length)

  const shown = createMemo(() => {
    if (props.expanded) return props.group.sessions

    const slice = props.group.sessions.slice(0, PROJECT_SESSION_LIMIT)

    // Keep the open session in view when it is older than the rows this fold shows.
    if (!props.selectedKey || slice.some((entry) => entry.key === props.selectedKey)) return slice
    const selected = props.group.sessions.find((entry) => entry.key === props.selectedKey)

    return selected ? [...slice, selected] : slice
  })

  const unread = createMemo(() => {
    const directories = [props.group.project.worktree, ...(props.group.project.sandboxes ?? [])]

    return directories.some((directory) => props.group.ctx.notification.project.hasUnread(directory))
  })

  const tag = createMemo(() => props.servers.tag(props.group.conn))

  return (
    <div
      data-slot="sidebar-projects-group"
      data-project={name()}
      data-active={props.active ? "" : undefined}
      data-collapsed={props.collapsed ? "" : undefined}
      class="flex min-w-0 shrink-0 flex-col"
    >
      <div
        class="group/project relative flex h-8 min-w-0 items-center rounded-[6px] transition-colors"
        classList={{
          "bg-v2-background-bg-layer-02": props.active,
          "hover:bg-v2-background-bg-layer-01": !props.active,
        }}
      >
        <button
          type="button"
          data-action="sidebar-project-toggle"
          aria-expanded={!props.collapsed}
          title={props.language.t(props.collapsed ? "sidebar.projects.expand" : "sidebar.projects.collapse")}
          class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[6px] ps-1.5 pe-1.5 text-start focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02"
          onClick={props.onToggle}
        >
          {/* The folder glyph carries the fold state, as the name does in a file tree. */}
          <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted">
            <Show when={props.group.project.icon} fallback={<Icon name={props.collapsed ? "folder" : "folder-open"} />}>
              <ProjectAvatar
                aria-hidden="true"
                fallback={name()}
                src={getProjectAvatarSource(props.group.project.id, props.group.project.icon)}
                variant={getProjectAvatarVariant(props.group.project.icon?.color)}
                generated={getProjectAvatarGenerated(props.group.project)}
              />
            </Show>
          </span>
          <span
            data-slot="sidebar-project-name"
            class="min-w-0 flex-1 truncate text-[13px] leading-4 font-medium text-v2-text-text-base"
            dir="auto"
          >
            {name()}
          </span>
          <Show when={tag()}>
            {(label) => (
              <span class="max-w-16 shrink-0 truncate text-[11px] leading-4 text-v2-text-text-faint">{label()}</span>
            )}
          </Show>
          <Show when={unread()}>
            <span
              data-slot="sidebar-project-unread"
              aria-hidden="true"
              class="size-1.5 shrink-0 rounded-full bg-v2-background-bg-accent group-hover/project:opacity-0"
            />
          </Show>
          <span
            data-slot="sidebar-project-count"
            class="shrink-0 tabular-nums text-[12px] leading-4 text-v2-text-text-faint group-hover/project:opacity-0"
          >
            {count()}
          </span>
        </button>
        <div
          data-slot="sidebar-project-actions"
          class="hover-reveal absolute inset-y-0 end-1 flex items-center gap-0.5 rounded-e-[6px] ps-3 group-hover/project:opacity-100 focus-within:opacity-100"
        >
          <Tooltip placement="bottom" value={props.language.t("command.session.new")}>
            <IconButton
              data-action="sidebar-project-new-session"
              variant="ghost-muted"
              size="small"
              icon={<Icon name="edit" />}
              aria-label={props.language.t("command.session.new")}
              onClick={props.onNewSession}
            />
          </Tooltip>
          <Menu gutter={6} modal={false} placement="bottom-end">
            <Menu.Trigger
              as={IconButton}
              data-action="sidebar-project-menu"
              variant="ghost-muted"
              size="small"
              icon={<Icon name="outline-dots" />}
              aria-label={props.language.t("common.moreOptions")}
            />
            <Menu.Portal>
              <Menu.Content>
                <Menu.Item onSelect={props.onNewSession}>{props.language.t("command.session.new")}</Menu.Item>
                <Menu.Item onSelect={props.onEdit}>{props.language.t("dialog.project.edit.title")}</Menu.Item>
                <Menu.Item disabled={!unread()} onSelect={props.onClearNotifications}>
                  {props.language.t("sidebar.project.clearNotifications")}
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </div>
      </div>
      <Show when={!props.collapsed}>
        <div class="flex min-w-0 flex-col gap-px pt-0.5">
          <Key each={shown()} by={(entry) => entry.key}>
            {(entry) => (
              <ProjectSessionRow
                entry={entry()}
                selected={entry().key === props.selectedKey}
                now={props.now}
                language={props.language}
                onOpen={() => props.onOpen(entry())}
                onArchive={() => props.onArchive(entry())}
                onDelete={() => props.onDelete(entry())}
              />
            )}
          </Key>
          <Show when={props.group.sessions.length > PROJECT_SESSION_LIMIT}>
            <button
              type="button"
              data-action={props.expanded ? "sidebar-project-show-less" : "sidebar-project-show-more"}
              class="h-7 shrink-0 rounded-[6px] ps-9 pe-2 text-start text-[12px] leading-4 text-v2-text-text-faint hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02"
              onClick={props.expanded ? props.onShowLess : props.onShowMore}
            >
              {props.language.t(props.expanded ? "sidebar.projects.showLess" : "session.tab.showMore")}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function ProjectSessionRow(props: {
  entry: InboxEntry
  selected: boolean
  now: number
  language: Language
  onOpen: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const status = () => props.entry.status
  const unread = () => status() === "done" || status() === "failed" || status() === "approval" || status() === "input"
  const title = () => sessionTabTitle(props.entry.session.title, props.language.t("session.tab.session"))
  const age = () => sessionAge(props.entry.session, props.now, props.language)

  return (
    <Menu.Context modal={false}>
      <Menu.Context.Trigger
        as="button"
        type="button"
        data-slot="sidebar-project-session"
        data-entry-key={encodeURIComponent(props.entry.key)}
        data-session-id={props.entry.session.id}
        data-status={status()}
        data-selected={props.selected ? "" : undefined}
        class="group/session flex h-8 min-w-0 items-center gap-1.5 rounded-[6px] ps-9 pe-2 text-start transition-[background,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02"
        classList={{
          "border-[0.5px] border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]":
            props.selected,
          "border-[0.5px] border-transparent hover:bg-v2-background-bg-layer-01": !props.selected,
        }}
        onClick={props.onOpen}
      >
        <span
          class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4"
          dir="auto"
          classList={{
            "text-v2-text-text-base": props.selected || unread(),
            "text-v2-text-text-muted": !props.selected && !unread(),
            "font-medium": props.selected,
          }}
        >
          {title()}
        </span>
        <Show when={status() === "working"}>
          <ActivityRing class="size-3.5 shrink-0" data-mark="busy" />
        </Show>
        <Show when={unread() && status() !== "working"}>
          <span
            data-slot="sidebar-project-session-dot"
            class="size-1.5 shrink-0 rounded-full"
            classList={{
              "bg-v2-state-fg-danger": status() === "failed",
              "bg-v2-state-fg-warning": status() === "approval" || status() === "input",
              "bg-v2-background-bg-accent": status() === "done",
            }}
          />
        </Show>
        <span
          data-slot="sidebar-project-session-age"
          class="shrink-0 text-[12px] leading-4 tabular-nums"
          classList={{
            "text-v2-text-text-faint": status() === "ready" || status() === "done",
            "text-v2-state-fg-info": status() === "working",
            "text-v2-state-fg-warning": status() === "approval" || status() === "input",
            "text-v2-state-fg-danger": status() === "failed",
          }}
        >
          {age()}
        </span>
      </Menu.Context.Trigger>
      <Menu.Context.Portal>
        <Menu.Context.Content>
          <Menu.Item onSelect={props.onArchive}>{props.language.t("common.archive")}</Menu.Item>
          <Menu.Item data-variant="critical" onSelect={props.onDelete}>
            {props.language.t("common.delete")}…
          </Menu.Item>
        </Menu.Context.Content>
      </Menu.Context.Portal>
    </Menu.Context>
  )
}

function DeleteDialog(props: { entry: InboxEntry; inbox: SessionInbox }) {
  const language = useLanguage()
  const dialog = useDialog()

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("session.delete.title")}
          description={language.t("session.delete.confirm", {
            name: sessionTabTitle(props.entry.session.title, language.t("command.session.new")),
          })}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            void props.inbox.remove(props.entry)
            dialog.close()
          }}
        >
          {language.t("session.delete.button")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function sessionAge(session: SessionInfo, now: number, language: Language) {
  // `time.updated` moves when a prompt is enqueued, so `time.idle` is when the last run ended.
  const seconds = Math.max(0, Math.floor((now - (session.time.idle ?? session.time.updated)) / 1000))

  if (seconds < 60) return language.t("sidebar.inbox.time.now")

  if (seconds < 3_600) return language.plural("sidebar.inbox.elapsed.minutes", Math.floor(seconds / 60))

  if (seconds < 86_400) return language.plural("sidebar.inbox.elapsed.hours", Math.floor(seconds / 3_600))

  return language.plural("sidebar.inbox.elapsed.days", Math.floor(seconds / 86_400))
}
