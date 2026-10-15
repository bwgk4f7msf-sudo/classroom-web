import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'mysql2/promise'
import { schema } from '../server/db/schema.js'

test('MySQL initializes an empty schema with foreign keys and supports repeated initialization', {
  skip: !process.env.TEST_MYSQL_URL,
}, async () => {
  const connection = await createConnection(process.env.TEST_MYSQL_URL)
  const database = `classroom_test_${randomUUID().replaceAll('-', '')}`
  let created = false
  try {
    await connection.query(`CREATE DATABASE \`${database}\``)
    created = true
    await connection.query(`USE \`${database}\``)
    await connection.query('SET SESSION foreign_key_checks=1')
    for (let run = 0; run < 2; run++) {
      for (const sql of schema(true)) await connection.execute(sql)
    }
    const [tables] = await connection.query('SHOW TABLES')
    assert.equal(tables.length, schema(true).length)
    await assert.rejects(connection.execute(`INSERT INTO notifications(user_id,message,created_at)
      VALUES (1,'invalid reference','2090-01-01T00:00:00.000Z')`), {
      code: 'ER_NO_REFERENCED_ROW_2',
    })
  } finally {
    try {
      if (created) await connection.query(`DROP DATABASE \`${database}\``)
    } finally {
      await connection.end()
    }
  }
})
