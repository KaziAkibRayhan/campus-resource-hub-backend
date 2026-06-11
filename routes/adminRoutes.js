const express = require("express");
const {
  getStats,
  getUsers,
  setUserBlocked,
  updateUserRole,
  deleteUser,
} = require("../controllers/adminController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/stats", protect, authorize("admin", "moderator"), getStats);
router.get("/users", protect, authorize("admin", "moderator"), getUsers);
router.put(
  "/users/:id/block",
  protect,
  authorize("admin", "moderator"),
  setUserBlocked
);
router.put("/users/:id/role", protect, authorize("admin"), updateUserRole);
router.delete("/users/:id", protect, authorize("admin"), deleteUser);

module.exports = router;
