const express = require("express");
const {
  getEvents,
  createEvent,
  approveEvent,
  deleteEvent,
} = require("../controllers/eventController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", getEvents);
router.post("/", protect, createEvent);
router.put("/:id/approve", protect, authorize("admin"), approveEvent);
router.delete("/:id", protect, deleteEvent);

module.exports = router;
