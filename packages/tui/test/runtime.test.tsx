import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { abbreviateHome } from "../src/runtime"
import { TuiPathsProvider, useTuiPaths } from "../src/context/runtime"

test("abbreviates paths within home boundaries", () => {
  expect(abbreviateHome("/home/test", "/home/test")).toBe("~")
  expect(abbreviateHome("/home/test/project", "/home/test")).toBe("~/project")
  expect(abbreviateHome("/home/tester/project", "/home/test")).toBe("/home/tester/project")
  expect(abbreviateHome("/tmp/project", "/home/test")).toBe("/tmp/project")
})

// Separators must come from the path flavor being abbreviated, not from the host platform,
// otherwise a POSIX directory (WSL, container, remote) is rendered as `~\deep\nested\dir`.
test("abbreviates posix paths regardless of host platform", () => {
  expect(abbreviateHome("/home/test/project", "/home/test")).toBe("~/project")
  expect(abbreviateHome("/home/test/deep/nested/dir", "/home/test")).toBe("~/deep/nested/dir")
  expect(abbreviateHome("/home/test/", "/home/test")).toBe("~")
  expect(abbreviateHome("/home/test/project", "/home/test/")).toBe("~/project")
})

test("abbreviates windows paths with native separators", () => {
  expect(abbreviateHome("C:\\Users\\test", "C:\\Users\\test")).toBe("~")
  expect(abbreviateHome("C:\\Users\\test\\project", "C:\\Users\\test")).toBe("~\\project")
  expect(abbreviateHome("C:/Users/test/project", "C:\\Users\\test")).toBe("~\\project")
  expect(abbreviateHome("C:\\Users\\tester\\project", "C:\\Users\\test")).toBe("C:\\Users\\tester\\project")
  expect(abbreviateHome("D:\\other", "C:\\Users\\test")).toBe("D:\\other")
})

test("leaves paths alone when flavors cannot be mixed", () => {
  expect(abbreviateHome("/home/test/project", "C:\\Users\\test")).toBe("/home/test/project")
  expect(abbreviateHome("C:\\Users\\test\\project", "/home/test")).toBe("C:\\Users\\test\\project")
  expect(abbreviateHome("/home/test/project", "")).toBe("/home/test/project")
})

test("provides focused immutable runtime inputs", async () => {
  let paths: ReturnType<typeof useTuiPaths>

  function Runtime() {
    paths = useTuiPaths()
    return <text>{paths.cwd}</text>
  }

  const app = await testRender(
    () => (
      <TuiPathsProvider value={{ cwd: "/work", home: "/home/test", state: "/state", worktree: "/worktree" }}>
        <Runtime />
      </TuiPathsProvider>
    ),
    { width: 40, height: 3 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("/work")
    expect(Object.isFrozen(paths!)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
