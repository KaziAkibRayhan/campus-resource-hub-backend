const express = require("express");
const {
  createDirectConversation,
  getChatUsers,
  getConversations,
  getMessages,
} = require("../controllers/chatController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/users", protect, getChatUsers);
router.get("/conversations", protect, getConversations);
router.post("/conversations/direct", protect, createDirectConversation);
router.get("/conversations/:id/messages", protect, getMessages);

module.exports = router;
