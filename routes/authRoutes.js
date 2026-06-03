// backend/routes/auth.js
const express = require("express");
const { body } = require("express-validator");
const {
  signup,
  verifySignupOtp,
  login,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  getMe,
  updateProfile,
  changePassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");
const { uploadProfileImage, handleUploadError } = require("../middleware/uploadMiddleware");
const { handleValidationErrors } = require("../utils/validation");
const { STUDENT_ID_REGEX } = require("../utils/authValidation");

const router = express.Router();

// Validation middleware
const signupValidation = [
  body("name")
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage("Name must be between 3 and 50 characters"),
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Please provide a valid email"),
  body("password")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/[a-z]/)
    .withMessage("Password must contain at least one lowercase letter")
    .matches(/[A-Z]/)
    .withMessage("Password must contain at least one uppercase letter")
    .matches(/[0-9]/)
    .withMessage("Password must contain at least one number"),
  body("studentId")
    .trim()
    .matches(STUDENT_ID_REGEX)
    .withMessage("Student ID must be 6 to 20 digits"),
  body("department")
    .isIn(["CSE", "EEE", "BBA", "English", "Law"])
    .withMessage("Invalid department"),
];

const loginValidation = [
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Please provide a valid email"),
  body("password").notEmpty().withMessage("Password is required"),
];

const otpValidation = [
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Please provide a valid email"),
  body("otp")
    .trim()
    .matches(/^[0-9]{6}$/)
    .withMessage("OTP must be a 6 digit code"),
];

const forgotPasswordValidation = [
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Please provide a valid email"),
];

const resetPasswordValidation = [
  ...otpValidation,
  body("newPassword")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/[a-z]/)
    .withMessage("Password must contain at least one lowercase letter")
    .matches(/[A-Z]/)
    .withMessage("Password must contain at least one uppercase letter")
    .matches(/[0-9]/)
    .withMessage("Password must contain at least one number"),
];

const updateProfileValidation = [
  body("name")
    .optional()
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage("Name must be between 3 and 50 characters"),
  body("email")
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage("Please provide a valid email"),
  body("department")
    .optional()
    .isIn(["CSE", "EEE", "BBA", "English", "Law"])
    .withMessage("Invalid department"),
  body("newPassword")
    .optional({ checkFalsy: true })
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters")
    .matches(/[a-z]/)
    .withMessage("Password must contain at least one lowercase letter")
    .matches(/[A-Z]/)
    .withMessage("Password must contain at least one uppercase letter")
    .matches(/[0-9]/)
    .withMessage("Password must contain at least one number"),
];

// Public routes
router.post("/signup", signupValidation, handleValidationErrors, signup);
router.post("/verify-signup-otp", otpValidation, handleValidationErrors, verifySignupOtp);
router.post("/login", loginValidation, handleValidationErrors, login);
router.post("/forgot-password", forgotPasswordValidation, handleValidationErrors, forgotPassword);
router.post("/verify-reset-otp", otpValidation, handleValidationErrors, verifyResetOtp);
router.post("/reset-password", resetPasswordValidation, handleValidationErrors, resetPassword);

// Protected routes
router.get("/me", protect, getMe);
router.put(
  "/update-profile",
  protect,
  uploadProfileImage.single("profileImage"),
  handleUploadError,
  updateProfileValidation,
  handleValidationErrors,
  updateProfile
);
router.put("/change-password", protect, changePassword);

module.exports = router;
