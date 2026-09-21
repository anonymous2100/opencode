import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createMemo, For } from "solid-js"
import { useLanguage } from "@/context/language"
import { activePromptAnchor, type SessionPromptAnchor } from "@/pages/session/prompt-anchors"

/**
 * Rails the user prompts of a conversation down the trailing edge so any earlier
 * prompt can be reached in one click. Anchors are the message ids themselves, so
 * selecting one reuses the same hash-scroll path as `#message-<id>` deep links.
 */
export function SessionPromptAnchors(props: {
  items: SessionPromptAnchor[]
  activeID: () => string | undefined
  onSelect: (id: string) => void
}) {
  const language = useLanguage()
  const active = createMemo(() => activePromptAnchor(props.items, props.activeID()))

  return (
    <div
      data-component="session-prompt-anchors"
      role="navigation"
      aria-label={language.t("session.promptAnchors.label")}
      // `right-4` clears the 12px scroll-view thumb, which keeps pointer events
      // even while invisible. The rail itself is inert so wheels fall through to
      // the conversation unless they land on an anchor.
      class="pointer-events-none absolute top-1/2 right-4 z-[55] flex max-h-[60%] -translate-y-1/2 flex-col items-end gap-[5px] overflow-y-auto no-scrollbar py-1.5"
    >
      <For each={props.items}>
        {(item) => (
          <Tooltip
            placement="left"
            class="flex items-center justify-end"
            value={<div class="max-w-[320px] text-12-regular">{item.text}</div>}
          >
            <button
              type="button"
              data-action="session-prompt-anchor"
              data-message-id={item.id}
              data-active={active() === item.id ? "true" : "false"}
              aria-label={language.t("session.promptAnchors.jump", { index: item.index })}
              aria-current={active() === item.id ? "location" : undefined}
              class="pointer-events-auto flex h-3.5 w-9 cursor-pointer items-center justify-end border-none bg-transparent p-0"
              onClick={() => props.onSelect(item.id)}
            >
              <span
                classList={{
                  "block h-[5px] rounded-full transition-all duration-150 hover:h-[7px]": true,
                  "w-[28px]": active() === item.id,
                  "w-[16px]": active() !== item.id,
                }}
                style={{
                  background: active() === item.id ? "var(--text-strong)" : "var(--border-weak-base)",
                }}
              />
            </button>
          </Tooltip>
        )}
      </For>
    </div>
  )
}
