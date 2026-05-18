const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");

const getConversationForUser = async (conversationId, userId) =>
  Conversation.findOne({ _id: conversationId, type: "direct", members: userId });

exports.getChatUsers = async (req, res) => {
  try {
    const users = await User.find({
      _id: { $ne: req.user._id },
      isBlocked: false,
    })
      .select("name email role department profileImage")
      .sort({ name: 1 })
      .lean();

    res.status(200).json({ success: true, users });
  } catch (error) {
    console.error("Get chat users error:", error);
    res.status(500).json({ success: false, message: "Error fetching users" });
  }
};

exports.getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      type: "direct",
      members: req.user._id,
    })
      .populate("members", "name email role department profileImage")
      .populate({
        path: "lastMessage",
        populate: { path: "sender", select: "name" },
      })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({ success: true, conversations });
  } catch (error) {
    console.error("Get conversations error:", error);
    res.status(500).json({ success: false, message: "Error fetching chats" });
  }
};

exports.createDirectConversation = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId || userId === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "Invalid user" });
    }

    let conversation = await Conversation.findOne({
      type: "direct",
      members: { $all: [req.user._id, userId], $size: 2 },
    });

    if (!conversation) {
      conversation = await Conversation.create({
        type: "direct",
        members: [req.user._id, userId],
        createdBy: req.user._id,
      });
    }

    await conversation.populate("members", "name email role department profileImage");

    res.status(200).json({ success: true, conversation });
  } catch (error) {
    console.error("Create direct chat error:", error);
    res.status(500).json({ success: false, message: "Error creating chat" });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const conversation = await getConversationForUser(
      req.params.id,
      req.user._id
    );

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Chat not found" });
    }

    const messages = await Message.find({ conversation: conversation._id })
      .populate("sender", "name email profileImage")
      .sort({ createdAt: 1 })
      .lean();

    res.status(200).json({ success: true, messages });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({ success: false, message: "Error fetching messages" });
  }
};
