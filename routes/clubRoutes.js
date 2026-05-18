const express = require("express");
const { body } = require("express-validator");
const {
  createClub,
  deleteClub,
  getClubs,
  joinClub,
  leaveClub,
} = require("../controllers/clubController");
const { protect, authorize, optionalProtect } = require("../middleware/authMiddleware");
const { handleValidationErrors } = require("../utils/validation");

const router = express.Router();

const validateClub = [
  body("name").trim().isLength({ min: 3, max: 80 }).withMessage("Club name must be between 3 and 80 characters"),
  body("description").trim().isLength({ min: 10, max: 500 }).withMessage("Description must be between 10 and 500 characters"),
  body("category").optional().trim(),
];

router.get("/", optionalProtect, getClubs);
router.post("/", protect, authorize("admin", "moderator"), validateClub, handleValidationErrors, createClub);
router.post("/:id/join", protect, joinClub);
router.delete("/:id/leave", protect, leaveClub);
router.delete("/:id", protect, deleteClub);

module.exports = router;
