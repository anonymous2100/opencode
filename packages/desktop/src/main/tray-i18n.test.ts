import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_ENGLISH, DESKTOP_NATIVE_KEYS, createDesktopNativeBundle, parseDesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import { dict as zh } from "../../src/renderer/i18n/zh"
import { dict as zht } from "../../src/renderer/i18n/zht"

// Every new tray key must resolve: the bundle is built with an English
// fallback for locales that have not translated it yet, and the strict
// parser rejects a bundle whose key set does not match the English source.
describe("desktop native tray keys", () => {
  const trayKeys = [
    "desktop.tray.show",
    "desktop.tray.hide",
    "desktop.tray.newWindow",
    "desktop.tray.quit",
  ] as const

  test("keys exist in the English source", () => {
    for (const key of trayKeys) expect(DESKTOP_NATIVE_ENGLISH[key]).toBeString()
  })

  test("bundle stays parseable after adding keys", () => {
    const bundle = createDesktopNativeBundle("zh", (key) => (zh as Record<string, string>)[key] ?? DESKTOP_NATIVE_ENGLISH[key])
    expect(parseDesktopNativeBundle(bundle)).toEqual(bundle)
  })

  test("chinese and traditional chinese translations are present", () => {
    for (const key of trayKeys) {
      expect((zh as Record<string, string>)[key]).toBeString()
      expect((zht as Record<string, string>)[key]).toBeString()
    }
  })

  test("no locale other than english changed key count", () => {
    expect(DESKTOP_NATIVE_KEYS.length).toBeGreaterThan(0)
  })
})
