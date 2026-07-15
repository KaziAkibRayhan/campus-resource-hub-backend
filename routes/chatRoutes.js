const express = require("express");
const {
  createDirectConversation,
  createGroupConversation,
  getChatUsers,
  getConversations,
  getMessages,
  updateGroupInfo,
  addMembers,
  removeMember,
  promoteToAdmin,
  demoteAdmin,
  leaveGroup,
  uploadAttachment,
  verifyChatAccess,
  downloadAttachment,
  searchHubInformation,
  askHubAssistant,
  streamHubAssistant,
} = require("../controllers/chatController");
const { protect } = require("../middleware/authMiddleware");
const { uploadChatAttachment, handleUploadError } = require("../middleware/uploadMiddleware");

const router = express.Router();

router.post("/verify", protect, verifyChatAccess);
router.get("/search", protect, searchHubInformation);
router.post("/assistant", protect, askHubAssistant);
router.post("/assistant/stream", protect, streamHubAssistant);
router.get("/users", protect, getChatUsers);
router.get("/conversations", protect, getConversations);
router.post("/conversations/direct", protect, createDirectConversation);
router.post("/conversations/group", protect, createGroupConversation);
router.get("/conversations/:id/messages", protect, getMessages);

// Group management
router.patch("/conversations/:id/info", protect, updateGroupInfo);
router.post("/conversations/:id/members", protect, addMembers);
router.delete("/conversations/:id/members", protect, removeMember);
router.post("/conversations/:id/admins", protect, promoteToAdmin);
router.delete("/conversations/:id/admins", protect, demoteAdmin);
router.post("/conversations/:id/leave", protect, leaveGroup);

// Attachments
router.post(
  "/attachments",
  protect,
  uploadChatAttachment.single("file"),
  handleUploadError,
  uploadAttachment
);
router.get("/messages/:messageId/attachments/:attachmentIndex/download", protect, downloadAttachment);

module.exports = router;
