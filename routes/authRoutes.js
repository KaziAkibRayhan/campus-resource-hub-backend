// backend/routes/auth.js
const express = require("express");
const { body } = require("express-validator");
const {
  signup,
  login,
  getMe,
  updateProfile,
  changePassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/authMiddleware");

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
    .matches(/^[0-9]+$/)
    .withMessage("Student ID must contain only numbers")
    .isLength({ min: 10 })
    .withMessage("Student ID must be at least 10 digits"),
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

// Validation error handler
const handleValidationErrors = (req, res, next) => {
  const { validationResult } = require("express-validator");
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array().map((err) => ({
        field: err.param,
        message: err.msg,
      })),
    });
  }
  next();
};

// Public routes
router.post("/signup", signupValidation, handleValidationErrors, signup);
router.post("/login", loginValidation, handleValidationErrors, login);

// Protected routes
router.get("/me", protect, getMe);
router.put("/update-profile", protect, updateProfile);
router.put("/change-password", protect, changePassword);

module.exports = router;
