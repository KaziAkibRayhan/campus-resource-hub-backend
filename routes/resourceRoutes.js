// backend/routes/resource.js
const express = require("express");
const { body } = require("express-validator");
const {
  uploadResource,
  getResources,
  getResourceById,
  updateResource,
  deleteResource,
  approveResource,
  rejectResource,
  incrementDownload,
  getMyUploads,
} = require("../controllers/resourceController");
const {
  protect,
  authorize,
  optionalProtect,
} = require("../middleware/authMiddleware");
const { upload, handleUploadError } = require("../middleware/uploadMiddleware");
const { handleValidationErrors } = require("../utils/validation");

const router = express.Router();

// Validation middleware
const resourceValidation = [
  body("title")
    .trim()
    .isLength({ min: 5, max: 100 })
    .withMessage("Title must be between 5 and 100 characters"),
  body("description")
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage("Description must be between 10 and 500 characters"),
  body("course").trim().notEmpty().withMessage("Course code is required"),
  body("department")
    .isIn(["CSE", "EEE", "BBA", "English", "Law"])
    .withMessage("Invalid department"),
  body("semester")
    .isIn(["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"])
    .withMessage("Invalid semester"),
];

// Public routes
router.get("/", optionalProtect, getResources);

// Protected routes (authenticated users)
router.post(
  "/",
  protect,
  upload.single("file"),
  handleUploadError,
  resourceValidation,
  handleValidationErrors,
  uploadResource
);

router.get("/user/my-uploads", protect, getMyUploads);
router.put("/:id", protect, updateResource);
router.delete("/:id", protect, deleteResource);
router.put("/:id/download", protect, incrementDownload);

router.get("/:id", optionalProtect, getResourceById);

// Admin/Moderator only routes
router.put(
  "/:id/approve",
  protect,
  authorize("admin", "moderator"),
  approveResource
);

router.put(
  "/:id/reject",
  protect,
  authorize("admin", "moderator"),
  rejectResource
);

module.exports = router;
