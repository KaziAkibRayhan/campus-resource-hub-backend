const STUDENT_ID_REGEX = /^[0-9]{6,20}$/;
const PASSWORD_REGEX = {
  lowercase: /[a-z]/,
  uppercase: /[A-Z]/,
  number: /[0-9]/,
};

const normalizeStudentId = (studentId = "") => String(studentId).trim();

module.exports = {
  STUDENT_ID_REGEX,
  PASSWORD_REGEX,
  normalizeStudentId,
};
