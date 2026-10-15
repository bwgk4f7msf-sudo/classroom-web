import { test } from 'node:test'
import assert from 'node:assert/strict'
import { schema } from '../server/db/schema.js'

for (const mysql of [false, true]) {
  test(`${mysql ? 'MySQL' : 'SQLite'} schema creates referenced tables before their dependents`, () => {
    const created = new Set()
    for (const sql of schema(mysql)) {
      const table = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1]
      for (const [, referenced] of sql.matchAll(/REFERENCES (\w+)/g)) {
        assert.ok(created.has(referenced), `${table} references missing table ${referenced}`)
      }
      created.add(table)
    }
  })
}
