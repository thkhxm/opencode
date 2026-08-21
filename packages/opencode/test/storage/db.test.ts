import { Database as BunDatabase } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { PermissionTable } from "@/session/session.sql"
import { it } from "../lib/effect"

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "opencode.db")
        : path.join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared database path when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "opencode.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})

describe("Database.repairLegacyPermissionTable", () => {
  test("adds default permission data for legacy rows", () => {
    const sqlite = new BunDatabase(":memory:")
    try {
      const db = drizzle({ client: sqlite })

      db.run(/* sql */ `
        CREATE TABLE permission (
          project_id text PRIMARY KEY,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        )
      `)
      db.run(/* sql */ `
        INSERT INTO permission (project_id, time_created, time_updated)
        VALUES ('proj_legacy', 1, 2)
      `)

      Database.repairLegacyPermissionTable(db)
      Database.repairLegacyPermissionTable(db)

      expect(db.select().from(PermissionTable).get()?.data).toEqual([])
    } finally {
      sqlite.close()
    }
  })
})
