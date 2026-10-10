import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  closestCenter,
  createSortable,
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { type LocalProject, useLayout } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { SessionItem } from "./sidebar-items"
import { displayName, sortedRootSessions } from "./helpers"
import { SortableWorkspace, type WorkspaceSidebarContext } from "./sidebar-workspace"
import type { ProjectSidebarContext } from "./sidebar-project"

const ProjectSessions = (props: {
  project: LocalProject
  sessionProps: ProjectSidebarContext["sessionProps"]
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const workspace = createMemo(() => {
    const [store, setStore] = serverSync().child(props.project.worktree, { bootstrap: false })
    return { store, setStore }
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => sortedRootSessions(workspace().store, props.sortNow()))
  const hasMore = createMemo(() => workspace().store.sessionTotal > sessions().length)
  const loadMore = async () => {
    workspace().setStore("limit", (limit) => (limit ?? 0) + 5)
    await serverSync().project.loadSessions(props.project.worktree)
  }

  return (
    <div class="flex flex-col gap-1 pb-1 pl-6">
      <For each={sessions()}>
        {(session) => (
          <SessionItem
            {...props.sessionProps}
            session={session}
            list={sessions()}
            slug={slug()}
            mobile={props.mobile}
            showTime
            showChild
          />
        )}
      </For>
      <Show when={hasMore()}>
        <button
          type="button"
          class="flex items-center gap-2 w-full min-w-0 rounded-md py-1 pl-2 pr-3 text-left text-14-regular text-text-weak hover:bg-surface-raised-base-hover cursor-default"
          data-action="project-expand"
          data-project={base64Encode(props.project.worktree)}
          onClick={() => void loadMore()}
        >
          <span class="min-w-0 flex-1 truncate">{language.t("sidebar.project.expand")}</span>
        </button>
      </Show>
    </div>
  )
}

const ProjectNode = (props: {
  project: LocalProject
  ctx: WorkspaceSidebarContext
  sidebar: ProjectSidebarContext
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const layout = useLayout()
  const serverSync = useServerSync()
  const language = useLanguage()
  const notification = useNotification()
  const sortable = createSortable(props.project.worktree)
  const [menu, setMenu] = createStore({ open: false })
  const dirs = createMemo(() => props.sidebar.workspaceIds(props.project))
  const workspacesEnabled = createMemo(() => props.sidebar.workspacesEnabled(props.project))
  const selected = createMemo(() => props.sidebar.currentProject()?.worktree === props.project.worktree)
  const pinned = createMemo(() => layout.sidebar.pinned(props.project.worktree))
  const open = createMemo(() => props.project.expanded)
  const count = createMemo(() =>
    dirs().reduce((total, directory) => {
      const [store] = serverSync().child(directory, { bootstrap: false })
      return total + sortedRootSessions(store, props.sortNow()).length
    }, 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const isWorking = createMemo(() =>
    dirs().some((directory) => {
      return Object.keys(serverSync().session.data.session_status).some((id) => {
        if (serverSync().session.get(id)?.directory !== directory) return false
        return serverSync().session.data.session_working(id)
      })
    }),
  )

  const toggle = () => {
    if (open()) {
      layout.projects.collapse(props.project.worktree)
      return
    }
    layout.projects.expand(props.project.worktree)
    void serverSync().project.loadSessions(props.project.worktree)
  }

  const activate = () => {
    if (selected()) {
      layout.sidebar.toggle()
      return
    }
    layout.projects.expand(props.project.worktree)
    props.sidebar.navigateToProject(props.project.worktree)
  }

  const clearNotifications = () => {
    dirs()
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))
    if (menu.open) setMenu("open", false)
  }

  return (
    <div
      // @ts-ignore
      use:sortable
      classList={{ "opacity-30": sortable.isActiveDraggable }}
    >
      <div data-component="sidebar-tree-project" data-project={base64Encode(props.project.worktree)}>
        <div
          classList={{
            "group/project flex items-center gap-1 rounded-md pr-1.5 transition-colors": true,
            "bg-surface-base-active": selected(),
            "hover:bg-surface-raised-base-hover": !selected(),
          }}
        >
          <IconButton
            icon={open() ? "chevron-down" : "chevron-right"}
            variant="ghost"
            size="small"
            class="shrink-0 rounded-md"
            aria-expanded={open()}
            aria-label={displayName(props.project)}
            data-action="project-toggle"
            data-project={base64Encode(props.project.worktree)}
            onClick={toggle}
          />
          <button
            type="button"
            class="flex items-center gap-2 min-w-0 flex-1 py-1.5 text-left cursor-default"
            data-action="project-switch"
            data-project={base64Encode(props.project.worktree)}
            onClick={activate}
          >
            <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
            <Tooltip placement="right" value={displayName(props.project)} gutter={10} class="min-w-0 flex-1">
              <span class="min-w-0 flex-1 truncate text-14-medium text-text-strong">
                {displayName(props.project)}
              </span>
            </Tooltip>
          </button>

          <Show when={!isWorking() && !unseenCount() && count() > 0}>
            <span
              classList={{
                "shrink-0 text-12-regular group-hover/project:hidden group-focus-within/project:hidden": true,
                "text-text-diff-delete-base": hasError(),
                "text-text-weak": !hasError(),
              }}
            >
              {count()}
            </span>
          </Show>
          <Show when={isWorking()}>
            <Spinner class="shrink-0 size-[15px] text-icon-weak" />
          </Show>

          <Tooltip
            placement="top"
            value={language.t(pinned() ? "sidebar.project.unpin" : "sidebar.project.pin")}
          >
            <IconButton
              icon={pinned() ? "pin-off" : "pin"}
              variant="ghost"
              size="small"
              classList={{
                "shrink-0 rounded-md": true,
                "opacity-100": pinned(),
                "opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto":
                  !pinned(),
              }}
              aria-label={language.t(pinned() ? "sidebar.project.unpin" : "sidebar.project.pin")}
              data-action="project-pin"
              data-project={base64Encode(props.project.worktree)}
              onClick={() => layout.sidebar.togglePinned(props.project.worktree)}
            />
          </Tooltip>

          <DropdownMenu modal={!props.sidebar.sidebarHovering()} onOpenChange={(value) => setMenu("open", value)}>
            <Tooltip placement="top" value={language.t("common.moreOptions")}>
              <DropdownMenu.Trigger
                as={IconButton}
                icon="dot-grid"
                variant="ghost"
                size="small"
                classList={{
                  "shrink-0 rounded-md": true,
                  "opacity-100": menu.open,
                  "opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto":
                    !menu.open,
                }}
                data-action="project-menu"
                data-project={base64Encode(props.project.worktree)}
                aria-label={language.t("common.moreOptions")}
              />
            </Tooltip>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="mt-1">
                <DropdownMenu.Item
                  onSelect={() => props.sidebar.showEditProjectDialog(props.project)}
                >
                  <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  data-action="project-workspaces-toggle"
                  data-project={base64Encode(props.project.worktree)}
                  disabled={props.project.vcs !== "git" && !workspacesEnabled()}
                  onSelect={() => props.sidebar.toggleProjectWorkspaces(props.project)}
                >
                  <DropdownMenu.ItemLabel>
                    {workspacesEnabled()
                      ? language.t("sidebar.workspaces.disable")
                      : language.t("sidebar.workspaces.enable")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  data-action="project-clear-notifications"
                  data-project={base64Encode(props.project.worktree)}
                  disabled={unseenCount() === 0}
                  onSelect={clearNotifications}
                >
                  <DropdownMenu.ItemLabel>{language.t("sidebar.project.clearNotifications")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  data-action="project-close-menu"
                  data-project={base64Encode(props.project.worktree)}
                  onSelect={() => props.sidebar.closeProject(props.project.worktree)}
                >
                  <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>

          <Tooltip placement="top" value={language.t("command.session.new")}>
            <IconButton
              icon="plus-small"
              variant="ghost"
              size="small"
              classList={{
                "shrink-0 rounded-md": true,
                "opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto": true,
              }}
              aria-label={language.t("command.session.new")}
              data-action="project-new-session"
              data-project={base64Encode(props.project.worktree)}
              onClick={() => props.sidebar.navigateToNewSession(props.project.worktree)}
            />
          </Tooltip>
        </div>

        <Show when={open()}>
          <div class="pt-1">
            <Show
              when={workspacesEnabled()}
              fallback={
                <ProjectSessions
                  project={props.project}
                  sessionProps={props.sidebar.sessionProps}
                  sortNow={props.sortNow}
                  mobile={props.mobile}
                />
              }
            >
              <div class="flex flex-col gap-3">
                <For each={dirs()}>
                  {(directory) => (
                    <SortableWorkspace
                      ctx={props.ctx}
                      directory={directory}
                      project={props.project}
                      sortNow={props.sortNow}
                      mobile={props.mobile}
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const SidebarTree = (props: {
  mobile?: boolean
  projects: Accessor<LocalProject[]>
  ctx: WorkspaceSidebarContext
  sidebar: ProjectSidebarContext
  sortNow: Accessor<number>
  openProjectLabel: string
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  onRevealActiveProject: () => void
  activeProject: Accessor<string | undefined>
  onDragStart: (event: unknown) => void
  onDragOver: (event: DragEvent) => void
  onDragEnd: () => void
}): JSX.Element => {
  const layout = useLayout()
  const serverSync = useServerSync()
  const language = useLanguage()
  const ordered = createMemo(() => {
    const pinned = layout.sidebar.pinned
    return [...props.projects()].sort((a, b) => Number(pinned(b.worktree)) - Number(pinned(a.worktree)))
  })

  createEffect(() => {
    const worktree = props.activeProject()
    if (!worktree) return
    const project = props.projects().find((item) => item.worktree === worktree)
    if (!project?.expanded) return
    void serverSync().project.loadSessions(worktree)
  })

  return (
    <div class="flex flex-col h-full min-h-0 min-w-0">
      <div class="shrink-0 flex items-center gap-1 px-3 pt-3 pb-1">
        <span class="min-w-0 flex-1 truncate text-14-medium text-text-strong">{language.t("home.projects")}</span>
        <TooltipKeybind
          placement="bottom"
          title={props.openProjectLabel}
          keybind={props.openProjectKeybind() ?? ""}
        >
          <IconButton
            icon="plus"
            variant="ghost"
            size="small"
            class="shrink-0 rounded-md"
            aria-label={props.openProjectLabel}
            onClick={props.onOpenProject}
          />
        </TooltipKeybind>
        <Tooltip placement="bottom" value={language.t("common.moreOptions")}>
          <IconButton
            icon="chevron-double-right"
            variant="ghost"
            size="small"
            class="shrink-0 rounded-md"
            aria-label={language.t("common.moreOptions")}
            onClick={props.onRevealActiveProject}
          />
        </Tooltip>
        <Tooltip placement="bottom" value={language.t("sidebar.menu.toggle")}>
          <IconButton
            icon="menu"
            variant="ghost"
            size="small"
            class="shrink-0 rounded-md"
            aria-label={language.t("sidebar.menu.toggle")}
            aria-expanded={layout.sidebar.opened()}
            onClick={layout.sidebar.toggle}
          />
        </Tooltip>
      </div>
      <div class="flex-1 min-h-0 min-w-0">
        <DragDropProvider
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          onDragOver={props.onDragOver}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragXAxis />
          <div class="h-full w-full overflow-y-auto no-scrollbar px-2 pb-2 [overflow-anchor:none]">
            <div class="flex flex-col gap-1">
              <SortableProvider ids={props.projects().map((project) => project.worktree)}>
                <For each={ordered()}>
                  {(project) => (
                    <ProjectNode
                      project={project}
                      ctx={props.ctx}
                      sidebar={props.sidebar}
                      sortNow={props.sortNow}
                      mobile={props.mobile}
                    />
                  )}
                </For>
              </SortableProvider>
            </div>
          </div>
          <DragOverlay>
            <Show when={props.projects().find((item) => item.worktree === props.activeProject())}>
              {(project) => (
                <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">
                  {displayName(project())}
                </div>
              )}
            </Show>
          </DragOverlay>
        </DragDropProvider>
      </div>
    </div>
  )
}
