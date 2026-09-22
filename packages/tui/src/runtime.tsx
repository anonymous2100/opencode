import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const windowsHome = isWindowsPath(home)
  // Abbreviating across path flavors (a Windows home with a WSL directory, or the reverse)
  // would splice separators from the wrong flavor into the result, so leave it untouched.
  if (windowsHome !== isWindowsPath(input)) return input
  const impl = windowsHome ? path.win32 : path.posix
  const relative = impl.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + impl.sep) || impl.isAbsolute(relative)) return input
  return "~" + impl.sep + relative
}

function isWindowsPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")
}
