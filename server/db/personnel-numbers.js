// A shared unique key also serializes student/teacher registrations on MySQL.
export async function initializePersonnelNumbers(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS personnel_numbers (
    number VARCHAR(64) PRIMARY KEY
  )${db.mysql ? ' ENGINE=InnoDB' : ''}`)
  const insert = db.mysql ? 'INSERT IGNORE' : 'INSERT OR IGNORE'
  await db.run(`${insert} INTO personnel_numbers(number)
    SELECT student_no FROM students UNION SELECT teacher_no FROM teachers`)
}

export async function reservePersonnelNumber(db, number) {
  await db.run('INSERT INTO personnel_numbers(number) VALUES (?)', [number])
}

export async function hasNumberConflict(db, number) {
  const result = await db.get(`SELECT COUNT(*) AS total FROM (
    SELECT user_id FROM students WHERE student_no=?
    UNION ALL
    SELECT user_id FROM teachers WHERE teacher_no=?
  ) AS owners`, [number, number])
  return result.total > 1
}
