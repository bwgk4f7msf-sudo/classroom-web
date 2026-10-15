import db from './db/db.js'

export async function archiveTeachingClass(classId) {
  return db.transaction(async () => {
    await db.run("UPDATE teaching_classes SET status='archived' WHERE id=?", [classId])
    // Cancellation preserves existing records without creating new absences.
    await db.run(`UPDATE attendance_tasks SET status='ended'
      WHERE teaching_class_id=? AND status<>'ended'`, [classId])
  })
}
