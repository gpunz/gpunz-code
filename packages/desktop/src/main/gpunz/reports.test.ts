import { describe, expect, mock, test } from "bun:test"

mock.module("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.2.0", getLocale: () => "ru", getPath: () => "." },
  safeStorage: { isEncryptionAvailable: () => false },
}))
mock.module("../store", () => ({ getStore: () => new Map() }))

const { describeError, ignorable, scrub } = await import("./reports")

describe("what a report may carry", () => {
  test("keys, tokens and e-mail addresses are masked", () => {
    const s = scrub(
      "GET https://7-21434.run.gpu.nz/v1/models?token=abcdef123456 Authorization: Bearer gnz_live_AAAABBBBCCCC user ivan@example.com",
      12_000,
      "/nowhere",
    )
    expect(s).not.toContain("abcdef123456")
    expect(s).not.toContain("AAAABBBBCCCC")
    expect(s).not.toContain("ivan@example.com")
  })

  test("the home folder and the name in it are gone, on every system", () => {
    expect(scrub("at f (C:\\Users\\Ivan Petrov\\AppData\\Local\\x.js:1:2)", 12_000, "C:\\Users\\Ivan Petrov")).toBe(
      "at f (~\\AppData\\Local\\x.js:1:2)",
    )
    expect(scrub("open C:/Users/Ivan Petrov/proj/a.ts", 12_000, "C:\\Users\\Ivan Petrov")).toBe("open ~/proj/a.ts")
    expect(scrub("ENOENT /home/masha/.config/x", 12_000, "/root")).toBe("ENOENT /home/~/.config/x")
    expect(scrub("ENOENT /Users/masha/Library/x", 12_000, "/root")).toBe("ENOENT /Users/~/Library/x")
  })

  test("a long text is clipped", () => {
    expect(scrub("x".repeat(300), 100, "/nowhere").length).toBeLessThan(140)
  })
})

describe("what is worth a report", () => {
  test("the network being away is not a bug", () => {
    expect(ignorable("TypeError: fetch failed")).toBe(true)
    expect(ignorable("Error: net::ERR_INTERNET_DISCONNECTED")).toBe(true)
    expect(ignorable("Error: getaddrinfo ENOTFOUND gpu.nz")).toBe(true)
    expect(ignorable("ResizeObserver loop completed with undelivered notifications.")).toBe(true)
    expect(ignorable("TypeError: Cannot read properties of undefined (reading 'phase')")).toBe(false)
  })

  test("anything thrown is described", () => {
    expect(describeError(new TypeError("boom")).message).toBe("TypeError: boom")
    expect(describeError(new Error("plain")).message).toBe("Error: plain")
    expect(describeError("text")).toEqual({ message: "text", stack: "" })
    expect(describeError({ message: "m", stack: "s" })).toEqual({ message: "m", stack: "s" })
    expect(describeError({ a: 1 }).message).toBe('{"a":1}')
  })
})
