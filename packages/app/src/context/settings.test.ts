import { describe, expect, test } from "bun:test"
import {
  hasExistingWebState,
  initialAgentVisibility,
  isAppUpgrade,
  newLayoutDesignsDefault,
  resolveLayoutDesigns,
  shouldDisplayTabsToast,
  shouldResetLayoutDefault,
} from "./settings"

describe("agent visibility", () => {
  test("shows the picker for existing profiles and hides it for first-time installs", () => {
    expect(initialAgentVisibility(undefined, true)).toBe(true)
    expect(initialAgentVisibility(undefined, false)).toBe(false)
  })

  test("shows the picker when updating from a recent release", () => {
    expect(initialAgentVisibility(undefined, false, "1.18.8")).toBe(true)
  })

  test("preserves the preference after initialization", () => {
    expect(initialAgentVisibility(true, true, "1.18.8")).toBeUndefined()
    expect(initialAgentVisibility(true, false)).toBeUndefined()
  })
})

describe("layout defaults", () => {
  test("blank profiles default to the legacy layout", () => {
    expect(newLayoutDesignsDefault).toBe(false)
  })

  test("only an explicit true selects the new layout", () => {
    expect(resolveLayoutDesigns(undefined)).toBe(false)
    expect(resolveLayoutDesigns(false)).toBe(false)
    expect(resolveLayoutDesigns(true)).toBe(true)
  })

  test("resets an existing preference exactly once", () => {
    expect(shouldResetLayoutDefault(undefined)).toBe(true)
    expect(shouldResetLayoutDefault(false)).toBe(true)
    expect(shouldResetLayoutDefault(true)).toBe(false)
  })

  test("classifies web profiles from existing settings or a recorded version", () => {
    expect(hasExistingWebState("{}", undefined)).toBe(true)
    expect(hasExistingWebState(null, "1.17.19")).toBe(true)
    expect(hasExistingWebState(null, undefined)).toBe(false)
  })

  test("detects upgrades only when a previous version is older", () => {
    expect(isAppUpgrade("1.17.19", "1.17.20")).toBe(true)
    expect(isAppUpgrade(undefined, "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.20", "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.21", "1.17.20")).toBe(false)
  })

  test("shows the tabs toast for upgrades and existing installs without a recorded version", () => {
    expect(shouldDisplayTabsToast("1.17.19", "1.17.20", false)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", true)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", false)).toBe(false)
  })
})
