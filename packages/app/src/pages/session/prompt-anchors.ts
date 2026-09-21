export type SessionPromptAnchor = {
  id: string
  index: number
  text: string
}

/**
 * Anchors highlight the prompt the reader is sitting on. While the view follows
 * the newest output there is no explicit selection yet, so the last prompt
 * stands in for "current" instead of leaving the rail blank.
 */
export function activePromptAnchor(items: SessionPromptAnchor[], currentID: string | undefined) {
  if (currentID && items.some((item) => item.id === currentID)) return currentID
  return items.at(-1)?.id
}
