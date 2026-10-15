export function personRow(person, type) {
  return {
    ...person,
    type,
    number: type === 'students' ? person.student_no : person.teacher_no,
    number_conflict: Number(person.number_conflict) === 1,
    reset_requested: Number(person.reset_requested) === 1,
  }
}
