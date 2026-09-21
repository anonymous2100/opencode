import { describe, expect, test } from "bun:test"
import { activePromptAnchor, type SessionPromptAnchor } from "./prompt-anchors"

const items: SessionPromptAnchor[] = [
  { id: "msg_1", index: 1, text: "first prompt" },
  { id: "msg_2", index: 2, text: "second prompt" },
]

describe("activePromptAnchor", () => {
  test("keeps the current selection", () => {
    expect(activePromptAnchor(items, "msg_1")).toBe("msg_1")
  })

  test("falls back to the newest prompt when nothing is selected", () => {
    expect(activePromptAnchor(items, undefined)).toBe("msg_2")
  })

  test("ignores a selection that is no longer visible", () => {
    expect(activePromptAnchor(items, "msg_removed")).toBe("msg_2")
  })

  test("has no active anchor without prompts", () => {
    expect(activePromptAnchor([], "msg_1")).toBeUndefined()
  })
})
