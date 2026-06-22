const express = require("express");
const { body } = require("express-validator");
const {
  approveItem,
  claimItem,
  createItem,
  decideClaim,
  deleteItem,
  getItems,
  rejectItem,
  reopenItem,
  resolveItem,
  updateItem,
} = require("../controllers/lostFoundController");
const { protect, authorize, optionalProtect } = require("../middleware/authMiddleware");
const { uploadImage, handleUploadError } = require("../middleware/uploadMiddleware");
const { handleValidationErrors } = require("../utils/validation");

const router = express.Router();

const validateItem = [
  body("type").isIn(["lost", "found"]).withMessage("Invalid item type"),
  body("item").trim().isLength({ min: 3, max: 80 }).withMessage("Item name must be between 3 and 80 characters"),
  body("description").trim().isLength({ min: 10, max: 500 }).withMessage("Description must be between 10 and 500 characters"),
  body("location").trim().notEmpty().withMessage("Location is required"),
  body("contact").trim().notEmpty().withMessage("Contact is required"),
];

router.get("/", optionalProtect, getItems);
router.post(
  "/",
  protect,
  uploadImage.single("image"),
  handleUploadError,
  validateItem,
  handleValidationErrors,
  createItem
);
router.put(
  "/:id",
  protect,
  uploadImage.single("image"),
  handleUploadError,
  validateItem,
  handleValidationErrors,
  updateItem
);
router.delete("/:id", protect, deleteItem);

// Claim lifecycle
router.post(
  "/:id/claims",
  protect,
  body("note").optional().trim().isLength({ max: 300 }).withMessage("Note too long"),
  handleValidationErrors,
  claimItem
);
router.put("/:id/claims/:claimId", protect, decideClaim);
router.put("/:id/resolve", protect, resolveItem);
router.put("/:id/reopen", protect, reopenItem);

// Moderation
router.put("/:id/approve", protect, authorize("admin", "moderator"), approveItem);
router.put("/:id/reject", protect, authorize("admin", "moderator"), rejectItem);

module.exports = router;
